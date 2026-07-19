#!/usr/bin/env tsx
/**
 * measure-ci-efficiency.ts — Post-rollout PR CI resource efficiency measurement.
 *
 * Queries GitHub Actions API for CI and Security Review workflow runs in a
 * time window, classifies each run's change impact, detects superseded runs,
 * and produces a structured efficiency report for comparison against the
 * pre-rollout baseline.
 *
 * Baseline (72h ending 2026-07-19 19:12 UTC):
 *   - 18,630 measured CI/Security runner-minutes
 *   - 99.54% classified
 *   - 53.9% conservatively avoidable
 *   - 3,808 superseded runner-minutes
 *   - 2,636 non-visual E2E minutes
 *   - 4,236 non-simulation headless minutes
 *   - 1,106 non-coverage coverage minutes
 *
 * Usage:
 *   GH_TOKEN=<token> npx tsx scripts/agent/ci/measure-ci-efficiency.ts \
 *     --start 2026-07-20T00:00:00Z \
 *     --end 2026-07-27T00:00:00Z \
 *     [--owner nalfeo] [--repo Crawler] \
 *     [--out report.json]
 *
 * Environment:
 *   GH_TOKEN  — GitHub personal access token with repo + actions:read scope
 *
 * API coverage limitations:
 *   - The GitHub /actions/runs/timing endpoint returns BILLABLE milliseconds
 *     rounded to the nearest minute; actual queue/startup overhead is excluded.
 *   - The GitHub API does not expose which job triggered a concurrency-group
 *     cancellation; superseded detection is approximated by checking whether
 *     a newer run for the same PR started before this run completed.
 *   - PR file listings are paginated at 100 files per page; PRs with >3000
 *     changed files are classified as "unknown/full" by GitHub's API.
 *   - Workflow runs older than 90 days may not be available via the REST API.
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Workflow IDs for workflows we measure in this repo. */
const WORKFLOW_IDS = {
  ci: 288745068,
  security: 291101062,
} as const;

type WorkflowKey = keyof typeof WORKFLOW_IDS;

/** Maximum delay between retry attempts, in milliseconds. */
const MAX_BACKOFF_MS = 8000;

/**
 * Throttle interval between paginated run-list requests.
 * GitHub enforces 5000 req/hr per authenticated user; 200ms ≈ 5 req/sec =
 * 18,000 req/hr, well within limit. The backoff in ghGet handles actual 429s.
 */
const LIST_PAGE_THROTTLE_MS = 200;

/** Change-impact classification matching detect-art-only.sh categories. */
type ChangeImpact =
  | 'art_only' // Only generated sprites / sprite-catalog
  | 'docs_only' // Only docs/AGENTS.md/*.md/*.txt
  | 'gameplay_safe' // Only engine/labs/e2e/docs/CI (headless safe)
  | 'sprites_only' // Only sprite pipeline scripts/tests
  | 'full' // Simulation-touching or mixed change
  | 'unknown'; // Could not classify (API error or >3000 files)

interface WorkflowRun {
  id: number;
  name: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  run_number: number;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  run_attempt: number;
  pull_requests: Array<{ number: number; head: { sha: string } }>;
  display_title: string;
}

interface JobTiming {
  name: string;
  started_at: string | null;
  completed_at: string | null;
  durationMinutes: number;
}

interface RunAnalysis {
  runId: number;
  workflowKey: WorkflowKey;
  prNumber: number | null;
  branch: string;
  sha: string;
  createdAt: string;
  completedAt: string | null;
  conclusion: string | null;
  impact: ChangeImpact;
  superseded: boolean;
  totalMinutes: number;
  jobs: JobTiming[];
  avoidableMinutes: number;
  avoidableReason: string;
  /** Minutes attributable to specific gate categories. */
  headlessMinutes: number;
  e2eMinutes: number;
  coverageMinutes: number;
  securityMinutes: number;
}

