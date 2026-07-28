import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReport,
  bucketBySize,
  collectMergedPrPages,
  computeOpenPrAging,
  computeStageTimings,
  deriveFindings,
  fetchOpenPrs,
  fetchMergedPrs,
  type BottleneckReport,
  type OpenPrRecord,
  type StageTiming,
} from '../../../scripts/agent/velocity/bottleneck-scan';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const HOUR = 3600_000;
const START = Date.parse('2026-07-01T00:00:00.000Z');
const at = (hours: number) => new Date(START + hours * HOUR).toISOString();

function graphqlPage(
  prs: Array<Record<string, unknown>>,
  endCursor: string | null,
  hasNextPage: boolean,
) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { endCursor, hasNextPage },
          nodes: prs.map((pr) => ({
            ...pr,
            reviews: { nodes: [] },
            commits: { nodes: [] },
          })),
        },
      },
    },
  });
}

function openPrGraphqlPage(
  prs: Array<Record<string, unknown>>,
  endCursor: string | null,
  hasNextPage: boolean,
) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { endCursor, hasNextPage },
          nodes: prs.map((pr) => ({
            title: `PR ${String(pr.number ?? 'unknown')}`,
            createdAt: at(0),
            updatedAt: at(1),
            labels: { nodes: [] },
            ...pr,
          })),
        },
      },
    },
  });
}

describe('computeStageTimings', () => {
  it('splits lead time into review queue, rework, and merge queue', () => {
    const [timing] = computeStageTimings([
      {
        number: 1,
        title: 'PR',
        createdAt: at(0),
        mergedAt: at(10),
        additions: 50,
        deletions: 10,
        changedFiles: 3,
        reviews: [{ submittedAt: at(2) }, { submittedAt: at(6) }],
        commits: [{ committedDate: at(1) }, { committedDate: at(7) }],
      },
    ]);
    expect(timing?.leadTimeH).toBe(10);
    expect(timing?.reviewQueueH).toBe(2);
    expect(timing?.reworkH).toBe(5);
    expect(timing?.mergeQueueH).toBe(3);
    expect(timing?.reviewRounds).toBe(2);
    expect(timing?.churn).toBe(60);
  });

  it('skips unmerged PRs, which have no lead time', () => {
    expect(
      computeStageTimings([
        {
          number: 2,
          title: 'open',
          createdAt: at(0),
          mergedAt: null,
          additions: 1,
          deletions: 0,
          changedFiles: 1,
        },
      ]),
    ).toHaveLength(0);
  });

  it('returns null stages rather than fabricating zeros when a PR was never reviewed', () => {
    const [timing] = computeStageTimings([
      {
        number: 3,
        title: 'no review',
        createdAt: at(0),
        mergedAt: at(4),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        reviews: [],
        commits: [{ committedDate: at(1) }],
      },
    ]);
    expect(timing?.reviewQueueH).toBeNull();
    expect(timing?.reworkH).toBeNull();
    expect(timing?.mergeQueueH).toBe(3);
  });

  it('clamps negative intervals caused by out-of-order timestamps', () => {
    const [timing] = computeStageTimings([
      {
        number: 4,
        title: 'weird',
        createdAt: at(0),
        mergedAt: at(5),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        reviews: [{ submittedAt: at(4) }],
        commits: [{ committedDate: at(1) }],
      },
    ]);
    expect(timing?.reworkH).toBe(0);
    expect(timing?.mergeQueueH).toBe(1);
    expect((timing?.reviewQueueH ?? 0) + (timing?.reworkH ?? 0) + (timing?.mergeQueueH ?? 0)).toBe(
      5,
    );
  });

  it('never starts merge queue before PR creation when commit metadata is older', () => {
    const [timing] = computeStageTimings([
      {
        number: 5,
        title: 'old commit date',
        createdAt: at(10),
        mergedAt: at(14),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        reviews: [],
        commits: [{ committedDate: at(1) }],
      },
    ]);
    expect(timing?.mergeQueueH).toBe(4);
    expect(timing?.leadTimeH).toBe(4);
  });
});

