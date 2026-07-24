/**
 * Tests for the sprite-queue reconciler (`runReconcile`) — PR2 of the durable
 * asset-queue feature.
 *
 * Three layers:
 *   1. PURE-UNIT tests of the trust-boundary guard (`isArtSurfacePath`,
 *      `assertArtSurfaceOnly`) — the security-critical allowlist, including path
 *      traversal / absolute / backslash escape attempts.
 *   2. CONTROL-FLOW tests drive a fully-faked `exec` to assert the branchy logic
 *      that a mock proves best: the guard REJECTS a non-art staged path BEFORE
 *      any push/PR/arm (fail-closed ordering), the throwaway worktree is cleaned
 *      up on a mid-cycle throw, and the whole cycle runs inside the injected
 *      cross-process lock.
 *   3. REAL-GIT tests run the reconciler against a temp bare "origin" + live
 *      clone with a mocked `gh` (in-memory PR store) to prove the load-bearing
 *      claims a mock cannot: cold-start no-op, no-delta no-op, exactly ONE PR
 *      (no duplicate on re-run), the promote→main diff is art-surface-only by
 *      construction, the steady-state no-op after a squash-merge lands the art on
 *      main, and create-race reuse of an already-open PR.
 *
 * Deterministic: `gh`/network are mocked via injected exec; the clock is injected
 * (no `Date.now()` / `Math.random()`).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '../../../scripts/sprites/checkin.js';
import {
  assertArtSurfaceModes,
  assertArtSurfaceOnly,
  isArtSurfacePath,
  ReconcileError,
  runReconcile,
  type ReconcileDeps,
} from '../../../scripts/sprites/reconcile-queue.js';

const FIXED_NOW = new Date('2026-07-24T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Layer 1: pure-unit trust-boundary guard
// ---------------------------------------------------------------------------

describe('isArtSurfacePath', () => {
  it('accepts the catalog and generated art paths', () => {
    expect(isArtSurfacePath('src/shared/data/sprite-catalog.json')).toBe(true);
    expect(isArtSurfacePath('public/assets/generated/manifest.json')).toBe(true);
    expect(isArtSurfacePath('public/assets/generated/skull-mace-var-2.png')).toBe(true);
    expect(isArtSurfacePath('public/assets/generated/nested/deep.png')).toBe(true);
  });

  it('rejects paths outside the art surface', () => {
    expect(isArtSurfacePath('src/core/combat/damage.ts')).toBe(false);
    expect(isArtSurfacePath('package.json')).toBe(false);
    expect(isArtSurfacePath('.github/workflows/ci.yml')).toBe(false);
    // A prefix that is NOT a path-segment boundary must not match.
    expect(isArtSurfacePath('public/assets/generated-evil/x.png')).toBe(false);
    expect(isArtSurfacePath('src/shared/data/sprite-catalog.json.bak')).toBe(false);
  });

  it('rejects the bare generated directory path (type-change escape)', () => {
    // `git diff --name-only` reports the root path when a tree entry changes
    // type (dir → file/symlink). A directory surface must match DESCENDANTS
    // ONLY, never the bare directory itself, or a whole-directory replacement
    // would slip past the guard.
    expect(isArtSurfacePath('public/assets/generated')).toBe(false);
    // The catalog is a FILE surface and must still match exactly.
    expect(isArtSurfacePath('src/shared/data/sprite-catalog.json')).toBe(true);
  });

  it('rejects traversal, absolute, and backslash escapes', () => {
    expect(isArtSurfacePath('public/assets/generated/../../../etc/passwd')).toBe(false);
    expect(isArtSurfacePath('public/assets/generated/./x.png')).toBe(false);
    expect(isArtSurfacePath('/public/assets/generated/x.png')).toBe(false);
    expect(isArtSurfacePath('C:/public/assets/generated/x.png')).toBe(false);
    expect(isArtSurfacePath('public\\assets\\generated\\x.png')).toBe(false);
    expect(isArtSurfacePath('')).toBe(false);
    expect(isArtSurfacePath('   ')).toBe(false);
  });
});

describe('assertArtSurfaceOnly', () => {
  it('passes an all-art-surface diff through unchanged', () => {
    const paths = ['public/assets/generated/a.png', 'src/shared/data/sprite-catalog.json'];
    expect(assertArtSurfaceOnly(paths)).toEqual(paths);
  });

  it('throws untrusted-diff when ANY path is outside the allowlist', () => {
    const paths = ['public/assets/generated/a.png', 'src/core/combat/damage.ts'];
    try {
      assertArtSurfaceOnly(paths);
      throw new Error('expected assertArtSurfaceOnly to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReconcileError);
      expect((err as ReconcileError).kind).toBe('untrusted-diff');
      expect((err as ReconcileError).message).toContain('src/core/combat/damage.ts');
    }
  });
});

describe('assertArtSurfaceModes (mode-aware type-change guard)', () => {
  const raw = (dstMode: string, status: string, p: string, srcMode = '100644'): string =>
    `:${srcMode} ${dstMode} 1111111 2222222 ${status}\t${p}`;

  it('accepts added/modified regular files and deletions of art paths', () => {
    const stdout = [
      raw('100644', 'A', 'public/assets/generated/skull.png', '000000'),
      raw('100644', 'M', 'public/assets/generated/manifest.json'),
      raw('100644', 'M', 'src/shared/data/sprite-catalog.json'),
      raw('000000', 'D', 'public/assets/generated/old.png'), // deletion (dst mode 000000)
    ].join('\n');
    expect(() => assertArtSurfaceModes(stdout)).not.toThrow();
  });

  it('accepts empty output (no staged changes)', () => {
    expect(() => assertArtSurfaceModes('')).not.toThrow();
  });

  it('REJECTS a file → symlink type-change at an allowlisted path', () => {
    // `--name-only` would report only the path (which passes the allowlist); the
    // real payload is the mode flip to 120000 (symlink).
    const stdout = raw('100644', 'T', 'public/assets/generated/manifest.json').replace(
      '100644 100644',
      '100644 120000',
    );
    try {
      assertArtSurfaceModes(stdout);
      throw new Error('expected assertArtSurfaceModes to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReconcileError);
      expect((err as ReconcileError).kind).toBe('untrusted-diff');
      expect((err as ReconcileError).message).toContain('120000');
    }
  });

  it('REJECTS a gitlink/submodule (160000) at an allowlisted path', () => {
    const stdout = `:000000 160000 0000000 abc1234 A\tpublic/assets/generated/evil`;
    expect(() => assertArtSurfaceModes(stdout)).toThrowError(ReconcileError);
  });

  it('REJECTS an executable-bit (100755) regular file', () => {
    const stdout = raw('100755', 'A', 'public/assets/generated/run.png', '000000');
    expect(() => assertArtSurfaceModes(stdout)).toThrowError(ReconcileError);
  });

  it('REJECTS a non-art path even with a regular-file mode', () => {
    const stdout = raw('100644', 'A', 'src/core/combat/damage.ts', '000000');
    try {
      assertArtSurfaceModes(stdout);
      throw new Error('expected assertArtSurfaceModes to throw');
    } catch (err) {
      expect((err as ReconcileError).kind).toBe('untrusted-diff');
      expect((err as ReconcileError).message).toContain('src/core/combat/damage.ts');
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2: control-flow (faked exec)
// ---------------------------------------------------------------------------

interface FakeExecConfig {
  queueExists?: boolean;
  promoteExists?: boolean;
  artDelta?: readonly string[];
  stagedNames?: readonly string[];
  nothingStaged?: boolean;
  commitFails?: boolean;
}

/**
 * A faked `exec` that walks the happy-path git/gh sequence, honoring `config` to
 * inject a failure/branch at a chosen point. Records every call so tests can
 * assert ordering + which commands did/did not run.
 */
