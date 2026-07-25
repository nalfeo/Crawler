import { describe, expect, it } from 'vitest';

// @ts-expect-error CI scripts are authored as ESM JavaScript, not typed app modules.
import { classifyParkedRun } from '../../.github/scripts/ci-recovery/action-required-retrigger.mjs';

const baseRun = {
  id: 123,
  conclusion: 'action_required',
  event: 'pull_request',
  path: '.github/workflows/ci.yml',
  head_sha: 'abc',
};

const basePull = {
  state: 'open',
  head: { repo: { full_name: 'nalfeo/Crawler' }, sha: 'abc' },
};

describe('action-required retrigger classification', () => {
  it('accepts latest parked required same-repo PR workflow runs', () => {
    expect(
      classifyParkedRun({
        run: baseRun,
        pull: basePull,
        latestRun: baseRun,
        repository: 'nalfeo/Crawler',
      }),
    ).toBeNull();
  });

  it('rejects stale parked runs after a newer run exists', () => {
    expect(
      classifyParkedRun({
        run: baseRun,
        pull: basePull,
        latestRun: { ...baseRun, id: 124 },
        repository: 'nalfeo/Crawler',
      }),
    ).toBe('stale-run');
  });

  it('rejects non-required workflows and moved PR heads', () => {
    expect(
      classifyParkedRun({
        run: { ...baseRun, path: '.github/workflows/merge-train.yml' },
        pull: basePull,
        latestRun: { ...baseRun, path: '.github/workflows/merge-train.yml' },
        repository: 'nalfeo/Crawler',
      }),
    ).toBe('workflow-not-required');
    expect(
      classifyParkedRun({
        run: baseRun,
        pull: { ...basePull, head: { ...basePull.head, sha: 'def' } },
        latestRun: baseRun,
        repository: 'nalfeo/Crawler',
      }),
    ).toBe('head-moved');
  });
});