describe('bucketBySize', () => {
  it('buckets PRs by churn and reports a median per bucket', () => {
    const timings = [
      { churn: 50, leadTimeH: 2 },
      { churn: 300, leadTimeH: 8 },
      { churn: 3000, leadTimeH: 40 },
    ] as StageTiming[];
    const buckets = bucketBySize(timings);
    expect(buckets.find((b) => b.bucket === '≤100 lines')?.medianLeadTimeH).toBe(2);
    expect(buckets.find((b) => b.bucket === '>2000 lines')?.medianLeadTimeH).toBe(40);
    expect(buckets.find((b) => b.bucket === '501–2000 lines')?.prs).toBe(0);
  });
});

describe('fetchMergedPrs', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('pages merged PR fetches below the GitHub GraphQL node ceiling', () => {
    const firstPage = Array.from({ length: 25 }, (_, index) => ({
      number: index + 1,
      title: `PR ${index + 1}`,
      createdAt: at(0),
      mergedAt: at(10 - index * 0.01),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    }));
    const oldest = firstPage.at(-1)!.mergedAt;
    const secondPage = [
      firstPage.at(-1)!,
      {
        number: 26,
        title: 'PR 26',
        createdAt: at(0),
        mergedAt: oldest,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      },
      {
        number: 27,
        title: 'PR 27',
        createdAt: at(0),
        mergedAt: at(1),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      },
    ];
    vi.mocked(execFileSync)
      .mockReturnValueOnce('nalfeo/Crawler')
      .mockReturnValueOnce(graphqlPage(firstPage, 'CURSOR_1', true))
      .mockReturnValueOnce(graphqlPage(secondPage, null, false));

    const prs = fetchMergedPrs('repo-root', 27);

    expect(prs.map((pr) => pr.number)).toEqual(Array.from({ length: 27 }, (_, index) => index + 1));
    expect(execFileSync).toHaveBeenCalledTimes(3);
    const repoArgs = vi.mocked(execFileSync).mock.calls[0]![1] as string[];
    expect(repoArgs).toEqual(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    const secondArgs = vi.mocked(execFileSync).mock.calls[2]![1] as string[];
    expect(secondArgs).toContain('api');
    expect(secondArgs).toContain('graphql');
    expect(secondArgs).toContain('cursor=CURSOR_1');
  });

  it('stops instead of looping forever when a page adds no unseen PRs', () => {
    const repeated = [
      {
        number: 1,
        title: 'PR 1',
        createdAt: at(0),
        mergedAt: at(1),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      },
    ];
    vi.mocked(execFileSync)
      .mockReturnValueOnce('nalfeo/Crawler')
      .mockReturnValueOnce(graphqlPage(repeated, 'CURSOR_1', true))
      .mockReturnValueOnce(graphqlPage(repeated, 'CURSOR_2', true));

    expect(fetchMergedPrs('repo-root', 2).map((pr) => pr.number)).toEqual([1]);
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });
});

describe('fetchOpenPrs', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('returns an empty array when GitHub reports no open PRs', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('nalfeo/Crawler')
      .mockReturnValueOnce(openPrGraphqlPage([], null, false));

    expect(fetchOpenPrs('repo-root')).toEqual([]);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('maps label nodes to plain strings', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('nalfeo/Crawler')
      .mockReturnValueOnce(
        openPrGraphqlPage(
          [
            {
              number: 1,
              labels: {
                nodes: [{ name: 'ci-conflict-order-wait' }, { name: 'merge-conflict' }],
              },
            },
          ],
          null,
          false,
        ),
      );

    expect(fetchOpenPrs('repo-root')).toEqual([
      {
        number: 1,
        title: 'PR 1',
        createdAt: at(0),
        updatedAt: at(1),
        labels: ['ci-conflict-order-wait', 'merge-conflict'],
      },
    ]);
  });

  it('pages through open PRs using the GraphQL cursor', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('nalfeo/Crawler')
      .mockReturnValueOnce(openPrGraphqlPage([{ number: 1 }], 'CURSOR_1', true))
      .mockReturnValueOnce(openPrGraphqlPage([{ number: 2 }], null, false));

    const prs = fetchOpenPrs('repo-root');

    expect(prs.map((pr) => pr.number)).toEqual([1, 2]);
    const secondArgs = vi.mocked(execFileSync).mock.calls[2]![1] as string[];
    expect(secondArgs).toContain('cursor=CURSOR_1');
  });
});

