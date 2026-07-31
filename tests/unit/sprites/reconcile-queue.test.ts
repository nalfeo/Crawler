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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planAssetCheckin } from '../../../scripts/sprites/checkin.js';
import type { Exec, ExecResult } from '../../../scripts/sprites/checkin.js';
import { parseAssetIssueBody } from '../../../scripts/sprites/asset-issues.js';
import {
  assertArtSurfaceModes,
  assertArtSurfaceOnly,
  computeClosingIssueNumbers,
  isArtSurfacePath,
  ReconcileError,
  runReconcile,
  scanOrphanedCheckinBranches,
  type ReconcileDeps,
} from '../../../scripts/sprites/reconcile-queue.js';

const FIXED_NOW = new Date('2026-07-24T12:00:00.000Z');
const TEST_CONTENT_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
// Layer 1.5: computeClosingIssueNumbers — pure-unit with faked exec
// ---------------------------------------------------------------------------

/** Build a realistic issue body containing an asset-checkin payload. */
function makeIssueBody(assetPaths: readonly string[]): string {
  const assets = assetPaths.map((assetPath) => ({
    assetPath,
    manifestKey: assetPath.replace('generated/', '').replace('.png', ''),
    briefId: null,
    variantIndex: null,
    contentHash: TEST_CONTENT_HASH,
  }));
  return planAssetCheckin({ assets, now: FIXED_NOW, slug: 'test-slug' }).issueBody;
}

/**
 * Build a fake exec for `computeClosingIssueNumbers` that returns:
 * - `issueJson` for `gh issue list`
 * - `mainPaths` for `git ls-tree`
 */
function makeClosingExec(
  issueJson: string,
  promotedPathsInput: readonly string[] = [],
  manifestAssetPaths: readonly string[] = [],
  issueListFails = false,
  lsTreeFails = false,
): Exec {
  let allIssues: Array<{ number?: unknown; body?: unknown }> | null = null;
  try {
    allIssues = JSON.parse(issueJson || '[]') as Array<{ number?: unknown; body?: unknown }>;
  } catch {
    allIssues = null;
  }
  const inferredPromotedPaths =
    promotedPathsInput.length > 0
      ? [...promotedPathsInput]
      : (allIssues ?? []).flatMap((raw) => {
          if (typeof raw.body !== 'string') return [];
          const payload = parseAssetIssueBody(raw.body);
          if (payload === null) return [];
          return payload.assets.map((asset) => `public/assets/${asset.assetPath}`);
        });
  const promotedPaths = inferredPromotedPaths;
  const inferredManifestAssetPaths =
    manifestAssetPaths.length > 0
      ? [...manifestAssetPaths]
      : promotedPaths
          .filter((p) => p.startsWith('public/assets/'))
          .map((p) => p.slice('public/assets/'.length));
  // In the sharded world the promoted tree carries one self-contained shard per
  // asset under entries/<key>.json (the aggregate manifest.json is gitignored).
  // Build a shardPath -> entry map so `git show <ref>:<shardPath>` can return the
  // single entry the reconciler reads, and expose the shard paths via ls-tree.
  const shardEntries = new Map<string, { assetPath: string; contentHash: string }>();
  for (const assetPath of inferredManifestAssetPaths) {
    const key = assetPath.replace('generated/', '').replace('.png', '');
    shardEntries.set(`public/assets/generated/entries/${key}.json`, {
      assetPath,
      contentHash: TEST_CONTENT_HASH,
    });
  }
  const lsTreePaths = [...promotedPaths, ...shardEntries.keys()];
  return (command, args) => {
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      if (issueListFails) return Promise.resolve({ stdout: '', stderr: 'error', code: 1 });
      if (allIssues === null) {
        return Promise.resolve({ stdout: issueJson, stderr: '', code: 0 });
      }
      const limitIdx = args.indexOf('--limit');
      const limitRaw = limitIdx >= 0 ? Number(args[limitIdx + 1]) : allIssues.length;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : allIssues.length;
      return Promise.resolve({
        stdout: JSON.stringify(allIssues.slice(0, Math.min(limit, allIssues.length))),
        stderr: '',
        code: 0,
      });
    }
    if (command === 'git' && args[0] === 'ls-tree') {
      if (lsTreeFails) return Promise.resolve({ stdout: '', stderr: 'error', code: 1 });
      return Promise.resolve({ stdout: lsTreePaths.join('\n'), stderr: '', code: 0 });
    }
    if (command === 'git' && args[0] === 'show') {
      // args[1] is `<ref>:<shardPath>`; the first colon separates them and shard
      // paths never contain a colon.
      const spec = typeof args[1] === 'string' ? args[1] : '';
      const shardPath = spec.slice(spec.indexOf(':') + 1);
      const entry = shardEntries.get(shardPath);
      if (entry === undefined) {
        return Promise.resolve({ stdout: '', stderr: 'missing', code: 1 });
      }
      return Promise.resolve({ stdout: JSON.stringify(entry), stderr: '', code: 0 });
    }
    return Promise.resolve({ stdout: '', stderr: `unexpected ${command} ${args[0]}`, code: 1 });
  };
}

