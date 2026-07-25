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
const MAX_ASSET_ISSUE_PAGES = 5;
const ASSET_COMMENT_WINDOW = 100;
const RECENT_PIPELINE_RUNS = 3;
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

async function runGhGraphql(query, variables, signal) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined) args.push('-F', `${name}=${value}`);
  }
  const output = await runCommand('gh', args, { signal });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub CLI returned invalid GraphQL JSON.');
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

const ASSET_REQUEST_ISSUES_QUERY = `
    query AssetRequestIssues($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        issues(
          first: 100
          after: $cursor
          states: OPEN
          labels: ["asset-request"]
          orderBy: { field: CREATED_AT, direction: ASC }
        ) {
          nodes {
            number
            title
            url
            createdAt
            updatedAt
            comments(last: ${ASSET_COMMENT_WINDOW}) {
              totalCount
              pageInfo { hasPreviousPage }
              nodes {
                id
                body
                createdAt
                updatedAt
                url
                author { login }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;

export async function loadAssetRequestIssues(repository, signal, queryGraphql = runGhGraphql) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error('Repository must use owner/name format.');
  const issues = [];
  let cursor = null;
  let apiCalls = 0;
  let truncated = false;
  for (let page = 1; page <= MAX_ASSET_ISSUE_PAGES; page += 1) {
    const response = await queryGraphql(
      ASSET_REQUEST_ISSUES_QUERY,
      { owner, name, cursor },
      signal,
    );
    apiCalls += 1;
    const connection = response.data?.repository?.issues;
    if (!Array.isArray(connection?.nodes)) {
      throw new Error('GitHub GraphQL did not return open asset-request issues.');
    }
    issues.push(...connection.nodes);
    if (!connection.pageInfo?.hasNextPage) return { issues, apiCalls, truncated: false };
    cursor = connection.pageInfo.endCursor;
    if (!cursor) throw new Error('GitHub GraphQL omitted the next asset-request issue cursor.');
    if (page === MAX_ASSET_ISSUE_PAGES) truncated = true;
  }
  return { issues, apiCalls, truncated };
}

export function selectLatestRunWithStep(runs, stepPattern) {
  return (
    runs.find((run) =>
      (run.jobs ?? []).some((job) =>
        (job.steps ?? []).some((step) => stepPattern.test(step.name ?? '')),
      ),
    ) ?? null
  );
}

async function loadRecentWorkflow(
  repository,
  workflowFile,
  knownRuns,
  signal,
  requiredStepPattern = null,
) {
  const response = await runGhJson(
    repository,
    `actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${RECENT_PIPELINE_RUNS}&page=1`,
    signal,
  );
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error(`GitHub API did not return workflow runs for ${workflowFile}.`);
  }
  const recentRuns = response.workflow_runs
    .sort(
      (left, right) =>
        (Date.parse(right.created_at ?? '') || 0) - (Date.parse(left.created_at ?? '') || 0) ||
        right.id - left.id,
    )
    .slice(0, RECENT_PIPELINE_RUNS);
  let apiCalls = 1;
  if (recentRuns.length === 0) {
    return {
      workflowFile,
      recentRuns,
      latestRun: null,
      truncated: false,
      apiCalls,
    };
  }
  let latestRun;
  if (requiredStepPattern) {
    const candidates = await mapWithConcurrency(recentRuns, RECENT_PIPELINE_RUNS, async (run) => {
      const known = knownRuns.find((entry) => entry.id === run.id && !entry.jobsError);
      if (known) {
        return {
          run: {
            ...run,
            jobs: known.jobs,
            jobsTruncated: Boolean(known.jobsTruncated),
          },
          apiCalls: 0,
        };
      }
      const result = await listJobs(repository, run.id, signal);
      return {
        run: { ...run, jobs: result.jobs, jobsTruncated: result.truncated },
        apiCalls: 1,
      };
    });
    apiCalls += candidates.reduce((sum, candidate) => sum + candidate.apiCalls, 0);
    latestRun =
      selectLatestRunWithStep(
        candidates.map((candidate) => candidate.run),
        requiredStepPattern,
      ) ?? candidates[0].run;
  } else {
    const latest = recentRuns[0];
    const known = knownRuns.find((run) => run.id === latest.id && !run.jobsError);
    if (known) {
      latestRun = {
        ...latest,
        jobs: known.jobs,
        jobsTruncated: Boolean(known.jobsTruncated),
      };
    } else {
      const result = await listJobs(repository, latest.id, signal);
      latestRun = { ...latest, jobs: result.jobs, jobsTruncated: result.truncated };
      apiCalls += 1;
    }
  }
  return {
    workflowFile,
    recentRuns,
    latestRun,
    truncated: Number(response.total_count ?? recentRuns.length) > recentRuns.length,
    apiCalls,
  };
}

async function loadCanonicalAssetRefs(repository, signal) {
  const refs = await runGhJson(repository, 'git/matching-refs/heads/assets/', signal);
  if (!Array.isArray(refs)) throw new Error('GitHub API did not return canonical asset refs.');
  return {
    refs: refs
      .filter((entry) =>
        ['refs/heads/assets/queue', 'refs/heads/assets/promote'].includes(entry.ref),
      )
      .map((entry) => ({
        ref: entry.ref,
        sha: entry.object?.sha ?? null,
        url: entry.object?.url ?? null,
      })),
    apiCalls: 1,
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

  const assetResults = await Promise.allSettled([
    loadAssetRequestIssues(repository, signal),
    loadRecentWorkflow(
      repository,
      'asset-request.yml',
      runs,
      signal,
      /ingest asset-request issues/i,
    ),
    loadRecentWorkflow(repository, 'sprite-queue-reconciler.yml', runs, signal),
    loadCanonicalAssetRefs(repository, signal),
  ]);
  signal?.throwIfAborted();
  const assetErrors = [];
  const assetNames = [
    'Open asset-request issues',
    'Asset Request Pipeline runs',
    'Sprite queue reconciler runs',
    'Canonical asset branches',
  ];
  for (let index = 0; index < assetResults.length; index += 1) {
    const result = assetResults[index];
    if (result.status === 'fulfilled') {
      apiCalls += result.value.apiCalls;
    } else {
      const error = `${assetNames[index]}: ${sanitizeErrorText(result.reason?.message ?? result.reason)}`;
      assetErrors.push(error);
      partialErrors.push(error);
    }
  }

  const issueResult =
    assetResults[0].status === 'fulfilled'
      ? assetResults[0].value
      : { issues: [], truncated: false };
  const assetWorkflow = assetResults[1].status === 'fulfilled' ? assetResults[1].value : null;
  const reconcilerWorkflow = assetResults[2].status === 'fulfilled' ? assetResults[2].value : null;
  const assetRefs = assetResults[3].status === 'fulfilled' ? assetResults[3].value.refs : [];

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
    assetRequests: {
      issues: issueResult.issues,
      issuesTruncated: issueResult.truncated,
      assetWorkflow,
      reconcilerWorkflow,
      refs: assetRefs,
      pullRequests: openPullResult.values.filter((pullRequest) =>
        ['assets/queue', 'assets/promote'].includes(pullRequest.head?.ref),
      ),
      errors: assetErrors,
    },
    activeRunsTruncated,
    partialErrors,
    apiCalls,
    fetchedAt: new Date().toISOString(),
  };
}
