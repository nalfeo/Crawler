/**
 * Unit tests for asset-pr.ts pure planning/parsing.
 *
 * The executor (`runAssetPrConsolidation`) is integration-shaped (git/gh) and
 * is exercised here only for its empty-queue short-circuit with a fake exec;
 * the merge math it relies on is covered by asset-issues.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  planAssetCheckin,
  type CheckinAsset,
  type Exec,
} from '../../../scripts/sprites/checkin.js';
import {
  parseOpenAssetIssues,
  planConsolidation,
  runAssetPrConsolidation,
  type AssetIssue,
} from '../../../scripts/sprites/asset-pr.js';

const NOW = new Date('2026-06-09T10:00:00Z');

function asset(over: Partial<CheckinAsset> = {}): CheckinAsset {
  return {
    assetPath: 'generated/skull-mace-var-2.png',
    manifestKey: 'skull-mace-var-2',
    briefId: 'skull-mace',
    variantIndex: 2,
    ...over,
  };
}

function issueBody(branch: string, assets: CheckinAsset[]): string {
  // Reuse the real writer so the parser is tested against real output.
  return planAssetCheckin({ assets, now: NOW, slug: branch.replace('assets/', '') }).issueBody;
}

describe('parseOpenAssetIssues', () => {
  it('extracts issues that carry a valid payload, sorted by number', () => {
    const json = JSON.stringify([
      {
        number: 7,
        title: 'b',
        body: issueBody('assets/b', [asset({ assetPath: 'generated/b-var-1.png' })]),
      },
      { number: 3, title: 'a', body: issueBody('assets/a', [asset()]) },
      { number: 9, title: 'no-payload', body: 'just text, no marker' },
    ]);
    const issues = parseOpenAssetIssues(json);
    expect(issues.map((i) => i.number)).toEqual([3, 7]);
    expect(issues[0]!.payload.branch).toBe('assets/a');
  });

  it('returns [] for malformed JSON or a non-array', () => {
    expect(parseOpenAssetIssues('not json')).toEqual([]);
    expect(parseOpenAssetIssues('{"number":1}')).toEqual([]);
  });
});

describe('planConsolidation', () => {
  const issues: AssetIssue[] = [
    {
      number: 3,
      title: 'a',
      payload: { version: 1, branch: 'assets/a', baseBranch: 'main', assets: [asset()] },
    },
    {
      number: 7,
      title: 'b',
      payload: {
        version: 1,
        branch: 'assets/b',
        baseBranch: 'main',
        assets: [
          asset({
            assetPath: 'generated/b-var-1.png',
            manifestKey: 'b-var-1',
            briefId: 'b',
            variantIndex: 1,
          }),
        ],
      },
    },
  ];

  it('produces a batch branch, dedup source branches, and a Closes-each-issue body', () => {
    const plan = planConsolidation({ issues, now: NOW });
    expect(plan.batchBranch).toMatch(/^assets\/batch-\d{8}-\d{6}$/);
    expect(plan.sourceBranches).toEqual(['assets/a', 'assets/b']);
    expect(plan.issueNumbers).toEqual([3, 7]);
    expect(plan.assets).toHaveLength(2);
    expect(plan.prBody).toContain('Closes #3');
    expect(plan.prBody).toContain('Closes #7');
    expect(plan.commitMessage).toContain('2 approved assets');
  });

  it('dedupes assets that appear in multiple issues by assetPath', () => {
    const dup: AssetIssue[] = [
      issues[0]!,
      {
        number: 8,
        title: 'dup',
        payload: { version: 1, branch: 'assets/dup', baseBranch: 'main', assets: [asset()] },
      },
    ];
    const plan = planConsolidation({ issues: dup, now: NOW });
    expect(plan.assets).toHaveLength(1);
    expect(plan.sourceBranches).toEqual(['assets/a', 'assets/dup']);
  });

  it('throws on an empty issue list', () => {
    expect(() => planConsolidation({ issues: [], now: NOW })).toThrow();
  });
});

describe('runAssetPrConsolidation', () => {
  it('returns null (no-op) when there are no open issues', async () => {
    const exec: Exec = (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return Promise.resolve({ stdout: '[]', stderr: '', code: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    };
    const result = await runAssetPrConsolidation('/repo', {
      exec,
      makeTempDir: () => Promise.resolve('/tmp/x'),
      removeDir: () => Promise.resolve(),
      readJson: () => Promise.resolve({} as never),
      writeJson: () => Promise.resolve(),
    });
    expect(result).toBeNull();
  });
});
