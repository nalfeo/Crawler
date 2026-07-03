/**
 * Unit tests for asset-pr.ts pure planning/parsing.
 *
 * The executor (`runAssetPrConsolidation`) is integration-shaped (git/gh) and
 * is exercised here only for its empty-queue short-circuit with a fake exec;
 * the merge math it relies on is covered by asset-issues.test.ts.
 */

import { createRequire } from 'node:module';
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

// Bind the PR-title assertions to the SAME rules the `commit-lint` CI gate uses
// (commitlint.title.config.cjs) instead of a hand-rolled copy, so the regression
// test can never pass while CI blocks — e.g. if the allowed type-enum or the
// header-max-length change, this test picks up the new values automatically.
const requireCjs = createRequire(import.meta.url);
const titleCommitlint = requireCjs('../../../commitlint.title.config.cjs') as {
  rules: {
    'type-enum': [number, string, readonly string[]];
    'header-max-length': [number, string, number];
  };
};
const ALLOWED_COMMIT_TYPES = titleCommitlint.rules['type-enum'][2];
const MAX_HEADER_LENGTH = titleCommitlint.rules['header-max-length'][2];

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
    // PR title is the squash-merge subject linted by the commit-lint CI job, so
    // it MUST be a conventional commit — regression guard for the missing prefix
    // that blocked every asset PR on commit-lint.
    expect(plan.prTitle).toBe('feat(sprites): add 2 approved assets (2 check-ins)');
  });

  it('emits a PR title that satisfies the real commit-lint title config (squash-merge subject)', () => {
    // Squash-merge uses the PR title as the commit subject on main, which the
    // `commit-lint` CI gate validates via commitlint.title.config.cjs. Assert
    // against that config's OWN type-enum + header-max-length so the test can't
    // pass while CI blocks. Regression guard: the title was `Add N approved
    // assets (…)` with no type prefix, which failed commit-lint (type-empty) and
    // left the art PR BLOCKED from merging.
    const single = planConsolidation({ issues: [issues[0]!], now: NOW });
    const multi = planConsolidation({ issues, now: NOW });
    const header = /^(?<type>[a-z]+)(?:\([^)]+\))?: .+/;
    for (const plan of [single, multi]) {
      const match = header.exec(plan.prTitle);
      expect(match, `PR title is not conventional-commit format: ${plan.prTitle}`).not.toBeNull();
      expect(ALLOWED_COMMIT_TYPES).toContain(match!.groups!.type);
      expect(plan.prTitle.length).toBeLessThanOrEqual(MAX_HEADER_LENGTH);
    }
    expect(single.prTitle).toContain('1 approved asset (1 check-in)');
    expect(multi.prTitle).toContain('2 approved assets (2 check-ins)');
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
      env: {},
    });
    expect(result).toBeNull();
  });

  it('refuses to run under CI (local-only, mirrors runAssetCheckin)', async () => {
    const exec: Exec = () => {
      throw new Error('exec must not run when CI guard trips');
    };
    await expect(
      runAssetPrConsolidation('/repo', {
        exec,
        makeTempDir: () => Promise.resolve('/tmp/x'),
        removeDir: () => Promise.resolve(),
        readJson: () => Promise.resolve({} as never),
        writeJson: () => Promise.resolve(),
        env: { CI: 'true' },
      }),
    ).rejects.toThrow(/local-only/);
  });
});
