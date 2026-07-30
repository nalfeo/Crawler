/**
 * Real (production) wiring for `runAssetCheckin` — the exec runner + fs hooks.
 * Shared by the `sprites:checkin` CLI and the sidecar's POST /api/checkin route
 * so both drive the exact same side-effect implementation.
 *
 * This module is intentionally separate from `checkin.ts` (which stays IO-free
 * for unit testing) and from `checkin-cli.ts` (which has an `invokedAsScript`
 * side effect on import).
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ASSET_CHECKIN_LABEL,
  CheckinError,
  type CheckinAsset,
  type CheckinManifest,
  type CheckinRunnerDeps,
  type Exec,
  type ExecResult,
  type QueuedAssetCheckin,
} from './checkin.js';
import { parseAssetIssueBody } from './asset-issues.js';
import { composeManifestFromShards, shardPathForKey } from './generated-shards.js';

export const realExec: Exec = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options?.cwd,
        maxBuffer: 16 * 1024 * 1024,
        // Default to the parent env so existing callers are unchanged; a caller
        // may override to inject a non-interactive git env.
        env: options?.env,
        // A `timeout` of 0/undefined means "no timeout" in child_process, so an
        // absent option preserves today's unbounded behavior.
        timeout: options?.timeoutMs,
      },
      (error, stdout, stderr) => {
        // A killed-on-timeout child reports `error.killed === true` (often with a
        // null exit code); normalize that to a non-zero code with a clear stderr
        // so callers see a failure instead of a spurious success.
        const killed = Boolean(error && (error as { killed?: unknown }).killed === true);
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        const timeoutNote =
          killed && options?.timeoutMs !== undefined
            ? `command timed out after ${options.timeoutMs}ms: ${command} ${args.join(' ')}`
            : '';
        resolve({
          stdout: String(stdout),
          stderr: timeoutNote ? `${timeoutNote}\n${String(stderr)}` : String(stderr),
          code,
        });
      },
    );
  });

/**
 * Copy ONLY `assets`' PNGs — plus their corresponding manifest/catalog
 * entries — from the live `srcRepoRoot` onto the freshly-checked-out worktree
 * `destRepoRoot`. This is a SELECTIVE projection, not a wholesale directory
 * copy: assets excluded from `assets` (already durably queued by another open
 * `asset-checkin` issue, or simply not part of this batch) must be absent from
 * the resulting branch diff so the branch content and the filed issue payload
 * stay aligned (see ADR 0066 / concern #2).
 *
 * Only the PNG and its per-asset manifest shard (`entries/<key>.json`) are
 * projected. The aggregate `manifest.json` is a gitignored build artifact and
 * the `generated:` sprite-catalog rows are derived at read-time, so neither is
 * written here — that is exactly what scopes a check-in's branch diff to the new
 * PNG(s) + their own shard(s), which never collide across disjoint check-ins.
 *
 * Concurrency semantics (accepted tradeoff — see ADR 0066 and the PR1
 * queue-commit ADR): this is a WHOLE-ASSET projection, not a field-level merge.
 * For a given manifest key it is last-writer-wins — both the PNG and the shard
 * are whole-file `cpSync` overlays replaced wholesale by the live source. When
 * the SAME key is edited concurrently from two stale worktrees, the second
 * durable commit's shard/PNG wins even if the first was newer; this is a valid
 * fast-forward push, so no data is corrupted, but a newer edit CAN be superseded
 * by an older one for that key. This matches the maintainer-accepted "manifest =
 * sole authority, whole-asset" design; a field-level/delta merge is deliberately
 * out of scope. The `same-key concurrent edits are last-writer-wins` regression
 * test documents and pins this behavior.
 */
export async function copyArtSurface(
  srcRepoRoot: string,
  destRepoRoot: string,
  assets: readonly CheckinAsset[],
): Promise<void> {
  // 1. Copy each approved PNG.
  for (const asset of assets) {
    const relSegments = asset.assetPath.split('/');
    const src = path.join(srcRepoRoot, 'public', 'assets', ...relSegments);
    if (!existsSync(src)) continue;
    const dest = path.join(destRepoRoot, 'public', 'assets', ...relSegments);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
  }

  // 2. Copy each asset's manifest shard (the sole committed source of truth).
  const srcGeneratedDir = path.join(srcRepoRoot, 'public', 'assets', 'generated');
  const destGeneratedDir = path.join(destRepoRoot, 'public', 'assets', 'generated');
  const manifestKeys = new Set(
    assets
      .map((asset) => asset.manifestKey)
      .filter((key): key is string => typeof key === 'string'),
  );
  for (const key of manifestKeys) {
    const srcShard = shardPathForKey(srcGeneratedDir, key);
    if (!existsSync(srcShard)) continue;
    const destShard = shardPathForKey(destGeneratedDir, key);
    mkdirSync(path.dirname(destShard), { recursive: true });
    cpSync(srcShard, destShard);
  }
}