function makeFakeExec(config: FakeExecConfig): {
  exec: Exec;
  calls: Array<{ command: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const artDelta = config.artDelta ?? ['public/assets/generated/a.png'];
  const stagedNames = config.stagedNames ?? artDelta;
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd });
    const joined = args.join(' ');
    const respond = (partial: Partial<ExecResult>): Promise<ExecResult> =>
      Promise.resolve({ stdout: '', stderr: '', code: 0, ...partial });

    if (command === 'git') {
      if (args[0] === 'ls-remote' && joined.includes('assets/queue')) {
        return respond({
          stdout: config.queueExists === false ? '' : 'qsha\trefs/heads/assets/queue\n',
        });
      }
      if (args[0] === 'ls-remote' && joined.includes('assets/promote')) {
        return respond({ stdout: config.promoteExists ? 'psha\trefs/heads/assets/promote\n' : '' });
      }
      if (
        args[0] === 'diff' &&
        joined.includes('--name-only') &&
        joined.includes('origin/main origin/assets/queue')
      ) {
        return respond({ stdout: artDelta.join('\n') });
      }
      if (args[0] === 'diff' && joined.includes('--cached') && joined.includes('--quiet')) {
        return respond({ code: config.nothingStaged ? 0 : 1 });
      }
      if (args[0] === 'diff' && joined.includes('--cached') && joined.includes('--name-only')) {
        return respond({ stdout: stagedNames.join('\n') });
      }
      if (args[0] === 'commit') {
        return respond({
          code: config.commitFails ? 1 : 0,
          stderr: config.commitFails ? 'commit boom' : '',
        });
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return respond({ stdout: 'promotesha\n' });
      }
      if (args[0] === 'rev-parse') {
        return respond({ stdout: 'psha\n' });
      }
      return respond({});
    }
    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') {
        return respond({ stdout: '[]' });
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return respond({ stdout: 'https://github.com/o/r/pull/1\n' });
      }
      return respond({});
    }
    return respond({ code: 1, stderr: `unknown command ${command}` });
  };
  return { exec, calls };
}

