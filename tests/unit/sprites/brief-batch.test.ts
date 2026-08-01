/**
 * Unit tests for brief-batch.ts pure planner/parser functions.
 *
 * Tests:
 *  - `parseBriefOnlyPRs`: JSON parsing, brief-only filtering, skip logic.
 *  - `planBriefBatch`: plan generation, dedup, conflict resolution.
 *  - `runBriefBatchConsolidation`: control-flow tests with a fake exec that
 *    records commands; proves the empty-queue short-circuit and the
 *    git/gh command sequence.
 */

import { describe, expect, it } from 'vitest';
import {
  parseBriefOnlyPRs,
  planBriefBatch,
  runBriefBatchConsolidation,
  type BriefBatchDeps,
  type BriefOnlyPR,
} from '../../../scripts/sprites/brief-batch.js';
import type { Exec, ExecResult } from '../../../scripts/sprites/checkin.js';

const NOW = new Date('2026-07-31T10:00:00Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeExec(
  responder: (command: string, args: readonly string[]) => Partial<ExecResult>,
): {
  exec: Exec;
  calls: Array<{ command: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd });
    return Promise.resolve({ stdout: '', stderr: '', code: 0, ...responder(command, args) });
  };
  return { exec, calls };
}

function controlDeps(exec: Exec): BriefBatchDeps {
  return {
    exec,
    makeTempDir: () => Promise.resolve('/tmp/fake-brief-batch-worktree'),
    removeDir: () => Promise.resolve(),
  };
}

/** Build a `diffsByHeadRef` map from a list of [headRef, files[]] pairs. */
function diffs(entries: Array<[string, string[]]>): Map<string, string> {
  return new Map(entries.map(([ref, files]) => [ref, files.join('\n')]));
}

// ---------------------------------------------------------------------------
// parseBriefOnlyPRs
// ---------------------------------------------------------------------------