function makeReadManifest(repoRoot: string): () => Promise<CheckinManifest> {
  return () => {
    // The aggregate manifest.json is a gitignored build artifact that may be
    // absent, so compose the read-model directly from the committed per-asset
    // shards (the source of truth).
    const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
    try {
      return Promise.resolve(composeManifestFromShards(generatedDir) as CheckinManifest);
    } catch {
      return Promise.resolve({});
    }
  };
}

/** One open `asset-checkin` issue's fields needed to build the queued-asset map. */
export interface QueuedIssueSource {
  readonly body: string;
  readonly issueUrl: string;
}

/**
 * Build the durable queued-asset map from open `asset-checkin` issues' raw
 * (body, url) pairs. Pure — no IO — so it is unit-testable without shelling
 * out to `gh`.
 *
 * When a path appears in more than one issue (or twice in the same issue):
 *   - If BOTH sides have a recorded hash AND the hashes are equal, the entries
 *     are genuinely identical — first-seen-wins, silent skip.
 *   - Otherwise (hashes differ, or either side's hash is absent) the queue is
 *     ambiguous: the entry is replaced with a hash-less sentinel so
 *     `reconcileQueuedContent` always returns 'ambiguous', failing closed.
 *     Silently keeping the first hash would misclassify a conflicting issue as
 *     a benign duplicate whenever the current asset content happens to match
 *     the first-seen hash — hiding the conflicting claim entirely.
 */
export function buildQueuedAssetMap(
  issues: readonly QueuedIssueSource[],
): ReadonlyMap<string, QueuedAssetCheckin> {
  const queued = new Map<string, QueuedAssetCheckin>();
  for (const issue of issues) {
    const payload = parseAssetIssueBody(issue.body);
    if (!payload) continue;
    for (const asset of payload.assets) {
      const existing = queued.get(asset.assetPath);
      if (existing !== undefined) {
        // A later entry claims the same path. Accept the skip only when BOTH
        // sides have a recorded hash AND they are equal — provably the same
        // content in two different issues (or duplicated within one issue).
        // Any other combination means the queue is ambiguous: strip the hash
        // from the existing entry so reconcileQueuedContent returns 'ambiguous'
        // for any incoming content, failing closed rather than silently
        // masking a genuine hash conflict.
        const isExactDuplicate =
          existing.contentHash !== undefined &&
          asset.contentHash !== undefined &&
          existing.contentHash === asset.contentHash;
        if (!isExactDuplicate && existing.contentHash !== undefined) {
          // Downgrade to hash-less sentinel (ambiguous).
          queued.set(asset.assetPath, { issueUrl: existing.issueUrl, branch: existing.branch });
        }
        // If existing already has no hash it already fails closed — no update.
        continue;
      }
      queued.set(asset.assetPath, {
        issueUrl: issue.issueUrl,
        branch: payload.branch,
        ...(asset.contentHash !== undefined ? { contentHash: asset.contentHash } : {}),
      });
    }
  }
  return queued;
}

