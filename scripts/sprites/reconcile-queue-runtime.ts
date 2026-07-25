/**
 * Real (production) wiring for `runReconcile` — the exec runner, temp-dir/fs
 * hooks, cross-process lock, and clock. Reuses the exact same `realExec` and
 * `makeCheckinFileLock` implementations the check-in / queue-commit flows use,
 * so a reconcile cycle and a concurrent dev-box queue-commit contend for one
 * repo-scoped lock and never race on fetch/worktree/ref operations.
 *
 * Kept separate from `reconcile-queue.ts` (IO-free, unit-tested) so that module
 * never imports node fs/child_process/os.
 *
 * The reconciler runs in CI (the hourly workflow) rather than on the dev box, so
 * — unlike the queue-commit primitive — it deliberately does NOT refuse under
 * `process.env.CI`. Running in CI is the entire point.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Exec } from './checkin.js';
import { makeCheckinFileLock, realExec } from './checkin-runtime.js';
import type { ReconcileDeps } from './reconcile-queue.js';

/**
 * Hard deadline for any single git/gh subprocess the reconciler spawns. A fetch/
 * push against `origin` or a `gh` API call completes in seconds; a minute-plus
 * wall means the subprocess is wedged (classically: git blocked on a credential
 * prompt) and must be killed so the cron job fails fast instead of hanging the
 * runner.
 */
const SUBPROCESS_TIMEOUT_MS = 120_000;

/**
 * Force git fully non-interactive so a missing/expired credential fails fast
 * instead of blocking on a prompt (which, headless, hangs indefinitely), and pin
 * the locale so any porcelain we key on is English. Mirrors the queue-commit
 * primitive's env exactly. `gh` inherits the same env, which is harmless.
 */
function nonInteractiveGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
  };
}

/** Build the production `ReconcileDeps` for a given repo root. */
export function createDefaultReconcileDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ReconcileDeps {
  const gitEnv = nonInteractiveGitEnv(env);
  // Every git/gh call goes through the shared realExec with a non-interactive env
  // and a hard deadline injected, so no reconcile subprocess can hang the runner.
  const exec: Exec = (command, args, options) =>
    realExec(command, args, {
      ...options,
      env: options?.env ?? gitEnv,
      timeoutMs: options?.timeoutMs ?? SUBPROCESS_TIMEOUT_MS,
    });
  return {
    exec,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-queue-reconcile-'))),
    removeDir: async (dir) => {
      // rmSync can throw EPERM on Windows while git still briefly holds a lock on
      // the just-removed worktree dir. Retry with backoff, then give up quietly:
      // cleanup is best-effort (OS temp reaping is the backstop) and must never
      // surface — the caller's `finally` also swallows throws.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          if (attempt === 4) return;
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    },
    withCrossProcessLock: makeCheckinFileLock(repoRoot),
    now: () => new Date(),
    env,
  };
}
