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
 * Also includes an **open-PR aging panel** to surface stalls while they are
 * happening, not just reconstructible afterward from merged-PR history.
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

/** Labels that indicate a PR is blocked in a known way. */
export const BLOCKING_LABELS = [
  'ci-conflict-order-wait',
  'merge-train-blocked',
  'human-approval-required',
  'merge-conflict',
] as const;

export type BlockingLabel = (typeof BLOCKING_LABELS)[number];

/**
 * Labels applied by CI when a PR is closed without ever merging. These mark the
 * repo's abandoned-work stream: a session burned agent time and CI minutes and
 * produced nothing that landed.
 */
export const WASTE_LABELS = ['ci-lifecycle-abandoned', 'copilot-empty-draft-repaired'] as const;

/** Bucket used when a closed-unmerged PR carries none of {@link WASTE_LABELS}. */
export const UNLABELED_WASTE_BUCKET = '(no lifecycle label)';

/**
 * Waste rate at which the scan raises a finding. Below this, closed-unmerged PRs
 * are ordinary churn (superseded work, duplicates); above it, abandonment is a
 * delivery bottleneck in its own right.
 */
export const WASTE_RATE_ALERT = 0.15;

/** Minimum closed-PR sample before the waste rate is trustworthy enough to act on. */
export const WASTE_MIN_SAMPLE = 20;

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

/** A single open PR as returned from GitHub GraphQL. */
export interface OpenPrRecord {
  number: number;
  title: string;
  createdAt: string;
  /** Timestamp of the most recent event on the PR (GitHub `updatedAt`). */
  updatedAt: string;
  labels: string[];
}

/** A closed PR (merged or abandoned) as returned from GitHub GraphQL. */
export interface ClosedPrRecord {
  number: number;
  title: string;
  closedAt: string;
  /** True when the PR actually landed; false when it was closed unmerged. */
  merged: boolean;
  labels: string[];
}

export interface AbandonedPrEntry {
  prNumber: number;
  title: string;
  closedAt: string;
  labels: string[];
}

