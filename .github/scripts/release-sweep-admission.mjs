/**
 * Release-sweep capacity admission (nalfeo/Crawler#3774).
 *
 * The release sweep (`release-report-sweep` — 30 shards, 15 per report leg,
 * running at `max-parallel: 20` — plus `baseline-sweep`)
 * is the single largest runner consumer in the repository: ~600 headless runs
 * that hold ~16 concurrent runners for up to an hour, fired on every push to
 * main. When CI and development are already competing for the account runner
 * pool, that sweep starves the work people are actually waiting on.
 *
 * This module decides, per release, whether to admit the sweep:
 *
 *   - unconstrained pool                          -> sweep (unchanged behavior)
 *   - constrained pool, last baseline < 24h old   -> skip (capacity goes to CI)
 *   - constrained pool, last baseline >= 24h old  -> sweep anyway (staleness override)
 *
 * "Constrained" is measured primarily as *work already waiting for a runner*
 * rather than work currently running: a running job is being served, but a
 * queued job is someone blocked on a full pool, and the sweep would extend that
 * wait. Total pool claim (running + queued + latent CI backlog) is a secondary
 * signal that catches a pool which is about to saturate but has not queued yet.
 *
 * The staleness override is what keeps this from silently ending the baseline
 * series: no matter how busy the pool stays, a release sweep always runs at
 * least once per `RELEASE_SWEEP_MIN_INTERVAL_HOURS`.
 *
 * Every failure path **fails open** (sweep). Skipping is an optimization; a
 * broken demand probe or an unreadable `baselines` branch must never be able to
 * quietly stop baselining, which is a release-blocking regression signal.
 *
 * CLI usage (from deploy.yml):
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=...
 *   node .github/scripts/release-sweep-admission.mjs
 */
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { paginate, request } from './ci-recovery/github.mjs';
import { inspectLatentBacklog, inspectRunnerDemand } from './sweep-budget.mjs';

/**
 * Peak concurrent runners the release sweep claims: the report-leg matrix runs
 * under `max-parallel: 20`, which is the whole GitHub Free account pool
 * (`ACCOUNT_RUNNER_LIMIT`). Pinned against deploy.yml by
 * `tests/unit/release-sweep-capacity-gate.test.ts`.
 */
export const RELEASE_SWEEP_PEAK_RUNNERS = 20;

/**
 * Competing demand (live non-sweep jobs + latent CI backlog) above which the
 * sweep is not worth its cost. Because the sweep can saturate the pool on its
 * own, it is admitted only when the pool is close to idle.
 */
export const RELEASE_SWEEP_MAX_COMPETING_DEMAND = 4;

/**
 * Non-sweep jobs allowed to be *waiting for a runner* while the sweep is still
 * admitted. This is the primary constraint signal: a running job is already
 * being served, but a queued job is work that a human is waiting on and that the
 * pool has no capacity for right now. Adding a sweep on top of a non-empty queue
 * directly extends that wait, so the default is 0 — any queue blocks the sweep
 * (subject to the staleness override).
 */
export const RELEASE_SWEEP_MAX_QUEUED_JOBS = 0;

/** Hours after which a constrained pool no longer justifies skipping. */
export const RELEASE_SWEEP_MIN_INTERVAL_HOURS = 24;

/** Branch the completed sweep publishes its baseline to. */
export const BASELINES_BRANCH = 'baselines';

const HOUR_MS = 60 * 60 * 1000;

