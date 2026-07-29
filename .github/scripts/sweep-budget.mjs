import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  hydrateRecoveryOwnership,
  isExternallyBlocked,
  recoveryBacklogEntries,
} from './ci-recovery/router.mjs';
import { paginate, request } from './ci-recovery/github.mjs';
import { queueEntries } from './merge-train/state.mjs';

export const SWEEP_POOL_SIZE = 10;
export const ACCOUNT_RUNNER_LIMIT = 20;
export const SWEEP_WORKFLOW_NAMES = new Set([
  'AI Sweep Eval',
  'AI Sweep Recover (round-2 validate-only)',
  'Weapon Sweep',
]);
const ACTIVE_RUN_STATUSES = ['queued', 'pending', 'in_progress', 'waiting', 'requested'];
const ACTIVE_JOB_STATUSES = new Set(['queued', 'pending', 'in_progress', 'waiting', 'requested']);

export class SweepProbeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SweepProbeError';
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function computeSweepBudget({
  nonSweepJobs,
  latentBacklog,
  accountRunnerLimit = ACCOUNT_RUNNER_LIMIT,
  sweepPoolSize = SWEEP_POOL_SIZE,
}) {
  if (!Number.isInteger(nonSweepJobs) || nonSweepJobs < 0) {
    throw new Error(`nonSweepJobs must be a non-negative integer, received ${nonSweepJobs}`);
  }
  if (!Number.isInteger(latentBacklog) || latentBacklog < 0) {
    throw new Error(`latentBacklog must be a non-negative integer, received ${latentBacklog}`);
  }
  return clamp(accountRunnerLimit - nonSweepJobs - latentBacklog, 1, sweepPoolSize);
}

export function allocateSweepSlots({ budget, activeRunIds, currentRunId }) {
  if (!Number.isInteger(budget) || budget < 1 || budget > SWEEP_POOL_SIZE) {
    throw new Error(`budget must be an integer in [1,${SWEEP_POOL_SIZE}], received ${budget}`);
  }
  const current = Number(currentRunId);
  if (!Number.isSafeInteger(current) || current <= 0) {
    throw new Error(`currentRunId must be a positive safe integer, received ${currentRunId}`);
  }
  const runs = [...new Set([...activeRunIds.map(Number), current])]
    .filter((runId) => Number.isSafeInteger(runId) && runId > 0)
    .sort((left, right) => left - right);
  const rank = runs.indexOf(current);
  if (runs.length > budget) {
    return [rank % budget];
  }
  const slots = Array.from({ length: budget }, (_, index) => index).filter(
    (slot) => slot % runs.length === rank,
  );
  return slots.length > 0 ? slots : [rank % budget];
}

export function enrichMatrix(entries, slots, scalarKey = 'value') {
  if (!Array.isArray(entries)) {
    throw new Error('matrix input must be a JSON array');
  }
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error('at least one sweep slot is required');
  }
  return entries.map((entry, index) => {
    const sweepSlot = slots[index % slots.length];
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return { ...entry, sweepSlot };
    }
    return { [scalarKey]: entry, sweepSlot };
  });
}

export function countLatentBacklog({ pullRequests, repository, now = new Date() }) {
  const baseEligible = pullRequests.filter(
    (pr) =>
      pr.state === 'open' &&
      !pr.draft &&
      pr.base?.ref === 'main' &&
      pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase(),
  );
  // Externally-blocked PRs (e.g. merge-train-blocked) are excluded from CI
  // Recovery slot consumption but still represent latent CI demand that will
  // eventually need runner capacity, so they count toward the sweep budget —
  // even when they carry ci-recovery-opt-out.
  const numbers = new Set([
    ...queueEntries(pullRequests, repository).map((pullRequest) => pullRequest.number),
    ...recoveryBacklogEntries(pullRequests, repository, now).map(
      (pullRequest) => pullRequest.number,
    ),
    ...baseEligible.filter(isExternallyBlocked).map((pr) => pr.number),
  ]);
  return numbers.size;
}

async function listActiveRuns(token, owner, repo, requestFn = request) {
  const runs = new Map();
  await Promise.all(
    ACTIVE_RUN_STATUSES.map(async (status) => {
      let page = 1;
      while (true) {
        const { data } = await requestFn(
          token,
          `/repos/${owner}/${repo}/actions/runs?status=${encodeURIComponent(status)}&per_page=100&page=${page}`,
        );
        const pageRuns = data?.workflow_runs || [];
        for (const run of pageRuns) runs.set(run.id, run);
        if (pageRuns.length < 100) break;
        page += 1;
      }
    }),
  );
  return [...runs.values()];
}