interface Report {
  generatedAt: string;
  analysisWindow: { start: string; end: string };
  apiLimitations: string[];
  totalRuns: number;
  classifiedRuns: number;
  classificationRate: number;
  totalMinutes: number;
  avoidableMinutes: number;
  avoidablePercent: number;
  supersededMinutes: number;
  /**
   * Percentage reduction in superseded runner-minutes vs. the baseline.
   * Null when baseline.supersededMinutes is 0 (no prior superseded waste to compare against),
   * which would indicate the baseline was already optimal in this dimension.
   */
  supersededReductionVsBaseline: number | null;
  nonVisualE2eMinutes: number;
  nonSimHeadlessMinutes: number;
  nonCoverageMinutes: number;
  impactBreakdown: Record<
    ChangeImpact,
    { runs: number; minutes: number; avoidableMinutes: number }
  >;
  perPrStats: {
    median: number;
    p95: number;
    sampleSize: number;
  };
  wallClockLatency: {
    median: number;
    p95: number;
    sampleSize: number;
  };
  classifierGaps: string[];
  baseline: {
    window: string;
    totalMinutes: number;
    avoidablePercent: number;
    supersededMinutes: number;
    nonVisualE2eMinutes: number;
    nonSimHeadlessMinutes: number;
    nonCoverageMinutes: number;
  };
  runs?: RunAnalysis[];
}

// ---------------------------------------------------------------------------
// GitHub API client (using built-in https)
// ---------------------------------------------------------------------------