describe('computeClosingIssueNumbers', () => {
  it('returns [] when there are no open asset-checkin issues', async () => {
    const exec = makeClosingExec('[]');
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [], complete: true });
  });

  it('closes one issue whose assets are all in changedPaths', async () => {
    const issueJson = JSON.stringify([
      { number: 42, body: makeIssueBody(['generated/skull-mace-var-2.png']) },
    ]);
    const exec = makeClosingExec(issueJson);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [42], complete: true });
  });

  it('closes multiple issues when all their assets are in changedPaths', async () => {
    const issueJson = JSON.stringify([
      { number: 10, body: makeIssueBody(['generated/a-var-1.png']) },
      { number: 20, body: makeIssueBody(['generated/b-var-1.png', 'generated/b-var-2.png']) },
    ]);
    const exec = makeClosingExec(issueJson);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [10, 20], complete: true });
  });

  it('does NOT close a partially-covered issue (some assets missing from changedPaths)', async () => {
    const issueJson = JSON.stringify([
      { number: 99, body: makeIssueBody(['generated/a.png', 'generated/b.png']) },
    ]);
    const exec = makeClosingExec(issueJson, ['public/assets/generated/a.png'], ['generated/a.png']);
    // Only 'a.png' is being promoted; 'b.png' is neither in changedPaths nor on main.
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [], complete: true });
  });

  it('closes an issue whose remaining assets are already on main (previously landed)', async () => {
    // Issue has [a.png, b.png]. 'a.png' is being promoted now; 'b.png' was
    // previously promoted (present in main). Together the issue is fully covered.
    const issueJson = JSON.stringify([
      { number: 55, body: makeIssueBody(['generated/a.png', 'generated/b.png']) },
    ]);
    const exec = makeClosingExec(
      issueJson,
      ['public/assets/generated/a.png', 'public/assets/generated/b.png'],
      ['generated/a.png', 'generated/b.png'],
    );
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [55], complete: true });
  });

  it('returns [] (non-fatal) when the gh issue list call fails', async () => {
    const exec = makeClosingExec('', [], [], /* issueListFails */ true);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [], complete: false });
  });

  it('returns [] (non-fatal) when the issue list JSON is malformed', async () => {
    const exec = makeClosingExec('not-valid-json');
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [], complete: false });
  });

  it('marks discovery incomplete when git ls-tree fails', async () => {
    const issueJson = JSON.stringify([{ number: 7, body: makeIssueBody(['generated/x.png']) }]);
    const exec = makeClosingExec(issueJson, [], [], false, /* lsTreeFails */ true);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [], complete: false });
  });

  it('does NOT close an issue with an empty asset list', async () => {
    // A malformed or empty-assets issue payload must not be closed vacuously.
    const issueJson = JSON.stringify([{ number: 1, body: makeIssueBody([]) }]);
    const exec = makeClosingExec(issueJson);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [], complete: true });
  });

  it('skips issues with missing or non-parseable payloads', async () => {
    const issueJson = JSON.stringify([
      { number: 1, body: 'just text, no payload marker' },
      { number: 2, body: makeIssueBody(['generated/valid.png']) },
    ]);
    const exec = makeClosingExec(issueJson);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    // Only issue #2 has a valid payload and is fully covered.
    expect(result).toEqual({ issueNumbers: [2], complete: true });
  });

  it('returns issue numbers in ascending order', async () => {
    const issueJson = JSON.stringify([
      { number: 30, body: makeIssueBody(['generated/c.png']) },
      { number: 5, body: makeIssueBody(['generated/a.png']) },
      { number: 15, body: makeIssueBody(['generated/b.png']) },
    ]);
    const exec = makeClosingExec(issueJson);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [5, 15, 30], complete: true });
  });

  it('excludes legacy hashless payloads (fail closed)', async () => {
    const issueBody = makeIssueBody(['generated/hashless.png']).replace(
      `,"contentHash":"${TEST_CONTENT_HASH}"`,
      '',
    );
    const issueJson = JSON.stringify([{ number: 77, body: issueBody }]);
    const exec = makeClosingExec(
      issueJson,
      ['public/assets/generated/hashless.png'],
      ['generated/hashless.png'],
    );
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result).toEqual({ issueNumbers: [], complete: true });
  });

  it('re-queries issue list with larger limits until complete', async () => {
    const issues = Array.from({ length: 250 }, (_, i) => ({
      number: i + 1,
      body: makeIssueBody([`generated/a-${i + 1}.png`]),
    }));
    const issueJson = JSON.stringify(issues);
    const promotedPaths = issues.map((issue) => {
      const payload = parseAssetIssueBody(issue.body)!;
      return `public/assets/${payload.assets[0]!.assetPath}`;
    });
    const manifestAssetPaths = issues.map(
      (issue) => parseAssetIssueBody(issue.body)!.assets[0]!.assetPath,
    );
    const exec = makeClosingExec(issueJson, promotedPaths, manifestAssetPaths);
    const result = await computeClosingIssueNumbers(exec, '/repo', 'origin/main', undefined);
    expect(result.complete).toBe(true);
    expect(result.issueNumbers).toHaveLength(250);
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
  issueListFails?: boolean;
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
  let createdPromotePr = false;
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
      if (args[0] === 'ls-tree') {
        return respond({ stdout: '' });
      }
      return respond({});
    }
    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') {
        return respond({
          stdout: createdPromotePr
            ? JSON.stringify([
                {
                  number: 1,
                  headRefName: 'assets/promote',
                  isCrossRepository: false,
                  labels: [],
                },
              ])
            : '[]',
        });
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        createdPromotePr = true;
        return respond({ stdout: 'https://github.com/o/r/pull/1\n' });
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        if (config.issueListFails) return respond({ stdout: '', stderr: 'boom', code: 1 });
        return respond({ stdout: '[]' });
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

  it('defers auto-merge arming when closing-issue discovery is incomplete', async () => {
    const { exec, calls } = makeFakeExec({ queueExists: true, issueListFails: true });
    const result = await runReconcile('/repo', controlDeps(exec));
    expect(result.status).toBe('pr-open');
    expect(result.armed).toBe(false);
    expect(result.closingIssueDiscoveryComplete).toBe(false);
    expect(
      calls.some((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2b: scanOrphanedCheckinBranches (faked exec)
// ---------------------------------------------------------------------------

type FakeCall = { command: string; args: string[] };

function makeScanExec(
  lsRemoteOutput: string,
  prListOutput: string,
  lsCode = 0,
  prCode = 0,
): { exec: Exec; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const exec: Exec = async (command, args, _opts) => {
    calls.push({ command, args: [...args] });
    if (command === 'git' && args[0] === 'ls-remote') {
      return { stdout: lsRemoteOutput, stderr: '', code: lsCode };
    }
    if (command === 'gh' && args[0] === 'pr') {
      return { stdout: prListOutput, stderr: '', code: prCode };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('scanOrphanedCheckinBranches', () => {
  const REMOTE = 'origin';
  const REPO_ROOT = '/fake/root';

  it('returns empty array when ls-remote returns nothing', async () => {
    const { exec } = makeScanExec('', '[]');
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    expect(result).toEqual([]);
  });

  it('returns all checkin branches when no open PRs exist', async () => {
    const lsRemote =
      'abc123\trefs/heads/assets/checkin-foo\n' + 'def456\trefs/heads/assets/checkin-bar\n';
    const { exec } = makeScanExec(lsRemote, '[]');
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    expect(result).toEqual(['assets/checkin-foo', 'assets/checkin-bar']);
  });

  it('excludes branches that are the head of an open PR', async () => {
    const lsRemote =
      'abc123\trefs/heads/assets/checkin-foo\n' +
      'def456\trefs/heads/assets/checkin-bar\n' +
      'ghi789\trefs/heads/assets/checkin-baz\n';
    const prList = JSON.stringify([{ headRefName: 'assets/checkin-bar' }]);
    const { exec } = makeScanExec(lsRemote, prList);
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    expect(result).toEqual(['assets/checkin-foo', 'assets/checkin-baz']);
  });

  it('returns empty when all branches have open PRs', async () => {
    const lsRemote =
      'abc123\trefs/heads/assets/checkin-foo\n' + 'def456\trefs/heads/assets/checkin-bar\n';
    const prList = JSON.stringify([
      { headRefName: 'assets/checkin-foo' },
      { headRefName: 'assets/checkin-bar' },
    ]);
    const { exec } = makeScanExec(lsRemote, prList);
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    expect(result).toEqual([]);
  });

  it('returns empty when ls-remote fails', async () => {
    const { exec } = makeScanExec('', '[]', 1);
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    expect(result).toEqual([]);
  });

  it('returns all branches when gh pr list returns invalid JSON (conservative)', async () => {
    const lsRemote = 'abc123\trefs/heads/assets/checkin-foo\n';
    const { exec } = makeScanExec(lsRemote, 'not-json', 0, 0);
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    // Conservative: invalid PR list → treat as no open PRs found → all branches are orphaned
    // (unlike a failed call which returns []; parse failure returns all branches)
    expect(result).toEqual(['assets/checkin-foo']);
  });

  it('does not include non-checkin branches from ls-remote', async () => {
    const lsRemote =
      'abc123\trefs/heads/assets/checkin-foo\n' +
      '111222\trefs/heads/assets/batch-123456\n' +
      '333444\trefs/heads/main\n';
    const { exec } = makeScanExec(lsRemote, '[]');
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    expect(result).toEqual(['assets/checkin-foo']);
  });

  it('passes --repo flag when repo param is provided', async () => {
    const { exec, calls } = makeScanExec('', '[]');
    await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, 'owner/repo');
    const prCall = calls.find((c) => c.command === 'gh');
    expect(prCall?.args).toContain('--repo');
    expect(prCall?.args).toContain('owner/repo');
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

function catalogPath(repo: string): string {
  return path.join(repo, 'src', 'shared', 'data', 'sprite-catalog.json');
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
  // The aggregate manifest.json is a gitignored build artifact in the sharded
  // world, so the committed base carries only the (empty) catalog. Art lands
  // later as per-asset shards under public/assets/generated/entries/.
  writeJson(catalogPath(liveDir), []);
  gitSync(liveDir, 'add', '-A');
  gitSync(liveDir, 'commit', '--no-verify', '-m', 'base');
  gitSync(liveDir, 'push', 'origin', 'main');
  return { root, originDir, liveDir };
}

/** Push an art commit onto origin's assets/queue branch (built from origin/main). */
function seedQueueWithArt(
  liveDir: string,
  keys: readonly string[],
  queueBranch = 'assets/queue',
): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-seed-'));
  try {
    // Base the queue on main so its non-art files match main (art-only diff).
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    const entriesDir = path.join(genDir, 'entries');
    mkdirSync(entriesDir, { recursive: true });
    for (const key of keys) {
      writeFileSync(path.join(genDir, `${key}.png`), PNG_BYTES);
      // One self-contained shard per asset — the sharded source of truth.
      writeJson(path.join(entriesDir, `${key}.json`), {
        assetPath: `generated/${key}.png`,
        spriteName: key,
        contentHash: TEST_CONTENT_HASH,
      });
    }
    gitSync(wt, 'add', '--', 'public/assets/generated');
    gitSync(wt, 'commit', '--no-verify', '-m', `queue art: ${keys.join(', ')}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/${queueBranch}`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * Push an art commit DIRECTLY onto origin/main (simulates the legacy asset-PR
 * flow that lands art without going through the queue branch).
 */
function addArtDirectlyToMain(liveDir: string, keys: readonly string[]): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-main-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    const entriesDir = path.join(genDir, 'entries');
    mkdirSync(entriesDir, { recursive: true });
    for (const key of keys) {
      writeFileSync(path.join(genDir, `${key}.png`), PNG_BYTES);
      writeJson(path.join(entriesDir, `${key}.json`), {
        assetPath: `generated/${key}.png`,
        spriteName: key,
        contentHash: TEST_CONTENT_HASH,
      });
    }
    gitSync(wt, 'add', '--', 'public/assets/generated');
    gitSync(wt, 'commit', '--no-verify', '-m', `direct-to-main art: ${keys.join(', ')}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/main`);
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
  /** The SHA passed to `--match-head-commit` when arming auto-merge. */
  matchHeadCommit?: string;
  /** Label names currently on the PR. */
  labels: string[];
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
  /** Labels the create-race-inserted PR carries (see `createRaceInsert`). */
  createRaceLabels: string[] = [];
  /**
   * Open `asset-checkin` issues available to `gh issue list`. Each entry is the
   * raw JSON object returned by `gh issue list --json number,body`. Populated via
   * `seedCheckinIssue`.
   */
  checkinIssues: Array<{ number: number; body: string }> = [];

  /** Pre-seed an open PR (used to exercise the create-race reuse path). */
  seedOpen(head: string, base: string, isCrossRepository = false, labels: string[] = []): number {
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
      labels: [...labels],
    });
    return number;
  }

  /** Pre-seed an open asset-checkin issue (for issue-closure tests). */
  seedCheckinIssue(number: number, body: string): void {
    this.checkinIssues.push({ number, body });
  }

  handle(args: readonly string[]): ExecResult {
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });
    const err = (stderr: string): ExecResult => ({ stdout: '', stderr, code: 1 });

    // Dispatch on the top-level gh subcommand.
    if (args[0] === 'issue') {
      const sub = args[1];
      if (sub === 'list') {
        return ok(JSON.stringify(this.checkinIssues));
      }
      return err(`unexpected gh issue ${sub}`);
    }

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
            labels: p.labels.map((name) => ({ name })),
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
          labels: [...this.createRaceLabels],
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
        labels: flags.label !== undefined ? [flags.label] : [],
      });
      return ok(`https://github.com/o/r/pull/${number}\n`);
    }
    if (sub === 'edit') {
      const number = Number(positional[0]);
      const pr = this.prs.find((p) => p.number === number);
      if (!pr) return err(`no PR ${number}`);
      if (flags.title !== undefined) pr.title = flags.title;
      if (flags.body !== undefined) pr.body = flags.body;
      if (flags['add-label'] !== undefined && !pr.labels.includes(flags['add-label'])) {
        pr.labels.push(flags['add-label']);
      }
      return ok();
    }
    if (sub === 'merge') {
      const number = Number(positional[0]);
      const pr = this.prs.find((p) => p.number === number);
      if (!pr) return err(`no PR ${number}`);
      pr.autoMerge = true;
      pr.matchHeadCommit = flags['match-head-commit'];
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
    // --match-head-commit is a load-bearing TOCTOU defense: assert it is the
    // exact promotion commit SHA, not an empty/wrong value.
    expect(gh.prs[0]!.matchHeadCommit).toBe(first.promoteCommit);
    expect(first.promoteCommit).toMatch(/^[0-9a-f]{40}$/);

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
    // Race-recovered PR must carry merge-train — it was opened without the
    // label by the concurrent writer and the reconciler must re-ensure it.
    expect(gh.prs[0]!.labels).toContain('merge-train');
  });

  it('(e3) does NOT re-add merge-train on a create-race PR that is already merge-train-blocked', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // The concurrent writer's PR was already blocked by the train before our
    // create attempt raced with it — re-ensuring merge-train here would fight
    // that intentional train decision, same as the normal update path.
    gh.createRaceInsert = true;
    gh.createRaceLabels = ['merge-train-blocked'];

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.created).toBe(false);
    expect(gh.prs[0]!.labels).not.toContain('merge-train');
    expect(gh.prs[0]!.labels).toContain('merge-train-blocked');
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

  it('(g) PR body uses the resolved branch names (not hardcoded defaults)', async () => {
    // Regression: buildPrContent used to hardcode `assets/queue`, `main`, and
    // `assets/promote` even when non-default options were passed. Using
    // --queue-branch / --promote-branch / --base would then publish wrong metadata.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    // Seed art onto a custom queue branch name.
    seedQueueWithArt(liveDir, ['skull-mace-var-2'], 'custom/queue');
    const gh = new FakeGh();

    const result = await runReconcile(liveDir, realDeps(gh), {
      queueBranch: 'custom/queue',
      promoteBranch: 'custom/promote',
      baseBranch: 'main',
    });
    expect(result.status).toBe('pr-open');
    const body = gh.prs[0]!.body;
    // Resolved branch names appear in the body.
    expect(body).toContain('`custom/queue`');
    expect(body).toContain('`custom/promote`');
    // Hardcoded defaults must NOT appear (they would be wrong metadata).
    expect(body).not.toContain('`assets/queue`');
    expect(body).not.toContain('`assets/promote`');
  });

  it('(h) preserves art on main that was never committed to the queue branch', async () => {
    // Regression for whole-surface checkout revert: a sprite that reached main
    // via an independent flow (legacy asset-PR) — and was therefore ABSENT from
    // the queue branch — must NOT be deleted when the reconciler promotes queue
    // art. The promotion commit should only touch paths queue positively added.
    //
    // Scenario: queue is created first, then art is added directly to main
    // (simulating the legacy asset-PR flow). Queue never absorbs that main
    // change, so the PNG is in main but absent from queue.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);

    // 1. Seed the queue FIRST (based on the empty main).
    //    Queue ends up with queue-added-sprite.png only.
    seedQueueWithArt(liveDir, ['queue-added-sprite']);

    // 2. AFTER queue is created, push art DIRECTLY to main (legacy asset-PR).
    //    Queue does NOT have this asset; main-only-sprite.png is absent from queue.
    addArtDirectlyToMain(liveDir, ['main-only-sprite']);

    const gh = new FakeGh();
    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');

    // Fetch the promotion branch and verify what changed vs the (now-updated) main.
    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main', 'assets/promote');
    const diff = gitSync(liveDir, 'diff', '--name-only', 'origin/main', 'origin/assets/promote')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Only queue-added paths should appear in the promote→main diff.
    expect(diff.some((p) => p.includes('queue-added-sprite'))).toBe(true);
    // The main-only asset must NOT be deleted (must NOT appear in the diff at all).
    expect(diff.some((p) => p.includes('main-only-sprite'))).toBe(false);
  });

  // ---------------------------------------------------------------------
  // merge-train label enrollment (the reconciler's armed --auto --squash
  // is worthless without this: the ONLY merge gate on `main` requires the
  // `merge-train` status, which is posted only after the merge-train App
  // admits a PR, and admission is gated on the PR carrying the `merge-train`
  // LABEL — see .github/scripts/merge-train/state.mjs).
  // ---------------------------------------------------------------------

  it('(i) labels a newly-created promote PR with merge-train', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.created).toBe(true);
    expect(gh.prs[0]!.labels).toContain('merge-train');
    expect(gh.prs[0]!.labels).not.toContain('human-approval-required');
  });

  it('(j) re-ensures merge-train on an existing PR that has no exclusion label', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // Simulate `crawler-ci[bot]` having stripped `merge-train` mid-cycle: the
    // PR is open, un-labeled, and carries no train state label.
    const seeded = gh.seedOpen('assets/promote', 'main', false, []);

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.created).toBe(false);
    expect(result.prNumber).toBe(seeded);
    expect(gh.prs[0]!.labels).toContain('merge-train');
  });

  it('(k) does NOT re-add merge-train while the train has it merge-train-blocked', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // The train deliberately removed `merge-train` and set `merge-train-blocked`
    // (see reconcile-lib.mjs's applyLandedRecoveryDecision / blocked paths).
    // Re-adding `merge-train` here would fight that intentional decision.
    gh.seedOpen('assets/promote', 'main', false, ['merge-train-blocked']);

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(gh.prs[0]!.labels).not.toContain('merge-train');
    expect(gh.prs[0]!.labels).toContain('merge-train-blocked');
  });

  it('(l) does NOT re-add merge-train once the PR carries the terminal merge-train-landed label', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // merge-train-landed is permanent (only ever added, never removed) — once
    // present the PR's change already landed on main; re-adding merge-train
    // is pointless.
    gh.seedOpen('assets/promote', 'main', false, ['merge-train-landed']);

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(gh.prs[0]!.labels).not.toContain('merge-train');
    expect(gh.prs[0]!.labels).toContain('merge-train-landed');
  });

  // ---------------------------------------------------------------------
  // Issue-closure: promotion PRs must include Closes #N for every
  // asset-checkin issue whose complete payload is represented by the
  // promotion (acceptance criteria from issue #2065).
  // ---------------------------------------------------------------------

  it('(m) PR body includes Closes #N for a fully-covered asset-checkin issue', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    // Seed the queue with one art asset.
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    // Register an asset-checkin issue whose single asset matches what we just queued.
    gh.seedCheckinIssue(42, makeIssueBody(['generated/skull-mace-var-2.png']));

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.closingIssueNumbers).toContain(42);
    expect(gh.prs[0]!.body).toContain('Closes #42');
  });

  it('(n) PR body includes Closes for multiple fully-covered issues', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['a-var-1', 'b-var-1']);
    const gh = new FakeGh();
    gh.seedCheckinIssue(10, makeIssueBody(['generated/a-var-1.png']));
    gh.seedCheckinIssue(20, makeIssueBody(['generated/b-var-1.png']));

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.closingIssueNumbers).toEqual([10, 20]);
    expect(gh.prs[0]!.body).toContain('Closes #10');
    expect(gh.prs[0]!.body).toContain('Closes #20');
  });

  it('(o) does NOT include Closes for a partially-covered issue', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    // Queue only asset 'a'; asset 'b' (also listed in the issue) is not queued.
    seedQueueWithArt(liveDir, ['a-var-1']);
    const gh = new FakeGh();
    // The issue lists two assets; only one is being promoted.
    gh.seedCheckinIssue(99, makeIssueBody(['generated/a-var-1.png', 'generated/b-var-1.png']));

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.closingIssueNumbers).toEqual([]);
    expect(gh.prs[0]!.body).not.toContain('Closes #99');
  });

  it('(p) includes Closes for an issue whose remaining asset is already on main', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    // Land 'b-var-1' on main directly (simulates a previous promotion).
    addArtDirectlyToMain(liveDir, ['b-var-1']);
    // Now queue 'a-var-1' (the other asset in the multi-asset issue).
    seedQueueWithArt(liveDir, ['a-var-1']);
    const gh = new FakeGh();
    // Issue covers both assets; 'b-var-1' is already on main, 'a-var-1' is being promoted.
    gh.seedCheckinIssue(55, makeIssueBody(['generated/a-var-1.png', 'generated/b-var-1.png']));

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.closingIssueNumbers).toContain(55);
    expect(gh.prs[0]!.body).toContain('Closes #55');
  });

  it('(q) idempotent: re-run produces the same Closes lines without duplication', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    gh.seedCheckinIssue(7, makeIssueBody(['generated/skull-mace-var-2.png']));

    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.status).toBe('pr-open');
    expect(gh.prs[0]!.body).toContain('Closes #7');
    // Count occurrences — idempotent means exactly one.
    expect(gh.prs[0]!.body.match(/Closes #7/g)?.length).toBe(1);

    // Re-run (PR still open, same art still pending) — body is re-written via edit.
    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('pr-open');
    expect(gh.prs[0]!.body).toContain('Closes #7');
    expect(gh.prs[0]!.body.match(/Closes #7/g)?.length).toBe(1);
  });

  it('(r) does NOT close when payload hash differs from promoted manifest hash', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['hash-mismatch']);
    const gh = new FakeGh();
    const mismatched = makeIssueBody(['generated/hash-mismatch.png']).replace(
      TEST_CONTENT_HASH,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    gh.seedCheckinIssue(88, mismatched);

    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');
    expect(result.closingIssueNumbers).toEqual([]);
    expect(gh.prs[0]!.body).not.toContain('Closes #88');
  });
});
