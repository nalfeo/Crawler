import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toBashScriptPath } from '../helpers/bash-script-path.js';

/**
 * Deterministic coverage for `scripts/agent/ci/merge-scope.sh`, the predicate
 * that decides whether verify-fast.sh runs the silent merge-revert guard
 * locally.
 *
 * Why this matters: the silent-revert guard is authoritative in CI but only on
 * `pull_request`, which made it purely post-hoc — PR #2022 silently discarded
 * Don Paco boss-ability rows and PR #2365 silently discarded an upstream
 * `test-only-exports.ts` wrapper, and a human had to notice both. Running the
 * guard the moment a merge commit is created closes that window.
 *
 * The safety-critical invariants asserted here:
 *   - a branch with NO merge commit reports has_merge=false (linear work pays
 *     nothing for the guard)
 *   - a branch WITH a merge commit reports has_merge=true (the guard runs)
 *   - a shallow clone reports can_run=false, so the caller SKIPS rather than
 *     inheriting the guard's fail-closed exit 2 for a mere tooling state
 *   - an unresolvable base reports can_run=false for the same reason
 *   - the classifier never exits non-zero, so it can never break verify:fast
 */

const SCRIPT = toBashScriptPath(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../scripts/agent/ci/merge-scope.sh',
  ),
);

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

const tempDirs: string[] = [];

/**
 * Removes a directory tree, retrying on EBUSY/EPERM/ENOTEMPTY. On Windows a
 * just-exited WSL `bash.exe` interop child leaves its working directory
 * transiently locked; `rmSync`'s own retries do not cover a busy top-level
 * `rmdir`, so a real async wait-and-retry loop is required. No-op fast path on
 * POSIX.
 */
async function rmDirWithRetry(dir: string, attempts = 15, delayMs = 300): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (attempt === attempts || !retryable) {
        throw err;
      }
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

interface Scope {
  has_merge: boolean;
  can_run: boolean;
  base_ref: string;
}

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (relPath: string, content: string, message: string) => void;
  scope: () => Scope;
}