export interface AbandonedWastePanel {
  /** Closed PRs in the sampled window (merged + abandoned). */
  closedPrs: number;
  merged: number;
  abandoned: number;
  /** `abandoned / closedPrs`, or 0 for an empty window. */
  wasteRate: number;
  /** Per-lifecycle-label breakdown of abandoned PRs, ordered by count descending. */
  labelBreakdown: { label: string; count: number }[];
  /** The 5 most recently closed abandoned PRs. */
  recent: AbandonedPrEntry[];
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

export interface OpenPrAgingEntry {
  prNumber: number;
  title: string;
  /** Total age since creation, in hours. */
  ageH: number;
  /** Hours since any recorded PR activity (`updatedAt`). */
  idleH: number;
  labels: string[];
}

export interface OpenPrAgingPanel {
  openPrs: number;
  p50AgeH: number;
  p90AgeH: number;
  maxAgeH: number;
  /** Count of open PRs older than 4 hours — the first-alert threshold. */
  countAbove4H: number;
  /** Per-blocking-label breakdown, ordered by count descending. */
  labelBreakdown: { label: string; count: number }[];
  /** The 5 oldest open PRs, ordered by total age descending. */
  oldest: OpenPrAgingEntry[];
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
  /** Open-PR aging panel. null when the caller does not supply open-PR data. */
  openPrAging: OpenPrAgingPanel | null;
  /** Abandoned-PR waste panel. null when the caller does not supply closed-PR data. */
  abandonedWaste: AbandonedWastePanel | null;
  findings: string[];
}

interface MergedPrPage {
  prs: PrRecord[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function hoursBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / HOUR_MS;
}

function maxIsoDate(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Nearest-rank percentile (1-indexed) on a pre-sorted ascending array.
 * p is in [0, 100]. Returns 0 for empty arrays.
 */
function sortedPercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

/**
 * Compute the open-PR aging panel from a snapshot of open PRs.
 *
 * @param prs    Open PR records, as fetched from GitHub (or a test fixture).
 * @param now    ISO timestamp to treat as "now" — injected for deterministic testing.
 */
export function computeOpenPrAging(prs: readonly OpenPrRecord[], now: string): OpenPrAgingPanel {
  if (prs.length === 0) {
    return {
      openPrs: 0,
      p50AgeH: 0,
      p90AgeH: 0,
      maxAgeH: 0,
      countAbove4H: 0,
      labelBreakdown: [],
      oldest: [],
    };
  }

  const nowMs = Date.parse(now);
  const ageHours = prs.map((pr) => (nowMs - Date.parse(pr.createdAt)) / HOUR_MS);
  const sorted = [...ageHours].sort((a, b) => a - b);

  const labelCounts = new Map<string, number>();
  for (const pr of prs) {
    for (const label of pr.labels) {
      if ((BLOCKING_LABELS as readonly string[]).includes(label)) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }
  }

  const oldest = [...prs]
    .map((pr) => ({
      prNumber: pr.number,
      title: pr.title,
      ageH: (nowMs - Date.parse(pr.createdAt)) / HOUR_MS,
      idleH: Math.max(0, (nowMs - Date.parse(pr.updatedAt)) / HOUR_MS),
      labels: pr.labels.filter((l) => (BLOCKING_LABELS as readonly string[]).includes(l)),
    }))
    .sort((a, b) => b.ageH - a.ageH)
    .slice(0, 5);

  return {
    openPrs: prs.length,
    p50AgeH: sortedPercentile(sorted, 50),
    p90AgeH: sortedPercentile(sorted, 90),
    maxAgeH: sorted[sorted.length - 1] ?? 0,
    countAbove4H: ageHours.filter((h) => h > 4).length,
    labelBreakdown: [...labelCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    oldest,
  };
}

/**
 * Compute the abandoned-PR waste panel from a window of closed PRs.
 *
 * Merged-PR stage timings only measure work that *landed*; a PR that is closed
 * without merging costs the same agent session and CI minutes but contributes
 * nothing, so it never appears in lead time. This panel makes that waste stream
 * visible.
 *
 * @param prs Closed PR records (both merged and abandoned) for the sampled window.
 */
export function computeAbandonedWaste(prs: readonly ClosedPrRecord[]): AbandonedWastePanel {
  const abandoned = prs.filter((pr) => !pr.merged);
  const labelCounts = new Map<string, number>();

  for (const pr of abandoned) {
    const wasteLabels = pr.labels.filter((l) => (WASTE_LABELS as readonly string[]).includes(l));
    if (wasteLabels.length === 0) {
      labelCounts.set(UNLABELED_WASTE_BUCKET, (labelCounts.get(UNLABELED_WASTE_BUCKET) ?? 0) + 1);
      continue;
    }
    for (const label of wasteLabels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }

  return {
    closedPrs: prs.length,
    merged: prs.length - abandoned.length,
    abandoned: abandoned.length,
    wasteRate: prs.length === 0 ? 0 : abandoned.length / prs.length,
    labelBreakdown: [...labelCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        // On a tie, real lifecycle labels rank above the catch-all bucket.
        if (a.label === UNLABELED_WASTE_BUCKET) return 1;
        if (b.label === UNLABELED_WASTE_BUCKET) return -1;
        return a.label.localeCompare(b.label);
      }),
    recent: [...abandoned]
      .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
      .slice(0, 5)
      .map((pr) => ({
        prNumber: pr.number,
        title: pr.title,
        closedAt: pr.closedAt,
        labels: pr.labels.filter((l) => (WASTE_LABELS as readonly string[]).includes(l)),
      })),
  };
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
    const mergeQueueStart =
      lastCommit == null
        ? null
        : maxIsoDate(
            lastCommit,
            firstReview ? maxIsoDate(firstReview, pr.createdAt) : pr.createdAt,
          );

    timings.push({
      prNumber: pr.number,
      title: pr.title,
      leadTimeH: hoursBetween(pr.createdAt, pr.mergedAt),
      reviewQueueH: firstReview ? Math.max(0, hoursBetween(pr.createdAt, firstReview)) : null,
      reworkH:
        firstReview && mergeQueueStart
          ? Math.max(0, hoursBetween(firstReview, mergeQueueStart))
          : null,
      mergeQueueH: mergeQueueStart ? Math.max(0, hoursBetween(mergeQueueStart, pr.mergedAt)) : null,
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

/**
 * Guard-specific remediation hints for the top guard friction finding.
 *
 * When a guard appears as the top denial source across captured sessions, the
 * bottleneck scan emits this remediation text so agents know exactly which
 * command to run to avoid the denial loop on the next PR — rather than the
 * generic "check whether the guard is mis-firing" fallback.
 *
 * Each entry maps a guard ID to a short imperative instruction. The key must
 * match the guard ID string recorded in the guard-telemetry JSON files.
 */
export const GUARD_REMEDIATION: Readonly<Record<string, string>> = {
  'pr-review-ledger':
    'run `npm run verify:pr-prereqs` before `create_pull_request` to surface missing or incomplete ledger files early and avoid the denial loop',
  'pr-preflight':
    'run `npm run verify:pr-prereqs` before `create_pull_request` to catch missing handoffs, ADR requirements, and forbidden-path violations ahead of the gate',
};

export function deriveFindings(report: Omit<BottleneckReport, 'findings'>): string[] {
  const findings: string[] = [];

  // Open-PR aging findings — surface stalls while they are happening.
  const aging = report.openPrAging;
  if (aging && aging.openPrs > 0) {
    if (aging.maxAgeH >= 24) {
      const head = aging.oldest[0];
      const blockDesc = head
        ? head.labels.length > 0
          ? ` (blocked: ${head.labels.join(', ')})`
          : ' (no blocking label — may be awaiting human review)'
        : '';
      findings.push(
        `⚠ STALL ALARM: oldest open PR age is ${aging.maxAgeH.toFixed(1)}h` +
          (head ? ` — PR #${head.prNumber} "${head.title}"${blockDesc}` : '') +
          `. ${aging.countAbove4H} of ${aging.openPrs} open PRs are older than 4h.`,
      );
    } else if (aging.maxAgeH >= 8) {
      findings.push(
        `Oldest open PR is ${aging.maxAgeH.toFixed(1)}h old (p90=${aging.p90AgeH.toFixed(1)}h). ` +
          `Watch for a growing queue.`,
      );
    }

    const topBlocker = aging.labelBreakdown[0];
    if (topBlocker && topBlocker.count >= 3) {
      findings.push(
        `${topBlocker.count} open PRs carry "${topBlocker.label}" — this label is head-of-line ` +
          `blocking them. Investigate the label's owner to unblock.`,
      );
    }
  }

  // Abandoned-PR waste — work that consumed a session but never landed.
  const waste = report.abandonedWaste;
  if (waste && waste.closedPrs >= WASTE_MIN_SAMPLE && waste.wasteRate >= WASTE_RATE_ALERT) {
    const top = waste.labelBreakdown[0];
    const cause = top
      ? ` Dominant class: "${top.label}" (${top.count} of ${waste.abandoned}).`
      : '';
    findings.push(
      `${waste.abandoned} of ${waste.closedPrs} closed PRs (${(waste.wasteRate * 100).toFixed(0)}%) ` +
        `never merged — that work consumed agent sessions and CI minutes and shipped nothing, and ` +
        `it is invisible in merged-PR lead time.${cause} Validate whether the dominant class reflects ` +
        `a fixable automation pattern before acting on this finding.`,
    );
  }

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
    const remediation = GUARD_REMEDIATION[top.guard];
    const tail = remediation
      ? ` Suggested fix: ${remediation}.`
      : ' Check whether the guard is catching real violations or mis-firing.';
    findings.push(
      `Guard "${top.guard}" denied ${top.deny} call(s) across captured sessions (estimated ` +
        `${top.deny * 2}+ avoidable extra tool calls). Each denial is a retry loop.${tail}`,
    );
  }

  if (findings.length === 0) {
    findings.push('No stage dominates lead time at this sample size. Widen --limit before acting.');
  }
  return findings;
}

/**
 * `gh pr list --json commits,reviews` costs roughly
 * `limit × 100 commits × 100 authors` GraphQL nodes, so anything above ~50 PRs
 * per request trips GitHub's hard 500,000-node ceiling. Page in small chunks,
 * but keep a stable PR-creation sort with GraphQL `endCursor` so long-lived PRs
 * are neither skipped nor duplicated when merge order differs from creation order.
 */
const PR_PAGE_SIZE = 25;

function fetchRepositorySlug(root: string): { owner: string; repo: string } {
  const slug = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  ).trim();
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new Error(`Could not determine repository slug from gh repo view output: ${slug}`);
  }
  return { owner, repo };
}

function fetchMergedPrPage(
  root: string,
  repository: { owner: string; repo: string },
  pageSize: number,
  cursor?: string | null,
): MergedPrPage {
  const query = `
    query($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(
          states: MERGED
          first: $pageSize
          after: $cursor
          orderBy: { field: CREATED_AT, direction: DESC }
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            createdAt
            mergedAt
            additions
            deletions
            changedFiles
            reviews(first: 100) {
              nodes { submittedAt }
            }
            commits(first: 100) {
              nodes {
                commit { committedDate }
              }
            }
          }
        }
      }
    }`;
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-F',
    `owner=${repository.owner}`,
    '-F',
    `repo=${repository.repo}`,
    '-F',
    `pageSize=${pageSize}`,
  ];
  if (cursor) {
    args.push('-F', `cursor=${cursor}`);
  }
  const raw = execFileSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequests?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            number: number;
            title: string;
            createdAt: string;
            mergedAt: string | null;
            additions: number;
            deletions: number;
            changedFiles: number;
            reviews?: { nodes?: Array<{ submittedAt?: string | null }> };
            commits?: { nodes?: Array<{ commit?: { committedDate?: string | null } }> };
          }>;
        };
      };
    };
  };
  const connection = parsed.data?.repository?.pullRequests;
  return {
    prs: (connection?.nodes ?? []).map((pr) => ({
      number: pr.number,
      title: pr.title,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      reviews: (pr.reviews?.nodes ?? []).map((review) => ({
        submittedAt: review.submittedAt ?? null,
      })),
      commits: (pr.commits?.nodes ?? []).map((commit) => ({
        committedDate: commit.commit?.committedDate ?? null,
      })),
    })),
    hasNextPage: connection?.pageInfo?.hasNextPage === true,
    endCursor: connection?.pageInfo?.endCursor ?? null,
  };
}

