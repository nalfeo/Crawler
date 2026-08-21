/**
 * Cutover: deterministically classify the FINAL `assets/queue` tip so every
 * path and annotation delta on the retired aggregate branch is accounted for
 * before the branch is archived.
 *
 * The report is the human-approval surface for migration: only groups a human
 * approves are converted into immutable requests (see `--emit-requests` in the
 * CLI), and the classification is a pure function of two commits, so it can be
 * re-run and diffed.
 *
 * Classifications:
 *   - `already-on-main`      queue bytes are identical to `main`; nothing to do.
 *   - `safe-request`         a complete, hash-consistent PNG+shard pair that adds
 *                            to (or cleanly replaces) `main`.
 *   - `naming-migration-conflict`
 *                            the same bytes already live on `main` under a
 *                            DIFFERENT path/key — a stale pre-rename entry.
 *   - `invalid-pair`         PNG without shard, shard without PNG, unreadable
 *                            shard, or a shard whose identity/hash disagrees
 *                            with the PNG bytes.
 *   - `requires-human`       anything that would delete or otherwise mutate
 *                            `main` without a proof (deletes, unknown paths).
 */

import {
  ANNOTATIONS_PATH,
  GENERATED_ROOT,
  sha256Bytes,
  type AssetRequestAnnotation,
} from './manifest.js';
import type { MaterializeDeps } from './reconcile.js';

export type QueueEntryClassification =
  | 'already-on-main'
  | 'safe-request'
  | 'naming-migration-conflict'
  | 'invalid-pair'
  | 'requires-human';

export interface QueueAssetGroup {
  /** Manifest key derived from the shard path, or the PNG stem when shard-less. */
  readonly manifestKey: string;
  /** `public/assets`-relative PNG path, when the group has one. */
  readonly assetPath: string | null;
  /** Repo-relative POSIX paths this group accounts for. */
  readonly paths: readonly string[];
  readonly classification: QueueEntryClassification;
  readonly detail: string;
  /** SHA-256 of the queue PNG bytes, when readable. */
  readonly contentHash: string | null;
  readonly briefId: string | null;
  readonly variantIndex: number | null;
  readonly sourceRun: string | null;
}

export interface QueueAnnotationDelta {
  readonly key: string;
  readonly classification: QueueEntryClassification;
  readonly detail: string;
  /** Queue-tip value, absent when the key was deleted on the queue. */
  readonly value: AssetRequestAnnotation | null;
}

export interface QueueMigrationReport {
  readonly version: 1;
  readonly baseSha: string;
  readonly queueTipSha: string;
  readonly groups: readonly QueueAssetGroup[];
  readonly annotations: readonly QueueAnnotationDelta[];
  /** Changed paths not covered by any group/annotation delta. Must stay empty. */
  readonly unclassifiedPaths: readonly string[];
  readonly summary: Readonly<Record<QueueEntryClassification, number>>;
}

export interface ClassifyQueueOptions {
  readonly baseRef?: string;
  readonly queueRef?: string;
}

const SHARD_PREFIX = `${GENERATED_ROOT}/entries/`;
const PNG_PREFIX = 'public/assets/generated/';

/** Parse `git diff --name-only` output into a sorted, de-duplicated path list. */
export function parseChangedPaths(stdout: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') paths.add(trimmed);
  }
  return [...paths].sort();
}

/**
 * Group changed art paths by manifest key so a PNG and its shard are classified
 * as ONE unit — the same atomicity the request contract enforces.
 */
