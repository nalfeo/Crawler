/**
 * Brief durability helpers (Phase 2: mirror / re-materialise).
 *
 * A generation run records the repo-relative path of the brief it was produced
 * from (`summary.json.briefPath`). Draft briefs live under the gitignored
 * `briefs/draft/**` tree, so a worktree checkpoint (or any `git clean`) can wipe
 * the local YAML while runs that reference it survive. These helpers give a
 * brief PATH-LEVEL durability by mirroring its bytes into the run store under a
 * stable, path-derived key (`workflowBriefKey`), and restoring them on demand.
 *
 * This is deliberately NOT a per-run brief snapshot: the store holds the latest
 * bytes for a given repo-relative path, keyed by that path. Two runs of the same
 * brief path share one mirrored copy; the last writer wins. That is sufficient
 * for the debugger/worker recovery use-cases and keeps the store small.
 *
 * The functions here own the fs + store I/O so they can be shared by the sidecar
 * server and the queue worker, and unit-tested directly. They must NOT move into
 * `sidecar/workflow-state.ts`, which is intentionally pure (key derivation only).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { workflowBriefKey } from './sidecar/workflow-state.js';
import type { RunStore } from './store/types.js';

/** Repo-relative POSIX path (forward slashes) for a repo-confined absolute path. */
export function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replace(/\\/g, '/');
}

/**
 * Whether a forward-slash-normalised repo-relative path (as produced by
 * `toRepoRelativePath`) stays inside the repo. Rejects parent escapes (`..`,
 * `../…`) and absolute paths — including Windows cross-drive (`D:/…`) and UNC
 * (`//server/…`) forms even when running on POSIX, by checking BOTH path
 * flavours. A leading `..foo` (no separator) is an ordinary child name and is
 * allowed — the previous `startsWith('..')` check wrongly rejected it.
 */
export function isRepoConfined(rel: string): boolean {
  if (rel === '..' || rel.startsWith('../')) return false;
  if (path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) return false;
  return true;
}

/**
 * Mirror a brief YAML file into the store under the `workflow-state/briefs/`
 * prefix, keyed by its repo-relative path. Best-effort: a mirror failure must
 * never fail the originating request — durability lagging is recoverable, a
 * 500 on synthesize/promote/generate is not.
 *
 * Idempotent: re-mirroring an unchanged brief re-writes identical bytes under
 * the same key, so it is safe to call from multiple sites (generate endpoint AND
 * worker) for the same path.
 */
export async function mirrorBriefToStore(
  store: RunStore,
  repoRoot: string,
  absPath: string,
): Promise<void> {
  try {
    const rel = toRepoRelativePath(repoRoot, absPath);
    if (!isRepoConfined(rel)) return;
    await store.put(workflowBriefKey(rel), readFileSync(absPath));
  } catch {
    // Swallow: the brief is still on disk for the current request; the next
    // synthesize/promote/generate will re-attempt the mirror.
  }
}

/**
 * Re-materialise a brief YAML file from the store back onto disk when the
 * local (gitignored) copy was wiped by a worktree checkpoint. Callers pass an
 * already repo-confined absolute path (validated via `resolveRepoPath`).
 *
 * Return / throw contract (relied on by the queue worker):
 * - `true`  — the brief is on disk afterwards (already present, or restored
 *             from the store).
 * - `false` — the brief is DEFINITELY unavailable: the path is not repo-confined
 *             or the store holds no mirrored copy. This is permanent; no retry
 *             can conjure the bytes, so the worker drops such a job immediately.
 * - THROWS  — the store or filesystem was unreachable/errored (a TRANSIENT
 *             failure). The worker lets this propagate so the job is retried,
 *             rather than mistaking a network blip for a missing brief. Sidecar
 *             read paths that only want best-effort degradation must wrap the
 *             call in try/catch (see `tryMaterialiseBrief` in server.ts).
 */
export async function materializeBriefFromStore(
  store: RunStore,
  repoRoot: string,
  absPath: string,
): Promise<boolean> {
  if (existsSync(absPath)) return true;
  const rel = toRepoRelativePath(repoRoot, absPath);
  if (!isRepoConfined(rel)) return false;
  const key = workflowBriefKey(rel);
  if (!(await store.has(key))) return false;
  const bytes = await store.get(key);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);
  return true;
}