function controlDeps(exec: Exec, overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    exec,
    makeTempDir: () => Promise.resolve('/tmp/fake-worktree'),
    removeDir: () => Promise.resolve(),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

describe('runReconcile (control-flow)', () => {
  it('cold-start: no-op without fetching when the queue branch is absent', async () => {
    const { exec, calls } = makeFakeExec({ queueExists: false });
    const result = await runReconcile('/repo', controlDeps(exec));
    expect(result.status).toBe('noop');
    // Only the initial ls-remote probe ran; no fetch, no worktree, no gh.
    expect(calls.some((c) => c.command === 'git' && c.args[0] === 'fetch')).toBe(false);
    expect(calls.some((c) => c.command === 'gh')).toBe(false);
  });

  it('no-op when the art-surface delta is empty', async () => {
    const { exec, calls } = makeFakeExec({ queueExists: true, artDelta: [] });
    const result = await runReconcile('/repo', controlDeps(exec));
    expect(result.status).toBe('noop');
    // Never staged a worktree or opened a PR.
    expect(calls.some((c) => c.command === 'git' && c.args[0] === 'worktree')).toBe(false);
    expect(calls.some((c) => c.command === 'gh')).toBe(false);
  });

  it('GUARD: rejects a non-art staged path BEFORE any commit/push/PR/arm', async () => {
    const { exec, calls } = makeFakeExec({
      queueExists: true,
      artDelta: ['public/assets/generated/a.png'],
      stagedNames: ['public/assets/generated/a.png', 'src/core/evil.ts'],
    });
    const removed: string[] = [];
    const deps = controlDeps(exec, { removeDir: (d) => (removed.push(d), Promise.resolve()) });

    await expect(runReconcile('/repo', deps)).rejects.toMatchObject({
      kind: 'untrusted-diff',
    });

    // Fail-closed ordering: NO commit, NO promote push, NO gh calls at all.
    expect(calls.some((c) => c.command === 'git' && c.args[0] === 'commit')).toBe(false);
    expect(
      calls.some(
        (c) =>
          c.command === 'git' &&
          c.args[0] === 'push' &&
          c.args.some((a) => a.includes('refs/heads/assets/promote')),
      ),
    ).toBe(false);
    expect(calls.some((c) => c.command === 'gh')).toBe(false);
    // The throwaway worktree was still cleaned up.
    expect(
      calls.some((c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove'),
    ).toBe(true);
    expect(removed).toContain('/tmp/fake-worktree');
  });

  it('cleans up the worktree when a mid-cycle git step throws', async () => {
    const { exec, calls } = makeFakeExec({ queueExists: true, commitFails: true });
    const removed: string[] = [];
    const deps = controlDeps(exec, { removeDir: (d) => (removed.push(d), Promise.resolve()) });

    await expect(runReconcile('/repo', deps)).rejects.toMatchObject({ kind: 'git-failed' });

    expect(
      calls.some((c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove'),
    ).toBe(true);
    expect(removed).toContain('/tmp/fake-worktree');
    // No push/PR after the failed commit.
    expect(
      calls.some(
        (c) =>
          c.command === 'git' &&
          c.args[0] === 'push' &&
          c.args.some((a) => a.includes('refs/heads/assets/promote')),
      ),
    ).toBe(false);
    expect(calls.some((c) => c.command === 'gh')).toBe(false);
  });

  it('runs the entire cycle inside the injected cross-process lock', async () => {
    const { exec } = makeFakeExec({ queueExists: false });
    let lockCalls = 0;
    let insideLock = false;
    let sawGitInsideLock = false;
    const deps = controlDeps(exec, {
      exec: (command, args, options) => {
        if (insideLock && command === 'git') sawGitInsideLock = true;
        return exec(command, args, options);
      },
      withCrossProcessLock: async (fn) => {
        lockCalls++;
        insideLock = true;
        try {
          return await fn();
        } finally {
          insideLock = false;
        }
      },
    });
    await runReconcile('/repo', deps);
    expect(lockCalls).toBe(1);
    expect(sawGitInsideLock).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 3: real git (temp bare origin + live clone, mocked gh)
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
]);

function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function toUrl(p: string): string {
  return p.split(path.sep).join('/');
}

function manifestPath(repo: string): string {
  return path.join(repo, 'public', 'assets', 'generated', 'manifest.json');
}
function catalogPath(repo: string): string {
  return path.join(repo, 'src', 'shared', 'data', 'sprite-catalog.json');
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

interface Repos {
  root: string;
  originDir: string;
  liveDir: string;
}

function setupRepos(): Repos {
  const root = mkdtempSync(path.join(tmpdir(), 'rq-git-'));
  const originDir = path.join(root, 'origin.git');
  const liveDir = path.join(root, 'live');
  mkdirSync(originDir);
  mkdirSync(liveDir);
  gitSync(originDir, 'init', '--bare', '-b', 'main');
  gitSync(liveDir, 'init', '-b', 'main');
  gitSync(liveDir, 'config', 'user.email', 'test@example.com');
  gitSync(liveDir, 'config', 'user.name', 'Reconcile Test');
  gitSync(liveDir, 'config', 'commit.gpgsign', 'false');
  gitSync(liveDir, 'remote', 'add', 'origin', toUrl(originDir));
  // Seed an art-free base on main so the queue branch's diff is art-only.
  writeJson(manifestPath(liveDir), { version: 1, entries: {} });
  writeJson(catalogPath(liveDir), []);
  gitSync(liveDir, 'add', '-A');
  gitSync(liveDir, 'commit', '--no-verify', '-m', 'base');
  gitSync(liveDir, 'push', 'origin', 'main');
  return { root, originDir, liveDir };
}

/** Push an art commit onto origin's assets/queue branch (built from origin/main). */
function seedQueueWithArt(liveDir: string, keys: readonly string[]): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-seed-'));
  try {
    // Base the queue on main so its non-art files match main (art-only diff).
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    mkdirSync(genDir, { recursive: true });
    const mPath = path.join(wt, 'public', 'assets', 'generated', 'manifest.json');
    const cPath = path.join(wt, 'src', 'shared', 'data', 'sprite-catalog.json');
    const manifest = readJson<{ version: number; entries: Record<string, unknown> }>(mPath);
    const catalog = readJson<Array<Record<string, unknown>>>(cPath);
    for (const key of keys) {
      writeFileSync(path.join(genDir, `${key}.png`), PNG_BYTES);
      manifest.entries[key] = { assetPath: `generated/${key}.png`, spriteName: key };
      catalog.push({ id: `generated:${key}`, kind: 'sprite', assetPath: `generated/${key}.png` });
    }
    writeJson(mPath, manifest);
    writeJson(cPath, catalog);
    gitSync(wt, 'add', '--', 'public/assets/generated', 'src/shared/data/sprite-catalog.json');
    gitSync(wt, 'commit', '--no-verify', '-m', `queue art: ${keys.join(', ')}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/assets/queue`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

/** Simulate a squash-merge of the promote branch into main + mark the PR merged. */
function simulateSquashMerge(liveDir: string, gh: FakeGh, prNumber: number): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/promote', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-merge-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    gitSync(
      wt,
      'checkout',
      'origin/assets/promote',
      '--',
      'public/assets/generated',
      'src/shared/data/sprite-catalog.json',
    );
    gitSync(wt, 'add', '--', 'public/assets/generated', 'src/shared/data/sprite-catalog.json');
    gitSync(wt, 'commit', '--no-verify', '-m', `squash merge #${prNumber}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/main`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
  const pr = gh.prs.find((p) => p.number === prNumber);
  if (pr) pr.state = 'merged';
}

interface FakePr {
  number: number;
  head: string;
  base: string;
  state: 'open' | 'merged' | 'closed';
  title: string;
  body: string;
  autoMerge: boolean;
  isCrossRepository: boolean;
}

/** In-memory `gh` PR store. `failCreateWhenExists` simulates the create-race. */
class FakeGh {
  prs: FakePr[] = [];
  next = 1;
  failCreateWhenExists = false;
  /**
   * When true, a `pr create` on a head/base with no existing open PR simulates a
   * concurrent writer having just opened one: it INSERTS the PR and then returns
   * an "already exists" failure. This exercises the create-fail → re-query →
   * reuse fallback path (the true create-race), unlike pre-seeding a PR before
   * the run (which the list-before-create finds first).
   */
  createRaceInsert = false;
  /** Pre-seed an open PR (used to exercise the create-race reuse path). */
  seedOpen(head: string, base: string, isCrossRepository = false): number {
    const number = this.next++;
    this.prs.push({
      number,
      head,
      base,
      state: 'open',
      title: '',
      body: '',
      autoMerge: false,
      isCrossRepository,
    });
    return number;
  }

  handle(args: readonly string[]): ExecResult {
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });
    const err = (stderr: string): ExecResult => ({ stdout: '', stderr, code: 1 });
    if (args[0] !== 'pr') return err(`unexpected gh ${args.join(' ')}`);
    const sub = args[1];
    const rest = args.slice(2);
    const flags: Record<string, string> = {};
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i]!;
      if (tok.startsWith('--')) {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[tok.slice(2)] = next;
          i++;
        } else {
          flags[tok.slice(2)] = 'true';
        }
      } else {
        positional.push(tok);
      }
    }

    if (sub === 'list') {
      // `gh pr list --head <branch>` matches by branch NAME across repos, so the
      // fake must surface cross-repo PRs too — the core is responsible for
      // discarding them via isCrossRepository.
      const matches = this.prs.filter(
        (p) => p.state === 'open' && p.head === flags.head && p.base === flags.base,
      );
      return ok(
        JSON.stringify(
          matches.map((p) => ({
            number: p.number,
            headRefName: p.head,
            isCrossRepository: p.isCrossRepository,
          })),
        ),
      );
    }
    if (sub === 'create') {
      const existing = this.prs.find(
        (p) =>
          p.state === 'open' &&
          p.head === flags.head &&
          p.base === flags.base &&
          !p.isCrossRepository,
      );
      if (existing && this.failCreateWhenExists) {
        return err(`a pull request for branch "${flags.head}" already exists`);
      }
      if (!existing && this.createRaceInsert) {
        // Simulate a concurrent writer opening the PR just before us: insert it,
        // then fail our create so the core falls back to re-query + reuse.
        this.prs.push({
          number: this.next++,
          head: flags.head!,
          base: flags.base!,
          state: 'open',
          title: flags.title ?? '',
          body: flags.body ?? '',
          autoMerge: false,
          isCrossRepository: false,
        });
        return err(`a pull request for branch "${flags.head}" already exists`);
      }
      const number = this.next++;
      this.prs.push({
        number,
        head: flags.head!,
        base: flags.base!,
        state: 'open',
        title: flags.title ?? '',
        body: flags.body ?? '',
        autoMerge: false,
        isCrossRepository: false,
      });
      return ok(`https://github.com/o/r/pull/${number}\n`);
    }
    if (sub === 'edit') {
      const number = Number(positional[0]);
      const pr = this.prs.find((p) => p.number === number);
      if (!pr) return err(`no PR ${number}`);
      if (flags.title !== undefined) pr.title = flags.title;
      if (flags.body !== undefined) pr.body = flags.body;
      return ok();
    }
    if (sub === 'merge') {
      const number = Number(positional[0]);
      const pr = this.prs.find((p) => p.number === number);
      if (!pr) return err(`no PR ${number}`);
      pr.autoMerge = true;
      return ok();
    }
    return err(`unexpected gh pr ${sub}`);
  }
}

/** Real-git exec with `gh` routed to the in-memory FakeGh. */
function realGitFakeGhExec(gh: FakeGh): Exec {
  return (command, args, options) => {
    if (command === 'git') {
      try {
        const stdout = execFileSync('git', args as string[], {
          cwd: options?.cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return Promise.resolve({ stdout, stderr: '', code: 0 });
      } catch (e) {
        const anyErr = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
        return Promise.resolve({
          stdout: anyErr.stdout?.toString() ?? '',
          stderr: anyErr.stderr?.toString() ?? '',
          code: typeof anyErr.status === 'number' ? anyErr.status : 1,
        });
      }
    }
    if (command === 'gh') {
      return Promise.resolve(gh.handle(args));
    }
    return Promise.resolve({ stdout: '', stderr: `unknown ${command}`, code: 1 });
  };
}

function realDeps(gh: FakeGh): ReconcileDeps {
  return {
    exec: realGitFakeGhExec(gh),
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'rq-wt-'))),
    removeDir: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
    now: () => FIXED_NOW,
    env: { ...process.env },
  };
}

describe('runReconcile (real git)', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          // Windows can briefly hold a just-removed worktree dir; retry.
        }
      }
    }
  });

  it('(a) no-ops on cold start when the queue branch does not exist', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    const gh = new FakeGh();
    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('noop');
    expect(gh.prs).toHaveLength(0);
  });

  it('(a) no-ops when the queue art surface already matches main', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    // Push a queue branch identical to main (no art added).
    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
    gitSync(liveDir, 'push', 'origin', 'origin/main:refs/heads/assets/queue');
    const gh = new FakeGh();
    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('noop');
    expect(gh.prs).toHaveLength(0);
  });

  it('(b) opens exactly ONE PR and does not duplicate on re-run', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();

    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.status).toBe('pr-open');
    expect(first.created).toBe(true);
    expect(first.armed).toBe(true);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]!.autoMerge).toBe(true);
    expect(gh.prs[0]!.head).toBe('assets/promote');
    expect(gh.prs[0]!.base).toBe('main');

    // Re-run with the SAME pending art (PR not yet merged): must reuse PR #1.
    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('pr-open');
    expect(second.created).toBe(false);
    expect(second.prNumber).toBe(first.prNumber);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]!.autoMerge).toBe(true);
  });

  it('(c) the promote→main diff is art-surface-only by construction', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['a-var-1', 'b-var-1']);
    const gh = new FakeGh();
    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');

    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main', 'assets/promote');
    const diff = gitSync(liveDir, 'diff', '--name-only', 'origin/main', 'origin/assets/promote')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(diff.length).toBeGreaterThan(0);
    for (const p of diff) {
      expect(isArtSurfacePath(p)).toBe(true);
    }
  });

  it('(d) returns to a no-op after the promote PR squash-merges into main', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();

    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.status).toBe('pr-open');
    // Land the art on main (squash-merge) + mark the PR merged.
    simulateSquashMerge(liveDir, gh, first.prNumber!);

    // Next cycle: queue's art is now in main ⇒ no delta ⇒ no-op, no new PR.
    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('noop');
    expect(gh.prs.filter((p) => p.state === 'open')).toHaveLength(0);
    expect(gh.prs).toHaveLength(1);
  });

  it('(e) reuses an already-open promote PR without creating a duplicate', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // A PR is already open for promote→main; our list-before-create finds it
    // first, so we edit+arm it (no create call at all).
    const seeded = gh.seedOpen('assets/promote', 'main');
    gh.failCreateWhenExists = true;

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.created).toBe(false);
    expect(result.prNumber).toBe(seeded);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]!.autoMerge).toBe(true);
  });

  it('(e2) recovers from a create-race: create fails, re-query reuses the PR', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // No PR exists when we list, but a concurrent writer opens one just before
    // our `gh pr create`, so create fails "already exists". The core must fall
    // back to re-query + reuse rather than throwing or duplicating.
    gh.createRaceInsert = true;

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.created).toBe(false);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]!.head).toBe('assets/promote');
    expect(gh.prs[0]!.autoMerge).toBe(true);
  });

  it('(f) ignores a cross-repository (fork) PR reusing the promote branch name', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // An attacker opens a fork PR whose head branch is ALSO named
    // `assets/promote` → base main. `gh pr list --head` matches it by name, but
    // the core must discard it (isCrossRepository) and open its OWN same-repo PR
    // rather than editing + arming the foreign diff.
    const forkPr = gh.seedOpen('assets/promote', 'main', /* isCrossRepository */ true);

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.created).toBe(true);
    expect(result.prNumber).not.toBe(forkPr);
    // The fork PR is never edited or armed.
    const fork = gh.prs.find((p) => p.number === forkPr)!;
    expect(fork.autoMerge).toBe(false);
    expect(fork.title).toBe('');
    // Exactly one same-repo PR was opened and armed.
    const ours = gh.prs.find((p) => p.number === result.prNumber)!;
    expect(ours.isCrossRepository).toBe(false);
    expect(ours.autoMerge).toBe(true);
  });
});
