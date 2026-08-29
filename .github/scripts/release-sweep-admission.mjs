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
 * least once per `RELEASE_SWEEP_MIN_INTERVAL_HOURS`. That override is serialized
 * against a sweep that is still in flight, because the `baselines` tip only
 * advances when a sweep *completes*: without it, every push during the 60-120
 * minute window of the first catch-up sweep would launch another one.
 *
 * Every failure path **fails open** (sweep), including a *partial* one: if any
 * probe fails, a skip verdict is discarded, because the surviving signals can
 * read as "constrained" while the missing one was the reason to sweep. Skipping
 * is an optimization; a broken demand probe or an unreadable `baselines` branch
 * must never be able to quietly stop baselining, which is a release-blocking
 * regression signal.
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

/** Workflow file that owns the release sweep jobs. */
export const RELEASE_WORKFLOW_FILE = 'deploy.yml';

/**
 * Job-name prefixes of the two release sweep legs, used to detect a sweep that
 * is still in flight in an earlier release run. Pinned against the real job
 * names in deploy.yml by `tests/unit/release-sweep-capacity-gate.test.ts`.
 */
export const RELEASE_SWEEP_JOB_PREFIXES = ['Release report leg', 'Baseline multi-floor sweep'];

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
 * @param {boolean} input.sweepInFlight a release sweep from an earlier run is still running
 * @param {Date|null} input.lastSweepAt when the last baseline was published
 * @param {Date} input.now current time
 * @returns {{ shouldSweep: boolean, reason: string, constrained: boolean, hoursSinceLastSweep: number|null }}
 */
export function decideReleaseSweep({
  nonSweepJobs,
  queuedJobs = 0,
  latentBacklog,
  sweepInFlight = false,
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
    if (sweepInFlight) {
      return {
        shouldSweep: false,
        constrained,
        hoursSinceLastSweep,
        reason: `runner pool is constrained (${pressure}) and no previous baseline was found, but a release sweep from an earlier run is still in flight; skipping so catch-up sweeps do not stack`,
      };
    }
    return {
      shouldSweep: true,
      constrained,
      hoursSinceLastSweep,
      reason: `runner pool is constrained (${pressure}) but no previous baseline was found; sweeping`,
    };
  }
  if (hoursSinceLastSweep >= minIntervalHours) {
    // The `baselines` tip only moves when a sweep *finishes*, so during the
    // 60-120 minute window of an in-flight sweep every later release would see
    // the same stale tip and pile on another full-pool sweep. One outstanding
    // catch-up sweep at a time is enough to refresh the series.
    if (sweepInFlight) {
      return {
        shouldSweep: false,
        constrained,
        hoursSinceLastSweep,
        reason: `runner pool is constrained (${pressure}) and the last baseline is ${hoursSinceLastSweep.toFixed(1)}h old, but a release sweep from an earlier run is still in flight; skipping so catch-up sweeps do not stack`,
      };
    }
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
 * Whether a release sweep started by an *earlier* release run is still running.
 *
 * The `baselines` tip only advances when a sweep completes, so without this the
 * staleness override re-admits a full-pool sweep on every push during the
 * 60-120 minute window of the first one.
 */
export async function inspectSweepInFlight({
  token,
  owner,
  repo,
  currentRunId,
  requestFn = request,
}) {
  const current = Number(currentRunId);
  const runs = [];
  for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
    const { data } = await requestFn(
      token,
      `/repos/${owner}/${repo}/actions/workflows/${RELEASE_WORKFLOW_FILE}/runs?status=${encodeURIComponent(status)}&per_page=100`,
    );
    for (const run of data?.workflow_runs || []) {
      if (Number(run.id) !== current) runs.push(run);
    }
  }
  const unique = [...new Map(runs.map((run) => [Number(run.id), run])).values()];
  for (const run of unique) {
    const { data } = await requestFn(
      token,
      `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    const sweeping = (data?.jobs || []).some(
      (job) =>
        job.status !== 'completed' &&
        RELEASE_SWEEP_JOB_PREFIXES.some((prefix) => String(job.name ?? '').startsWith(prefix)),
    );
    if (sweeping) return true;
  }
  return false;
}

/**
 * Probe live demand and the baseline recency, then decide. Any probe failure is
 * reported through `warnings` and forces the fail-open verdict (sweep): a
 * missing pressure signal means the skip decision cannot be trusted, and losing
 * a baseline is worse than spending runners.
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
  let sweepInFlight = false;
  let lastSweepAt = null;

  const [demandResult, backlogResult, lastSweepResult, inFlightResult] = await Promise.allSettled([
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
    inspectSweepInFlight({ token, owner, repo, currentRunId, requestFn }),
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
  if (inFlightResult.status === 'fulfilled') {
    sweepInFlight = inFlightResult.value;
  } else {
    warnings.push(`in-flight sweep probe failed: ${inFlightResult.reason?.message}`);
  }

  const decision = decideReleaseSweep({
    nonSweepJobs,
    queuedJobs,
    latentBacklog,
    sweepInFlight,
    lastSweepAt,
    now,
    maxCompetingDemand,
    maxQueuedJobs,
    minIntervalHours,
  });
  // A single failed probe is enough to invalidate a skip: the surviving signals
  // can still read as "constrained" while the missing one was the reason to
  // sweep. Degrading one input to zero is not fail-open on its own.
  if (!decision.shouldSweep && warnings.length > 0) {
    return {
      ...decision,
      shouldSweep: true,
      reason: `${decision.reason} — but ${warnings.length} probe(s) failed, so the skip is not trustworthy; sweeping`,
      nonSweepJobs,
      queuedJobs,
      latentBacklog,
      sweepInFlight,
      lastSweepAt,
      warnings,
    };
  }
  return {
    ...decision,
    nonSweepJobs,
    queuedJobs,
    latentBacklog,
    sweepInFlight,
    lastSweepAt,
    warnings,
  };
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
      `### Release sweep admission\n\n- **Sweep:** ${result.shouldSweep ? 'yes' : 'skipped'}\n- **Reason:** ${result.reason}\n- **Measured:** ${result.queuedJobs} queued job(s), ${result.nonSweepJobs} active non-sweep job(s), ${result.latentBacklog} latent backlog, sweep in flight: ${result.sweepInFlight ? 'yes' : 'no'}\n`,
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
