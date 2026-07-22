import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  BLOCKED_LABEL,
  CI_CONFLICT_ORDER_WAIT_LABEL,
  QUEUE_LABEL,
  RECOVERY_PENDING_LABEL,
  VALIDATION_FAILED_LABEL,
} from '../../../scripts/merge-train/state.mjs';
import {
  OWNER_LABEL_PREFIX,
  WAITING_LABEL,
  WAITING_TRANSITION_LABEL,
} from '../../../scripts/ci-recovery/state.mjs';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_ACTIVE_RUNS = 25;
export const RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const TRAIN_COMMENT_LABELS = new Set([
  QUEUE_LABEL,
  BLOCKED_LABEL,
  CI_CONFLICT_ORDER_WAIT_LABEL,
  VALIDATION_FAILED_LABEL,
]);

function hasAnyLabel(pullRequest, names) {
  return (pullRequest.labels ?? []).some((label) => names.has(label.name));
}

function isRecoveryPullRequest(pullRequest) {
  return (pullRequest.labels ?? []).some(
    (label) =>
      label.name === RECOVERY_PENDING_LABEL ||
      label.name === WAITING_LABEL ||
      label.name === WAITING_TRANSITION_LABEL ||
      label.name.startsWith(OWNER_LABEL_PREFIX),
  );
}

export function parseGitHubRepository(remoteUrl) {
  const normalized = String(remoteUrl ?? '')
    .trim()
    .replace(/\.git$/i, '');
  const match =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(normalized) ??
    /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(normalized) ??
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i.exec(normalized);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function sanitizeErrorText(value, environment = process.env) {
  let text = String(value ?? '');
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const secret = environment[name];
    if (secret) text = text.replaceAll(secret, '<redacted>');
  }
  return text
    .replace(/\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]+\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runCommand(binary, args, options = {}) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
        GH_PAGER: 'cat',
        PAGER: 'cat',
      },
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      signal: options.signal,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const detail = sanitizeErrorText(error?.stderr || error?.message || error);
    throw new Error(`${binary} command failed${detail ? `: ${detail}` : ''}`);
  }
}

async function runGhJson(repository, endpoint, signal) {
  const output = await runCommand(
    'gh',
    ['api', '--method', 'GET', `repos/${repository}/${endpoint}`],
    { signal },
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub CLI returned invalid JSON.');
  }
}

async function paginateArray(repository, endpoint, signal, maxPages = 10) {
  const values = [];
  let apiCalls = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const pageValues = await runGhJson(
      repository,
      `${endpoint}${separator}per_page=100&page=${page}`,
      signal,
    );
    apiCalls += 1;
    if (!Array.isArray(pageValues))
      throw new Error(`GitHub API did not return an array for ${endpoint}.`);
    values.push(...pageValues);
    if (pageValues.length < 100) return { values, apiCalls, truncated: false };
  }
  return { values, apiCalls, truncated: true };
}

async function listRunsForStatus(repository, status, signal) {
  const response = await runGhJson(
    repository,
    `actions/runs?status=${encodeURIComponent(status)}&per_page=100&page=1`,
    signal,
  );
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error(`GitHub API did not return workflow runs for status ${status}.`);
  }
  return {
    runs: response.workflow_runs,
    totalCount: Number(response.total_count ?? response.workflow_runs.length),
    apiCalls: 1,
  };
}

async function listJobs(repository, runId, signal) {
  const response = await runGhJson(
    repository,
    `actions/runs/${runId}/jobs?filter=latest&per_page=100&page=1`,
    signal,
  );
  if (!Array.isArray(response.jobs)) {
    throw new Error(`GitHub API did not return jobs for run ${runId}.`);
  }
  return {
    jobs: response.jobs,
    truncated: Number(response.total_count ?? response.jobs.length) > response.jobs.length,
  };
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export function mergeRunStatusResults(results, statuses = RUN_STATUSES) {
  const runsById = new Map();
  const partialErrors = [];
  let apiCalls = 0;
  let omittedCount = 0;
  let successCount = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === 'rejected') {
      partialErrors.push(
        `Workflow status ${statuses[index]}: ${sanitizeErrorText(result.reason?.message ?? result.reason)}`,
      );
      continue;
    }
    successCount += 1;
    apiCalls += result.value.apiCalls;
    omittedCount += Math.max(0, result.value.totalCount - result.value.runs.length);
    for (const run of result.value.runs) runsById.set(run.id, run);
  }
  return {
    runs: [...runsById.values()],
    partialErrors,
    apiCalls,
    omittedCount,
    allFailed: successCount === 0,
  };
}