function report(overrides: Partial<Omit<BottleneckReport, 'findings'>>) {
  return {
    schema: 'crawler-velocity-bottlenecks/v1' as const,
    generatedAt: at(0),
    prsAnalyzed: 10,
    stages: [],
    medianLeadTimeH: 10,
    leadTimeBySize: [],
    slowest: [],
    estimationAccuracy: null,
    guardFriction: [],
    openPrAging: null,
    ...overrides,
  };
}

describe('deriveFindings', () => {
  it('names the dominant stage and distinguishes queue from active time', () => {
    const findings = deriveFindings(
      report({
        stages: [
          { name: 'open → first review', kind: 'queue', medianHours: 8, shareOfLeadTime: 0.8 },
          {
            name: 'first review → last push',
            kind: 'active',
            medianHours: 1,
            shareOfLeadTime: 0.1,
          },
        ],
      }),
    );
    expect(findings.join('\n')).toMatch(/open → first review/);
    expect(findings.join('\n')).toMatch(/QUEUE time/);
  });

  it('flags batch size when large PRs are much slower', () => {
    const findings = deriveFindings(
      report({
        leadTimeBySize: [
          { bucket: '≤100 lines', prs: 5, medianLeadTimeH: 4 },
          { bucket: '>2000 lines', prs: 4, medianLeadTimeH: 40 },
        ],
      }),
    );
    expect(findings.join('\n')).toMatch(/batch size is a live bottleneck/);
  });

  it('flags systematic under-estimation', () => {
    const findings = deriveFindings(
      report({
        estimationAccuracy: { sessions: 10, exact: 2, under: 6, over: 2, medianAbsDelta: 1 },
      }),
    );
    expect(findings.join('\n')).toMatch(/OVER their apple estimate/);
  });

  it('reports honestly when the sample shows nothing', () => {
    expect(deriveFindings(report({})).join('\n')).toMatch(/Widen --limit/);
  });
});

describe('collectMergedPrPages', () => {
  it('keeps paging by stable cursor when merge order differs from creation order', () => {
    const calls: Array<string | null | undefined> = [];
    const prs = collectMergedPrPages((_pageSize, cursor) => {
      calls.push(cursor);
      if (!cursor) {
        return {
          prs: [
            {
              number: 30,
              title: 'newest created',
              createdAt: at(30),
              mergedAt: at(90),
              additions: 1,
              deletions: 0,
              changedFiles: 1,
            },
            {
              number: 20,
              title: 'older created',
              createdAt: at(20),
              mergedAt: at(70),
              additions: 1,
              deletions: 0,
              changedFiles: 1,
            },
          ],
          hasNextPage: true,
          endCursor: 'CURSOR_1',
        };
      }
      return {
        prs: [
          {
            number: 10,
            title: 'long lived but merged late',
            createdAt: at(10),
            mergedAt: at(85),
            additions: 1,
            deletions: 0,
            changedFiles: 1,
          },
        ],
        hasNextPage: false,
        endCursor: null,
      };
    }, 3);

    expect(calls).toEqual([null, 'CURSOR_1']);
    expect(prs.map((pr) => pr.number)).toEqual([30, 20, 10]);
  });
});

// ─── Helpers for open-PR aging tests ────────────────────────────────────────

function openPr(number: number, ageH: number, labels: string[] = [], idleH?: number): OpenPrRecord {
  const now = START + 100 * HOUR; // reference "now" = t+100h
  return {
    number,
    title: `PR ${number}`,
    createdAt: new Date(now - ageH * HOUR).toISOString(),
    updatedAt: new Date(now - (idleH ?? ageH) * HOUR).toISOString(),
    labels,
  };
}

const NOW = new Date(START + 100 * HOUR).toISOString();

