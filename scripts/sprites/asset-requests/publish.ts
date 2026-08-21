/**
 * Publish a sealed asset request as an IMMUTABLE git ref.
 *
 * Every request is an ORPHAN commit (no parent) whose tree contains exactly its
 * manifest plus its declared payload — nothing else. That structural property is
 * what makes "a single request cannot overwrite unrelated sprites" checkable
 * rather than merely intended: there is no aggregate branch to inherit, so a
 * request literally cannot carry bytes it did not declare.
 *
 * The commit is built with git PLUMBING against a throwaway index
 * (`GIT_INDEX_FILE`), so publishing never touches the caller's branch, index,
 * HEAD, or working tree — the same durability contract `runQueueCommit` offers,
 * without the mutable aggregate branch.
 *
 * Determinism: the request id is derived from the manifest body, and the commit
 * is created with fixed identity/date env, so republishing the same payload
 * yields the byte-identical commit and the same ref. Publishing is therefore
 * idempotent, and a "correction" is impossible in-place — it must be a NEW
 * request that names the old one in `supersedes`.
 */

import type { Exec } from '../checkin.js';
import {
  AssetRequestError,
  pngRepoPath,
  requestBranchName,
  requestManifestPath,
  sealAssetRequest,
  serializeAssetRequest,
  sha256Bytes,
  shardRepoPath,
  type AssetRequestManifest,
  type AssetRequestManifestBody,
} from './manifest.js';

/** Fixed commit identity so a replayed request produces the identical commit. */
export const REQUEST_COMMIT_IDENTITY = {
  name: 'Crawler Asset Requests',
  email: 'asset-requests@crawler.invalid',
  /** Unix epoch — a wall clock would make replay produce a different SHA. */
  date: '1970-01-01T00:00:00+0000',
} as const;

export type PublishRequestStatus = 'created' | 'already-published';

export class PublishRequestError extends Error {
  constructor(
    readonly kind:
      | 'payload-missing'
      | 'payload-hash-mismatch'
      | 'git-failed'
      | 'ref-exists-with-different-content',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PublishRequestError';
  }
}

export interface PublishRequestDeps {
  readonly exec: Exec;
  /** Read raw bytes of an absolute path. Throws (any error) when absent. */
  readonly readFileBytes: (absolutePath: string) => Promise<Uint8Array>;
  /** Write a UTF-8 file, creating parent directories. */
  readonly writeTextFile: (absolutePath: string, contents: string) => Promise<void>;
  /** Create + return an empty temp directory (throwaway index/staging). */
  readonly makeTempDir: () => Promise<string>;
  /** Remove a directory tree (best-effort cleanup). */
  readonly removeDir: (dir: string) => Promise<void>;
  /** Base env for git subprocesses. Defaults to an empty env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Join path segments (injectable so tests can stay platform-neutral). */
  readonly joinPath: (...segments: string[]) => string;
}

export interface PublishRequestOptions {
  /** Remote to publish the ref to. Defaults to `origin`. */
  readonly remote?: string;
  /** Root the payload files are read from. Defaults to `repoRoot`. */
  readonly sourceRoot?: string;
  /** Push the ref to `remote`. Defaults to true; false publishes locally only. */
  readonly push?: boolean;
}

export interface PublishRequestResult {
  readonly status: PublishRequestStatus;
  readonly requestId: string;
  /** Branch name (no `refs/heads/`). */
  readonly branch: string;
  /** The sealed request commit SHA. */
  readonly commit: string;
  /** Repo-relative POSIX paths carried by the request commit. */
  readonly paths: readonly string[];
}