/** Strict non-negative-integer env parse; anything malformed falls back. */
function parseNonNegativeInt(raw, fallback) {
  const normalized = String(raw ?? '').trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** Strict positive-integer env parse; anything malformed falls back. */
function parsePositiveInt(raw, fallback) {
  const parsed = parseNonNegativeInt(raw, fallback);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Pure admission decision.
 *
 * @param {object} input
 * @param {number} input.nonSweepJobs live non-sweep jobs competing for runners
 * @param {number} input.queuedJobs non-sweep jobs waiting for a free runner
 * @param {number} input.latentBacklog queued CI demand not yet scheduled
 * @param {Date|null} input.lastSweepAt when the last baseline was published
 * @param {Date} input.now current time
 * @returns {{ shouldSweep: boolean, reason: string, constrained: boolean, hoursSinceLastSweep: number|null }}
 */
export function decideReleaseSweep({
  nonSweepJobs,
  queuedJobs = 0,
  latentBacklog,
  lastSweepAt,
  now = new Date(),
  maxCompetingDemand = RELEASE_SWEEP_MAX_COMPETING_DEMAND,
  maxQueuedJobs = RELEASE_SWEEP_MAX_QUEUED_JOBS,
  minIntervalHours = RELEASE_SWEEP_MIN_INTERVAL_HOURS,
}) {
  if (!Number.isInteger(nonSweepJobs) || nonSweepJobs < 0) {
    throw new Error(`nonSweepJobs must be a non-negative integer, received ${nonSweepJobs}`);
  }
  if (!Number.isInteger(queuedJobs) || queuedJobs < 0) {
    throw new Error(`queuedJobs must be a non-negative integer, received ${queuedJobs}`);
  }
  if (!Number.isInteger(latentBacklog) || latentBacklog < 0) {
    throw new Error(`latentBacklog must be a non-negative integer, received ${latentBacklog}`);
  }
  // Two independent constraint signals, either of which is disqualifying:
  //   1. work already waiting for a runner (queue depth) — the pool is full now;
  //   2. total claim on the pool (running + queued + latent CI backlog) — the
  //      pool is about to be full.
  const queueConstrained = queuedJobs > maxQueuedJobs;
  const demand = nonSweepJobs + latentBacklog;
  const demandConstrained = demand > maxCompetingDemand;
  const constrained = queueConstrained || demandConstrained;
  const pressure = queueConstrained
    ? `${queuedJobs} job(s) already waiting for a runner (> ${maxQueuedJobs})`
    : `competing demand ${demand} > ${maxCompetingDemand}`;
  const lastSweepMs =
    lastSweepAt instanceof Date && Number.isFinite(lastSweepAt.getTime())
      ? lastSweepAt.getTime()
      : null;
  const hoursSinceLastSweep =
    lastSweepMs === null ? null : Math.max(0, (now.getTime() - lastSweepMs) / HOUR_MS);

  if (!constrained) {
    return {
      shouldSweep: true,
      constrained,
      hoursSinceLastSweep,
      reason: `runner pool has headroom (${queuedJobs} job(s) queued <= ${maxQueuedJobs}, competing demand ${demand} <= ${maxCompetingDemand})`,
    };
  }
  if (hoursSinceLastSweep === null) {
    return {
      shouldSweep: true,
      constrained,
      hoursSinceLastSweep,
      reason: `runner pool is constrained (${pressure}) but no previous baseline was found; sweeping`,
    };
  }
  if (hoursSinceLastSweep >= minIntervalHours) {
    return {
      shouldSweep: true,
      constrained,
      hoursSinceLastSweep,
      reason: `runner pool is constrained (${pressure}) but the last baseline is ${hoursSinceLastSweep.toFixed(1)}h old (>= ${minIntervalHours}h); sweeping anyway`,
    };
  }
  return {
    shouldSweep: false,
    constrained,
    hoursSinceLastSweep,
    reason: `runner pool is constrained (${pressure}; the sweep alone claims up to ${RELEASE_SWEEP_PEAK_RUNNERS} runners) and the last baseline is only ${hoursSinceLastSweep.toFixed(1)}h old (< ${minIntervalHours}h); skipping`,
  };
}

/**
 * Commit date of the `baselines` branch tip, i.e. when the last release sweep
 * finished and published. Returns null when the branch does not exist yet (no
 * sweep has ever published) so the caller treats the series as stale.
 */
export async function fetchLastSweepAt({ token, owner, repo, requestFn = request }) {
  const { data } = await requestFn(
    token,
    `/repos/${owner}/${repo}/commits?sha=${BASELINES_BRANCH}&per_page=1`,
  );
  const commit = Array.isArray(data) ? data[0] : null;
  const raw = commit?.commit?.committer?.date ?? commit?.commit?.author?.date;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Probe live demand and the baseline recency, then decide. Any probe failure is
 * reported through `warnings` and degraded to the fail-open inputs (no
 * measurable pressure / unknown last sweep), so the caller still sweeps.
 */
export async function resolveReleaseSweepAdmission({
  token,
  repository,
  currentRunId,
  now = new Date(),
  requestFn = request,
  paginateFn = paginate,
  minIntervalHours = RELEASE_SWEEP_MIN_INTERVAL_HOURS,
  maxCompetingDemand = RELEASE_SWEEP_MAX_COMPETING_DEMAND,
  maxQueuedJobs = RELEASE_SWEEP_MAX_QUEUED_JOBS,
}) {
  const [owner, repo] = String(repository).split('/');
  if (!token || !owner || !repo) {
    throw new Error('Missing GITHUB_TOKEN or GITHUB_REPOSITORY');
  }
  const warnings = [];
  let nonSweepJobs = 0;
  let queuedJobs = 0;
  let latentBacklog = 0;
  let lastSweepAt = null;

  const [demandResult, backlogResult, lastSweepResult] = await Promise.allSettled([
    inspectRunnerDemand({
      token,
      owner,
      repo,
      currentRunId,
      requestFn,
      excludeRunIds: [currentRunId],
    }),
    inspectLatentBacklog({ token, owner, repo, now, paginateFn }),
    fetchLastSweepAt({ token, owner, repo, requestFn }),
  ]);

  if (demandResult.status === 'fulfilled') {
    nonSweepJobs = demandResult.value.nonSweepJobs;
    queuedJobs = demandResult.value.queuedJobs ?? 0;
  } else {
    warnings.push(`runner demand probe failed: ${demandResult.reason?.message}`);
  }
  if (backlogResult.status === 'fulfilled') {
    latentBacklog = backlogResult.value;
  } else {
    warnings.push(`latent backlog probe failed: ${backlogResult.reason?.message}`);
  }
  if (lastSweepResult.status === 'fulfilled') {
    lastSweepAt = lastSweepResult.value;
  } else {
    warnings.push(`baselines branch probe failed: ${lastSweepResult.reason?.message}`);
  }

  const decision = decideReleaseSweep({
    nonSweepJobs,
    queuedJobs,
    latentBacklog,
    lastSweepAt,
    now,
    maxCompetingDemand,
    maxQueuedJobs,
    minIntervalHours,
  });
  return { ...decision, nonSweepJobs, queuedJobs, latentBacklog, lastSweepAt, warnings };
}

async function writeOutputs(path, result) {
  // `reason` can embed an error message, so collapse newlines: a multi-line
  // value would corrupt the whole GITHUB_OUTPUT file.
  const reason = String(result.reason).replace(/\s*\r?\n\s*/g, ' ');
  await appendFile(
    path,
    [
      `should_sweep=${result.shouldSweep}`,
      `reason=${reason}`,
      `non_sweep_jobs=${result.nonSweepJobs}`,
      `queued_jobs=${result.queuedJobs}`,
      `latent_backlog=${result.latentBacklog}`,
      '',
    ].join('\n'),
  );
}

export async function runFromEnv(env = process.env, resolveFn = resolveReleaseSweepAdmission) {
  let result;
  try {
    result = await resolveFn({
      token: env.GITHUB_TOKEN,
      repository: env.GITHUB_REPOSITORY,
      currentRunId: env.GITHUB_RUN_ID,
      minIntervalHours: parsePositiveInt(
        env.RELEASE_SWEEP_MIN_INTERVAL_HOURS,
        RELEASE_SWEEP_MIN_INTERVAL_HOURS,
      ),
      maxCompetingDemand: parsePositiveInt(
        env.RELEASE_SWEEP_MAX_COMPETING_DEMAND,
        RELEASE_SWEEP_MAX_COMPETING_DEMAND,
      ),
      maxQueuedJobs: parseNonNegativeInt(
        env.RELEASE_SWEEP_MAX_QUEUED_JOBS,
        RELEASE_SWEEP_MAX_QUEUED_JOBS,
      ),
    });
  } catch (error) {
    // Fail open: an unexpected failure here must not stop baselining.
    process.stderr.write(
      `::warning::Release sweep admission failed; sweeping anyway: ${error.message}\n`,
    );
    result = {
      shouldSweep: true,
      reason: `admission check failed (${error.message}); failing open`,
      nonSweepJobs: 0,
      queuedJobs: 0,
      latentBacklog: 0,
      warnings: [],
    };
  }
  for (const warning of result.warnings ?? []) {
    process.stderr.write(`::warning::${warning}; failing open on that signal\n`);
  }
  process.stdout.write(`release sweep should_sweep=${result.shouldSweep} — ${result.reason}\n`);
  if (!env.GITHUB_OUTPUT) {
    throw new Error('Missing GITHUB_OUTPUT');
  }
  await writeOutputs(env.GITHUB_OUTPUT, result);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `### Release sweep admission\n\n- **Sweep:** ${result.shouldSweep ? 'yes' : 'skipped'}\n- **Reason:** ${result.reason}\n- **Measured:** ${result.queuedJobs} queued job(s), ${result.nonSweepJobs} active non-sweep job(s), ${result.latentBacklog} latent backlog\n`,
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromEnv().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