export function groupChangedPaths(paths: readonly string[]): {
  readonly groups: ReadonlyMap<string, string[]>;
  readonly annotationsChanged: boolean;
  readonly unclassified: readonly string[];
} {
  const groups = new Map<string, string[]>();
  const unclassified: string[] = [];
  let annotationsChanged = false;
  const push = (key: string, repoPath: string): void => {
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [repoPath]);
    else list.push(repoPath);
  };
  for (const repoPath of paths) {
    if (repoPath === ANNOTATIONS_PATH) {
      annotationsChanged = true;
      continue;
    }
    if (repoPath.startsWith(SHARD_PREFIX) && repoPath.endsWith('.json')) {
      push(repoPath.slice(SHARD_PREFIX.length, -'.json'.length), repoPath);
      continue;
    }
    if (repoPath.startsWith(PNG_PREFIX) && repoPath.toLowerCase().endsWith('.png')) {
      push(repoPath.slice(PNG_PREFIX.length, -'.png'.length), repoPath);
      continue;
    }
    unclassified.push(repoPath);
  }
  for (const list of groups.values()) list.sort();
  return { groups, annotationsChanged, unclassified: unclassified.sort() };
}

async function blobAt(
  deps: MaterializeDeps,
  repoRoot: string,
  rev: string,
  repoPath: string,
): Promise<string | null> {
  const result = await deps.exec(
    'git',
    ['rev-parse', '--verify', '--quiet', `${rev}:${repoPath}`],
    { cwd: repoRoot, env: deps.env },
  );
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function mustGit(
  deps: MaterializeDeps,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await deps.exec('git', args, { cwd, env: deps.env });
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** Index of `main`'s generated PNG content hashes, for rename detection. */
async function mainContentIndex(
  deps: MaterializeDeps,
  mainWorktree: string,
  repoRoot: string,
  baseRef: string,
): Promise<ReadonlyMap<string, string[]>> {
  const listing = await mustGit(deps, repoRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    baseRef,
    '--',
    GENERATED_ROOT,
  ]);
  const index = new Map<string, string[]>();
  for (const repoPath of parseChangedPaths(listing)) {
    if (!repoPath.toLowerCase().endsWith('.png')) continue;
    const bytes = await deps.readFileBytes(deps.joinPath(mainWorktree, ...repoPath.split('/')));
    const hash = sha256Bytes(bytes);
    const list = index.get(hash) ?? [];
    list.push(repoPath);
    index.set(hash, list);
  }
  for (const list of index.values()) list.sort();
  return index;
}

function annotationsOf(text: string | null): Record<string, AssetRequestAnnotation> {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const sprites = (parsed as { sprites?: unknown } | null)?.sprites;
  if (typeof sprites !== 'object' || sprites === null || Array.isArray(sprites)) return {};
  const result: Record<string, AssetRequestAnnotation> = {};
  for (const [key, value] of Object.entries(sprites as Record<string, unknown>)) {
    const record = value as Record<string, unknown>;
    result[key] = {
      key,
      favorite: record?.favorite === true,
      disliked: record?.disliked === true,
      comment: typeof record?.comment === 'string' ? record.comment : '',
    };
  }
  return result;
}

function sameAnnotation(a: AssetRequestAnnotation, b: AssetRequestAnnotation): boolean {
  return a.favorite === b.favorite && a.disliked === b.disliked && a.comment === b.comment;
}

/**
 * Produce the deterministic migration report for the final queue tip.
 *
 * Accounts for EVERY changed path: each is either in a group, the annotation
 * delta list, or `unclassifiedPaths` (which a cutover must drive to empty).
 */
export async function classifyQueueTip(
  repoRoot: string,
  deps: MaterializeDeps,
  options: ClassifyQueueOptions = {},
): Promise<QueueMigrationReport> {
  const baseRef = options.baseRef ?? 'origin/main';
  const queueRef = options.queueRef ?? 'origin/assets/queue';
  const baseSha = await mustGit(deps, repoRoot, ['rev-parse', baseRef]);
  const queueTipSha = await mustGit(deps, repoRoot, ['rev-parse', queueRef]);

  const changed = parseChangedPaths(
    await mustGit(deps, repoRoot, [
      'diff',
      '--name-only',
      baseSha,
      queueTipSha,
      '--',
      GENERATED_ROOT,
    ]),
  );
  const { groups, annotationsChanged, unclassified } = groupChangedPaths(changed);

  const temp = await deps.makeTempDir();
  const worktrees: string[] = [];
  try {
    const queueWorktree = deps.joinPath(temp, 'queue');
    const mainWorktree = deps.joinPath(temp, 'main');
    await mustGit(deps, repoRoot, ['worktree', 'add', '--detach', queueWorktree, queueTipSha]);
    worktrees.push(queueWorktree);
    await mustGit(deps, repoRoot, ['worktree', 'add', '--detach', mainWorktree, baseSha]);
    worktrees.push(mainWorktree);

    const contentIndex = await mainContentIndex(deps, mainWorktree, repoRoot, baseSha);

    const classified: QueueAssetGroup[] = [];
    for (const manifestKey of [...groups.keys()].sort()) {
      classified.push(
        await classifyGroup(
          deps,
          repoRoot,
          manifestKey,
          groups.get(manifestKey) ?? [],
          baseSha,
          queueTipSha,
          queueWorktree,
          contentIndex,
        ),
      );
    }

    const annotations: QueueAnnotationDelta[] = [];
    if (annotationsChanged) {
      const queueDoc = annotationsOf(await showBlob(deps, repoRoot, queueTipSha, ANNOTATIONS_PATH));
      const mainDoc = annotationsOf(await showBlob(deps, repoRoot, baseSha, ANNOTATIONS_PATH));
      const keys = [...new Set([...Object.keys(queueDoc), ...Object.keys(mainDoc)])].sort();
      for (const key of keys) {
        const queueValue = queueDoc[key];
        const mainValue = mainDoc[key];
        if (queueValue === undefined) {
          annotations.push({
            key,
            classification: 'requires-human',
            detail:
              'key exists on main but not on the queue tip; a deletion needs explicit approval',
            value: null,
          });
          continue;
        }
        if (mainValue !== undefined && sameAnnotation(queueValue, mainValue)) {
          annotations.push({
            key,
            classification: 'already-on-main',
            detail: 'identical annotation already on main',
            value: queueValue,
          });
          continue;
        }
        annotations.push({
          key,
          classification: 'safe-request',
          detail:
            mainValue === undefined ? 'new annotation key' : 'annotation value differs from main',
          value: queueValue,
        });
      }
    }

    const summary: Record<QueueEntryClassification, number> = {
      'already-on-main': 0,
      'safe-request': 0,
      'naming-migration-conflict': 0,
      'invalid-pair': 0,
      'requires-human': 0,
    };
    for (const group of classified) summary[group.classification] += 1;
    for (const delta of annotations) summary[delta.classification] += 1;

    return {
      version: 1,
      baseSha,
      queueTipSha,
      groups: classified,
      annotations,
      unclassifiedPaths: unclassified,
      summary,
    };
  } finally {
    for (const worktree of worktrees) {
      await deps
        .exec('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot, env: deps.env })
        .catch(() => undefined);
    }
    await deps
      .exec('git', ['worktree', 'prune'], { cwd: repoRoot, env: deps.env })
      .catch(() => undefined);
    await deps.removeDir(temp).catch(() => undefined);
  }
}

async function showBlob(
  deps: MaterializeDeps,
  repoRoot: string,
  rev: string,
  repoPath: string,
): Promise<string | null> {
  const result = await deps.exec('git', ['show', `${rev}:${repoPath}`], {
    cwd: repoRoot,
    env: deps.env,
  });
  return result.code === 0 ? result.stdout : null;
}

async function classifyGroup(
  deps: MaterializeDeps,
  repoRoot: string,
  manifestKey: string,
  paths: readonly string[],
  baseSha: string,
  queueTipSha: string,
  queueWorktree: string,
  contentIndex: ReadonlyMap<string, string[]>,
): Promise<QueueAssetGroup> {
  const pngRepoPath = `${PNG_PREFIX}${manifestKey}.png`;
  const shardRepoPath = `${SHARD_PREFIX}${manifestKey}.json`;
  const assetPath = `generated/${manifestKey}.png`;

  const queuePng = await blobAt(deps, repoRoot, queueTipSha, pngRepoPath);
  const queueShard = await blobAt(deps, repoRoot, queueTipSha, shardRepoPath);
  const mainPng = await blobAt(deps, repoRoot, baseSha, pngRepoPath);
  const mainShard = await blobAt(deps, repoRoot, baseSha, shardRepoPath);

  const base = {
    manifestKey,
    assetPath: queuePng === null ? null : assetPath,
    paths,
    contentHash: null as string | null,
    briefId: null as string | null,
    variantIndex: null as number | null,
    sourceRun: null as string | null,
  };

  if (queuePng === null && queueShard === null) {
    return {
      ...base,
      classification: 'requires-human',
      detail:
        'present on main but deleted on the queue tip; a deletion requires an explicit ' +
        'source-bound removal proof',
    };
  }
  if (queuePng === null || queueShard === null) {
    return {
      ...base,
      classification: 'invalid-pair',
      detail:
        queuePng === null
          ? 'shard has no PNG on the queue tip'
          : 'PNG has no manifest shard on the queue tip',
    };
  }
  if (queuePng === mainPng && queueShard === mainShard) {
    return {
      ...base,
      classification: 'already-on-main',
      detail: 'identical bytes already on main',
    };
  }

  let shard: Record<string, unknown>;
  try {
    shard = JSON.parse(
      await deps.readTextFile(deps.joinPath(queueWorktree, ...shardRepoPath.split('/'))),
    ) as Record<string, unknown>;
  } catch (error) {
    return {
      ...base,
      classification: 'invalid-pair',
      detail: `shard is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const bytes = await deps.readFileBytes(deps.joinPath(queueWorktree, ...pngRepoPath.split('/')));
  const contentHash = sha256Bytes(bytes);
  const briefId = typeof shard.briefId === 'string' ? shard.briefId : null;
  const variantIndex = typeof shard.variantIndex === 'number' ? shard.variantIndex : null;
  const sourceRun = typeof shard.sourceRun === 'string' ? shard.sourceRun : null;
  const enriched = { ...base, contentHash, briefId, variantIndex, sourceRun };

  if (shard.assetPath !== assetPath) {
    return {
      ...enriched,
      classification: 'invalid-pair',
      detail: `shard points at "${String(shard.assetPath)}" but the PNG lives at "${assetPath}"`,
    };
  }
  if (typeof shard.contentHash === 'string' && shard.contentHash !== contentHash) {
    return {
      ...enriched,
      classification: 'invalid-pair',
      detail: `shard declares contentHash ${shard.contentHash} but the PNG hashes to ${contentHash}`,
    };
  }
  if (briefId === null || variantIndex === null) {
    return {
      ...enriched,
      classification: 'invalid-pair',
      detail: 'shard is missing the canonical briefId/variantIndex identity',
    };
  }

  const twins = (contentIndex.get(contentHash) ?? []).filter((p) => p !== pngRepoPath);
  if (twins.length > 0) {
    return {
      ...enriched,
      classification: 'naming-migration-conflict',
      detail: `identical bytes already live on main at [${twins.join(', ')}] under a different name`,
    };
  }
  if (mainPng !== null && mainPng !== queuePng) {
    return {
      ...enriched,
      classification: 'requires-human',
      detail: 'main carries DIFFERENT bytes at this path; replacing them needs explicit approval',
    };
  }
  return {
    ...enriched,
    classification: 'safe-request',
    detail:
      mainPng === null ? 'new asset absent from main' : 'shard-only update over identical PNG',
  };
}

/** Stable JSON rendering of the report (sorted keys, trailing newline). */
export function renderMigrationReport(report: QueueMigrationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