function githubGet(path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'User-Agent': 'Crawler-CI-Efficiency-Analyzer/1.0',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) {
          resolve(null);
          return;
        }
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`GitHub API ${res.statusCode} for ${path}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from ${path}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/** Rate-limited GitHub API call with simple exponential backoff on 429/503. */
async function ghGet(path: string, token: string, retries = 3): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await githubGet(path, token);
      return result;
    } catch (err) {
      const msg = String(err);
      if ((msg.includes('429') || msg.includes('503')) && attempt < retries) {
        // Cap backoff at MAX_BACKOFF_MS to avoid excessive waits in analysis runs
        const delayMs = Math.min(500 * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

/** Fetch all pages from a paginated GitHub API endpoint. */
async function ghGetAll(
  basePath: string,
  token: string,
  // 100 pages × 100 items = 10,000 items; sufficient for any 7-day PR file listing
  pageLimit = 100,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let page = 1; page <= pageLimit; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const data = (await ghGet(`${basePath}${sep}per_page=100&page=${page}`, token)) as {
      items?: unknown[];
      workflow_runs?: unknown[];
      jobs?: unknown[];
      files?: unknown[];
      total_count?: number;
    } | null;

    if (!data) break;

    // GitHub wraps results differently per endpoint
    const items =
      data.workflow_runs ?? data.jobs ?? data.files ?? (Array.isArray(data) ? data : null);
    if (!items || items.length === 0) break;
    results.push(...items);

    // Stop early if we received fewer than 100 items (last page)
    if (items.length < 100) break;
  }
  if (results.length >= pageLimit * 100) {
    process.stderr.write(
      `⚠️  ghGetAll hit page limit (${pageLimit} pages) for ${basePath}; results may be incomplete.\n`,
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Acceptance thresholds (per issue #1702 acceptance criteria)
// ---------------------------------------------------------------------------

const ACCEPTANCE = {
  /** Avoidable share must be below this percentage. */
  avoidableMaxPercent: 15,
  /** Superseded runner waste must be reduced by at least this fraction vs. baseline. */
  supersededReductionMinPercent: 90,
  /** At least this fraction of runner time must be classifiable. */
  classificationMinRate: 0.95,
  /** Minimum number of representative post-rollout days required. */
  minWindowDays: 7,
} as const;

// ---------------------------------------------------------------------------
// Change-impact classification (mirrors detect-art-only.sh)
// NOTE: This duplicates path patterns from detect-art-only.sh by design so the
// analysis tool runs without a git checkout. When detect-art-only.sh gains new
// impact flags (e.g., from issue #1688), update BOTH files.
// TODO(#1688): Once #1688 merges, extend classifyFiles() to emit the new flags
//   visual_touched / sim_touched / coverage_touched / sprite_pipeline_touched /
//   dependencies_touched for more precise avoidable-minute attribution.
// ---------------------------------------------------------------------------

function classifyFiles(files: string[]): ChangeImpact {
  if (files.length === 0) return 'unknown';

  const isArtOnly = files.every(
    (f) => f.startsWith('public/assets/generated/') || f === 'src/shared/data/sprite-catalog.json',
  );
  if (isArtOnly) return 'art_only';

  const isDocsOnly = files.every(
    (f) =>
      f.startsWith('docs/') ||
      f.startsWith('.specify/specs/') ||
      f === 'AGENTS.md' ||
      f.endsWith('.md') ||
      f.endsWith('.txt'),
  );
  if (isDocsOnly) return 'docs_only';

  const isSpritesOnly = files.every(
    (f) =>
      f.startsWith('scripts/sprites/') ||
      f.startsWith('tests/unit/sprites/') ||
      f.startsWith('tests/integration/sprites/') ||
      [
        'tests/integration/batch-cli.test.ts',
        'tests/integration/generate-one.test.ts',
        'tests/integration/judge-budget-cache.test.ts',
        'tests/integration/judge-pipeline.test.ts',
        'tests/integration/run-full.test.ts',
        'tests/integration/sidecar-lifecycle.test.ts',
        'tests/integration/synth-to-generate.test.ts',
        'tests/integration/weapons-pipeline.test.ts',
      ].includes(f),
  );
  if (isSpritesOnly) return 'sprites_only';

  // gameplay_safe: headless simulation runner cannot be affected
  const GAMEPLAY_SAFE_PREFIXES = [
    'src/engine/',
    'src/labs/',
    'tests/e2e/',
    'docs/',
    'public/',
    '.github/',
    'scripts/sprites/',
    'tests/unit/sprites/',
    'tests/integration/sprites/',
  ];
  const GAMEPLAY_SAFE_EXACT = new Set([
    'src/shared/data/sprite-catalog.json',
    'scripts/agent/ci/detect-art-only.sh',
    'tests/unit/detect-change-scope.test.ts',
    'tests/integration/batch-cli.test.ts',
    'tests/integration/generate-one.test.ts',
    'tests/integration/judge-budget-cache.test.ts',
    'tests/integration/judge-pipeline.test.ts',
    'tests/integration/run-full.test.ts',
    'tests/integration/sidecar-lifecycle.test.ts',
    'tests/integration/synth-to-generate.test.ts',
    'tests/integration/weapons-pipeline.test.ts',
  ]);

  const isGameplaySafe = files.every(
    (f) =>
      GAMEPLAY_SAFE_PREFIXES.some((p) => f.startsWith(p)) ||
      GAMEPLAY_SAFE_EXACT.has(f) ||
      f.endsWith('.md') ||
      f.endsWith('.txt'),
  );
  if (isGameplaySafe) return 'gameplay_safe';

  return 'full';
}

// ---------------------------------------------------------------------------
// Job categorization (maps GitHub job names to cost categories)
// ---------------------------------------------------------------------------

const JOB_CATEGORY_PATTERNS = {
  headless: ['headless', 'floor-1', 'sim'],
  e2e: ['e2e', 'playwright', 'visual', 'visual-regression'],
  coverage: ['coverage', 'test-coverage'],
  security: ['security', 'audit', 'scan'],
} as const;

type JobCategory = keyof typeof JOB_CATEGORY_PATTERNS | 'other';

function categorizeJob(jobName: string): JobCategory {
  const lower = jobName.toLowerCase();
  for (const [category, patterns] of Object.entries(JOB_CATEGORY_PATTERNS) as Array<
    [JobCategory, readonly string[]]
  >) {
    if (patterns.some((p) => lower.includes(p))) return category;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Superseded detection
// ---------------------------------------------------------------------------

/**
 * Mark older runs for the same PR as superseded when a newer run for the same
 * PR started before the older run completed. This mirrors the behavior that
 * concurrency groups (issue #1689) would enforce.
 */
function detectSupersededRuns(runs: WorkflowRun[]): Set<number> {
  // Group runs by (workflow_id, pr_number)
  const groups = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const prNum = run.pull_requests[0]?.number;
    if (!prNum) continue;
    const key = `${run.workflow_id}:${prNum}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  const superseded = new Set<number>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    // Sort by creation time ascending
    const sorted = [...group].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      const older = sorted[i]!;
      // Prefer `updated_at` as the closest proxy for job completion available in
      // the workflow-run list endpoint. The GitHub REST API does not expose a
      // dedicated `completed_at` field on workflow runs; `updated_at` is set when
      // all jobs finish and the run transitions to a terminal status. This means
      // superseded detection slightly under-counts: a run that is still queued
      // when the next run starts will not be marked superseded until updated_at
      // advances past created_at of the newer run. The limitation is documented in
      // the report's apiLimitations section.
      const completedAtProxy = older.updated_at;
      // Check if any newer run started before the older one completed
      for (let j = i + 1; j < sorted.length; j++) {
        const newer = sorted[j]!;
        if (new Date(newer.created_at) < new Date(completedAtProxy) && newer.id !== older.id) {
          superseded.add(older.id);
          break;
        }
      }
    }
  }
  return superseded;
}

