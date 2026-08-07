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
  findLandedPromotion,
  formatSourceTrailers,
  isArtSurfacePath,
  parseSourceTrailers,
  ReconcileError,
  runReconcile,
  scanOrphanedCheckinBranches,
  tidyUpLandedPromotion,
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
    expect(isArtSurfacePath('briefs/enemies/panda-boba-sniper.yaml')).toBe(true);
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
  /** Raw `git log --raw` output standing in for main's history at the paths. */
  baseHistoryRaw?: string;
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
      // Convergence guard (`filterPromotablePaths`): the blob each ref holds at
      // the candidate paths plus every blob its history held there. The faked
      // main has neither the paths nor (by default) any history for them, so the
      // delta is genuinely-new art and the happy path proceeds.
      if (joined.includes('ls-tree') && args.includes('-r')) {
        const isBase = joined.includes('origin/main');
        return respond({
          stdout: isBase
            ? ''
            : artDelta.map((p, i) => `100644 blob ${'a'.repeat(39)}${i}\t${p}`).join('\n'),
        });
      }
      if (joined.includes('log') && args.includes('--raw')) {
        const isBase = joined.includes('origin/main');
        return respond({ stdout: isBase ? (config.baseHistoryRaw ?? '') : '' });
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

/**
 * The tidy-up step probes `gh pr list --state merged` at the very start of every
 * cycle to find the last LANDED promotion, so "no gh calls" assertions must
 * tolerate exactly that probe (and nothing else).
 */
function isTidyUpProbe(call: { command: string; args: string[] }): boolean {
  return (
    call.command === 'gh' &&
    call.args[0] === 'pr' &&
    call.args[1] === 'list' &&
    call.args.includes('merged')
  );
}

describe('runReconcile (control-flow)', () => {
  it('cold-start: no-op without fetching when the queue branch is absent', async () => {
    const { exec, calls } = makeFakeExec({ queueExists: false });
    const result = await runReconcile('/repo', controlDeps(exec));
    expect(result.status).toBe('noop');
    // Only the initial ls-remote probe ran; no fetch, no worktree, no gh.
    expect(calls.some((c) => c.command === 'git' && c.args[0] === 'fetch')).toBe(false);
    expect(calls.filter((c) => c.command === 'gh').every(isTidyUpProbe)).toBe(true);
  });

  it('no-op when the art-surface delta is empty', async () => {
    const { exec, calls } = makeFakeExec({ queueExists: true, artDelta: [] });
    const result = await runReconcile('/repo', controlDeps(exec));
    expect(result.status).toBe('noop');
    // Never staged a worktree or opened a PR.
    expect(calls.some((c) => c.command === 'git' && c.args[0] === 'worktree')).toBe(false);
    expect(calls.filter((c) => c.command === 'gh').every(isTidyUpProbe)).toBe(true);
  });

  it('no-ops when every candidate path is a stale re-assertion of superseded bytes', async () => {
    // The hourly ping-pong: the delta is non-empty, but main's history already
    // carried these exact bytes at this path and moved on. Re-promoting them
    // reverts main and guarantees another PR next hour — so we must no-op.
    const sha = `${'a'.repeat(39)}0`;
    const { exec, calls } = makeFakeExec({
      queueExists: true,
      artDelta: ['public/assets/generated/a.png'],
      baseHistoryRaw: `:100644 100644 ${sha} ${'b'.repeat(40)} M\tpublic/assets/generated/a.png\n`,
    });
    const result = await runReconcile('/repo', controlDeps(exec));
    expect(result.status).toBe('noop');
    expect(calls.some((c) => c.command === 'git' && c.args[0] === 'worktree')).toBe(false);
    expect(calls.filter((c) => c.command === 'gh').every(isTidyUpProbe)).toBe(true);
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
    expect(calls.filter((c) => c.command === 'gh').every(isTidyUpProbe)).toBe(true);
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
    expect(calls.filter((c) => c.command === 'gh').every(isTidyUpProbe)).toBe(true);
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
    // Deterministically sorted: overlay order decides the winner when two
    // sources disagree, so it must not depend on `ls-remote` output order.
    expect(result).toEqual(['assets/checkin-bar', 'assets/checkin-foo']);
  });

  it('excludes branches that are the head of an open PR', async () => {
    const lsRemote =
      'abc123\trefs/heads/assets/checkin-foo\n' +
      'def456\trefs/heads/assets/checkin-bar\n' +
      'ghi789\trefs/heads/assets/checkin-baz\n';
    const prList = JSON.stringify([{ headRefName: 'assets/checkin-bar' }]);
    const { exec } = makeScanExec(lsRemote, prList);
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    expect(result).toEqual(['assets/checkin-baz', 'assets/checkin-foo']);
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

  it('returns [] when gh pr list returns invalid JSON (fail-closed)', async () => {
    const lsRemote = 'abc123\trefs/heads/assets/checkin-foo\n';
    const { exec } = makeScanExec(lsRemote, 'not-json', 0, 0);
    const result = await scanOrphanedCheckinBranches(exec, REPO_ROOT, REMOTE, undefined);
    // Fail-closed: invalid PR list → treat as unknown PR state → return [] to avoid
    // harvesting branches that might have active PRs.
    expect(result).toEqual([]);
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
    const lsRemote = 'abc123\trefs/heads/assets/checkin-foo\n';
    const { exec, calls } = makeScanExec(lsRemote, '[]');
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

/** Distinct PNG bytes that SUPERSEDE {@link PNG_BYTES} at the same asset path. */
const SUPERSEDING_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
]);

/** Distinct PNG bytes standing in for a brand-new approval main has never held. */
const FRESH_EDIT_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
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

function seedQueueWithLegacyManifest(
  liveDir: string,
  keys: readonly string[],
  queueBranch = 'assets/queue',
): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-seed-legacy-queue-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    mkdirSync(genDir, { recursive: true });
    for (const key of keys) {
      writeFileSync(path.join(genDir, `${key}.png`), PNG_BYTES);
    }
    writeJson(path.join(genDir, 'manifest.json'), { version: 1, assets: keys });
    gitSync(wt, 'add', '--', 'public/assets/generated');
    gitSync(wt, 'commit', '--no-verify', '-m', `queue legacy manifest: ${keys.join(', ')}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/${queueBranch}`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

function seedQueueWithBrief(
  liveDir: string,
  briefPath: string,
  yaml: string,
  queueBranch = 'assets/queue',
): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-seed-brief-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    const briefAbs = path.join(wt, ...briefPath.split('/'));
    mkdirSync(path.dirname(briefAbs), { recursive: true });
    writeFileSync(briefAbs, yaml);
    gitSync(wt, 'add', '--', 'briefs');
    gitSync(wt, 'commit', '--no-verify', '-m', `queue brief: ${briefPath}`);
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
function addArtDirectlyToMain(
  liveDir: string,
  keys: readonly string[],
  bytes: Buffer = PNG_BYTES,
): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-main-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    const entriesDir = path.join(genDir, 'entries');
    mkdirSync(entriesDir, { recursive: true });
    for (const key of keys) {
      writeFileSync(path.join(genDir, `${key}.png`), bytes);
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

/** Push a NEW edit of an existing queued asset (distinct bytes) onto the queue. */
function editQueuedArt(liveDir: string, key: string, bytes: Buffer): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/queue');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-edit-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/assets/queue');
    writeFileSync(path.join(wt, 'public', 'assets', 'generated', `${key}.png`), bytes);
    gitSync(wt, 'add', '--', 'public/assets/generated');
    gitSync(wt, 'commit', '--no-verify', '-m', `queue edit: ${key}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/assets/queue`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * Re-seed the queue with the ORIGINAL PNG bytes plus a freshly-stamped shard
 * blob (different JSON content, so a new git object). Used to simulate an
 * A→B→A re-approval where the user approves the same pixels again after main
 * has moved to a different version.
 */
function reapproveQueueWithOriginalBytesAndFreshShard(liveDir: string, key: string): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/queue');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-reapprove-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/assets/queue');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    const entriesDir = path.join(genDir, 'entries');
    mkdirSync(entriesDir, { recursive: true });
    // PNG goes back to original bytes (A→B→A).
    writeFileSync(path.join(genDir, `${key}.png`), PNG_BYTES);
    // Shard is re-stamped with a NEW blob (new contentHash), so it is not stale
    // by itself — the atomicity fix must withhold it alongside its paired PNG.
    writeJson(path.join(entriesDir, `${key}.json`), {
      assetPath: `generated/${key}.png`,
      spriteName: key,
      contentHash: 'reapproved-' + TEST_CONTENT_HASH,
    });
    gitSync(wt, 'add', '--', 'public/assets/generated');
    gitSync(wt, 'commit', '--no-verify', '-m', `re-approve original bytes: ${key}`);
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

/**
 * Seed a pre-sharding check-in branch on origin. This branch carries an
 * aggregate `manifest.json` at `public/assets/generated/manifest.json` (the
 * layout that predates the July-29 shard migration) instead of per-asset
 * shards under `entries/`. The test verifies that `runReconcile` filters out
 * the legacy manifest and only promotes the PNGs.
 */
function seedLegacyCheckinBranch(
  liveDir: string,
  branchName: string,
  keys: readonly string[],
): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
  const wt = mkdtempSync(path.join(tmpdir(), 'rq-legacy-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'origin/main');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    mkdirSync(genDir, { recursive: true });
    for (const key of keys) {
      writeFileSync(path.join(genDir, `${key}.png`), PNG_BYTES);
    }
    // Simulate the pre-shard aggregate manifest.json (no entries/ shards).
    writeJson(path.join(genDir, 'manifest.json'), { version: 1, assets: keys });
    gitSync(wt, 'add', '--', 'public/assets/generated');
    gitSync(wt, 'commit', '--no-verify', '-m', `legacy checkin: ${keys.join(', ')}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/${branchName}`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
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
  /** Head commit OID (set when the PR is recorded as merged). */
  headRefOid?: string;
  /** ISO merge timestamp (set when the PR is recorded as merged). */
  mergedAt?: string;
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

  /**
   * Record an already-MERGED PR (what `gh pr list --state merged` returns). The
   * caller supplies the head OID so the tidy-up path can verify it against the
   * `refs/pull/<n>/head` ref it fetches.
   */
  seedMerged(
    head: string,
    base: string,
    headRefOid: string,
    mergedAt: string,
    isCrossRepository = false,
  ): number {
    const number = this.next++;
    this.prs.push({
      number,
      head,
      base,
      state: 'merged',
      title: '',
      body: '',
      autoMerge: false,
      isCrossRepository,
      labels: [],
      headRefOid,
      mergedAt,
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
      // `--state` defaults to open; the tidy-up path queries `merged`.
      const wantState = flags.state === 'merged' ? 'merged' : 'open';
      const matches = this.prs.filter(
        (p) => p.state === wantState && p.head === flags.head && p.base === flags.base,
      );
      return ok(
        JSON.stringify(
          matches.map((p) => ({
            number: p.number,
            headRefName: p.head,
            baseRefName: p.base,
            headRefOid: p.headRefOid,
            mergedAt: p.mergedAt,
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

  it('(c) promotes queued brief files alongside art-surface changes', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    const briefPath = 'briefs/enemies/panda-boba-sniper.yaml';
    seedQueueWithBrief(liveDir, briefPath, 'id: panda-boba-sniper\n');
    const gh = new FakeGh();
    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');

    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/promote');
    const promotedBrief = gitSync(liveDir, 'show', `origin/assets/promote:${briefPath}`);
    expect(promotedBrief).toContain('id: panda-boba-sniper');
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

  it('(d2) CONVERGES: never re-asserts bytes main already carried and superseded', async () => {
    // The production ping-pong (hourly promotion PR with no new approvals): the
    // queue holds bytes main ALREADY landed and has since moved on from, so the
    // two-dot AM delta is non-empty forever and the reconciler re-reverted main
    // every cycle. It must now recognize the queue copy as superseded ⇒ no-op.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();

    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.status).toBe('pr-open');
    simulateSquashMerge(liveDir, gh, first.prNumber!);

    // Someone supersedes that asset on main (a later promotion / asset PR).
    addArtDirectlyToMain(liveDir, ['skull-mace-var-2'], SUPERSEDING_PNG_BYTES);

    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('noop');
    // The withheld path is REPORTED, not silently dropped.
    expect(second.withheldPaths).toContain('public/assets/generated/skull-mace-var-2.png');
    expect(gh.prs.filter((p) => p.state === 'open')).toHaveLength(0);
    // ...and it stays converged: no PR is ever reopened for the same stale bytes.
    const third = await runReconcile(liveDir, realDeps(gh));
    expect(third.status).toBe('noop');
    expect(gh.prs).toHaveLength(1);
  });

  it('(d3) still promotes a RE-EDIT of an asset the reconciler already landed', async () => {
    // The convergence guard must not block the normal loop: after a promotion
    // lands the queue's bytes on main, the next approval of that same asset is
    // brand-new content on a path whose current main bytes came from the queue
    // itself, so it must still promote.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();

    const first = await runReconcile(liveDir, realDeps(gh));
    simulateSquashMerge(liveDir, gh, first.prNumber!);
    editQueuedArt(liveDir, 'skull-mace-var-2', FRESH_EDIT_PNG_BYTES);

    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('pr-open');
    expect(second.changedPaths).toContain('public/assets/generated/skull-mace-var-2.png');
  });

  it('(d4) MAIN WINS: does not clobber a main-side change the source never saw', async () => {
    // A stale source (e.g. a July `assets/checkin-*` branch holding an outdated
    // sprite-catalog.json) must never overwrite bytes main obtained from another
    // flow — that is a silent regression AND the other half of the ping-pong.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();

    const first = await runReconcile(liveDir, realDeps(gh));
    simulateSquashMerge(liveDir, gh, first.prNumber!);
    // Main moves on independently; the queue then edits the same path without
    // ever having seen main's new bytes.
    addArtDirectlyToMain(liveDir, ['skull-mace-var-2'], SUPERSEDING_PNG_BYTES);
    editQueuedArt(liveDir, 'skull-mace-var-2', FRESH_EDIT_PNG_BYTES);

    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('noop');
    expect(second.withheldPaths).toContain('public/assets/generated/skull-mace-var-2.png');
    expect(gh.prs.filter((p) => p.state === 'open')).toHaveLength(0);
  });

  it('(d5) ATOMIC: withholds PNG AND shard together on A→B→A re-approval', async () => {
    // The A→B→A split-brain bug: main previously carried PNG blob A; later
    // moved to blob B; source is re-approved back to blob A with a freshly-
    // stamped shard. Without atomicity the stale PNG is withheld but the new
    // shard blob passes — `check:asset-integrity` would then fail because the
    // promoted shard's `contentHash` describes A while main still holds B.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();

    // Phase 1: original bytes (A) land on main.
    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.status).toBe('pr-open');
    simulateSquashMerge(liveDir, gh, first.prNumber!);

    // Phase 2: main moves on to blob B via an independent flow.
    addArtDirectlyToMain(liveDir, ['skull-mace-var-2'], SUPERSEDING_PNG_BYTES);

    // Phase 3: queue is re-approved back to blob A with a FRESH shard blob.
    reapproveQueueWithOriginalBytesAndFreshShard(liveDir, 'skull-mace-var-2');

    const second = await runReconcile(liveDir, realDeps(gh));
    // Both the PNG (stale) and its paired shard (fresh but atomically linked)
    // must be withheld — no partial promotion that breaks asset integrity.
    expect(second.status).toBe('noop');
    expect(second.withheldPaths).toContain('public/assets/generated/skull-mace-var-2.png');
    expect(second.withheldPaths).toContain(
      'public/assets/generated/entries/skull-mace-var-2.json',
    );
    expect(gh.prs.filter((p) => p.state === 'open')).toHaveLength(0);
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

  it('(s) harvests orphan checkin branch when queue branch is absent', async () => {
    // No assets/queue branch — only an orphaned assets/checkin-* branch.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-orphan-only', ['orphan-sprite-var-1']);
    const gh = new FakeGh();
    // No open PRs for the orphan branch.

    const result = await runReconcile(liveDir, realDeps(gh));
    // Should reconcile (not noop) because the orphan branch contributes art.
    expect(result.status).toBe('pr-open');
    expect(gh.prs).toHaveLength(1);
    // The PNG path should be in the promote commit; manifest.json must NOT be.
    const promotedFiles = gitSync(
      liveDir,
      'ls-tree',
      '--name-only',
      '-r',
      'origin/assets/promote',
      '--',
      'public/assets/generated',
    )
      .split('\n')
      .filter(Boolean);
    expect(promotedFiles.some((f) => f.endsWith('orphan-sprite-var-1.png'))).toBe(true);
    expect(promotedFiles.some((f) => f === 'public/assets/generated/manifest.json')).toBe(false);
  });

  it('(t) filters pre-sharding aggregate manifest from legacy checkin branch — idempotent on re-run', async () => {
    // A legacy orphan branch (aggregate manifest, no shards) plus a queue branch.
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['queue-sprite-var-1']);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-legacy-123', ['legacy-sprite-var-1']);
    const gh = new FakeGh();

    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.status).toBe('pr-open');

    // Verify: legacy manifest.json must not have landed in the promote commit.
    const promotedFiles = gitSync(
      liveDir,
      'ls-tree',
      '--name-only',
      '-r',
      'origin/assets/promote',
      '--',
      'public/assets/generated',
    )
      .split('\n')
      .filter(Boolean);
    expect(promotedFiles.some((f) => f === 'public/assets/generated/manifest.json')).toBe(false);
    expect(promotedFiles.some((f) => f.endsWith('legacy-sprite-var-1.png'))).toBe(true);
    expect(promotedFiles.some((f) => f.endsWith('queue-sprite-var-1.png'))).toBe(true);

    // Re-run: idempotent — same PR reused, no duplicate.
    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('pr-open');
    expect(gh.prs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Source-snapshot trailers + landed-promotion tidy-up.
//
// These cover the convergence fix: a promotion records the EXACT source tips it
// harvested, and once that promotion MERGES the next cycle retires precisely
// those snapshots under a compare-and-swap lease. Without the tidy-up the
// reconciler oscillates — `--diff-filter=AM` only asks "does this source differ
// from main", so whichever source currently disagrees with main always re-wins
// the overlay and a promotion PR is opened every hour forever.
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('source trailers', () => {
  it('round-trips a queue snapshot and orphan snapshots', () => {
    const sources = {
      queueSha: SHA_A,
      orphans: [
        { branch: 'assets/checkin-zzz', sha: SHA_B },
        { branch: 'assets/checkin-aaa', sha: SHA_C },
      ],
    };
    const text = formatSourceTrailers(sources);
    // Deterministically ordered by branch name so re-harvesting identical
    // sources produces a byte-identical commit message.
    expect(text).toBe(
      `Queue-Source: ${SHA_A}\n` +
        `Orphan-Source: assets/checkin-aaa ${SHA_C}\n` +
        `Orphan-Source: assets/checkin-zzz ${SHA_B}`,
    );
    expect(parseSourceTrailers(text)).toEqual({
      queueSha: SHA_A,
      orphans: [
        { branch: 'assets/checkin-aaa', sha: SHA_C },
        { branch: 'assets/checkin-zzz', sha: SHA_B },
      ],
    });
  });

  it('emits nothing when there is no queue snapshot and no orphan', () => {
    expect(formatSourceTrailers({ queueSha: null, orphans: [] })).toBe('');
  });

  it('parses trailers out of a full commit message body', () => {
    const message = [
      'chore(assets): reconcile queued sprite edits',
      '',
      'Art-surface harvest of assets/queue onto main (3 path(s)).',
      '',
      `Queue-Source: ${SHA_A}`,
    ].join('\n');
    expect(parseSourceTrailers(message).queueSha).toBe(SHA_A);
  });

  it('FAIL CLOSED: drops malformed trailers rather than guessing', () => {
    const message = [
      'Queue-Source: not-a-sha',
      `Queue-Source: ${SHA_A.slice(0, 39)}`,
      `Orphan-Source: assets/checkin-ok`, // missing sha
      `Orphan-Source: assets/checkin-ok ${SHA_B} extra`, // too many fields
      `Orphan-Source: main ${SHA_B}`, // not an assets/checkin-* branch
      `Orphan-Source: ../../etc/passwd ${SHA_B}`, // traversal attempt
      `Orphan-Source: assets/checkin-ok deadbeef`, // short sha
    ].join('\n');
    expect(parseSourceTrailers(message)).toEqual({ queueSha: null, orphans: [] });
  });

  it('FAIL CLOSED: format skips entries it would refuse to parse back', () => {
    const text = formatSourceTrailers({
      queueSha: 'nope',
      orphans: [
        { branch: 'main', sha: SHA_A },
        { branch: 'assets/checkin-ok', sha: 'short' },
        { branch: 'assets/checkin-ok', sha: SHA_B },
      ],
    });
    expect(text).toBe(`Orphan-Source: assets/checkin-ok ${SHA_B}`);
  });

  it('keeps only the first snapshot for a duplicated orphan branch', () => {
    const parsed = parseSourceTrailers(
      `Orphan-Source: assets/checkin-dup ${SHA_A}\nOrphan-Source: assets/checkin-dup ${SHA_B}`,
    );
    expect(parsed.orphans).toEqual([{ branch: 'assets/checkin-dup', sha: SHA_A }]);
  });
});

describe('findLandedPromotion / tidyUpLandedPromotion (real git)', () => {
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

  const TIDY_OPTIONS = {
    remote: 'origin',
    repo: undefined,
    promoteBranch: 'assets/promote',
    baseBranch: 'main',
    queueBranch: 'assets/queue',
  };

  /**
   * Land an open promotion the way GitHub does: squash its art onto `main`,
   * publish the permanent `refs/pull/<n>/head` ref, delete the promote branch,
   * and flip the fake PR to `merged`.
   */
  function landPromotion(liveDir: string, gh: FakeGh, prNumber: number, headSha: string): void {
    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/promote', 'main');
    gitSync(liveDir, 'push', 'origin', `${headSha}:refs/pull/${prNumber}/head`);
    // SQUASH merge, matching the repo merge policy: `main` gains a NEW commit
    // carrying the promotion's tree, so the promotion's own commits never become
    // ancestors of `main` (which is what bounds the trailer scan).
    const mainSha = gitSync(liveDir, 'rev-parse', 'origin/main').trim();
    const tree = gitSync(liveDir, 'rev-parse', `${headSha}^{tree}`).trim();
    const squashed = gitSync(
      liveDir,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Reconcile Test',
      'commit-tree',
      tree,
      '-p',
      mainSha,
      '-m',
      `squash promote #${prNumber}`,
    ).trim();
    gitSync(liveDir, 'push', 'origin', `${squashed}:refs/heads/main`);
    gitSync(liveDir, 'push', 'origin', '--delete', 'assets/promote');
    const pr = gh.prs.find((p) => p.number === prNumber)!;
    pr.state = 'merged';
    pr.headRefOid = headSha;
    pr.mergedAt = '2026-08-03T00:00:00Z';
  }

  /**
   * Land a NEW approval on top of an existing source branch (an approve/check-in
   * that races the promotion). Commits onto the branch's current tip so the
   * source advances past the harvested snapshot.
   */
  function advanceBranchWithArt(liveDir: string, branch: string, key: string): void {
    gitSync(
      liveDir,
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${branch}:refs/rq-test/${branch}`,
    );
    const wt = mkdtempSync(path.join(tmpdir(), 'rq-advance-'));
    try {
      gitSync(liveDir, 'worktree', 'add', wt, '--detach', `refs/rq-test/${branch}`);
      const genDir = path.join(wt, 'public', 'assets', 'generated');
      mkdirSync(genDir, { recursive: true });
      writeFileSync(path.join(genDir, `${key}.png`), PNG_BYTES);
      gitSync(wt, 'add', '--', 'public/assets/generated');
      gitSync(wt, 'commit', '--no-verify', '-m', `approve ${key}`);
      const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
      gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/${branch}`);
    } finally {
      gitSync(liveDir, 'worktree', 'remove', '--force', wt);
      rmSync(wt, { recursive: true, force: true });
    }
  }

  function remoteSha(liveDir: string, branch: string): string | null {
    const out = execFileSync('git', ['ls-remote', '--heads', 'origin', branch], {
      cwd: liveDir,
      encoding: 'utf8',
    });
    const sha = out.split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  it('records the harvested source tips on the promotion commit', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-trailer-1', ['orphan-sprite-var-9']);
    const queueSha = remoteSha(liveDir, 'assets/queue')!;
    const orphanSha = remoteSha(liveDir, 'assets/checkin-trailer-1')!;

    const gh = new FakeGh();
    const result = await runReconcile(liveDir, realDeps(gh));
    expect(result.status).toBe('pr-open');

    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/promote');
    const body = execFileSync('git', ['log', '-1', '--format=%B', result.promoteCommit!], {
      cwd: liveDir,
      encoding: 'utf8',
    });
    expect(parseSourceTrailers(body)).toEqual({
      queueSha,
      orphans: [{ branch: 'assets/checkin-trailer-1', sha: orphanSha }],
    });
  });

  it('retires the queue and the orphan branch once the promotion has MERGED', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-tidy-1', ['orphan-sprite-var-9']);

    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);

    const tidy = await tidyUpLandedPromotion(realGitFakeGhExec(gh), liveDir, TIDY_OPTIONS);
    expect(tidy.queueReset).toBe(true);
    expect(tidy.deletedBranches).toEqual(['assets/checkin-tidy-1']);
    // The queue now points at main, and the orphan branch is gone.
    expect(remoteSha(liveDir, 'assets/queue')).toBe(remoteSha(liveDir, 'main'));
    expect(remoteSha(liveDir, 'assets/checkin-tidy-1')).toBeNull();
  });

  it('CONVERGES: the very next cycle after a merged promotion is a no-op', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-converge-1', ['orphan-sprite-var-9']);

    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.status).toBe('pr-open');
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);

    // This is the regression the whole change exists for: before the tidy-up
    // the orphan branch was re-harvested every hour, so this second cycle
    // opened ANOTHER promotion PR with the same files, forever.
    const second = await runReconcile(liveDir, realDeps(gh));
    expect(second.status).toBe('noop');
    expect(second.tidiedQueue).toBe(true);
    expect(second.tidiedBranches).toEqual(['assets/checkin-converge-1']);
    expect(gh.prs.filter((p) => p.state === 'open')).toHaveLength(0);
  });

  it('CAS MISS: never discards art that landed on a source after the harvest', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-cas-1', ['orphan-sprite-var-9']);

    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);

    // A newly-approved asset lands on BOTH sources after the harvest.
    advanceBranchWithArt(liveDir, 'assets/queue', 'late-arrival-var-0');
    advanceBranchWithArt(liveDir, 'assets/checkin-cas-1', 'late-orphan-var-0');
    const queueAfter = remoteSha(liveDir, 'assets/queue');
    const orphanAfter = remoteSha(liveDir, 'assets/checkin-cas-1');

    const tidy = await tidyUpLandedPromotion(realGitFakeGhExec(gh), liveDir, TIDY_OPTIONS);
    expect(tidy.queueReset).toBe(false);
    expect(tidy.deletedBranches).toEqual([]);
    expect(remoteSha(liveDir, 'assets/queue')).toBe(queueAfter);
    expect(remoteSha(liveDir, 'assets/checkin-cas-1')).toBe(orphanAfter);
  });

  it('does nothing while the promotion is still open (not merged)', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    await runReconcile(liveDir, realDeps(gh));
    const queueBefore = remoteSha(liveDir, 'assets/queue');

    const tidy = await tidyUpLandedPromotion(realGitFakeGhExec(gh), liveDir, TIDY_OPTIONS);
    expect(tidy).toEqual({ queueReset: false, deletedBranches: [] });
    expect(remoteSha(liveDir, 'assets/queue')).toBe(queueBefore);
  });

  it('SECURITY: ignores a merged fork PR that reuses the promote branch name', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);
    gh.prs.find((p) => p.number === first.prNumber)!.isCrossRepository = true;

    const exec = realGitFakeGhExec(gh);
    expect(
      await findLandedPromotion(exec, liveDir, 'origin', undefined, 'assets/promote', 'main'),
    ).toBeNull();
    const tidy = await tidyUpLandedPromotion(exec, liveDir, TIDY_OPTIONS);
    expect(tidy).toEqual({ queueReset: false, deletedBranches: [] });
  });

  it('FAIL CLOSED: refuses to act when the reported head OID does not resolve', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);
    // GitHub reports a head the pull ref does not actually contain.
    gh.prs.find((p) => p.number === first.prNumber)!.headRefOid = SHA_A;

    const exec = realGitFakeGhExec(gh);
    expect(
      await findLandedPromotion(exec, liveDir, 'origin', undefined, 'assets/promote', 'main'),
    ).toBeNull();
  });

  it('FAIL CLOSED: a gh failure leaves every source in place', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    const queueBefore = remoteSha(liveDir, 'assets/queue');
    const exec: Exec = (command, args, options) =>
      command === 'gh'
        ? Promise.resolve({ stdout: '', stderr: 'gh boom', code: 1 })
        : realGitFakeGhExec(gh)(command, args, options);

    const tidy = await tidyUpLandedPromotion(exec, liveDir, TIDY_OPTIONS);
    expect(tidy).toEqual({ queueReset: false, deletedBranches: [] });
    expect(remoteSha(liveDir, 'assets/queue')).toBe(queueBefore);
  });

  it('REVERT SAFETY: never retires a source whose art was reverted off main', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-revert-1', ['orphan-sprite-var-9']);

    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);
    const queueAfter = remoteSha(liveDir, 'assets/queue');
    const orphanAfter = remoteSha(liveDir, 'assets/checkin-revert-1');

    // A human reverts the art promotion on main. "The PR merged" is now NO LONGER
    // proof that the art is on main — the source branches hold the only copies,
    // so retiring them would destroy the art.
    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
    gitSync(liveDir, 'push', 'origin', '+origin/main~1:refs/heads/main');

    const tidy = await tidyUpLandedPromotion(realGitFakeGhExec(gh), liveDir, TIDY_OPTIONS);
    expect(tidy).toEqual({ queueReset: false, deletedBranches: [] });
    expect(remoteSha(liveDir, 'assets/queue')).toBe(queueAfter);
    expect(remoteSha(liveDir, 'assets/checkin-revert-1')).toBe(orphanAfter);
  });

  it('REVERT SAFETY: queue retirement keeps legacy manifest paths in the proof', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithLegacyManifest(liveDir, []);

    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    expect(first.changedPaths).toEqual(['public/assets/generated/manifest.json']);
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);
    const queueAfter = remoteSha(liveDir, 'assets/queue');

    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
    gitSync(liveDir, 'push', 'origin', '+origin/main~1:refs/heads/main');

    const tidy = await tidyUpLandedPromotion(realGitFakeGhExec(gh), liveDir, TIDY_OPTIONS);
    expect(tidy).toEqual({ queueReset: false, deletedBranches: [] });
    expect(remoteSha(liveDir, 'assets/queue')).toBe(queueAfter);
  });

  it('FORGERY: a repair commit on the promotion cannot inject a branch deletion', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));

    // A branch the promotion NEVER harvested. It is pinned at `main`, so it adds
    // nothing to the art surface — meaning the revert guard would happily let it
    // go and ONLY the trailer-provenance check can save it.
    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
    gitSync(liveDir, 'push', 'origin', 'origin/main:refs/heads/assets/checkin-innocent');
    const innocentSha = remoteSha(liveDir, 'assets/checkin-innocent')!;

    // Simulate CI recovery pushing a repair commit onto the promotion whose
    // message claims a source snapshot the promotion never took.
    gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/promote');
    const forged = gitSync(
      liveDir,
      '-c',
      'user.email=ci@example.com',
      '-c',
      'user.name=CI Recovery',
      'commit-tree',
      `${first.promoteCommit!}^{tree}`,
      '-p',
      first.promoteCommit!,
      '-m',
      // Uses the EXACT promotion subject — a subject check alone would be
      // fooled, so this proves the uniqueness rule is what actually holds.
      `chore(assets): reconcile queued sprite edits\n\n` +
        `Orphan-Source: assets/checkin-innocent ${innocentSha}`,
    ).trim();
    gitSync(liveDir, 'push', 'origin', `+${forged}:refs/heads/assets/promote`);
    landPromotion(liveDir, gh, first.prNumber!, forged);

    const tidy = await tidyUpLandedPromotion(realGitFakeGhExec(gh), liveDir, TIDY_OPTIONS);
    // Two commits now claim the promotion subject, so provenance is ambiguous
    // and tidy-up fails closed: nothing is retired.
    expect(tidy).toEqual({ queueReset: false, deletedBranches: [] });
    expect(remoteSha(liveDir, 'assets/checkin-innocent')).toBe(innocentSha);
  });

  it('BASE RACE: aborts when main moves between the safety proof and the push', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    seedLegacyCheckinBranch(liveDir, 'assets/checkin-race-1', ['orphan-sprite-var-9']);

    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);
    const queueAfter = remoteSha(liveDir, 'assets/queue');
    const orphanAfter = remoteSha(liveDir, 'assets/checkin-race-1');

    // Revert `main` AFTER the proof has been computed against the fetched base
    // snapshot but BEFORE any destructive push, by reverting on the first
    // `ls-remote` of the base branch that the pre-push re-assertion performs.
    const real = realGitFakeGhExec(gh);
    let proofDone = false;
    const exec: Exec = (command, args, options) => {
      if (
        command === 'git' &&
        args[0] === 'ls-remote' &&
        args.includes('main') &&
        proofDone === false
      ) {
        proofDone = true;
        gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'main');
        gitSync(liveDir, 'push', 'origin', '+origin/main~1:refs/heads/main');
      }
      return real(command, args, options);
    };

    const tidy = await tidyUpLandedPromotion(exec, liveDir, TIDY_OPTIONS);
    expect(tidy).toEqual({ queueReset: false, deletedBranches: [] });
    expect(remoteSha(liveDir, 'assets/queue')).toBe(queueAfter);
    expect(remoteSha(liveDir, 'assets/checkin-race-1')).toBe(orphanAfter);
  });

  it('picks the newest merge by mergedAt, not by PR number', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    gh.next = 2;
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);
    // A LOWER-numbered promotion that merged LATER must win the ordering.
    const older = gh.seedMerged(
      'assets/promote',
      'main',
      first.promoteCommit!,
      '2026-08-02T00:00:00Z',
    );
    gitSync(liveDir, 'push', 'origin', `${first.promoteCommit!}:refs/pull/${older}/head`);

    const landed = await findLandedPromotion(
      realGitFakeGhExec(gh),
      liveDir,
      'origin',
      undefined,
      'assets/promote',
      'main',
    );
    expect(landed?.prNumber).toBe(first.prNumber);
  });

  it('rejects non-integer merged PR numbers', async () => {
    const { root, liveDir } = setupRepos();
    cleanups.push(root);
    seedQueueWithArt(liveDir, ['skull-mace-var-2']);
    const gh = new FakeGh();
    const first = await runReconcile(liveDir, realDeps(gh));
    landPromotion(liveDir, gh, first.prNumber!, first.promoteCommit!);
    const invalid = gh.seedMerged(
      'assets/promote',
      'main',
      first.promoteCommit!,
      '2026-08-04T00:00:00Z',
    );
    gh.prs.find((p) => p.number === invalid)!.number = 0.5 as unknown as number;

    const landed = await findLandedPromotion(
      realGitFakeGhExec(gh),
      liveDir,
      'origin',
      undefined,
      'assets/promote',
      'main',
    );

    expect(landed?.prNumber).toBe(first.prNumber);
  });
});