describe('parseBriefOnlyPRs', () => {
  it('returns empty array for malformed JSON', () => {
    expect(parseBriefOnlyPRs('not json', new Map())).toEqual([]);
    expect(parseBriefOnlyPRs('{"x":1}', new Map())).toEqual([]);
  });

  it('returns empty array when no diff entries provided', () => {
    const json = JSON.stringify([{ number: 1, title: 'a', headRefName: 'feat/brief-a' }]);
    expect(parseBriefOnlyPRs(json, new Map())).toEqual([]);
  });

  it('returns empty array when diff has non-brief files', () => {
    const json = JSON.stringify([{ number: 1, title: 'a', headRefName: 'feat/brief-a' }]);
    const d = diffs([['feat/brief-a', ['briefs/enemies/foo.yaml', 'src/game/foo.ts']]]);
    expect(parseBriefOnlyPRs(json, d)).toEqual([]);
  });

  it('returns empty array when diff is empty (nothing changed vs main)', () => {
    const json = JSON.stringify([{ number: 1, title: 'a', headRefName: 'feat/brief-a' }]);
    const d = diffs([['feat/brief-a', []]]);
    expect(parseBriefOnlyPRs(json, d)).toEqual([]);
  });

  it('identifies a brief-only PR correctly', () => {
    const json = JSON.stringify([
      { number: 3, title: 'Add panda sniper brief', headRefName: 'copilot/panda-sniper-brief' },
    ]);
    const d = diffs([
      ['copilot/panda-sniper-brief', ['briefs/enemies/panda-boba-sniper.yaml']],
    ]);
    const result = parseBriefOnlyPRs(json, d);
    expect(result).toHaveLength(1);
    expect(result[0]?.number).toBe(3);
    expect(result[0]?.headRefName).toBe('copilot/panda-sniper-brief');
    expect(result[0]?.briefPaths).toEqual(['briefs/enemies/panda-boba-sniper.yaml']);
  });

  it('filters out non-brief-only PRs and keeps brief-only ones', () => {
    const json = JSON.stringify([
      { number: 1, title: 'brief only', headRefName: 'brief-only' },
      { number: 2, title: 'mixed', headRefName: 'mixed' },
      { number: 3, title: 'brief only 2', headRefName: 'brief-only-2' },
    ]);
    const d = diffs([
      ['brief-only', ['briefs/enemies/foo.yaml']],
      ['mixed', ['briefs/enemies/bar.yaml', 'src/game/bar.ts']],
      ['brief-only-2', ['briefs/weapons/sword.yaml']],
    ]);
    const result = parseBriefOnlyPRs(json, d);
    expect(result.map((r) => r.number)).toEqual([1, 3]);
  });

  it('returns results sorted by PR number (oldest first)', () => {
    const json = JSON.stringify([
      { number: 7, title: 'z', headRefName: 'ref-7' },
      { number: 3, title: 'a', headRefName: 'ref-3' },
      { number: 5, title: 'm', headRefName: 'ref-5' },
    ]);
    const d = diffs([
      ['ref-7', ['briefs/enemies/z.yaml']],
      ['ref-3', ['briefs/enemies/a.yaml']],
      ['ref-5', ['briefs/enemies/m.yaml']],
    ]);
    const result = parseBriefOnlyPRs(json, d);
    expect(result.map((r) => r.number)).toEqual([3, 5, 7]);
  });

  it('captures multiple brief paths from one PR', () => {
    const json = JSON.stringify([
      { number: 1, title: 'multi', headRefName: 'multi-brief' },
    ]);
    const d = diffs([
      ['multi-brief', ['briefs/enemies/foo.yaml', 'briefs/weapons/bar.yaml']],
    ]);
    const result = parseBriefOnlyPRs(json, d);
    expect(result[0]?.briefPaths).toEqual(['briefs/enemies/foo.yaml', 'briefs/weapons/bar.yaml']);
  });

  it('skips PRs with missing headRefName', () => {
    const json = JSON.stringify([{ number: 1, title: 'bad' }]);
    expect(parseBriefOnlyPRs(json, new Map())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// planBriefBatch
// ---------------------------------------------------------------------------

describe('planBriefBatch', () => {
  const pr1: BriefOnlyPR = {
    number: 3,
    title: 'panda brief',
    headRefName: 'copilot/panda',
    briefPaths: ['briefs/enemies/panda-boba-sniper.yaml'],
  };
  const pr2: BriefOnlyPR = {
    number: 7,
    title: 'ratfolk brief',
    headRefName: 'copilot/ratfolk',
    briefPaths: ['briefs/enemies/ratfolk-elite-underboss.yaml'],
  };

  it('throws when there are no PRs', () => {
    expect(() => planBriefBatch({ prs: [], now: NOW })).toThrow('no brief-only PRs');
  });

  it('produces correct batch branch name', () => {
    const plan = planBriefBatch({ prs: [pr1], now: NOW, slug: 'test-slug' });
    expect(plan.batchBranch).toBe('batch/test-slug');
  });

  it('uses timestamp-based slug when not provided', () => {
    const plan = planBriefBatch({ prs: [pr1], now: NOW });
    expect(plan.batchBranch).toBe('batch/briefs-20260731-100000');
  });

  it('deduplicates brief paths (last-writer-wins on same path)', () => {
    const pr3: BriefOnlyPR = {
      ...pr2,
      number: 9,
      briefPaths: ['briefs/enemies/panda-boba-sniper.yaml'], // same as pr1
    };
    const plan = planBriefBatch({ prs: [pr1, pr3], now: NOW });
    // panda path appears once
    expect(plan.allBriefPaths.filter((p) => p.includes('panda'))).toHaveLength(1);
  });

  it('sorts allBriefPaths alphabetically', () => {
    const plan = planBriefBatch({ prs: [pr2, pr1], now: NOW }); // reversed order
    expect(plan.allBriefPaths).toEqual([
      'briefs/enemies/panda-boba-sniper.yaml',
      'briefs/enemies/ratfolk-elite-underboss.yaml',
    ]);
  });

  it('includes all source PRs in plan', () => {
    const plan = planBriefBatch({ prs: [pr1, pr2], now: NOW });
    expect(plan.sourcePRs).toHaveLength(2);
    expect(plan.sourcePRs.map((p) => p.number)).toEqual([3, 7]);
  });

  it('includes PR numbers in PR body', () => {
    const plan = planBriefBatch({ prs: [pr1, pr2], now: NOW });
    expect(plan.prBody).toContain('#3');
    expect(plan.prBody).toContain('#7');
  });

  it('includes all brief paths in PR body', () => {
    const plan = planBriefBatch({ prs: [pr1, pr2], now: NOW });
    expect(plan.prBody).toContain('panda-boba-sniper.yaml');
    expect(plan.prBody).toContain('ratfolk-elite-underboss.yaml');
  });
});

// ---------------------------------------------------------------------------
// runBriefBatchConsolidation — control-flow (faked exec)
// ---------------------------------------------------------------------------

describe('runBriefBatchConsolidation', () => {
  const openPRsJson = JSON.stringify([
    { number: 3, title: 'panda brief', headRefName: 'copilot/panda' },
    { number: 7, title: 'ratfolk brief', headRefName: 'copilot/ratfolk' },
    { number: 99, title: 'mixed PR', headRefName: 'copilot/mixed' },
  ]);

  it('returns null when gh pr list returns empty array', async () => {
    const { exec } = makeFakeExec(() => ({ stdout: '[]' }));
    const result = await runBriefBatchConsolidation('/repo', controlDeps(exec), {});
    expect(result).toBeNull();
  });

  it('returns null when no PRs are brief-only', async () => {
    const { exec } = makeFakeExec((cmd, args) => {
      if (cmd === 'gh' && args.includes('list')) return { stdout: openPRsJson };
      if (cmd === 'git' && args.includes('fetch')) return { stdout: '', code: 0 };
      // All diffs return mixed (non-brief-only) output
      if (cmd === 'git' && args.includes('diff'))
        return { stdout: 'src/game/foo.ts\nbriefs/enemies/bar.yaml' };
      return {};
    });
    const result = await runBriefBatchConsolidation('/repo', controlDeps(exec), {});
    expect(result).toBeNull();
  });

  it('skips PRs whose branches are missing on the remote', async () => {
    const { exec, calls } = makeFakeExec((cmd, args) => {
      if (cmd === 'gh' && args.includes('list')) return { stdout: openPRsJson };
      if (cmd === 'git' && args[0] === 'fetch' && args[2] === 'origin') {
        const refspec = args[3] ?? '';
        // Simulate missing branch for copilot/panda
        if (refspec.includes('copilot/panda')) return { code: 128, stderr: 'not found' };
        if (refspec.includes('copilot/ratfolk')) return { code: 0 };
        if (refspec.includes('copilot/mixed')) return { code: 0 };
        return { code: 0 };
      }
      if (cmd === 'git' && args.includes('diff')) {
        if (args.some((a) => a.includes('copilot/ratfolk')))
          return { stdout: 'briefs/enemies/ratfolk-elite-underboss.yaml' };
        return { stdout: 'src/game/foo.ts' }; // mixed — filtered out
      }
      // Remaining git/gh calls for the batch creation
      if (cmd === 'gh' && args.includes('create'))
        return { stdout: 'https://github.com/nalfeo/Crawler/pull/200\n' };
      return {};
    });
    const result = await runBriefBatchConsolidation('/repo', controlDeps(exec), {
      slug: 'test-20260731',
    });
    expect(result).not.toBeNull();
    expect(result?.plan.sourcePRs).toHaveLength(1);
    expect(result?.plan.sourcePRs[0]?.headRefName).toBe('copilot/ratfolk');
    // copilot/panda should have been attempted but skipped
    const pandaFetch = calls.find(
      (c) => c.command === 'git' && c.args.includes('copilot/panda'),
    );
    expect(pandaFetch).toBeTruthy();
  });

  it('creates the batch branch and opens a PR', async () => {
    const { exec, calls } = makeFakeExec((cmd, args) => {
      if (cmd === 'gh' && args.includes('list')) return { stdout: openPRsJson };
      if (cmd === 'git' && args[0] === 'fetch') return { code: 0 };
      if (cmd === 'git' && args.includes('diff')) {
        if (args.some((a) => a.includes('copilot/panda')))
          return { stdout: 'briefs/enemies/panda-boba-sniper.yaml' };
        if (args.some((a) => a.includes('copilot/ratfolk')))
          return { stdout: 'briefs/enemies/ratfolk-elite-underboss.yaml' };
        return { stdout: 'src/game/foo.ts' }; // mixed — filtered
      }
      if (cmd === 'gh' && args.includes('create'))
        return { stdout: 'https://github.com/nalfeo/Crawler/pull/201\n' };
      return {};
    });

    const result = await runBriefBatchConsolidation('/repo', controlDeps(exec), {
      slug: 'test-batch',
    });

    expect(result?.prUrl).toBe('https://github.com/nalfeo/Crawler/pull/201');
    expect(result?.plan.batchBranch).toBe('batch/test-batch');
    expect(result?.plan.sourcePRs).toHaveLength(2);

    // Verify git worktree add was called
    const worktreeAdd = calls.find(
      (c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add',
    );
    expect(worktreeAdd).toBeTruthy();
    expect(worktreeAdd?.args).toContain('batch/test-batch');

    // Verify brief files were checked out explicitly (not via wildcard)
    const checkouts = calls.filter(
      (c) => c.command === 'git' && c.args[0] === 'checkout' && c.args.some(p => p.startsWith('briefs/')),
    );
    expect(checkouts.length).toBeGreaterThanOrEqual(2);
    const checkedOutPaths = checkouts.map((c) => c.args.find((a) => a.startsWith('briefs/')));
    expect(checkedOutPaths).toContain('briefs/enemies/panda-boba-sniper.yaml');
    expect(checkedOutPaths).toContain('briefs/enemies/ratfolk-elite-underboss.yaml');

    // Verify git add, commit, push, and gh pr create were called
    const gitAdd = calls.find((c) => c.command === 'git' && c.args[0] === 'add');
    expect(gitAdd?.args).toContain('briefs/');
    const gitCommit = calls.find((c) => c.command === 'git' && c.args[0] === 'commit');
    expect(gitCommit?.args).toContain('-m');
    const gitPush = calls.find((c) => c.command === 'git' && c.args[0] === 'push');
    expect(gitPush?.args).toContain('batch/test-batch');
    const ghCreate = calls.find((c) => c.command === 'gh' && c.args.includes('create'));
    expect(ghCreate).toBeTruthy();
  });

  it('uses three-dot diff to compare against merge base', async () => {
    const { exec, calls } = makeFakeExec((cmd, args) => {
      if (cmd === 'gh' && args.includes('list'))
        return { stdout: JSON.stringify([{ number: 1, title: 't', headRefName: 'feat/brief' }]) };
      if (cmd === 'git' && args[0] === 'fetch') return { code: 0 };
      if (cmd === 'git' && args.includes('diff'))
        return { stdout: 'briefs/enemies/foo.yaml' };
      if (cmd === 'gh' && args.includes('create'))
        return { stdout: 'https://github.com/nalfeo/Crawler/pull/1\n' };
      return {};
    });

    await runBriefBatchConsolidation('/repo', controlDeps(exec), {});

    const diffCall = calls.find((c) => c.command === 'git' && c.args.includes('diff'));
    expect(diffCall).toBeTruthy();
    // Three-dot diff: origin/main...origin/<headRef>
    const diffArg = diffCall?.args.find((a) => a.includes('...'));
    expect(diffArg).toMatch(/origin\/main\.\.\.origin\//);
  });
});