async function git(
  exec: Exec,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await exec('git', args, { cwd, env });
  if (result.code !== 0) {
    throw new PublishRequestError(
      'git-failed',
      `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** Commit message body: greppable trailers bind the commit to its manifest. */
export function buildRequestCommitMessage(manifest: AssetRequestManifest): string {
  const lines = [
    `chore(assets): asset request ${manifest.requestId.slice(0, 12)} (${manifest.operation})`,
    '',
    `Asset-Request: ${manifest.requestId}`,
    `Asset-Request-Operation: ${manifest.operation}`,
    `Asset-Request-Producer: ${manifest.producer}`,
    `Observed-Main: ${manifest.observedMainSha}`,
  ];
  if (manifest.supersedes !== null) lines.push(`Supersedes-Request: ${manifest.supersedes}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Files (repo-relative POSIX path -> source path relative to `sourceRoot`) the
 * request commit must carry as real bytes.
 */
function payloadFiles(manifest: AssetRequestManifest): readonly string[] {
  const files: string[] = [];
  for (const asset of manifest.assets) {
    files.push(pngRepoPath(asset.assetPath), shardRepoPath(asset.manifestKey));
  }
  return files;
}

/**
 * Seal `body` and publish it as `refs/heads/assets/request/<id>`.
 *
 * Fails closed when a declared PNG's bytes do not hash to its manifest
 * `contentHash` (so the PNG and its shard can never disagree), and when a
 * declared payload file is missing.
 */
export async function publishAssetRequest(
  repoRoot: string,
  body: AssetRequestManifestBody,
  deps: PublishRequestDeps,
  options: PublishRequestOptions = {},
): Promise<PublishRequestResult> {
  const manifest = sealAssetRequest(body);
  const remote = options.remote ?? 'origin';
  const sourceRoot = options.sourceRoot ?? repoRoot;
  const shouldPush = options.push ?? true;
  const branch = requestBranchName(manifest.requestId);
  const ref = `refs/heads/${branch}`;
  const baseEnv = deps.env ?? {};

  // Hash-verify every declared PNG BEFORE any object is written: a mismatched
  // pair must never reach the object database, let alone a ref.
  for (const asset of manifest.assets) {
    const absolute = deps.joinPath(sourceRoot, ...pngRepoPath(asset.assetPath).split('/'));
    let bytes: Uint8Array;
    try {
      bytes = await deps.readFileBytes(absolute);
    } catch (error) {
      throw new PublishRequestError(
        'payload-missing',
        `declared payload "${pngRepoPath(asset.assetPath)}" is missing under ${sourceRoot}`,
        { cause: error },
      );
    }
    const actual = sha256Bytes(bytes);
    if (actual !== asset.contentHash) {
      throw new PublishRequestError(
        'payload-hash-mismatch',
        `"${asset.assetPath}" hashes to ${actual} but the request declares ${asset.contentHash}; ` +
          'the PNG and its manifest shard must travel atomically with matching bytes',
      );
    }
  }

  const temp = await deps.makeTempDir();
  try {
    const indexFile = deps.joinPath(temp, 'request.index');
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: REQUEST_COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: REQUEST_COMMIT_IDENTITY.email,
      GIT_AUTHOR_DATE: REQUEST_COMMIT_IDENTITY.date,
      GIT_COMMITTER_NAME: REQUEST_COMMIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: REQUEST_COMMIT_IDENTITY.email,
      GIT_COMMITTER_DATE: REQUEST_COMMIT_IDENTITY.date,
    };

    const manifestFile = deps.joinPath(temp, 'manifest.json');
    await deps.writeTextFile(manifestFile, serializeAssetRequest(manifest));

    const staged: string[] = [];
    const stage = async (repoPath: string, absoluteSource: string): Promise<void> => {
      const blob = await git(
        deps.exec,
        repoRoot,
        ['hash-object', '-w', '--no-filters', '--', absoluteSource],
        env,
      );
      await git(
        deps.exec,
        repoRoot,
        ['update-index', '--add', '--cacheinfo', `100644,${blob},${repoPath}`],
        env,
      );
      staged.push(repoPath);
    };

    await stage(requestManifestPath(manifest.requestId), manifestFile);
    for (const repoPath of payloadFiles(manifest)) {
      const absolute = deps.joinPath(sourceRoot, ...repoPath.split('/'));
      try {
        await deps.readFileBytes(absolute);
      } catch (error) {
        throw new PublishRequestError(
          'payload-missing',
          `declared payload "${repoPath}" is missing under ${sourceRoot}`,
          { cause: error },
        );
      }
      await stage(repoPath, absolute);
    }

    const tree = await git(deps.exec, repoRoot, ['write-tree'], env);
    const commit = await git(
      deps.exec,
      repoRoot,
      ['commit-tree', tree, '-m', buildRequestCommitMessage(manifest)],
      env,
    );

    // A published request is immutable: an existing ref with this id already
    // holds this exact content (same id <=> same body), so publishing again is a
    // no-op rather than an update.
    const existing = await deps.exec('git', ['ls-remote', remote, ref], { cwd: repoRoot, env });
    if (shouldPush && existing.code === 0 && existing.stdout.trim() !== '') {
      const remoteSha = existing.stdout.trim().split(/\s+/)[0] ?? '';
      if (remoteSha !== commit) {
        throw new PublishRequestError(
          'ref-exists-with-different-content',
          `${ref} already exists at ${remoteSha} but this request builds ${commit}; ` +
            'a sealed request ref is never rewritten — publish a superseding request instead',
        );
      }
      return {
        status: 'already-published',
        requestId: manifest.requestId,
        branch,
        commit,
        paths: [...staged].sort(),
      };
    }

    await git(deps.exec, repoRoot, ['update-ref', ref, commit], env);
    if (shouldPush) {
      // `--force-with-lease=<ref>:` (empty expectation) is a compare-and-swap
      // CREATE: the push fails if the ref exists at all, so two racing
      // publishers can never silently overwrite one another.
      await git(
        deps.exec,
        repoRoot,
        ['push', `--force-with-lease=${ref}:`, remote, `${commit}:${ref}`],
        env,
      );
    }

    return {
      status: 'created',
      requestId: manifest.requestId,
      branch,
      commit,
      paths: [...staged].sort(),
    };
  } catch (error) {
    if (error instanceof PublishRequestError || error instanceof AssetRequestError) throw error;
    throw new PublishRequestError(
      'git-failed',
      `failed to publish asset request: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await deps.removeDir(temp).catch(() => undefined);
  }
}