function makeRepo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-scope-'));
  tempDirs.push(dir);

  const git = (...args: string[]): string => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`);
    }
    return res.stdout;
  };

  const commit = (relPath: string, content: string, message: string): void => {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    git('add', relPath);
    git('commit', '-q', '-m', message);
  };

  const scope = (): Scope => {
    const res = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env } as NodeJS.ProcessEnv,
    });
    // The classifier must never fail: verify-fast.sh consumes its stdout and a
    // non-zero exit would take the whole fast gate down with it.
    expect(res.status).toBe(0);
    const readBool = (key: 'has_merge' | 'can_run'): boolean => {
      const m = res.stdout.match(new RegExp(`^${key}=(true|false)$`, 'm'));
      if (!m) throw new Error(`missing '${key}' in output:\n${res.stdout}`);
      return m[1] === 'true';
    };
    const baseMatch = res.stdout.match(/^base_ref=(.*)$/m);
    if (!baseMatch) throw new Error(`missing 'base_ref' in output:\n${res.stdout}`);
    return {
      has_merge: readBool('has_merge'),
      can_run: readBool('can_run'),
      base_ref: baseMatch[1] ?? '',
    };
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  commit('README.md', 'base\n', 'base');

  return { dir, git, commit, scope };
}

describe.runIf(hasBash && hasGit)('merge-scope.sh', () => {
  it('reports has_merge=false for a linear feature branch', () => {
    const repo = makeRepo();
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('src/a.ts', 'export const a = 1;\n', 'feat: a');
    repo.commit('src/b.ts', 'export const b = 2;\n', 'feat: b');

    expect(repo.scope()).toEqual({ has_merge: false, can_run: true, base_ref: 'main' });
  });

  it('reports has_merge=false on main itself (no commits ahead of base)', () => {
    const repo = makeRepo();

    expect(repo.scope()).toEqual({ has_merge: false, can_run: true, base_ref: 'main' });
  });

  it('reports has_merge=true once the branch merges main back in', () => {
    const repo = makeRepo();
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('src/a.ts', 'export const a = 1;\n', 'feat: a');

    repo.git('checkout', '-q', 'main');
    repo.commit('src/upstream.ts', 'export const u = 1;\n', 'feat: upstream');

    repo.git('checkout', '-q', 'feature');
    repo.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main into feature');

    expect(repo.scope()).toEqual({ has_merge: true, can_run: true, base_ref: 'main' });
  });

  it('reports has_merge=true for a merge that resolved a real conflict', () => {
    const repo = makeRepo();
    repo.commit('src/shared.ts', 'export const shared = "base";\n', 'feat: shared');

    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('src/shared.ts', 'export const shared = "feature";\n', 'feat: feature edit');

    repo.git('checkout', '-q', 'main');
    repo.commit('src/shared.ts', 'export const shared = "upstream";\n', 'feat: upstream edit');

    repo.git('checkout', '-q', 'feature');
    // Conflicted merge resolved by taking one side wholesale — precisely the
    // shape that produced the silent reverts this gate exists to catch.
    spawnSync('git', ['merge', '--no-ff', 'main'], { cwd: repo.dir, encoding: 'utf8' });
    repo.git('checkout', '--ours', 'src/shared.ts');
    repo.git('add', 'src/shared.ts');
    repo.git('commit', '-q', '--no-edit');

    expect(repo.scope()).toEqual({ has_merge: true, can_run: true, base_ref: 'main' });
  });

  it('reports can_run=false for a shallow clone rather than failing', () => {
    const origin = makeRepo();
    origin.commit('src/a.ts', 'export const a = 1;\n', 'feat: a');

    const dir = mkdtempSync(path.join(tmpdir(), 'merge-scope-shallow-'));
    tempDirs.push(dir);
    const clone = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${origin.dir}`, dir], {
      encoding: 'utf8',
    });
    expect(clone.status).toBe(0);

    const res = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('has_merge=false');
    expect(res.stdout).toContain('can_run=false');
    expect(res.stdout).toContain('base_ref=');
  });

  it('reports can_run=false when no mainline base resolves', () => {
    const repo = makeRepo();
    // Rename the only mainline branch away so neither origin/main nor main
    // resolves: the guard cannot compute a base, so it must be skipped, not run.
    repo.git('branch', '-m', 'main', 'unrelated-trunk');

    expect(repo.scope()).toEqual({ has_merge: false, can_run: false, base_ref: '' });
  });

  it('reports can_run=false outside a git work tree', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'merge-scope-nogit-'));
    tempDirs.push(dir);

    const res = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      // `git rev-parse --is-inside-work-tree` walks upward, so a temp dir under
      // a git-managed /tmp would otherwise resolve. Force the negative case.
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('can_run=false');
    expect(res.stdout).toContain('base_ref=');
  });

  it('prefers origin/main over local main when both resolve', () => {
    const origin = makeRepo();
    origin.commit('src/upstream.ts', 'export const upstream = 1;\n', 'feat: upstream');

    const dir = mkdtempSync(path.join(tmpdir(), 'merge-scope-origin-'));
    tempDirs.push(dir);
    const clone = spawnSync('git', ['clone', '-q', `file://${origin.dir}`, dir], {
      encoding: 'utf8',
    });
    expect(clone.status).toBe(0);

    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'local.ts'), 'export const local = 1;\n');
    const add = spawnSync('git', ['add', 'src/local.ts'], { cwd: dir, encoding: 'utf8' });
    expect(add.status).toBe(0);
    const commit = spawnSync('git', ['commit', '-q', '-m', 'feat: local'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      } as NodeJS.ProcessEnv,
    });
    expect(commit.status).toBe(0);

    const checkout = spawnSync('git', ['checkout', '-q', '-b', 'feature'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(checkout.status).toBe(0);

    const res = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('base_ref=origin/main');
  });
});