async function countActiveJobsForRun(token, owner, repo, runId, requestFn = request) {
  let count = 0;
  let page = 1;
  while (true) {
    const { data } = await requestFn(
      token,
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    const jobs = data?.jobs || [];
    count += jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;
    if (jobs.length < 100) break;
    page += 1;
  }
  return count;
}

export async function inspectRunnerDemand({
  token,
  owner,
  repo,
  currentRunId,
  requestFn = request,
}) {
  const runs = await listActiveRuns(token, owner, repo, requestFn);
  const sweepRuns = runs.filter((run) => SWEEP_WORKFLOW_NAMES.has(run.name));
  const nonSweepRuns = runs.filter((run) => !SWEEP_WORKFLOW_NAMES.has(run.name));
  const jobCounts = await Promise.all(
    nonSweepRuns.map(async (run) => {
      const count = await countActiveJobsForRun(token, owner, repo, run.id, requestFn);
      return Math.max(1, count);
    }),
  );
  return {
    activeSweepRunIds: [...new Set([...sweepRuns.map((run) => run.id), Number(currentRunId)])],
    nonSweepJobs: jobCounts.reduce((total, count) => total + count, 0),
  };
}

export async function inspectLatentBacklog({
  token,
  owner,
  repo,
  now = new Date(),
  paginateFn = paginate,
}) {
  const repository = `${owner}/${repo}`;
  let pullRequests = await paginateFn(
    token,
    `/repos/${owner}/${repo}/pulls?state=open&base=main&sort=updated&direction=desc`,
  );
  pullRequests = await hydrateRecoveryOwnership(
    pullRequests,
    (number) => paginateFn(token, `/repos/${owner}/${repo}/issues/${number}/comments`),
    6,
  );
  const unreadableOwners = pullRequests.filter(
    (pullRequest) => pullRequest.recoveryStateUnreadable,
  );
  if (unreadableOwners.length > 0) {
    throw new Error(
      `CI recovery ownership unreadable for PR ${unreadableOwners.map((pullRequest) => `#${pullRequest.number}`).join(', ')}`,
    );
  }
  return countLatentBacklog({ pullRequests, repository, now });
}

export async function calculateSweepAdmission({
  token,
  repository,
  currentRunId,
  matrixEntries,
  matrixKey = 'value',
  requestFn = request,
  paginateFn = paginate,
  now = new Date(),
}) {
  const [owner, repo] = String(repository).split('/');
  if (!token || !owner || !repo) {
    throw new Error('Missing GITHUB_TOKEN or GITHUB_REPOSITORY');
  }
  let runnerDemand;
  let latentBacklog;
  try {
    [runnerDemand, latentBacklog] = await Promise.all([
      inspectRunnerDemand({ token, owner, repo, currentRunId, requestFn }),
      inspectLatentBacklog({ token, owner, repo, now, paginateFn }),
    ]);
  } catch (error) {
    throw new SweepProbeError(`GitHub demand probe failed: ${error.message}`, { cause: error });
  }
  const budget = computeSweepBudget({
    nonSweepJobs: runnerDemand.nonSweepJobs,
    latentBacklog,
  });
  const slots = allocateSweepSlots({
    budget,
    activeRunIds: runnerDemand.activeSweepRunIds,
    currentRunId,
  });
  return {
    budget,
    slots,
    maxParallel: slots.length,
    matrix: enrichMatrix(matrixEntries, slots, matrixKey),
    nonSweepJobs: runnerDemand.nonSweepJobs,
    latentBacklog,
  };
}

async function writeOutputs(path, result) {
  const values = {
    budget: result.budget,
    slots: JSON.stringify(result.slots),
    max_parallel: result.maxParallel,
    matrix: JSON.stringify(result.matrix),
    non_sweep_jobs: result.nonSweepJobs,
    latent_backlog: result.latentBacklog,
  };
  await appendFile(
    path,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
  );
}

export async function runFromEnv(env = process.env, calculateFn = calculateSweepAdmission) {
  const matrixEntries = JSON.parse(env.MATRIX_JSON || '[]');
  let result;
  try {
    result = await calculateFn({
      token: env.GITHUB_TOKEN,
      repository: env.GITHUB_REPOSITORY,
      currentRunId: env.GITHUB_RUN_ID,
      matrixEntries,
      matrixKey: env.MATRIX_KEY || 'value',
    });
  } catch (error) {
    if (!(error instanceof SweepProbeError)) {
      throw error;
    }
    process.stderr.write(
      `::warning::Sweep budget probe failed; failing closed to slot 0: ${error.message}\n`,
    );
    result = {
      budget: 1,
      slots: [0],
      maxParallel: 1,
      matrix: enrichMatrix(matrixEntries, [0], env.MATRIX_KEY || 'value'),
      nonSweepJobs: ACCOUNT_RUNNER_LIMIT,
      latentBacklog: 0,
    };
  }
  process.stdout.write(
    `sweep budget=${result.budget} slots=${result.slots.join(',')} non_sweep_jobs=${result.nonSweepJobs} latent_backlog=${result.latentBacklog}\n`,
  );
  if (!env.GITHUB_OUTPUT) {
    throw new Error('Missing GITHUB_OUTPUT');
  }
  await writeOutputs(env.GITHUB_OUTPUT, result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromEnv().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
