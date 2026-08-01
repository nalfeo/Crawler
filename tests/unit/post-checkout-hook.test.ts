import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toBashScriptPath } from '../helpers/bash-script-path.js';

/**
 * Regression tests for `.githooks/post-checkout`.
 *
 * The hook auto-creates a `node_modules` junction/symlink in new git worktrees
 * so commands work immediately without waiting for preflight to react.
 * These tests exercise the real hook script through throwaway repositories to
 * catch regressions in path resolution, argument handling, and all documented
 * no-op cases.
 *
 * Pattern follows `tests/unit/local-scope.test.ts` for real-shell tests.
 */

const HOOK_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.githooks/post-checkout',
);

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasWorktree = spawnSync('git', ['worktree', 'list']).status === 0;

const tempDirs: string[] = [];

/**
 * Removes a directory tree, retrying on EBUSY/EPERM/ENOTEMPTY.
 * On Windows, a just-exited WSL bash child can leave the directory transiently
 * locked — a real async retry loop is needed (see local-scope.test.ts).
 */
async function rmDirWithRetry(dir: string, attempts = 15, delayMs = 300): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (attempt === attempts || !retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rmDirWithRetry(dir);
  }
});

interface MainRepo {
  dir: string;
  hookPath: string;
  git: (...args: string[]) => string;
  write: (relPath: string, content: string) => void;
}

/**
 * Builds a throwaway main git repo with the `post-checkout` hook installed
 * via `core.hooksPath .githooks` and one seed commit.
 */
function makeMainRepo(): MainRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'post-checkout-'));
  tempDirs.push(dir);

  const git = (...args: string[]): string => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`);
    }
    return res.stdout;
  };

  const write = (relPath: string, content: string): void => {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Post-Checkout Test');
  git('config', 'commit.gpgsign', 'false');

  // Install the hook from source
  mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  const hookContent = readFileSync(HOOK_SRC, 'utf8');
  const hookDest = path.join(dir, '.githooks', 'post-checkout');
  writeFileSync(hookDest, hookContent, { mode: 0o755 });
  git('config', 'core.hooksPath', '.githooks');

  write('README.md', '# seed\n');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');

  return { dir, hookPath: hookDest, git, write };
}

describe('.githooks/post-checkout worktree node_modules hook', () => {
  it('resolves bash and git worktree (prerequisites)', () => {
    expect(hasBash).toBe(true);
    expect(hasWorktree).toBe(true);
  });

  it.skipIf(!hasBash || !hasWorktree)(
    'creates a symlink in a new worktree when main has node_modules',
    () => {
      const { dir, git } = makeMainRepo();
      mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'dummy.txt'), 'pkg');

      const wtDir = mkdtempSync(path.join(tmpdir(), 'post-checkout-wt-'));
      tempDirs.push(wtDir);
      git('worktree', 'add', '--detach', wtDir, 'HEAD');

      const nmPath = path.join(wtDir, 'node_modules');
      expect(existsSync(nmPath)).toBe(true);
      expect(lstatSync(nmPath).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(!hasBash || !hasWorktree)(
    'no-op when main has no node_modules — exits cleanly without creating symlink',
    () => {
      const { git } = makeMainRepo();
      // Main repo intentionally has no node_modules.

      const wtDir = mkdtempSync(path.join(tmpdir(), 'post-checkout-wt-'));
      tempDirs.push(wtDir);
      git('worktree', 'add', '--detach', wtDir, 'HEAD');

      expect(existsSync(path.join(wtDir, 'node_modules'))).toBe(false);
    },
  );

  it.skipIf(!hasBash || !hasWorktree)(
    'no-op when node_modules already exists in the worktree — does not overwrite',
    () => {
      const { dir, git, hookPath } = makeMainRepo();
      mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'dummy.txt'), 'pkg');

      const wtDir = mkdtempSync(path.join(tmpdir(), 'post-checkout-wt-'));
      tempDirs.push(wtDir);
      git('worktree', 'add', '--detach', wtDir, 'HEAD');

      const nmPath = path.join(wtDir, 'node_modules');
      expect(existsSync(nmPath)).toBe(true);
      const beforeIno = lstatSync(nmPath).ino;

      // Invoke the hook again in the same worktree (simulates a second branch checkout)
      const res = spawnSync('bash', [toBashScriptPath(hookPath), 'HEAD', 'HEAD', '1'], {
        cwd: wtDir,
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      // Existing node_modules should be unchanged
      expect(lstatSync(nmPath).ino).toBe(beforeIno);
    },
  );

  it.skipIf(!hasBash || !hasWorktree)(
    'no-op when checkout-type is 0 (file checkout, not branch) — does not create symlink',
    () => {
      const { dir, git, hookPath } = makeMainRepo();
      mkdirSync(path.join(dir, 'node_modules'), { recursive: true });

      const wtDir = mkdtempSync(path.join(tmpdir(), 'post-checkout-wt-'));
      tempDirs.push(wtDir);
      git('worktree', 'add', '--detach', wtDir, 'HEAD');

      // Remove the symlink created by worktree add so we can test the file-checkout gate
      const nmPath = path.join(wtDir, 'node_modules');
      rmSync(nmPath, { recursive: true, force: true });

      // Invoke hook with checkout-type=0 (file checkout)
      const res = spawnSync('bash', [toBashScriptPath(hookPath), 'HEAD', 'HEAD', '0'], {
        cwd: wtDir,
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(existsSync(nmPath)).toBe(false);
    },
  );

  it.skipIf(!hasBash || !hasWorktree)(
    'no-op when invoked in the main worktree itself — does not touch existing node_modules',
    () => {
      const { dir, hookPath } = makeMainRepo();
      mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'dummy.txt'), 'pkg');

      const beforeStat = lstatSync(path.join(dir, 'node_modules'));

      // Invoke the hook with CWD = main repo (not a worktree)
      const res = spawnSync('bash', [toBashScriptPath(hookPath), 'HEAD', 'HEAD', '1'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);

      // node_modules should remain an ordinary directory, not converted to a symlink
      const afterStat = lstatSync(path.join(dir, 'node_modules'));
      expect(afterStat.isSymbolicLink()).toBe(false);
      expect(afterStat.isDirectory()).toBe(true);
      expect(afterStat.ino).toBe(beforeStat.ino);
    },
  );
});