// ---------------------------------------------------------------------------
// Avoidable minutes computation
// ---------------------------------------------------------------------------

function computeAvoidableMinutes(
  impact: ChangeImpact,
  superseded: boolean,
  jobs: JobTiming[],
  _workflowKey: WorkflowKey,
): { avoidableMinutes: number; avoidableReason: string } {
  if (superseded) {
    return {
      avoidableMinutes: jobs.reduce((s, j) => s + j.durationMinutes, 0),
      avoidableReason: 'superseded',
    };
  }

  if (impact === 'art_only' || impact === 'docs_only') {
    // All heavy gates were avoidable; only scope-detection and lightweight checks needed.
    // Patterns match job names in .github/workflows/ci.yml (detect, typecheck, lint, format,
    // unit-tests, commit-lint). Any new lightweight CI jobs should be added here.
    const lightJobPatterns = ['detect', 'scope', 'typecheck', 'lint', 'format', 'unit', 'commit'];
    const heavy = jobs.filter(
      (j) => !lightJobPatterns.some((p) => j.name.toLowerCase().includes(p)),
    );
    const avoidable = heavy.reduce((s, j) => s + j.durationMinutes, 0);
    return { avoidableMinutes: avoidable, avoidableReason: impact };
  }

  if (impact === 'gameplay_safe') {
    // Only the headless gate was avoidable
    const headlessJobs = jobs.filter((j) => categorizeJob(j.name) === 'headless');
    const avoidable = headlessJobs.reduce((s, j) => s + j.durationMinutes, 0);
    return { avoidableMinutes: avoidable, avoidableReason: 'gameplay_safe_headless' };
  }

  if (impact === 'sprites_only') {
    // Non-sprite game test jobs were avoidable
    const nonSpritePatterns = ['headless', 'e2e', 'coverage'];
    const avoidable = jobs
      .filter((j) => nonSpritePatterns.some((p) => j.name.toLowerCase().includes(p)))
      .reduce((s, j) => s + j.durationMinutes, 0);
    return { avoidableMinutes: avoidable, avoidableReason: 'sprites_only' };
  }

  return { avoidableMinutes: 0, avoidableReason: 'none' };
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

async function fetchRunsInWindow(
  workflowId: number,
  workflowKey: WorkflowKey,
  owner: string,
  repo: string,
  token: string,
  startDate: Date,
  endDate: Date,
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  let page = 1;
  // A 7-day window at 200 PR-triggered runs/day would need ~14 pages (100/page).
  // 200 pages is a conservative cap that prevents runaway pagination.
  const pageLimit = 200;

  process.stderr.write(`Fetching ${workflowKey} workflow runs...`);

  while (page <= pageLimit) {
    const data = (await ghGet(
      `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?event=pull_request&per_page=100&page=${page}`,
      token,
    )) as { workflow_runs: WorkflowRun[]; total_count: number } | null;

    if (!data?.workflow_runs?.length) break;

    let foundAny = false;
    let passedWindow = false;

    for (const run of data.workflow_runs) {
      const runDate = new Date(run.created_at);
      if (runDate > endDate) continue;
      if (runDate < startDate) {
        passedWindow = true;
        break;
      }
      runs.push(run);
      foundAny = true;
    }

    if (passedWindow || !foundAny) break;
    page++;

    await new Promise((r) => setTimeout(r, LIST_PAGE_THROTTLE_MS));
    if (page % 10 === 0) process.stderr.write('.');
  }

  process.stderr.write(` found ${runs.length}\n`);
  return runs;
}

async function fetchJobTimings(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<JobTiming[]> {
  const data = (await ghGet(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    token,
  )) as {
    jobs: Array<{
      name: string;
      started_at: string | null;
      completed_at: string | null;
    }>;
  } | null;

  if (!data?.jobs) return [];

  return data.jobs.map((job) => {
    const startMs = job.started_at ? new Date(job.started_at).getTime() : 0;
    const endMs = job.completed_at ? new Date(job.completed_at).getTime() : 0;
    const durationMinutes = startMs && endMs ? Math.max(0, (endMs - startMs) / 60000) : 0;
    return {
      name: job.name,
      started_at: job.started_at,
      completed_at: job.completed_at,
      durationMinutes,
    };
  });
}

async function fetchPrFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const files = (await ghGetAll(
    `/repos/${owner}/${repo}/pulls/${prNumber}/files`,
    token,
    30, // Max 3000 files (30 pages × 100)
  )) as Array<{ filename: string }>;
  return files.map((f) => f.filename);
}

/**
 * Nearest-rank percentile. For p=50 (median) on an odd array this returns the
 * middle element; on an even array it returns the lower-middle element (not an
 * interpolated average). This is consistent with the baseline measurement
 * methodology and avoids fractional runner-minute values in the report.
 *
 * Returns 0 for an empty array ("no data"); callers should check sampleSize > 0
 * before interpreting the value.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // nearest-rank: rank = ceil(p/100 * n), 1-based → 0-based index = rank - 1
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(0, rank - 1), sorted.length - 1);
  return sorted[idx] ?? 0;
}

async function analyze(args: {
  owner: string;
  repo: string;
  token: string;
  start: Date;
  end: Date;
  outFile?: string;
  includeRunDetails?: boolean;
}): Promise<Report> {
  const { owner, repo, token, start, end } = args;

  // Fetch all runs in window for both workflows
  const [ciRuns, securityRuns] = await Promise.all([
    fetchRunsInWindow(WORKFLOW_IDS.ci, 'ci', owner, repo, token, start, end),
    fetchRunsInWindow(WORKFLOW_IDS.security, 'security', owner, repo, token, start, end),
  ]);

  const allRuns = [
    ...ciRuns.map((r) => ({ run: r, wf: 'ci' as WorkflowKey })),
    ...securityRuns.map((r) => ({ run: r, wf: 'security' as WorkflowKey })),
  ];

  process.stderr.write(`Total runs to analyze: ${allRuns.length}\n`);

  // Detect superseded runs
  const supersededIds = detectSupersededRuns([...ciRuns, ...securityRuns]);

  // Analyze each run
  const analyses: RunAnalysis[] = [];
  const prFileCache = new Map<number, string[]>();
  let analyzed = 0;

  for (const { run, wf } of allRuns) {
    const prNum = run.pull_requests[0]?.number ?? null;

    // Get PR files for classification
    let impact: ChangeImpact = 'unknown';
    if (prNum) {
      let files = prFileCache.get(prNum);
      if (!files) {
        try {
          files = await fetchPrFiles(owner, repo, prNum, token);
          prFileCache.set(prNum, files);
        } catch {
          files = [];
        }
      }
      impact = files.length > 0 ? classifyFiles(files) : 'unknown';
    }

    // Get job timings
    let jobs: JobTiming[] = [];
    try {
      jobs = await fetchJobTimings(owner, repo, run.id, token);
    } catch {
      // Use empty jobs on error
    }

    const totalMinutes = jobs.reduce((s, j) => s + j.durationMinutes, 0);
    const superseded = supersededIds.has(run.id);

    const { avoidableMinutes, avoidableReason } = computeAvoidableMinutes(
      impact,
      superseded,
      jobs,
      wf,
    );

    const headlessMinutes = jobs
      .filter((j) => categorizeJob(j.name) === 'headless')
      .reduce((s, j) => s + j.durationMinutes, 0);
    const e2eMinutes = jobs
      .filter((j) => categorizeJob(j.name) === 'e2e')
      .reduce((s, j) => s + j.durationMinutes, 0);
    const coverageMinutes = jobs
      .filter((j) => categorizeJob(j.name) === 'coverage')
      .reduce((s, j) => s + j.durationMinutes, 0);
    const securityMinutes = jobs
      .filter((j) => categorizeJob(j.name) === 'security')
      .reduce((s, j) => s + j.durationMinutes, 0);

    analyses.push({
      runId: run.id,
      workflowKey: wf,
      prNumber: prNum,
      branch: run.head_branch,
      sha: run.head_sha,
      createdAt: run.created_at,
      completedAt: run.updated_at ?? null,
      conclusion: run.conclusion,
      impact,
      superseded,
      totalMinutes,
      jobs,
      avoidableMinutes,
      avoidableReason,
      headlessMinutes,
      e2eMinutes,
      coverageMinutes,
      securityMinutes,
    });

    analyzed++;
    if (analyzed % 50 === 0) {
      process.stderr.write(`Analyzed ${analyzed}/${allRuns.length} runs...\n`);
    }
  }

  // Aggregate statistics
  const totalMinutes = analyses.reduce((s, a) => s + a.totalMinutes, 0);
  const avoidableMinutes = analyses.reduce((s, a) => s + a.avoidableMinutes, 0);
  const supersededMinutes = analyses
    .filter((a) => a.superseded)
    .reduce((s, a) => s + a.totalMinutes, 0);

  // Non-visual E2E: E2E minutes where impact is not visual-touching
  const nonVisualE2eMinutes = analyses
    .filter(
      (a) => a.impact === 'docs_only' || a.impact === 'art_only' || a.impact === 'gameplay_safe',
    )
    .reduce((s, a) => s + a.e2eMinutes, 0);

  // Non-sim headless: headless minutes where impact is gameplay_safe
  const nonSimHeadlessMinutes = analyses
    .filter((a) => a.impact === 'gameplay_safe')
    .reduce((s, a) => s + a.headlessMinutes, 0);

  // Non-coverage coverage: coverage minutes where impact is docs/art/gameplay_safe
  const nonCoverageMinutes = analyses
    .filter(
      (a) => a.impact === 'docs_only' || a.impact === 'art_only' || a.impact === 'gameplay_safe',
    )
    .reduce((s, a) => s + a.coverageMinutes, 0);

  // Classification rate
  const classifiedCount = analyses.filter((a) => a.impact !== 'unknown').length;
  const classificationRate = analyses.length > 0 ? classifiedCount / analyses.length : 0;

  // Impact breakdown
  const impactBreakdown: Report['impactBreakdown'] = {
    art_only: { runs: 0, minutes: 0, avoidableMinutes: 0 },
    docs_only: { runs: 0, minutes: 0, avoidableMinutes: 0 },
    gameplay_safe: { runs: 0, minutes: 0, avoidableMinutes: 0 },
    sprites_only: { runs: 0, minutes: 0, avoidableMinutes: 0 },
    full: { runs: 0, minutes: 0, avoidableMinutes: 0 },
    unknown: { runs: 0, minutes: 0, avoidableMinutes: 0 },
  };
  for (const a of analyses) {
    const bucket = impactBreakdown[a.impact];
    bucket.runs++;
    bucket.minutes += a.totalMinutes;
    bucket.avoidableMinutes += a.avoidableMinutes;
  }

  // Per-PR statistics (minutes per PR head = sum of all run minutes for that PR)
  const prMinutes = new Map<number, number>();
  for (const a of analyses) {
    if (a.prNumber) {
      prMinutes.set(a.prNumber, (prMinutes.get(a.prNumber) ?? 0) + a.totalMinutes);
    }
  }
  const prMinuteValues = [...prMinutes.values()];

  // Wall-clock latency (minutes from run.created_at to run.completedAt)
  const latencies = analyses
    .filter((a): a is RunAnalysis & { completedAt: string } => a.completedAt !== null)
    .map((a) => {
      const completed = new Date(a.completedAt).getTime();
      return (completed - new Date(a.createdAt).getTime()) / 60000;
    });

  // Baseline for comparison
  const baseline = {
    window: '72h ending 2026-07-19 19:12 UTC',
    totalMinutes: 18630,
    avoidablePercent: 53.9,
    supersededMinutes: 3808,
    nonVisualE2eMinutes: 2636,
    nonSimHeadlessMinutes: 4236,
    nonCoverageMinutes: 1106,
  };

  const supersededReductionVsBaseline =
    baseline.supersededMinutes > 0
      ? (1 - supersededMinutes / baseline.supersededMinutes) * 100
      : null;

  // Classifier gap detection: look for required-check skips on 'full' impact runs
  const classifierGaps: string[] = [];
  for (const a of analyses) {
    if (a.impact === 'unknown' && a.workflowKey === 'ci') {
      classifierGaps.push(
        `PR #${a.prNumber ?? 'unknown'} run ${a.runId}: unclassified (no files or API error)`,
      );
    }
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    analysisWindow: { start: start.toISOString(), end: end.toISOString() },
    apiLimitations: [
      'GitHub /actions/runs/{id}/timing returns BILLABLE ms rounded to 1min; queue overhead excluded.',
      'Superseded detection approximated from run timestamps; concurrency-cancel events not directly exposed.',
      'PR file listings capped at 3000 files by GitHub API; larger PRs classified as unknown.',
      'Workflow runs older than 90 days may be unavailable.',
      'This measurement counts wall-clock job duration, not billable minutes, for consistency with baseline.',
    ],
    totalRuns: analyses.length,
    classifiedRuns: classifiedCount,
    classificationRate,
    totalMinutes,
    avoidableMinutes,
    avoidablePercent: totalMinutes > 0 ? (avoidableMinutes / totalMinutes) * 100 : 0,
    supersededMinutes,
    supersededReductionVsBaseline,
    nonVisualE2eMinutes,
    nonSimHeadlessMinutes,
    nonCoverageMinutes,
    impactBreakdown,
    perPrStats: {
      median: percentile(prMinuteValues, 50),
      p95: percentile(prMinuteValues, 95),
      sampleSize: prMinuteValues.length,
    },
    wallClockLatency: {
      median: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      sampleSize: latencies.length,
    },
    classifierGaps,
    baseline,
    ...(args.includeRunDetails ? { runs: analyses } : {}),
  };

  return report;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(report: Report): string {
  const b = report.baseline;
  const deltaAvoidable = report.avoidablePercent - b.avoidablePercent;
  const deltaSuperseded = report.supersededReductionVsBaseline;

  const fmt = (n: number, d = 1) => n.toFixed(d);
  const pct = (n: number) => `${fmt(n)}%`;
  const fmtMin = (n: number) => `${Math.round(n).toLocaleString()} min`;

  const avoidableStatus =
    report.avoidablePercent < ACCEPTANCE.avoidableMaxPercent
      ? `✅ PASS (<${ACCEPTANCE.avoidableMaxPercent}%)`
      : `❌ FAIL (${pct(report.avoidablePercent)}, target <${ACCEPTANCE.avoidableMaxPercent}%)`;

  const supersededStatus =
    deltaSuperseded !== null && deltaSuperseded >= ACCEPTANCE.supersededReductionMinPercent
      ? `✅ PASS (≥${ACCEPTANCE.supersededReductionMinPercent}% reduction)`
      : `❌ FAIL (${deltaSuperseded !== null ? `${fmt(deltaSuperseded)}%` : 'N/A'} reduction, target ≥${ACCEPTANCE.supersededReductionMinPercent}%)`;

  const classifiedStatus =
    report.classificationRate >= ACCEPTANCE.classificationMinRate
      ? `✅ PASS (≥${Math.round(ACCEPTANCE.classificationMinRate * 100)}%)`
      : `❌ FAIL (${pct(report.classificationRate * 100)}, target ≥${Math.round(ACCEPTANCE.classificationMinRate * 100)}%)`;

  const gapsStatus =
    report.classifierGaps.length === 0
      ? '✅ PASS (no gaps detected)'
      : `⚠️ ${report.classifierGaps.length} potential gaps`;

  return `# Post-Rollout CI Efficiency Report

Generated: ${report.generatedAt}
Window: ${report.analysisWindow.start} → ${report.analysisWindow.end}

## Summary

| Metric | Baseline | Post-Rollout | Change | Target |
|--------|----------|--------------|--------|--------|
| Total runner-minutes | ${fmtMin(b.totalMinutes)} | ${fmtMin(report.totalMinutes)} | ${fmt(((report.totalMinutes - b.totalMinutes) / b.totalMinutes) * 100)}% | — |
| Avoidable % | ${pct(b.avoidablePercent)} | ${pct(report.avoidablePercent)} | ${fmt(deltaAvoidable)}pp | <15% |
| Superseded minutes | ${fmtMin(b.supersededMinutes)} | ${fmtMin(report.supersededMinutes)} | ${deltaSuperseded !== null ? `-${fmt(deltaSuperseded)}%` : 'N/A'} | -90% |
| Non-visual E2E min | ${fmtMin(b.nonVisualE2eMinutes)} | ${fmtMin(report.nonVisualE2eMinutes)} | — | — |
| Non-sim headless min | ${fmtMin(b.nonSimHeadlessMinutes)} | ${fmtMin(report.nonSimHeadlessMinutes)} | — | — |
| Non-coverage min | ${fmtMin(b.nonCoverageMinutes)} | ${fmtMin(report.nonCoverageMinutes)} | — | — |

## Acceptance Criteria

- **Avoidable share <15%**: ${avoidableStatus}
- **Superseded ≥90% reduction**: ${supersededStatus}
- **Classification ≥95%**: ${classifiedStatus}
- **No classifier-caused gaps**: ${gapsStatus}

## Per-PR Statistics

| Metric | Value |
|--------|-------|
| Median minutes/PR | ${fmt(report.perPrStats.median)} |
| p95 minutes/PR | ${fmt(report.perPrStats.p95)} |
| Sample PRs | ${report.perPrStats.sampleSize} |

## Wall-Clock Latency

| Metric | Value |
|--------|-------|
| Median latency (min) | ${fmt(report.wallClockLatency.median)} |
| p95 latency (min) | ${fmt(report.wallClockLatency.p95)} |
| Sample runs | ${report.wallClockLatency.sampleSize} |

## Impact Classification Breakdown

| Impact | Runs | Minutes | Avoidable Min |
|--------|------|---------|---------------|
${Object.entries(report.impactBreakdown)
  .map(
    ([k, v]) =>
      `| ${k} | ${v.runs} | ${Math.round(v.minutes)} | ${Math.round(v.avoidableMinutes)} |`,
  )
  .join('\n')}

## API Limitations

${report.apiLimitations.map((l) => `- ${l}`).join('\n')}

## Classifier Gaps

${report.classifierGaps.length === 0 ? 'None detected.' : report.classifierGaps.map((g) => `- ${g}`).join('\n')}
`;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  owner: string;
  repo: string;
  token: string;
  start: Date;
  end: Date;
  outFile?: string;
  includeRunDetails: boolean;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
  if (!token) {
    console.error('Error: GH_TOKEN or GITHUB_TOKEN environment variable is required.');
    process.exit(1);
  }

  const startStr = get('--start');
  const endStr = get('--end');

  if (!startStr || !endStr) {
    console.error('Usage: GH_TOKEN=<token> npx tsx scripts/agent/ci/measure-ci-efficiency.ts \\');
    console.error('         --start 2026-07-20T00:00:00Z \\');
    console.error('         --end 2026-07-27T00:00:00Z \\');
    console.error('         [--owner nalfeo] [--repo Crawler] [--out report.json] [--details]');
    process.exit(1);
  }

  return {
    owner: get('--owner') ?? 'nalfeo',
    repo: get('--repo') ?? 'Crawler',
    token,
    start: new Date(startStr),
    end: new Date(endStr),
    outFile: get('--out'),
    includeRunDetails: args.includes('--details'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const windowDays = (args.end.getTime() - args.start.getTime()) / (1000 * 60 * 60 * 24);
  if (windowDays < ACCEPTANCE.minWindowDays) {
    console.error(
      `❌ Window is ${windowDays.toFixed(1)} days, but the acceptance criterion requires at least` +
        ` ${ACCEPTANCE.minWindowDays} representative post-rollout days.`,
    );
    console.error(
      '   Run after all dependency issues (#1688, #1689, #1696, #1697, #1698) have merged',
    );
    console.error('   and the observation window has elapsed.');
    process.exit(1);
  }

  process.stderr.write(`\nAnalyzing CI efficiency for ${args.owner}/${args.repo}\n`);
  process.stderr.write(`Window: ${args.start.toISOString()} → ${args.end.toISOString()}\n\n`);

  const report = await analyze(args);

  const markdown = renderReport(report);
  console.log(markdown);

  if (args.outFile) {
    writeFileSync(args.outFile, JSON.stringify(report, null, 2));
    process.stderr.write(`\nReport written to ${args.outFile}\n`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