export function collectMergedPrPages(
  fetchPage: (pageSize: number, cursor?: string | null) => MergedPrPage,
  limit: number,
): PrRecord[] {
  const collected: PrRecord[] = [];
  const seen = new Set<number>();
  let cursor: string | null = null;

  while (collected.length < limit) {
    const page = fetchPage(Math.min(PR_PAGE_SIZE, limit - collected.length), cursor);
    if (page.prs.length === 0) break;

    let added = 0;
    for (const pr of page.prs) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      collected.push(pr);
      added += 1;
    }
    if (added === 0 || !page.hasNextPage || !page.endCursor) break;
    cursor = page.endCursor;
  }

  return collected.slice(0, limit);
}

export function fetchMergedPrs(root: string, limit: number): PrRecord[] {
  const repository = fetchRepositorySlug(root);
  return collectMergedPrPages(
    (pageSize, cursor) => fetchMergedPrPage(root, repository, pageSize, cursor),
    limit,
  );
}

/**
 * Fetch all currently-open PRs with their labels and timestamps.
 * Uses a simple paginated GraphQL query — no commits or reviews needed.
 */
export function fetchOpenPrs(root: string): OpenPrRecord[] {
  const repository = fetchRepositorySlug(root);
  const query = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(
          states: OPEN
          first: 100
          after: $cursor
          orderBy: { field: CREATED_AT, direction: DESC }
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            createdAt
            updatedAt
            labels(first: 100) {
              nodes { name }
            }
          }
        }
      }
    }`;

  const collected: OpenPrRecord[] = [];
  let cursor: string | null = null;

  for (;;) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${repository.owner}`,
      '-F',
      `repo=${repository.repo}`,
    ];
    if (cursor) {
      args.push('-F', `cursor=${cursor}`);
    }
    const raw = execFileSync('gh', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as {
      data?: {
        repository?: {
          pullRequests?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: Array<{
              number: number;
              title: string;
              createdAt: string;
              updatedAt: string;
              labels?: { nodes?: Array<{ name: string }> };
            }>;
          };
        };
      };
    };
    const connection = parsed.data?.repository?.pullRequests;
    for (const pr of connection?.nodes ?? []) {
      collected.push({
        number: pr.number,
        title: pr.title,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        labels: (pr.labels?.nodes ?? []).map((l) => l.name),
      });
    }
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    cursor = connection.pageInfo.endCursor;
  }

  return collected;
}