function makeListQueuedAssets(
  repoRoot: string,
): () => Promise<ReadonlyMap<string, QueuedAssetCheckin>> {
  return async () => {
    const result = await realExec(
      'gh',
      [
        'issue',
        'list',
        '--label',
        ASSET_CHECKIN_LABEL,
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'body,url',
      ],
      { cwd: repoRoot },
    );
    if (result.code !== 0) {
      throw new CheckinError(
        'gh-failed',
        `Failed to list open ${ASSET_CHECKIN_LABEL} issues: ${result.stderr || result.stdout}`,
      );
    }

    let issues: unknown;
    try {
      issues = JSON.parse(result.stdout);
    } catch (error) {
      throw new CheckinError(
        'gh-failed',
        `Failed to parse open ${ASSET_CHECKIN_LABEL} issues: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!Array.isArray(issues)) {
      throw new CheckinError(
        'gh-failed',
        `Expected an array of open ${ASSET_CHECKIN_LABEL} issues.`,
      );
    }

    const sources: QueuedIssueSource[] = [];
    for (const issue of issues) {
      if (typeof issue !== 'object' || issue === null) continue;
      const body = (issue as { body?: unknown }).body;
      const issueUrl = (issue as { url?: unknown }).url;
      if (typeof body !== 'string' || typeof issueUrl !== 'string') continue;
      sources.push({ body, issueUrl });
    }
    return buildQueuedAssetMap(sources);
  };
}

/**
 * How long (ms) before an unrenewed lock is considered abandoned/crashed.
 * Must be comfortably longer than LOCK_HEARTBEAT_MS.
 */
const CHECKIN_LOCK_STALE_MS = 60_000;

/** How often (ms) the lock holder refreshes its ownership marker. */
const CHECKIN_LOCK_HEARTBEAT_MS = 10_000;

/**
 * Create a cross-process file lock for `runAssetCheckin` keyed by `repoRoot`.
 *
 * The lock is a directory (atomic exclusive mkdir) containing an owner file
 * that records a random token refreshed periodically by a heartbeat timer.
 * Different repositories can check in concurrently; concurrent calls for the
 * SAME repo are serialized.
 *
 * Stale-lock recovery: if the owner file's mtime is older than
 * CHECKIN_LOCK_STALE_MS (i.e. the holder crashed / was SIGKILL'd), the
 * contender atomically renames the lock directory to claim it, then removes
 * it and retries. This prevents a crashed process from permanently blocking
 * future check-ins without requiring manual file deletion.
 */
export function makeCheckinFileLock(repoRoot: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  const lockDir = path.join(tmpdir(), `asset-checkin-${hash}.lockdir`);

  function ownerFile(): string {
    return path.join(lockDir, 'owner');
  }

  function readToken(): string {
    try {
      return readFileSync(ownerFile(), 'utf8');
    } catch {
      return '';
    }
  }

  async function acquireLock(): Promise<string> {
    for (;;) {
      try {
        mkdirSync(lockDir); // atomic exclusive create — EEXIST if held
        const token = randomUUID();
        try {
          writeFileSync(ownerFile(), token);
        } catch (err) {
          rmSync(lockDir, { recursive: true, force: true });
          throw err;
        }
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

        // Lock held — reclaim if abandoned (mtime older than CHECKIN_LOCK_STALE_MS).
        try {
          const age = Date.now() - statSync(ownerFile()).mtimeMs;
          if (age >= CHECKIN_LOCK_STALE_MS) {
            const recovery = `${lockDir}.recovering.${randomUUID()}`;
            try {
              renameSync(lockDir, recovery); // atomic steal
              rmSync(recovery, { recursive: true, force: true });
              continue; // back to mkdirSync
            } catch {
              // Another process won the rename race — fall through to retry.
            }
          }
        } catch (statErr) {
          if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
            // Owner file missing (crash between mkdir and write); age the dir itself.
            try {
              const dirAge = Date.now() - statSync(lockDir).mtimeMs;
              if (dirAge >= CHECKIN_LOCK_STALE_MS) {
                const recovery = `${lockDir}.recovering.${randomUUID()}`;
                try {
                  renameSync(lockDir, recovery);
                  rmSync(recovery, { recursive: true, force: true });
                  continue;
                } catch {
                  // Another process won; retry normally.
                }
              }
            } catch {
              // Lock dir vanished between our create and stat — retry.
            }
          }
          // Other stat error — just retry.
        }

        // A live process holds the lock. Report a friendly error immediately
        // rather than spinning; the caller can retry.
        throw new CheckinError(
          'checkin-locked',
          'Another check-in is already in progress in this repository. ' +
            'Retry in a moment; stale locks auto-expire after 60 s.',
        );
      }
    }
  }

  function releaseLock(token: string, heartbeat: NodeJS.Timeout): void {
    clearInterval(heartbeat);
    try {
      if (readToken() === token) rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — stale locks are auto-reclaimed by the next acquirer.
    }
  }

  return async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const token = await acquireLock();
    // Use a const so the callback always has a stable reference for clearInterval;
    // we never set it to null inside the callback, eliminating the confusing
    // cross-scope mutation pattern.
    const heartbeat = setInterval(() => {
      try {
        // Stop refreshing if we no longer own the lock (e.g. reclaimed after a
        // crash) so we don't fight the new owner's heartbeat.
        if (readToken() !== token) {
          clearInterval(heartbeat);
          return;
        }
        writeFileSync(ownerFile(), token);
      } catch {
        // Best-effort heartbeat — ownership check before release is authoritative.
      }
    }, CHECKIN_LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await fn();
    } finally {
      releaseLock(token, heartbeat);
    }
  };
}

/** Build the production `CheckinRunnerDeps` for a given repo root. */
export function createDefaultCheckinDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckinRunnerDeps {
  return {
    exec: realExec,
    copyArtSurface,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-checkin-'))),
    removeDir: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
    readManifest: makeReadManifest(repoRoot),
    listQueuedAssets: makeListQueuedAssets(repoRoot),
    withCrossProcessLock: makeCheckinFileLock(repoRoot),
    env,
  };
}