describe('computeOpenPrAging', () => {
  it('returns zeroed panel for an empty list', () => {
    const panel = computeOpenPrAging([], NOW);
    expect(panel.openPrs).toBe(0);
    expect(panel.maxAgeH).toBe(0);
    expect(panel.oldest).toHaveLength(0);
    expect(panel.labelBreakdown).toHaveLength(0);
  });

  it('computes p50 / p90 / max / countAbove4H from age distribution', () => {
    // ages: 1h, 2h, 4h, 8h, 16h, 32h → sorted [1,2,4,8,16,32]
    const prs = [1, 2, 4, 8, 16, 32].map((ageH, idx) => openPr(idx + 1, ageH));
    const panel = computeOpenPrAging(prs, NOW);

    expect(panel.openPrs).toBe(6);
    expect(panel.maxAgeH).toBeCloseTo(32, 5);
    expect(panel.p50AgeH).toBeCloseTo(4, 5); // nearest-rank p50 of 6 → idx 2 = 4
    expect(panel.p90AgeH).toBeCloseTo(32, 5); // nearest-rank p90 of 6 → idx 5 = 32
    // ages > 4h: 8, 16, 32 → 3
    expect(panel.countAbove4H).toBe(3);
  });

  it('surfaces only known blocking labels in the breakdown', () => {
    const prs = [
      openPr(1, 10, ['ci-conflict-order-wait']),
      openPr(2, 5, ['ci-conflict-order-wait', 'merge-conflict']),
      openPr(3, 2, ['some-other-label']),
    ];
    const panel = computeOpenPrAging(prs, NOW);

    expect(panel.labelBreakdown).toContainEqual({ label: 'ci-conflict-order-wait', count: 2 });
    expect(panel.labelBreakdown).toContainEqual({ label: 'merge-conflict', count: 1 });
    expect(panel.labelBreakdown.find((e) => e.label === 'some-other-label')).toBeUndefined();
  });

  it('returns the 5 oldest entries ordered by total age descending', () => {
    const prs = [1, 2, 3, 4, 5, 6, 7].map((ageH, idx) => openPr(idx + 1, ageH));
    const panel = computeOpenPrAging(prs, NOW);

    expect(panel.oldest).toHaveLength(5);
    expect(panel.oldest[0]?.prNumber).toBe(7); // age 7h
    expect(panel.oldest[4]?.prNumber).toBe(3); // age 3h
  });

  it('reports idleH from updatedAt, not createdAt', () => {
    // PR created 20h ago, but last updated only 3h ago
    const pr = openPr(1, 20, [], 3);
    const panel = computeOpenPrAging([pr], NOW);
    expect(panel.oldest[0]?.ageH).toBeCloseTo(20, 5);
    expect(panel.oldest[0]?.idleH).toBeCloseTo(3, 5);
  });

  it('oldest entries expose only blocking labels, not unrelated ones', () => {
    const pr = openPr(1, 10, ['ci-conflict-order-wait', 'some-other-label']);
    const panel = computeOpenPrAging([pr], NOW);
    expect(panel.oldest[0]?.labels).toEqual(['ci-conflict-order-wait']);
  });

  // ── 2026-07-27 scenario simulation ───────────────────────────────────────
  // Simulates the 18-PR ci-conflict-order-wait stall that ran unnoticed for 64h.
  // Based on confirmed incident facts (18 PRs, max ~64h, PR #1976 as oldest);
  // per-PR ages and the conflicting subset are constructed, not captured.
  it('2026-07-27 scenario: 18 PRs carrying ci-conflict-order-wait for up to 64h is obviously alarming', () => {
    const ages = [64, 62, 58, 55, 48, 44, 40, 36, 32, 28, 24, 18, 14, 10, 8, 6, 4, 2];
    expect(ages).toHaveLength(18);

    const prs: OpenPrRecord[] = ages.map((ageH, idx) => {
      const labels: string[] = ['ci-conflict-order-wait'];
      if (idx < 7) labels.push('merge-conflict'); // the genuinely conflicting subset
      return openPr(1976 + idx, ageH, labels);
    });

    const panel = computeOpenPrAging(prs, NOW);

    expect(panel.openPrs).toBe(18);
    expect(panel.maxAgeH).toBeCloseTo(64, 5);
    expect(panel.p90AgeH).toBeGreaterThan(40); // p90 of 18 → idx 15 = 36+, well above threshold
    expect(panel.countAbove4H).toBe(16); // all but the 2h and 4h PRs (threshold is > 4h)
    expect(panel.labelBreakdown).toContainEqual({ label: 'ci-conflict-order-wait', count: 18 });
    expect(panel.labelBreakdown).toContainEqual({ label: 'merge-conflict', count: 7 });

    // The oldest entry should be the head-of-line offender (PR #1976, 64h)
    expect(panel.oldest[0]?.prNumber).toBe(1976);
    expect(panel.oldest[0]?.ageH).toBeCloseTo(64, 5);

    // deriveFindings must produce a STALL ALARM with this panel
    const findings = deriveFindings(
      report({
        openPrAging: panel,
        stages: [
          { name: 'last push → merge', kind: 'queue', medianHours: 4, shareOfLeadTime: 0.4 },
        ],
      }),
    );
    const text = findings.join('\n');
    expect(text).toMatch(/STALL ALARM/);
    expect(text).toMatch(/64\.0h/);
    expect(text).toMatch(/ci-conflict-order-wait/);
  });
});

