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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Exec } from './checkin.js';
import { copyArtSurface, makeCheckinFileLock, realExec } from './checkin-runtime.js';
import type { QueueCommitDeps, SpriteAnnotationUpdate } from './queue-commit.js';

/**
 * Hard deadline for any single git subprocess a queue-commit spawns. A
 * fetch/push against `origin` completes in seconds on a dev box; a minute-plus
 * wall means git is wedged (classically: blocked on a credential prompt) and
 * must be killed so the sidecar mutation lock / editor save never hangs forever.
 */
const GIT_SUBPROCESS_TIMEOUT_MS = 120_000;
const ANNOTATIONS_RELATIVE_PATH = 'public/assets/generated/sprite-editor-annotations.json';

/**
 * Merge annotation updates into the destination queue-tip document by sprite
 * key. The caller's aggregate is never copied, so two stale worktrees editing
 * different sprites cannot erase each other.
 */
export async function mergeSpriteAnnotationUpdates(
  worktree: string,
  updates: readonly SpriteAnnotationUpdate[],
): Promise<void> {
  const target = path.join(worktree, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  let document: { version: 1; sprites: Record<string, unknown> } = { version: 1, sprites: {} };
  if (existsSync(target)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'));
    } catch (error) {
      throw new Error(
        `${ANNOTATIONS_RELATIVE_PATH} is invalid JSON on the queue tip: ${
          error instanceof Error ? error.message : String(error)
        }. Repair the queue file, then retry the Sprite Editor save.`,
        { cause: error },
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { sprites?: unknown }).sprites !== 'object' ||
      (parsed as { sprites?: unknown }).sprites === null ||
      Array.isArray((parsed as { sprites?: unknown }).sprites)
    ) {
      throw new Error(
        `${ANNOTATIONS_RELATIVE_PATH} must contain an object-valued "sprites" map. Repair the queue file, then retry the Sprite Editor save.`,
      );
    }
    document = {
      version: 1,
      sprites: { ...((parsed as { sprites: Record<string, unknown> }).sprites ?? {}) },
    };
  }
  for (const update of updates) {
    document.sprites[update.key] = {
      favorite: update.favorite,
      disliked: update.disliked,
      comment: update.comment,
    };
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Force git fully non-interactive so a missing/expired credential fails fast
 * instead of blocking on a terminal or GUI prompt (which, headless, hangs
 * indefinitely), and pin the locale so the push-rejection porcelain the
 * retry/CAS classifier matches is always English. `GIT_ASKPASS` is forced
 * EMPTY (not merely defaulted) because an inherited GUI askpass helper would
 * still be invoked despite `GIT_TERMINAL_PROMPT=0`. `GIT_OPTIONAL_LOCKS=0`
 * avoids incidental index-lock contention across the concurrent worktrees this
 * flow creates.
 */
function nonInteractiveGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    // Pin porcelain to English: `isNonFastForwardRejection` keys on git's
    // rejection phrases, which git otherwise localizes per LC_MESSAGES/LANG.
    LC_ALL: 'C',
    LANG: 'C',
  };
}

/** Build the production `QueueCommitDeps` for a given repo root. */
export function createDefaultQueueCommitDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): QueueCommitDeps {
  const gitEnv = nonInteractiveGitEnv(env);
  // Every git call goes through the shared realExec but with a non-interactive
  // env and a hard deadline injected, so no queue-commit git subprocess can hang
  // the caller. A caller-supplied env/timeout still wins (none do today).
  const exec: Exec = (command, args, options) =>
    realExec(command, args, {
      ...options,
      env: options?.env ?? gitEnv,
      timeoutMs: options?.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS,
    });
  return {
    exec,
    copyArtSurface,
    mergeSpriteAnnotations: mergeSpriteAnnotationUpdates,
    copyBriefFiles: async (sourceRoot, worktree, briefPaths) => {
      for (const briefPath of briefPaths) {
        const src = path.join(sourceRoot, ...briefPath.split('/'));
        const dst = path.join(worktree, ...briefPath.split('/'));
        mkdirSync(path.dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }
    },
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-queue-commit-'))),
    removeDir: async (dir) => {
      // rmSync can throw EPERM on Windows while git still briefly holds a lock on
      // the just-removed worktree dir. Retry with backoff, then give up quietly:
      // cleanup is best-effort (OS temp reaping is the backstop) and must never
      // surface — the caller's `finally` also swallows throws, but resilience
      // here keeps real leaks rare.
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
    env,
  };
}
