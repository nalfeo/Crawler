#!/usr/bin/env tsx
/**
 * measure-ci-efficiency.ts — Post-rollout PR CI resource efficiency measurement.
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { IncomingHttpHeaders } from 'node:http';

const WORKFLOW_IDS = {
  ci: 288745068,
  security: 291101062,
} as const;

type WorkflowKey = keyof typeof WORKFLOW_IDS;

const MAX_BACKOFF_MS = 8000;
const LIST_PAGE_THROTTLE_MS = 200;

type ChangeImpact =
  | 'art_only'
  | 'docs_only'
  | 'gameplay_safe'
  | 'sprites_only'
  | 'full'
  | 'unknown';

type ImpactMetricValue = number | null;

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
  pull_requests: Array<{
    number: number;
    head?: { sha?: string };
    base?: { sha?: string };
  }>;
  display_title: string;
}

interface JobTiming {
  name: string;
  status: string;
  conclusion: string | null;
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
  supersededAt: string | null;
  supersededMinutes: number;
  totalMinutes: number;
  jobs: JobTiming[];
  avoidableMinutes: number;
  avoidableReason: string;
  headlessMinutes: number;
  e2eMinutes: number;
  coverageMinutes: number;
  securityMinutes: number;
  spritesTouched: boolean;
}

interface PerGroupStats {
  median: number;
  p95: number;
  sampleSize: number;
}

interface Report {
  generatedAt: string;
  analysisWindow: { start: string; end: string; days: number };
  apiLimitations: string[];
  totalRuns: number;
  classifiedRuns: number;
  classificationRate: number;
  totalMinutes: number;
  avoidableMinutes: number;
  avoidablePercent: number;
  supersededMinutes: number;
  supersededReductionVsBaseline: number | null;
  nonVisualE2eMinutes: ImpactMetricValue;
  nonVisualE2eStatus: 'uncertain' | 'measured';
  nonSimHeadlessMinutes: number;
  nonCoverageMinutes: number;
  incomplete: boolean;
  incompleteReasons: string[];
  impactBreakdown: Record<
    ChangeImpact,
    {
      runs: number;
      minutes: number;
      avoidableMinutes: number;
      perHeadStats: PerGroupStats;
    }
  >;
  perPrStats: PerGroupStats;
  wallClockLatency: PerGroupStats;
  baselineWallClockLatency: {
    median: number | null;
    p95: number | null;
  };
  classifierGaps: string[];
  classifierUncertain: string[];
  baseline: {
    window: string;
    days: number;
    totalMinutes: number;
    avoidablePercent: number;
    supersededMinutes: number;
    nonVisualE2eMinutes: number;
    nonSimHeadlessMinutes: number;
    nonCoverageMinutes: number;
  };
  normalizedBaseline: {
    totalMinutesForWindow: number;
    supersededMinutesPerDay: number;
    supersededMinutesForWindow: number;
  };
  runs?: RunAnalysis[];
}

export class GitHubApiError extends Error {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly path: string;

  constructor(path: string, statusCode: number, headers: IncomingHttpHeaders, body: string) {
    super(`GitHub API ${statusCode} for ${path}: ${body.slice(0, 200)}`);
    this.name = 'GitHubApiError';
    this.statusCode = statusCode;
    this.headers = headers;
    this.body = body;
    this.path = path;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubGet(path: string, token: string): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method: 'GET',
      headers: {
        Authorization: ['Bearer', token].join(' '),
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
          reject(new GitHubApiError(path, res.statusCode ?? 0, res.headers, body));
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

function parseRateLimitResetMs(headers: IncomingHttpHeaders): number | null {
  const reset = headers['x-ratelimit-reset'];
  if (typeof reset !== 'string') return null;
  const epochSeconds = Number.parseInt(reset, 10);
  if (!Number.isFinite(epochSeconds)) return null;
  return Math.max(0, epochSeconds * 1000 - Date.now());
}

function isPrimaryRateLimit(err: GitHubApiError): boolean {
  const remaining = err.headers['x-ratelimit-remaining'];
  const noRemaining = typeof remaining === 'string' && remaining === '0';
  return err.statusCode === 403 && (noRemaining || err.body.toLowerCase().includes('rate limit'));
}

export async function ghGet(
  path: string,
  token: string,
  retries = 3,
  getImpl: (path: string, token: string) => Promise<unknown> = githubGet,
): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await getImpl(path, token);
    } catch (err) {
      const apiErr = err instanceof GitHubApiError ? err : null;
      const retryable =
        apiErr !== null &&
        (apiErr.statusCode === 429 || apiErr.statusCode === 503 || isPrimaryRateLimit(apiErr));
      if (!retryable || attempt >= retries || apiErr === null) throw err;

      const resetWaitMs = parseRateLimitResetMs(apiErr.headers);
      const fallbackMs = Math.min(500 * Math.pow(2, attempt), MAX_BACKOFF_MS);
      const waitMs = isPrimaryRateLimit(apiErr)
        ? Math.max(resetWaitMs ?? fallbackMs, 250)
        : resetWaitMs === null
          ? fallbackMs
          : Math.min(Math.max(resetWaitMs, 250), MAX_BACKOFF_MS);
      await delay(waitMs);
    }
  }
  throw new Error(`Exhausted retries for ${path}`);
}

const ACCEPTANCE = {
  avoidableMaxPercent: 15,
  supersededReductionMinPercent: 90,
  classificationMinRate: 0.95,
  minWindowDays: 7,
} as const;

interface ClassifyOptions {
  packageJsonGameplaySafe?: boolean;
}

export function classifyFiles(files: string[], options: ClassifyOptions = {}): ChangeImpact {
  const packageJsonGameplaySafe = options.packageJsonGameplaySafe ?? false;
  if (files.length === 0) return 'unknown';

  const isArtOnly = files.every(
    (f) => f.startsWith('public/assets/generated/') || f === 'src/shared/data/sprite-catalog.json',
  );
  if (isArtOnly) return 'art_only';

  const isDocsOnly = files.every((f) => {
    if (f.startsWith('src/')) return false;
    return (
      f.startsWith('docs/') ||
      f.startsWith('.specify/specs/') ||
      f === 'AGENTS.md' ||
      f.endsWith('.md') ||
      f.endsWith('.txt')
    );
  });
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

  const gameplaySafePrefixes = [
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

  const gameplaySafeExact = new Set([
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

  const isGameplaySafe = files.every((f) => {
    if (f.startsWith('src/')) {
      return gameplaySafePrefixes.some((p) => f.startsWith(p)) || gameplaySafeExact.has(f);
    }
    if (f === 'package.json') return packageJsonGameplaySafe;
    return (
      gameplaySafePrefixes.some((p) => f.startsWith(p)) ||
      gameplaySafeExact.has(f) ||
      f.endsWith('.md') ||
      f.endsWith('.txt')
    );
  });

  if (isGameplaySafe) return 'gameplay_safe';
  return 'full';
}

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

function isSpritesTouched(files: string[]): boolean {
  return files.some(
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
}

type KnownCiJob =
  | 'changes'
  | 'types_lint'
  | 'format_labs'
  | 'coverage'
  | 'unit'
  | 'integration'
  | 'sprites'
  | 'headless'
  | 'e2e'
  | 'advisory'
  | 'human_approval'
  | 'merge_gate'
  | 'ci'
  | 'other';

function classifyCiJobName(name: string): KnownCiJob {
  const lower = name.toLowerCase();
  if (lower.includes('detect change scope')) return 'changes';
  if (lower.includes('types') && lower.includes('lint')) return 'types_lint';
  if (lower.includes('format') && lower.includes('labs')) return 'format_labs';
  if (lower.includes('unit tests (coverage)')) return 'coverage' as KnownCiJob;
  if (lower.includes('unit tests')) return 'unit';
  if (lower.includes('integration tests')) return 'integration';
  if (lower.includes('sprite pipeline tests')) return 'sprites';
  if (lower.includes('headless floor 1')) return 'headless';
  if (lower.includes('e2e visual regression')) return 'e2e';
  if (lower.includes('advisory checks')) return 'advisory';
  if (lower.includes('human approval')) return 'human_approval';
  if (lower.includes('merge gate')) return 'merge_gate';
  if (lower === 'ci') return 'ci';
  return 'other';
}

const AVOIDABLE_JOBS_BY_IMPACT: Record<ChangeImpact, ReadonlySet<KnownCiJob>> = {
  art_only: new Set(['integration', 'sprites', 'headless', 'e2e']),
  docs_only: new Set(['unit', 'integration', 'sprites', 'headless', 'e2e', 'advisory', 'coverage']),
  gameplay_safe: new Set(['headless']),
  sprites_only: new Set(['unit', 'integration', 'headless', 'e2e', 'coverage']),
  full: new Set(),
  unknown: new Set(),
};

function clippedSupersededMinutes(jobs: JobTiming[], supersededAt: string): number {
  const cutoffMs = new Date(supersededAt).getTime();
  if (!Number.isFinite(cutoffMs)) return 0;

  let total = 0;
  for (const job of jobs) {
    const startMs = job.started_at ? new Date(job.started_at).getTime() : Number.NaN;
    const endMs = job.completed_at ? new Date(job.completed_at).getTime() : Number.NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    const clippedStart = Math.max(startMs, cutoffMs);
    const clippedEnd = endMs;
    if (clippedEnd > clippedStart) {
      total += (clippedEnd - clippedStart) / 60000;
    }
  }
  return total;
}

export function detectSupersededRuns(runs: WorkflowRun[]): Map<number, string> {
  const groups = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const prNum = run.pull_requests[0]?.number;
    if (!prNum) continue;
    const key = `${run.workflow_id}:${prNum}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  const supersededAtByRun = new Map<number, string>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;

    const sorted = [...group].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      const older = sorted[i]!;
      const olderCompletedAt = new Date(older.updated_at).getTime();
      if (!Number.isFinite(olderCompletedAt)) continue;

      let firstSupersedingAt: string | null = null;
      for (let j = i + 1; j < sorted.length; j++) {
        const newer = sorted[j]!;
        const newerCreatedAt = new Date(newer.created_at).getTime();
        if (newerCreatedAt < olderCompletedAt) {
          firstSupersedingAt = newer.created_at;
          break;
        }
      }

      if (firstSupersedingAt) supersededAtByRun.set(older.id, firstSupersedingAt);
    }
  }

  return supersededAtByRun;
}

function computeAvoidableMinutes(
  impact: ChangeImpact,
  jobs: JobTiming[],
  workflowKey: WorkflowKey,
  supersededAt: string | null,
  spritesTouched: boolean,
): { avoidableMinutes: number; avoidableReason: string; supersededMinutes: number } {
  if (supersededAt) {
    const supersededMinutes = clippedSupersededMinutes(jobs, supersededAt);
    return {
      avoidableMinutes: supersededMinutes,
      avoidableReason: 'superseded',
      supersededMinutes,
    };
  }

  if (workflowKey !== 'ci') {
    return { avoidableMinutes: 0, avoidableReason: 'unmodeled_security', supersededMinutes: 0 };
  }

  const avoidableJobs = AVOIDABLE_JOBS_BY_IMPACT[impact];
  if (avoidableJobs.size === 0) {
    return { avoidableMinutes: 0, avoidableReason: 'none', supersededMinutes: 0 };
  }

  const avoidableMinutes = jobs
    .filter((job) => avoidableJobs.has(classifyCiJobName(job.name)))
    .reduce((sum, job) => sum + job.durationMinutes, 0);

  const reason = spritesTouched ? `${impact}_sprites_touched` : impact;
  return { avoidableMinutes, avoidableReason: reason, supersededMinutes: 0 };
}

export async function fetchRunsInWindow(
  workflowId: number,
  workflowKey: WorkflowKey,
  owner: string,
  repo: string,
  token: string,
  startDate: Date,
  endDate: Date,
  getImpl: (path: string, token: string) => Promise<unknown> = ghGet,
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  let page = 1;
  const pageLimit = 200;

  process.stderr.write(`Fetching ${workflowKey} workflow runs...`);

  while (page <= pageLimit) {
    const data = (await getImpl(
      `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?event=pull_request&per_page=100&page=${page}`,
      token,
    )) as { workflow_runs: WorkflowRun[] } | null;

    if (!data?.workflow_runs?.length) break;

    let passedWindow = false;
    for (const run of data.workflow_runs) {
      const runDate = new Date(run.created_at);
      if (runDate > endDate) continue;
      if (runDate < startDate) {
        passedWindow = true;
        break;
      }
      runs.push(run);
    }

    if (passedWindow) break;

    page++;
    await delay(LIST_PAGE_THROTTLE_MS);
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
      status: string;
      conclusion: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>;
  } | null;

  if (!data?.jobs) {
    throw new Error(`Missing jobs payload for run ${runId}`);
  }

  return data.jobs.map((job) => {
    const startMs = job.started_at != null ? new Date(job.started_at).getTime() : null;
    const endMs = job.completed_at != null ? new Date(job.completed_at).getTime() : null;
    const durationMinutes =
      startMs != null && endMs != null ? Math.max(0, (endMs - startMs) / 60000) : 0;

    return {
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      durationMinutes,
    };
  });
}

async function fetchChangedFilesAtHead(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token: string,
): Promise<{ files: string[]; capped: boolean; packageJsonGameplaySafe: boolean }> {
  const data = (await ghGet(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`, token)) as {
    files?: Array<{ filename: string }>;
  } | null;

  const files = data?.files?.map((f) => f.filename) ?? [];
  let packageJsonGameplaySafe = false;
  if (files.includes('package.json')) {
    packageJsonGameplaySafe = await evaluatePackageJsonGameplaySafe(
      owner,
      repo,
      baseSha,
      headSha,
      token,
    );
  }

  // Compare endpoint truncates file lists at 300 entries.
  return { files, capped: files.length >= 300, packageJsonGameplaySafe };
}

async function fetchRepoJsonAtSha(
  owner: string,
  repo: string,
  path: string,
  sha: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const encodedPath = encodeURIComponent(path);
  const data = (await ghGet(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${sha}`,
    token,
  )) as {
    type?: string;
    encoding?: string;
    content?: string;
  } | null;
  if (
    !data ||
    data.type !== 'file' ||
    data.encoding !== 'base64' ||
    typeof data.content !== 'string'
  ) {
    return null;
  }
  const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  try {
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function packageJsonGameplaySafeFromObjects(
  basePkg: Record<string, unknown>,
  headPkg: Record<string, unknown>,
): boolean {
  const depKeys = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const key of depKeys) {
    if (JSON.stringify(toRecord(basePkg[key])) !== JSON.stringify(toRecord(headPkg[key])))
      return false;
  }

  const top = new Set([...Object.keys(basePkg), ...Object.keys(headPkg)]);
  const changedTop = [...top].filter(
    (key) => JSON.stringify(basePkg[key]) !== JSON.stringify(headPkg[key]),
  );
  if (changedTop.length === 0) return false;
  if (changedTop.some((key) => key !== 'scripts')) return false;

  const baseScripts = toRecord(basePkg['scripts']);
  const headScripts = toRecord(headPkg['scripts']);
  const scriptKeys = new Set([...Object.keys(baseScripts), ...Object.keys(headScripts)]);
  const changedScripts = [...scriptKeys].filter(
    (key) => JSON.stringify(baseScripts[key]) !== JSON.stringify(headScripts[key]),
  );
  if (changedScripts.length === 0) return false;

  const safeScriptKey = /^(sprites:|lab$|devtools$|setup:azure(?::|$))/;
  return changedScripts.every((key) => safeScriptKey.test(key));
}

async function evaluatePackageJsonGameplaySafe(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token: string,
): Promise<boolean> {
  const [basePkg, headPkg] = await Promise.all([
    fetchRepoJsonAtSha(owner, repo, 'package.json', baseSha, token),
    fetchRepoJsonAtSha(owner, repo, 'package.json', headSha, token),
  ]);
  if (!basePkg || !headPkg) return false;
  return packageJsonGameplaySafeFromObjects(basePkg, headPkg);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(0, rank - 1), sorted.length - 1);
  return sorted[idx] ?? 0;
}

type ExpectedJobBehavior = 'required_success' | 'allowed_skipped';

function expectedCiJobsForImpact(
  impact: ChangeImpact,
  spritesTouched: boolean,
): Map<KnownCiJob, ExpectedJobBehavior> {
  const expected = new Map<KnownCiJob, ExpectedJobBehavior>([
    ['changes', 'required_success'],
    ['human_approval', 'required_success'],
    ['merge_gate', 'required_success'],
    ['ci', 'required_success'],
  ]);

  const set = (job: KnownCiJob, value: ExpectedJobBehavior) => expected.set(job, value);

  switch (impact) {
    case 'docs_only': {
      set('types_lint', 'allowed_skipped');
      set('format_labs', 'allowed_skipped');
      set('unit', 'allowed_skipped');
      set('integration', 'allowed_skipped');
      set('sprites', 'allowed_skipped');
      set('headless', 'allowed_skipped');
      set('e2e', 'allowed_skipped');
      break;
    }
    case 'art_only': {
      set('types_lint', 'required_success');
      set('format_labs', 'required_success');
      set('unit', 'required_success');
      set('integration', 'allowed_skipped');
      set('sprites', 'allowed_skipped');
      set('headless', 'allowed_skipped');
      set('e2e', 'allowed_skipped');
      break;
    }
    case 'sprites_only': {
      set('types_lint', 'required_success');
      set('format_labs', 'required_success');
      set('unit', 'allowed_skipped');
      set('integration', 'allowed_skipped');
      set('sprites', 'required_success'); // sprites_only implies sprites_touched
      set('headless', 'allowed_skipped');
      set('e2e', 'allowed_skipped');
      break;
    }
    case 'gameplay_safe': {
      set('types_lint', 'required_success');
      set('format_labs', 'required_success');
      set('unit', 'required_success');
      set('integration', 'required_success');
      if (spritesTouched) set('sprites', 'required_success');
      set('headless', 'allowed_skipped');
      set('e2e', 'required_success');
      break;
    }
    case 'full': {
      set('types_lint', 'required_success');
      set('format_labs', 'required_success');
      set('unit', 'required_success');
      set('integration', 'required_success');
      if (spritesTouched) set('sprites', 'required_success');
      set('headless', 'required_success');
      set('e2e', 'required_success');
      break;
    }
    case 'unknown':
    default:
      break;
  }

  return expected;
}

function detectClassifierGapFindings(analyses: RunAnalysis[]): {
  gaps: string[];
  uncertain: string[];
} {
  const gaps: string[] = [];
  const uncertain: string[] = [];

  for (const analysis of analyses) {
    if (analysis.workflowKey !== 'ci') continue;

    if (analysis.impact === 'unknown') {
      uncertain.push(`PR #${analysis.prNumber ?? 'unknown'} run ${analysis.runId}: impact unknown`);
      continue;
    }

    const expected = expectedCiJobsForImpact(analysis.impact, analysis.spritesTouched);
    const observed = new Map<KnownCiJob, JobTiming>();
    for (const job of analysis.jobs) {
      const key = classifyCiJobName(job.name);
      if (key === 'other') continue;
      if (!observed.has(key)) observed.set(key, job);
    }

    for (const [jobKey, behavior] of expected.entries()) {
      const job = observed.get(jobKey);
      const display = `${jobKey.replace(/_/g, ' ')}`;
      if (!job) {
        uncertain.push(
          `PR #${analysis.prNumber ?? 'unknown'} run ${analysis.runId}: missing evidence for "${display}"`,
        );
        continue;
      }

      if (job.status !== 'completed' || job.conclusion === null) {
        uncertain.push(
          `PR #${analysis.prNumber ?? 'unknown'} run ${analysis.runId}: non-terminal "${job.name}" (${job.status}/${job.conclusion ?? 'null'})`,
        );
        continue;
      }

      if (behavior === 'required_success' && job.conclusion !== 'success') {
        gaps.push(
          `PR #${analysis.prNumber ?? 'unknown'} run ${analysis.runId}: required job "${job.name}" conclusion=${job.conclusion}`,
        );
      }

      if (behavior === 'allowed_skipped' && !['success', 'skipped'].includes(job.conclusion)) {
        gaps.push(
          `PR #${analysis.prNumber ?? 'unknown'} run ${analysis.runId}: scoped job "${job.name}" invalid conclusion=${job.conclusion}`,
        );
      }
    }
  }

  return { gaps, uncertain };
}

function computePerGroupStats(values: number[]): PerGroupStats {
  return {
    median: percentile(values, 50),
    p95: percentile(values, 95),
    sampleSize: values.length,
  };
}

async function analyze(args: {
  owner: string;
  repo: string;
  token: string;
  start: Date;
  end: Date;
  outFile?: string;
  includeRunDetails?: boolean;
  baselineWallClockLatency?: { median: number | null; p95: number | null };
}): Promise<Report> {
  const { owner, repo, token, start, end } = args;

  const [ciRuns, securityRuns] = await Promise.all([
    fetchRunsInWindow(WORKFLOW_IDS.ci, 'ci', owner, repo, token, start, end),
    fetchRunsInWindow(WORKFLOW_IDS.security, 'security', owner, repo, token, start, end),
  ]);

  const allRuns = [
    ...ciRuns.map((r) => ({ run: r, wf: 'ci' as WorkflowKey })),
    ...securityRuns.map((r) => ({ run: r, wf: 'security' as WorkflowKey })),
  ];

  process.stderr.write(`Total runs to analyze: ${allRuns.length}\n`);

  const supersededAtByRun = detectSupersededRuns([...ciRuns, ...securityRuns]);

  const analyses: RunAnalysis[] = [];
  const fileCache = new Map<
    string,
    {
      impact: ChangeImpact;
      capped: boolean;
      packageJsonGameplaySafe: boolean;
      spritesTouched: boolean;
    }
  >();
  const incompleteReasons: string[] = [];

  for (const { run, wf } of allRuns) {
    const prNum = run.pull_requests[0]?.number ?? null;

    if (run.status !== 'completed' || run.conclusion === null) {
      incompleteReasons.push(
        `run ${run.id} (${wf}) is non-terminal (${run.status}/${run.conclusion ?? 'null'})`,
      );
      continue;
    }

    let impact: ChangeImpact = 'unknown';
    let spritesTouched = false;

    if (prNum) {
      const pr = run.pull_requests[0];
      const baseSha = pr?.base?.sha;
      const headSha = pr?.head?.sha ?? run.head_sha;

      if (baseSha && headSha) {
        const cacheKey = `${baseSha}...${headSha}`;
        const cached = fileCache.get(cacheKey);
        if (cached) {
          impact = cached.impact;
          spritesTouched = cached.spritesTouched;
        } else {
          const changed = await fetchChangedFilesAtHead(owner, repo, baseSha, headSha, token);
          spritesTouched = isSpritesTouched(changed.files);
          impact = changed.capped
            ? 'unknown'
            : classifyFiles(changed.files, {
                packageJsonGameplaySafe: changed.packageJsonGameplaySafe,
              });
          fileCache.set(cacheKey, {
            impact,
            capped: changed.capped,
            packageJsonGameplaySafe: changed.packageJsonGameplaySafe,
            spritesTouched,
          });
        }
      }
    }

    const jobs = await fetchJobTimings(owner, repo, run.id, token);

    const totalMinutes = jobs.reduce((s, j) => s + j.durationMinutes, 0);
    const supersededAt = supersededAtByRun.get(run.id) ?? null;

    const { avoidableMinutes, avoidableReason, supersededMinutes } = computeAvoidableMinutes(
      impact,
      jobs,
      wf,
      supersededAt,
      spritesTouched,
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
      superseded: supersededAt !== null,
      supersededAt,
      supersededMinutes,
      totalMinutes,
      jobs,
      avoidableMinutes,
      avoidableReason,
      headlessMinutes,
      e2eMinutes,
      coverageMinutes,
      securityMinutes,
      spritesTouched,
    });
  }

  if (
    analyses.some(
      (a) =>
        a.workflowKey === 'security' &&
        a.totalMinutes > 0 &&
        a.avoidableReason === 'unmodeled_security',
    )
  ) {
    incompleteReasons.push(
      'Security workflow avoidable-minute attribution is conservative (non-superseded security runs are not fully modeled).',
    );
  }

  const totalMinutes = analyses.reduce((s, a) => s + a.totalMinutes, 0);
  const classifiedRuns = analyses.filter((a) => a.impact !== 'unknown').length;
  const classifiedMinutes = analyses
    .filter((a) => a.impact !== 'unknown')
    .reduce((s, a) => s + a.totalMinutes, 0);
  const classificationRate = totalMinutes > 0 ? classifiedMinutes / totalMinutes : 0;

  const avoidableMinutes = analyses.reduce((s, a) => s + a.avoidableMinutes, 0);
  const supersededMinutes = analyses.reduce((s, a) => s + a.supersededMinutes, 0);

  const nonVisualE2eMinutes: ImpactMetricValue = null;
  const nonVisualE2eStatus: Report['nonVisualE2eStatus'] = 'uncertain';

  const nonSimHeadlessMinutes = analyses
    .filter((a) => a.impact === 'gameplay_safe')
    .reduce((s, a) => s + a.headlessMinutes, 0);

  const nonCoverageMinutes = analyses
    .filter(
      (a) =>
        a.impact === 'docs_only' ||
        a.impact === 'art_only' ||
        a.impact === 'gameplay_safe' ||
        a.impact === 'sprites_only',
    )
    .reduce((s, a) => s + a.coverageMinutes, 0);

  const impactBreakdownBase: Report['impactBreakdown'] = {
    art_only: { runs: 0, minutes: 0, avoidableMinutes: 0, perHeadStats: computePerGroupStats([]) },
    docs_only: { runs: 0, minutes: 0, avoidableMinutes: 0, perHeadStats: computePerGroupStats([]) },
    gameplay_safe: {
      runs: 0,
      minutes: 0,
      avoidableMinutes: 0,
      perHeadStats: computePerGroupStats([]),
    },
    sprites_only: {
      runs: 0,
      minutes: 0,
      avoidableMinutes: 0,
      perHeadStats: computePerGroupStats([]),
    },
    full: { runs: 0, minutes: 0, avoidableMinutes: 0, perHeadStats: computePerGroupStats([]) },
    unknown: { runs: 0, minutes: 0, avoidableMinutes: 0, perHeadStats: computePerGroupStats([]) },
  };

  const minutesPerHeadByImpact = new Map<ChangeImpact, Map<string, number>>();
  for (const a of analyses) {
    const bucket = impactBreakdownBase[a.impact];
    bucket.runs++;
    bucket.minutes += a.totalMinutes;
    bucket.avoidableMinutes += a.avoidableMinutes;

    if (a.prNumber !== null) {
      const key = `${a.prNumber}:${a.sha}`;
      const perImpact = minutesPerHeadByImpact.get(a.impact) ?? new Map<string, number>();
      perImpact.set(key, (perImpact.get(key) ?? 0) + a.totalMinutes);
      minutesPerHeadByImpact.set(a.impact, perImpact);
    }
  }

  for (const impact of Object.keys(impactBreakdownBase) as ChangeImpact[]) {
    const values = [...(minutesPerHeadByImpact.get(impact)?.values() ?? [])];
    impactBreakdownBase[impact].perHeadStats = computePerGroupStats(values);
  }

  const perHeadMinutes = new Map<string, number>();
  for (const a of analyses) {
    if (a.prNumber !== null) {
      const key = `${a.prNumber}:${a.sha}`;
      perHeadMinutes.set(key, (perHeadMinutes.get(key) ?? 0) + a.totalMinutes);
    }
  }

  const prMinuteValues = [...perHeadMinutes.values()];

  const latencies = analyses
    .filter((a): a is RunAnalysis & { completedAt: string } => a.completedAt !== null)
    .map((a) => {
      const completed = new Date(a.completedAt).getTime();
      return (completed - new Date(a.createdAt).getTime()) / 60000;
    })
    .filter((n) => Number.isFinite(n) && n >= 0);

  const baseline = {
    window: '72h ending 2026-07-19 19:12 UTC',
    days: 3,
    totalMinutes: 18630,
    avoidablePercent: 53.9,
    supersededMinutes: 3808,
    nonVisualE2eMinutes: 2636,
    nonSimHeadlessMinutes: 4236,
    nonCoverageMinutes: 1106,
  };

  const windowDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  const baselineSupersededPerDay = baseline.supersededMinutes / baseline.days;
  const currentSupersededPerDay = windowDays > 0 ? supersededMinutes / windowDays : 0;

  const supersededReductionVsBaseline =
    baselineSupersededPerDay > 0
      ? (1 - currentSupersededPerDay / baselineSupersededPerDay) * 100
      : null;

  const normalizedBaseline = {
    totalMinutesForWindow: (baseline.totalMinutes / baseline.days) * windowDays,
    supersededMinutesPerDay: baselineSupersededPerDay,
    supersededMinutesForWindow: baselineSupersededPerDay * windowDays,
  };

  const { gaps, uncertain } = detectClassifierGapFindings(analyses);

  return {
    generatedAt: new Date().toISOString(),
    analysisWindow: { start: start.toISOString(), end: end.toISOString(), days: windowDays },
    apiLimitations: [
      'GitHub /actions/runs/{id}/timing returns BILLABLE ms rounded to 1min; queue overhead excluded.',
      'Superseded detection approximated from run timestamps; concurrency-cancel events not directly exposed.',
      'Run-level file classification is reconstructed from compare(base...head); compare file lists are capped at 300 and capped comparisons are marked unknown.',
      'Workflow runs older than 90 days may be unavailable.',
      'This measurement counts wall-clock job duration, not billable minutes, for consistency with baseline.',
      'Non-visual E2E metric is disabled until #1688 visual_touched is available.',
    ],
    totalRuns: analyses.length,
    classifiedRuns,
    classificationRate,
    totalMinutes,
    avoidableMinutes,
    avoidablePercent: totalMinutes > 0 ? (avoidableMinutes / totalMinutes) * 100 : 0,
    supersededMinutes,
    supersededReductionVsBaseline,
    nonVisualE2eMinutes,
    nonVisualE2eStatus,
    nonSimHeadlessMinutes,
    nonCoverageMinutes,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
    impactBreakdown: impactBreakdownBase,
    perPrStats: computePerGroupStats(prMinuteValues),
    wallClockLatency: computePerGroupStats(latencies),
    baselineWallClockLatency: args.baselineWallClockLatency ?? { median: null, p95: null },
    classifierGaps: gaps,
    classifierUncertain: uncertain,
    baseline,
    normalizedBaseline,
    ...(args.includeRunDetails ? { runs: analyses } : {}),
  };
}

function renderReport(report: Report): string {
  const b = report.baseline;
  const fmt = (n: number, d = 1) => n.toFixed(d);
  const pct = (n: number) => `${fmt(n)}%`;
  const fmtMin = (n: number) => `${Math.round(n).toLocaleString()} min`;

  const deltaAvoidable = report.avoidablePercent - b.avoidablePercent;
  const normalizedTotalDeltaPct =
    report.normalizedBaseline.totalMinutesForWindow > 0
      ? ((report.totalMinutes - report.normalizedBaseline.totalMinutesForWindow) /
          report.normalizedBaseline.totalMinutesForWindow) *
        100
      : 0;

  const avoidableStatus = report.incomplete
    ? `⚠️ UNCERTAIN (incomplete data: ${report.incompleteReasons.length} issue(s))`
    : report.avoidablePercent < ACCEPTANCE.avoidableMaxPercent
      ? `✅ PASS (<${ACCEPTANCE.avoidableMaxPercent}%)`
      : `❌ FAIL (${pct(report.avoidablePercent)}, target <${ACCEPTANCE.avoidableMaxPercent}%)`;

  const supersededStatus = report.incomplete
    ? `⚠️ UNCERTAIN (incomplete data)`
    : report.supersededReductionVsBaseline !== null &&
        report.supersededReductionVsBaseline >= ACCEPTANCE.supersededReductionMinPercent
      ? `✅ PASS (≥${ACCEPTANCE.supersededReductionMinPercent}% reduction/day)`
      : `❌ FAIL (${report.supersededReductionVsBaseline !== null ? `${fmt(report.supersededReductionVsBaseline)}%` : 'N/A'} reduction/day, target ≥${ACCEPTANCE.supersededReductionMinPercent}%)`;

  const classifiedStatus = report.incomplete
    ? `⚠️ UNCERTAIN (incomplete data)`
    : report.classificationRate >= ACCEPTANCE.classificationMinRate
      ? `✅ PASS (≥${Math.round(ACCEPTANCE.classificationMinRate * 100)}% of runner-minutes)`
      : `❌ FAIL (${pct(report.classificationRate * 100)}, target ≥${Math.round(ACCEPTANCE.classificationMinRate * 100)}%)`;

  const gapsStatus =
    report.classifierGaps.length === 0 && report.classifierUncertain.length === 0
      ? '✅ PASS (no gaps detected)'
      : report.classifierGaps.length > 0
        ? `❌ FAIL (${report.classifierGaps.length} validated gap(s), ${report.classifierUncertain.length} uncertain)`
        : `⚠️ UNCERTAIN (${report.classifierUncertain.length} uncertain finding(s))`;

  const nonVisualValue =
    report.nonVisualE2eStatus === 'measured' && report.nonVisualE2eMinutes !== null
      ? fmtMin(report.nonVisualE2eMinutes)
      : 'N/A (uncertain until #1688 visual_touched)';

  const baselineLatencyMedian =
    report.baselineWallClockLatency.median === null
      ? 'N/A'
      : fmt(report.baselineWallClockLatency.median);
  const baselineLatencyP95 =
    report.baselineWallClockLatency.p95 === null ? 'N/A' : fmt(report.baselineWallClockLatency.p95);

  return `# Post-Rollout CI Efficiency Report

Generated: ${report.generatedAt}
Window: ${report.analysisWindow.start} → ${report.analysisWindow.end} (${fmt(report.analysisWindow.days, 2)} days)

## Summary

| Metric | Baseline | Post-Rollout | Change | Target |
|--------|----------|--------------|--------|--------|
| Total runner-minutes (window-normalized baseline) | ${fmtMin(report.normalizedBaseline.totalMinutesForWindow)} | ${fmtMin(report.totalMinutes)} | ${fmt(normalizedTotalDeltaPct)}% | — |
| Total runner-minutes/day | ${fmt(b.totalMinutes / b.days)} | ${fmt(report.analysisWindow.days > 0 ? report.totalMinutes / report.analysisWindow.days : 0)} | — | — |
| Avoidable % | ${pct(b.avoidablePercent)} | ${pct(report.avoidablePercent)} | ${fmt(deltaAvoidable)}pp | <15% |
| Superseded minutes/day | ${fmt(report.normalizedBaseline.supersededMinutesPerDay)} | ${fmt(report.analysisWindow.days > 0 ? report.supersededMinutes / report.analysisWindow.days : 0)} | ${report.supersededReductionVsBaseline !== null ? `-${fmt(report.supersededReductionVsBaseline)}%` : 'N/A'} | -90% |
| Non-visual E2E min | ${fmtMin(b.nonVisualE2eMinutes)} | ${nonVisualValue} | — | — |
| Non-sim headless min | ${fmtMin(b.nonSimHeadlessMinutes)} | ${fmtMin(report.nonSimHeadlessMinutes)} | — | — |
| Non-coverage min | ${fmtMin(b.nonCoverageMinutes)} | ${fmtMin(report.nonCoverageMinutes)} | — | — |

## Acceptance Criteria

- **Avoidable share <15%**: ${avoidableStatus}
- **Superseded ≥90% reduction**: ${supersededStatus}
- **Classification ≥95% of runner-minutes**: ${classifiedStatus}
- **No classifier-caused gaps / false skips**: ${gapsStatus}

## Per-PR-Head Statistics

| Metric | Value |
|--------|-------|
| Median minutes/PR head | ${fmt(report.perPrStats.median)} |
| p95 minutes/PR head | ${fmt(report.perPrStats.p95)} |
| Sample PR heads | ${report.perPrStats.sampleSize} |

## Per-Impact Per-PR-Head Statistics

| Impact | Median min/head | p95 min/head | Sample heads |
|--------|------------------|--------------|--------------|
${(
  Object.entries(report.impactBreakdown) as Array<
    [ChangeImpact, Report['impactBreakdown'][ChangeImpact]]
  >
)
  .map(
    ([impact, stats]) =>
      `| ${impact} | ${fmt(stats.perHeadStats.median)} | ${fmt(stats.perHeadStats.p95)} | ${stats.perHeadStats.sampleSize} |`,
  )
  .join('\n')}

## Wall-Clock Latency Comparison

| Metric | Baseline | Post-Rollout |
|--------|----------|--------------|
| Median latency (min) | ${baselineLatencyMedian} | ${fmt(report.wallClockLatency.median)} |
| p95 latency (min) | ${baselineLatencyP95} | ${fmt(report.wallClockLatency.p95)} |
| Sample runs | N/A | ${report.wallClockLatency.sampleSize} |

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

## Classifier Required-Check Findings

${
  report.classifierGaps.length === 0 && report.classifierUncertain.length === 0
    ? 'None detected.'
    : [
        ...report.classifierGaps.map((gap) => `- GAP: ${gap}`),
        ...report.classifierUncertain.map((item) => `- UNCERTAIN: ${item}`),
      ].join('\n')
}

${
  report.incompleteReasons.length > 0
    ? `## Incomplete Data\n\n${report.incompleteReasons.map((reason) => `- ${reason}`).join('\n')}`
    : ''
}
`;
}

function parseArgs(argv: string[]): {
  owner: string;
  repo: string;
  token: string;
  start: Date;
  end: Date;
  outFile?: string;
  includeRunDetails: boolean;
  baselineWallClockLatency: { median: number | null; p95: number | null };
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
  const baselineLatencyMedianStr = get('--baseline-latency-median');
  const baselineLatencyP95Str = get('--baseline-latency-p95');

  if (!startStr || !endStr) {
    console.error('Usage: GH_TOKEN=<token> npx tsx scripts/agent/ci/measure-ci-efficiency.ts \\');
    console.error('         --start 2026-07-20T00:00:00Z \\');
    console.error('         --end 2026-07-27T00:00:00Z \\');
    console.error('         [--owner nalfeo] [--repo Crawler] [--out report.json] [--details]');
    process.exit(1);
  }

  const start = new Date(startStr);
  const end = new Date(endStr);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    console.error('❌ --start and --end must be valid ISO-8601 timestamps.');
    process.exit(1);
  }
  if (end <= start) {
    console.error('❌ --end must be greater than --start.');
    process.exit(1);
  }

  const parseOptionalNumber = (value: string | undefined, flag: string): number | null => {
    if (value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`❌ ${flag} must be a non-negative number when provided.`);
      process.exit(1);
    }
    return parsed;
  };

  const baselineLatencyMedian = parseOptionalNumber(
    baselineLatencyMedianStr,
    '--baseline-latency-median',
  );
  const baselineLatencyP95 = parseOptionalNumber(baselineLatencyP95Str, '--baseline-latency-p95');

  return {
    owner: get('--owner') ?? 'nalfeo',
    repo: get('--repo') ?? 'Crawler',
    token,
    start,
    end,
    outFile: get('--out'),
    includeRunDetails: args.includes('--details'),
    baselineWallClockLatency: {
      median: baselineLatencyMedian,
      p95: baselineLatencyP95,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const windowDays = (args.end.getTime() - args.start.getTime()) / (1000 * 60 * 60 * 24);
  if (windowDays < ACCEPTANCE.minWindowDays) {
    console.error(
      `❌ Window is ${windowDays.toFixed(1)} days, but the acceptance criterion requires at least ${ACCEPTANCE.minWindowDays} representative post-rollout days.`,
    );
    process.exit(1);
  }

  if (args.end.getTime() > Date.now()) {
    console.error('❌ --end must be in the past (<= now) so the observation window is complete.');
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

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export const __test = {
  ACCEPTANCE,
  classifyCiJobName,
  clippedSupersededMinutes,
  computeAvoidableMinutes,
  detectClassifierGapFindings,
  detectSupersededRuns,
  expectedCiJobsForImpact,
  packageJsonGameplaySafeFromObjects,
  parseRateLimitResetMs,
};