describe('deriveFindings (open PR aging)', () => {
  it('emits a STALL ALARM when max age is at or above 24h', () => {
    const panel = computeOpenPrAging([openPr(1, 30, ['merge-train-blocked'])], NOW);
    const findings = deriveFindings(report({ openPrAging: panel }));
    expect(findings.join('\n')).toMatch(/STALL ALARM/);
    expect(findings.join('\n')).toMatch(/merge-train-blocked/);
  });

  it('emits a watch warning when max age is between 8h and 24h', () => {
    const panel = computeOpenPrAging([openPr(1, 12)], NOW);
    const findings = deriveFindings(report({ openPrAging: panel }));
    expect(findings.join('\n')).toMatch(/Watch for a growing queue/);
    expect(findings.join('\n')).not.toMatch(/STALL ALARM/);
  });

  it('does not emit an age warning for healthy queues (max < 8h)', () => {
    const panel = computeOpenPrAging([openPr(1, 3)], NOW);
    const findings = deriveFindings(report({ openPrAging: panel }));
    expect(findings.join('\n')).not.toMatch(/STALL ALARM/);
    expect(findings.join('\n')).not.toMatch(/Watch for a growing queue/);
  });

  it('flags a dominant blocking label when 3 or more PRs share it', () => {
    const prs = [
      openPr(1, 30, ['ci-conflict-order-wait']),
      openPr(2, 20, ['ci-conflict-order-wait']),
      openPr(3, 10, ['ci-conflict-order-wait']),
    ];
    const panel = computeOpenPrAging(prs, NOW);
    const findings = deriveFindings(report({ openPrAging: panel }));
    expect(findings.join('\n')).toMatch(/ci-conflict-order-wait/);
    expect(findings.join('\n')).toMatch(/head-of-line blocking/);
  });

  it('notes missing blocking label on alarming PR', () => {
    const panel = computeOpenPrAging([openPr(99, 48, [])], NOW);
    const findings = deriveFindings(report({ openPrAging: panel }));
    expect(findings.join('\n')).toMatch(/STALL ALARM/);
    expect(findings.join('\n')).toMatch(/no blocking label/);
  });
});

describe('buildReport', () => {
  it('keeps a supplied empty open-PR snapshot instead of treating it as unavailable', () => {
    const report = buildReport('/tmp/repo', [], [], NOW);
    expect(report.openPrAging).toEqual({
      openPrs: 0,
      p50AgeH: 0,
      p90AgeH: 0,
      maxAgeH: 0,
      countAbove4H: 0,
      labelBreakdown: [],
      oldest: [],
    });
  });

  it('uses null only when the caller omits open-PR data entirely', () => {
    const report = buildReport('/tmp/repo', [], undefined, NOW);
    expect(report.openPrAging).toBeNull();
  });
});