export function statusCountGapWarning(count) {
  if (count <= 0) return null;
  return `${count} active workflow run${count === 1 ? ' was' : 's were'} counted but not returned in the status snapshots; the run may have transitioned state during refresh.`;
}

export async function resolveProjectContext(workingDirectory, signal) {
  if (!workingDirectory) {
    throw new Error('Canvas runtime did not provide an active project working directory.');
  }
  const remoteUrl = await runCommand('git', ['remote', 'get-url', 'origin'], {
    cwd: workingDirectory,
    signal,
  });
  const repository = parseGitHubRepository(remoteUrl);
  if (!repository) throw new Error('Origin remote is not a supported github.com repository.');
  return { repository, workingDirectory };
}

export async function loadRepositoryState(repository, signal) {
  let apiCalls = 0;
  const partialErrors = [];
  const openPullResult = await paginateArray(repository, 'pulls?state=open&base=main', signal);
  apiCalls += openPullResult.apiCalls;
  if (openPullResult.truncated) partialErrors.push('Open pull-request results were truncated.');

  const recoveryResult = await paginateArray(
    repository,
    `issues?state=closed&labels=${encodeURIComponent(RECOVERY_PENDING_LABEL)}`,
    signal,
    2,
  );
  apiCalls += recoveryResult.apiCalls;
  if (recoveryResult.truncated)
    partialErrors.push('Closed recovery-pending results were truncated.');

  const recoveryPullRequests = recoveryResult.values.filter((issue) => issue.pull_request);
  const commentsNeeded = openPullResult.values.filter((pullRequest) =>
    hasAnyLabel(pullRequest, TRAIN_COMMENT_LABELS),
  );
  const commentsByPr = new Map();
  const commentFetchFailed = new Set();
  const commentResults = await mapWithConcurrency(commentsNeeded, 5, async (pullRequest) => {
    try {
      const result = await paginateArray(
        repository,
        `issues/${pullRequest.number}/comments`,
        signal,
        3,
      );
      return { number: pullRequest.number, ...result };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return {
        number: pullRequest.number,
        values: [],
        apiCalls: 1,
        truncated: false,
        fetchFailed: true,
        error: sanitizeErrorText(error?.message ?? error),
      };
    }
  });
  for (const result of commentResults) {
    apiCalls += result.apiCalls;
    commentsByPr.set(result.number, result.values);
    if (result.fetchFailed) commentFetchFailed.add(result.number);
    if (result.truncated) partialErrors.push(`Comments for PR #${result.number} were truncated.`);
    if (result.error) partialErrors.push(`Comments for PR #${result.number}: ${result.error}`);
  }

  const runResults = await Promise.allSettled(
    RUN_STATUSES.map((status) => listRunsForStatus(repository, status, signal)),
  );
  signal?.throwIfAborted();
  const mergedRuns = mergeRunStatusResults(runResults);
  partialErrors.push(...mergedRuns.partialErrors);
  apiCalls += mergedRuns.apiCalls;
  if (mergedRuns.allFailed) throw new Error(partialErrors.join(' '));
  const countGapWarning = statusCountGapWarning(mergedRuns.omittedCount);
  if (countGapWarning) partialErrors.push(countGapWarning);

  const allRuns = mergedRuns.runs.sort(
    (left, right) =>
      (Date.parse(left.created_at ?? '') || 0) - (Date.parse(right.created_at ?? '') || 0) ||
      left.id - right.id,
  );
  const selectedRuns = allRuns.slice(0, MAX_ACTIVE_RUNS);
  const activeRunsTruncated = Math.max(0, allRuns.length - selectedRuns.length);
  const runs = await mapWithConcurrency(selectedRuns, 5, async (run) => {
    try {
      const result = await listJobs(repository, run.id, signal);
      apiCalls += 1;
      return { ...run, jobs: result.jobs, jobsTruncated: result.truncated };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      apiCalls += 1;
      return {
        ...run,
        jobs: [],
        jobsError: sanitizeErrorText(error?.message ?? error),
      };
    }
  });

  return {
    repository,
    openPullRequests: openPullResult.values.filter(
      (pullRequest) =>
        hasAnyLabel(pullRequest, TRAIN_COMMENT_LABELS) || isRecoveryPullRequest(pullRequest),
    ),
    recoveryPullRequests,
    commentsByPr,
    commentFetchFailed,
    runs,
    activeRunsTruncated,
    partialErrors,
    apiCalls,
    fetchedAt: new Date().toISOString(),
  };
}
