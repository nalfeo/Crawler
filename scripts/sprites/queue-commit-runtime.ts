/**
 * Real (production) wiring for `runQueueCommit` — the exec runner, temp-dir/fs
 * hooks, and cross-process lock. Reuses the exact same `realExec`,
 * `copyArtSurface`, and `makeCheckinFileLock` implementations the check-in flow
 * uses, so the merge semantics AND the cross-process serialization are shared:
 * the sidecar approve route, the approve CLI, and the canvas editor's CLI
 * subprocess all contend for one repo-scoped lock and never race.
 *
 * Kept separate from `queue-commit.ts` (IO-free, unit-tested) so that module
 * never imports node fs/child_process.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyArtSurface, makeCheckinFileLock, realExec } from './checkin-runtime.js';
import type { QueueCommitDeps } from './queue-commit.js';

/** Build the production `QueueCommitDeps` for a given repo root. */
export function createDefaultQueueCommitDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): QueueCommitDeps {
  return {
    exec: realExec,
    copyArtSurface,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-queue-commit-'))),
    removeDir: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
    withCrossProcessLock: makeCheckinFileLock(repoRoot),
    env,
  };
}
