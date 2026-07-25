import { describe, expect, it } from 'vitest';
import {
  bucketBySize,
  computeStageTimings,
  deriveFindings,
  type BottleneckReport,
  type StageTiming,
} from '../../../scripts/agent/velocity/bottleneck-scan';

const HOUR = 3600_000;
const START = Date.parse('2026-07-01T00:00:00.000Z');
const at = (hours: number) => new Date(START + hours * HOUR).toISOString();

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