/**
 * Fetch the most recently closed PRs (merged and unmerged) with their labels.
 *
 * Deliberately lighter than {@link fetchMergedPrs}: no commits or reviews, so a
 * single page covers the whole window without risking GraphQL's node ceiling.
 */
export function fetchClosedPrs(root: string, limit: number): ClosedPrRecord[] {
  const repository = fetchRepositorySlug(root);
  const query = `
    query($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(
          states: [MERGED, CLOSED]
          first: $pageSize
          after: $cursor
          orderBy: { field: CREATED_AT, direction: DESC }
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            closedAt
            merged
            labels(first: 100) {
              nodes { name }
            }
          }
        }
      }
    }`;

  const collected: ClosedPrRecord[] = [];
  const seen = new Set<number>();
  let cursor: string | null = null;

  while (collected.length < limit) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${repository.owner}`,
      '-F',
      `repo=${repository.repo}`,
      '-F',
      `pageSize=${Math.min(100, limit - collected.length)}`,
    ];
    if (cursor) {
      args.push('-F', `cursor=${cursor}`);
    }
    const raw = execFileSync('gh', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as {
      data?: {
        repository?: {
          pullRequests?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: Array<{
              number: number;
              title: string;
              closedAt: string | null;
              merged: boolean;
              labels?: { nodes?: Array<{ name: string }> };
            }>;
          };
        };
      };
    };
    const connection = parsed.data?.repository?.pullRequests;
    const nodes = connection?.nodes ?? [];
    if (nodes.length === 0) break;

    let added = 0;
    for (const pr of nodes) {
      if (seen.has(pr.number) || pr.closedAt == null) continue;
      seen.add(pr.number);
      collected.push({
        number: pr.number,
        title: pr.title,
        closedAt: pr.closedAt,
        merged: pr.merged,
        labels: (pr.labels?.nodes ?? []).map((l) => l.name),
      });
      added += 1;
    }
    if (added === 0 || !connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    cursor = connection.pageInfo.endCursor;
  }

  return collected.slice(0, limit);
}

export function buildReport(
  root: string,
  prs: readonly PrRecord[],
  openPrRecords?: readonly OpenPrRecord[],
  now: string = new Date().toISOString(),
  closedPrRecords?: readonly ClosedPrRecord[],
): BottleneckReport {
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
    generatedAt: now,
    prsAnalyzed: timings.length,
    stages,
    medianLeadTimeH,
    leadTimeBySize: bucketBySize(timings),
    slowest: [...timings].sort((a, b) => b.leadTimeH - a.leadTimeH).slice(0, 5),
    estimationAccuracy: readEstimationAccuracy(root),
    guardFriction: readGuardFriction(root),
    openPrAging: openPrRecords ? computeOpenPrAging(openPrRecords, now) : null,
    abandonedWaste: closedPrRecords ? computeAbandonedWaste(closedPrRecords) : null,
  };
  return { ...partial, findings: deriveFindings(partial) };
}

export function render(report: BottleneckReport): string {
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

  const aging = report.openPrAging;
  if (aging) {
    const stallFlag = aging.maxAgeH >= 24 ? ' ← ⚠ STALL ALARM' : '';
    lines.push(`\n─── Open PR aging ───`);
    lines.push(
      `${aging.openPrs} open PRs · p50=${aging.p50AgeH.toFixed(1)}h · ` +
        `p90=${aging.p90AgeH.toFixed(1)}h · MAX=${aging.maxAgeH.toFixed(1)}h${stallFlag}`,
    );
    lines.push(`${aging.countAbove4H} PRs older than 4h`);

    if (aging.labelBreakdown.length > 0) {
      lines.push('Blocking labels:');
      for (const entry of aging.labelBreakdown) {
        lines.push(`  ${String(entry.count).padStart(3)}  ${entry.label}`);
      }
    }

    if (aging.oldest.length > 0) {
      lines.push('Oldest open PRs:');
      for (const pr of aging.oldest) {
        const labelStr = pr.labels.length > 0 ? `  [${pr.labels.join(', ')}]` : '';
        const stateStr = `idle=${pr.idleH.toFixed(1)}h`;
        lines.push(
          `  #${String(pr.prNumber).padEnd(6)} ${pr.ageH.toFixed(1)}h (${stateStr})${labelStr}  ${pr.title}`,
        );
      }
    }
  }

  const waste = report.abandonedWaste;
  if (waste) {
    const alarm =
      waste.closedPrs >= WASTE_MIN_SAMPLE && waste.wasteRate >= WASTE_RATE_ALERT
        ? ' ← ⚠ WASTE ALARM'
        : '';
    lines.push(`\n─── Abandoned PR waste ───`);
    lines.push(
      `${waste.abandoned} of ${waste.closedPrs} closed PRs never merged ` +
        `(${(waste.wasteRate * 100).toFixed(0)}%)${alarm}`,
    );
    if (waste.labelBreakdown.length > 0) {
      lines.push('Lifecycle labels:');
      for (const entry of waste.labelBreakdown) {
        lines.push(`  ${String(entry.count).padStart(3)}  ${entry.label}`);
      }
    }
    if (waste.recent.length > 0) {
      lines.push('Most recently abandoned:');
      for (const pr of waste.recent) {
        const labelStr = pr.labels.length > 0 ? `  [${pr.labels.join(', ')}]` : '';
        lines.push(`  #${String(pr.prNumber).padEnd(6)} ${pr.closedAt}${labelStr}  ${pr.title}`);
      }
    }
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
  const now = new Date().toISOString();

  const openPrs = fetchOpenPrs(root);
  const report = buildReport(
    root,
    fetchMergedPrs(root, limit),
    openPrs,
    now,
    fetchClosedPrs(root, limit),
  );
  const out = resolve(root, flag('out', 'files/velocity-bottlenecks.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(render(report));
  process.stdout.write(`Report → ${out}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
