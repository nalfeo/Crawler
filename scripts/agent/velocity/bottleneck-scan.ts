/**
 * Bottleneck scan — the observational half of the velocity system.
 *
 * Applies a DevLake-style value-stream model to Crawler's own delivery data and
 * reports where lead time actually goes. The distinction that matters is
 * **queue time vs. active time**: a stage that is slow because work is waiting
 * is a completely different problem from a stage that is slow because work is
 * happening, and only the former is usually cheap to fix.
 *
 * Stages, derived from merged-PR timestamps:
 *   open → first review      QUEUE   (nobody has looked yet)
 *   first review → last push ACTIVE  (rework in response to review)
 *   last push → merge        QUEUE   (CI + merge gate)
 *
 * Everything comes from `gh` plus files already committed in this repo, so the
 * scan needs no database, no Docker, and no new infrastructure.
 *
 *   npm run velocity:scan -- [--limit 60] [--out files/velocity-bottlenecks.json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { median } from './stats.js';

const HOUR_MS = 3600_000;

interface PrRecord {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviews?: { submittedAt?: string | null }[];
  commits?: { committedDate?: string | null }[];
}

export interface StageTiming {
  prNumber: number;
  title: string;
  leadTimeH: number;
  reviewQueueH: number | null;
  reworkH: number | null;
  mergeQueueH: number | null;
  reviewRounds: number;
  churn: number;
}

export interface BottleneckReport {
  schema: 'crawler-velocity-bottlenecks/v1';
  generatedAt: string;
  prsAnalyzed: number;
  stages: {
    name: string;
    kind: 'queue' | 'active';
    medianHours: number;
    shareOfLeadTime: number;
  }[];
  medianLeadTimeH: number;
  leadTimeBySize: { bucket: string; prs: number; medianLeadTimeH: number }[];
  slowest: StageTiming[];
  estimationAccuracy: {
    sessions: number;
    exact: number;
    under: number;
    over: number;
    medianAbsDelta: number;
  } | null;
  guardFriction: { guard: string; allow: number; deny: number }[];
  findings: string[];
}

function hoursBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / HOUR_MS;
}

export function computeStageTimings(prs: readonly PrRecord[]): StageTiming[] {
  const timings: StageTiming[] = [];
  for (const pr of prs) {
    if (!pr.mergedAt) continue;

    const reviewTimes = (pr.reviews ?? [])
      .map((r) => r.submittedAt)
      .filter((value): value is string => typeof value === 'string')
      .sort();
    const commitTimes = (pr.commits ?? [])
      .map((c) => c.committedDate)
      .filter((value): value is string => typeof value === 'string')
      .sort();

    const firstReview = reviewTimes[0] ?? null;
    const lastCommit = commitTimes[commitTimes.length - 1] ?? null;

    timings.push({
      prNumber: pr.number,
      title: pr.title,
      leadTimeH: hoursBetween(pr.createdAt, pr.mergedAt),
      reviewQueueH: firstReview ? Math.max(0, hoursBetween(pr.createdAt, firstReview)) : null,
      reworkH:
        firstReview && lastCommit ? Math.max(0, hoursBetween(firstReview, lastCommit)) : null,
      mergeQueueH: lastCommit ? Math.max(0, hoursBetween(lastCommit, pr.mergedAt)) : null,
      reviewRounds: reviewTimes.length,
      churn: pr.additions + pr.deletions,
    });
  }
  return timings;
}

function definedMedian(values: readonly (number | null)[]): number {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return present.length === 0 ? 0 : median(present);
}

export function bucketBySize(timings: readonly StageTiming[]): BottleneckReport['leadTimeBySize'] {
  const buckets: { bucket: string; test: (churn: number) => boolean }[] = [
    { bucket: '≤100 lines', test: (c) => c <= 100 },
    { bucket: '101–500 lines', test: (c) => c > 100 && c <= 500 },
    { bucket: '501–2000 lines', test: (c) => c > 500 && c <= 2000 },
    { bucket: '>2000 lines', test: (c) => c > 2000 },
  ];
  return buckets.map(({ bucket, test }) => {
    const matching = timings.filter((t) => test(t.churn));
    return {
      bucket,
      prs: matching.length,
      medianLeadTimeH: matching.length === 0 ? 0 : median(matching.map((t) => t.leadTimeH)),
    };
  });
}

export function readEstimationAccuracy(root: string): BottleneckReport['estimationAccuracy'] {
  const dir = join(root, 'docs/knowledge/metrics/apples');
  if (!existsSync(dir)) return null;
  const deltas: number[] = [];
  let exact = 0;
  let under = 0;
  let over = 0;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        estimated_apples?: number;
        actual_apples?: number;
      };
      const estimated = record.estimated_apples;
      const actual = record.actual_apples;
      if (typeof estimated !== 'number' || typeof actual !== 'number') continue;
      const delta = actual - estimated;
      deltas.push(Math.abs(delta));
      if (delta === 0) exact++;
      else if (delta > 0) under++;
      else over++;
    } catch {
      // A malformed record should not sink the whole scan.
    }
  }
  if (deltas.length === 0) return null;
  return {
    sessions: deltas.length,
    exact,
    under,
    over,
    medianAbsDelta: median(deltas),
  };
}

export function readGuardFriction(root: string): BottleneckReport['guardFriction'] {
  const dir = join(root, 'docs/knowledge/metrics/guard-telemetry');
  if (!existsSync(dir)) return [];
  const totals = new Map<string, { allow: number; deny: number }>();

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        quarantined?: boolean;
        guards?: Record<string, { allow?: number; deny?: number }>;
      };
      if (record.quarantined) continue;
      for (const [guard, counts] of Object.entries(record.guards ?? {})) {
        const entry = totals.get(guard) ?? { allow: 0, deny: 0 };
        entry.allow += counts.allow ?? 0;
        entry.deny += counts.deny ?? 0;
        totals.set(guard, entry);
      }
    } catch {
      // Ignore unreadable telemetry captures.
    }
  }
  return [...totals.entries()]
    .map(([guard, counts]) => ({ guard, ...counts }))
    .sort((a, b) => b.deny - a.deny);
}

export function deriveFindings(report: Omit<BottleneckReport, 'findings'>): string[] {
  const findings: string[] = [];

  const ranked = [...report.stages].sort((a, b) => b.medianHours - a.medianHours);
  const worst = ranked[0];
  if (worst && worst.medianHours > 0) {
    findings.push(
      `Largest stage is "${worst.name}" (${worst.kind}) at a median of ${worst.medianHours.toFixed(1)}h, ` +
        `${(worst.shareOfLeadTime * 100).toFixed(0)}% of lead time.` +
        (worst.kind === 'queue'
          ? ' It is QUEUE time — work is waiting, not being done, which is usually the cheapest kind of time to remove.'
          : ' It is ACTIVE time — reducing it needs a real capability change, not just scheduling.'),
    );
  }

  const large = report.leadTimeBySize.find((b) => b.bucket === '>2000 lines');
  const small = report.leadTimeBySize.find((b) => b.bucket === '≤100 lines');
  if (large && small && large.prs >= 3 && small.prs >= 3 && small.medianLeadTimeH > 0) {
    const ratio = large.medianLeadTimeH / small.medianLeadTimeH;
    if (ratio >= 2) {
      findings.push(
        `Large PRs (>2000 lines) take ${ratio.toFixed(1)}× the lead time of small ones — ` +
          `batch size is a live bottleneck; test a decomposition-policy arm in the lab.`,
      );
    }
  }

  const estimation = report.estimationAccuracy;
  if (estimation && estimation.sessions >= 5) {
    const underRate = estimation.under / estimation.sessions;
    if (underRate >= 0.4) {
      findings.push(
        `${(underRate * 100).toFixed(0)}% of recorded sessions came in OVER their apple estimate ` +
          `(median absolute error ${estimation.medianAbsDelta.toFixed(1)}🍎). Systematic ` +
          `under-estimation inflates queue time downstream because work is scheduled against a fiction.`,
      );
    }
  }

  const noisyGuards = report.guardFriction.filter((g) => g.deny > 0);
  if (noisyGuards.length > 0) {
    const top = noisyGuards[0] as { guard: string; deny: number; allow: number };
    findings.push(
      `Guard "${top.guard}" denied ${top.deny} call(s) across captured sessions. Each denial is a ` +
        `retry loop; check whether the guard is catching real violations or mis-firing.`,
    );
  }

  if (findings.length === 0) {
    findings.push('No stage dominates lead time at this sample size. Widen --limit before acting.');
  }
  return findings;
}

function fetchMergedPrs(root: string, limit: number): PrRecord[] {
  const raw = execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(limit),
      '--json',
      'number,title,createdAt,mergedAt,additions,deletions,changedFiles,reviews,commits',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  return JSON.parse(raw) as PrRecord[];
}

export function buildReport(root: string, prs: readonly PrRecord[]): BottleneckReport {
  const timings = computeStageTimings(prs);
  const medianLeadTimeH = timings.length === 0 ? 0 : median(timings.map((t) => t.leadTimeH));

  const rawStages = [
    {
      name: 'open → first review',
      kind: 'queue' as const,
      medianHours: definedMedian(timings.map((t) => t.reviewQueueH)),
    },
    {
      name: 'first review → last push',
      kind: 'active' as const,
      medianHours: definedMedian(timings.map((t) => t.reworkH)),
    },
    {
      name: 'last push → merge',
      kind: 'queue' as const,
      medianHours: definedMedian(timings.map((t) => t.mergeQueueH)),
    },
  ];
  const stages = rawStages.map((stage) => ({
    ...stage,
    shareOfLeadTime: medianLeadTimeH > 0 ? stage.medianHours / medianLeadTimeH : 0,
  }));

  const partial: Omit<BottleneckReport, 'findings'> = {
    schema: 'crawler-velocity-bottlenecks/v1',
    generatedAt: new Date().toISOString(),
    prsAnalyzed: timings.length,
    stages,
    medianLeadTimeH,
    leadTimeBySize: bucketBySize(timings),
    slowest: [...timings].sort((a, b) => b.leadTimeH - a.leadTimeH).slice(0, 5),
    estimationAccuracy: readEstimationAccuracy(root),
    guardFriction: readGuardFriction(root),
  };
  return { ...partial, findings: deriveFindings(partial) };
}

function render(report: BottleneckReport): string {
  const lines: string[] = [];
  lines.push(`\n═══ Crawler delivery bottleneck scan ═══`);
  lines.push(
    `${report.prsAnalyzed} merged PRs · median lead time ${report.medianLeadTimeH.toFixed(1)}h\n`,
  );
  lines.push('Stage                        Kind     Median(h)   Share');
  lines.push('─'.repeat(58));
  for (const stage of report.stages) {
    lines.push(
      stage.name.padEnd(29) +
        stage.kind.padEnd(9) +
        stage.medianHours.toFixed(1).padStart(9) +
        `${(stage.shareOfLeadTime * 100).toFixed(0)}%`.padStart(8),
    );
  }

  lines.push('\nLead time by PR size:');
  for (const bucket of report.leadTimeBySize) {
    lines.push(
      `  ${bucket.bucket.padEnd(16)} n=${String(bucket.prs).padStart(3)}  ${bucket.medianLeadTimeH.toFixed(1)}h`,
    );
  }

  if (report.estimationAccuracy) {
    const e = report.estimationAccuracy;
    lines.push(
      `\nApple estimation: ${e.sessions} sessions · ${e.exact} exact / ${e.under} under-estimated / ` +
        `${e.over} over-estimated · median |error| ${e.medianAbsDelta.toFixed(1)}🍎`,
    );
  }

  lines.push('\nFindings:');
  for (const finding of report.findings) lines.push(`  • ${finding}`);
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
  };
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const limit = Number(flag('limit', '60'));

  const report = buildReport(root, fetchMergedPrs(root, limit));
  const out = resolve(root, flag('out', 'files/velocity-bottlenecks.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(render(report));
  process.stdout.write(`Report → ${out}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
