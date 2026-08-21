/**
 * Real (production) wiring for the immutable asset-request primitives.
 *
 * Kept separate from `manifest.ts` / `publish.ts` / `reconcile.ts` (all IO-free
 * or dependency-injected) so those modules never import node `fs`/`child_process`
 * and stay unit-testable against temp git repos.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Exec } from '../checkin.js';
import { realExec } from '../checkin-runtime.js';
import type { PublishRequestDeps } from './publish.js';
import type { MaterializeDeps } from './reconcile.js';

/** Hard deadline for any single git subprocess these primitives spawn. */
const GIT_SUBPROCESS_TIMEOUT_MS = 120_000;

/**
 * Force git fully non-interactive (a missing credential must fail fast rather
 * than block on a prompt) and pin the locale so rejection porcelain is stable.
 */
export function nonInteractiveGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

function makeExec(env: NodeJS.ProcessEnv): Exec {
  return (command, args, options) =>
    realExec(command, args, {
      ...options,
      env: options?.env ?? env,
      timeoutMs: options?.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS,
    });
}

function removeDirWithRetry(dir: string): Promise<void> {
  // rmSync can throw EPERM on Windows while git still briefly holds a lock on a
  // just-removed worktree. Cleanup is best-effort — OS temp reaping backstops it.
  return (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        if (attempt === 4) return;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  })();
}

function writeTextFile(absolutePath: string, contents: string): Promise<void> {
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  return Promise.resolve();
}

/** Production deps for `publishAssetRequest`. */
export function createDefaultPublishDeps(env: NodeJS.ProcessEnv = process.env): PublishRequestDeps {
  const gitEnv = nonInteractiveGitEnv(env);
  return {
    exec: makeExec(gitEnv),
    readFileBytes: (absolutePath) => Promise.resolve(readFileSync(absolutePath)),
    writeTextFile,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-request-publish-'))),
    removeDir: removeDirWithRetry,
    joinPath: (...segments) => path.join(...segments),
    env: gitEnv,
  };
}

/** Production deps for `materializeAssetRequests` / `archiveConsumedRequests`. */
export function createDefaultMaterializeDeps(
  env: NodeJS.ProcessEnv = process.env,
): MaterializeDeps {
  const gitEnv = nonInteractiveGitEnv(env);
  return {
    exec: makeExec(gitEnv),
    makeTempDir: () =>
      Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-request-reconcile-'))),
    removeDir: removeDirWithRetry,
    readFileBytes: (absolutePath) => Promise.resolve(readFileSync(absolutePath)),
    readTextFile: (absolutePath) => Promise.resolve(readFileSync(absolutePath, 'utf8')),
    writeTextFile,
    copyFile: (source, destination) => {
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      return Promise.resolve();
    },
    removeFile: (absolutePath) => {
      rmSync(absolutePath, { force: true });
      return Promise.resolve();
    },
    pathExists: (absolutePath) => Promise.resolve(existsSync(absolutePath)),
    joinPath: (...segments) => path.join(...segments),
    env: gitEnv,
  };
}
