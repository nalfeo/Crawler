import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildBlockers, summarizePullRequests } from './model.mjs';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;
const DEFAULT_REPOSITORY = 'nalfeo/Crawler';

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

async function runGhJson(args, options = {}) {
  const output = await runCommand('gh', args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub CLI returned invalid JSON.');
  }
}

async function resolveRepository(cwd, signal) {
  if (!cwd) return DEFAULT_REPOSITORY;
  try {
    const remote = await runCommand('git', ['remote', 'get-url', 'origin'], { cwd, signal });
    return parseGitHubRepository(remote) ?? DEFAULT_REPOSITORY;
  } catch {
    return DEFAULT_REPOSITORY;
  }
}

function repoArgs(repository) {
  return ['--repo', repository];
}

export async function listPullRequests(options = {}) {
  const repository = options.repository ?? (await resolveRepository(options.cwd, options.signal));
  const state = options.state ?? 'open';
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 100);
  const raw = await runGhJson(
    [
      'pr',
      'list',
      ...repoArgs(repository),
      '--state',
      state,
      '--limit',
      String(limit),
      '--json',
      'number,title,url,state,isDraft,headRefName,headRefOid,updatedAt,labels,mergeStateStatus,mergeable',
    ],
    { signal: options.signal },
  );
  return { repository, pullRequests: summarizePullRequests(raw) };
}

async function readPullRequest(repository, pullNumber, signal) {
  return runGhJson(
    [
      'pr',
      'view',
      String(pullNumber),
      ...repoArgs(repository),
      '--json',
      'number,title,url,state,isDraft,headRefName,headRefOid,updatedAt,labels,mergeStateStatus,mergeable',
    ],
    { signal },
  );
}

export async function listCheckRuns(repository, ref, signal, runJson = runGhJson) {
  if (!ref) return [];
  const checkRuns = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await runJson(
      [
        'api',
        '--method',
        'GET',
        `repos/${repository}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&page=${page}`,
      ],
      { signal },
    );
    if (!Array.isArray(response.check_runs)) {
      throw new Error('GitHub API did not return check_runs.');
    }
    checkRuns.push(...response.check_runs);
    if (response.check_runs.length < 100) {
      return checkRuns;
    }
  }
  return checkRuns;
}

const REVIEW_THREADS_QUERY = `
  query PrReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes { isResolved isOutdated isCollapsed }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

async function graphql(query, variables, signal) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined) args.push('-F', `${name}=${value}`);
  }
  return runGhJson(args, { signal });
}

export async function countUnresolvedReviewThreads(repository, pullNumber, signal) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error('Repository must use owner/name format.');
  let cursor = null;
  let unresolved = 0;
  let truncated = false;
  for (let page = 1; page <= 5; page += 1) {
    const response = await graphql(
      REVIEW_THREADS_QUERY,
      { owner, name, number: pullNumber, cursor },
      signal,
    );
    const threads = response.data?.repository?.pullRequest?.reviewThreads;
    if (!Array.isArray(threads?.nodes)) {
      throw new Error('GitHub GraphQL did not return reviewThreads.');
    }
    unresolved += threads.nodes.filter(
      (thread) => !thread.isResolved && !thread.isOutdated && !thread.isCollapsed,
    ).length;
    if (!threads.pageInfo?.hasNextPage) return { unresolved, truncated: false };
    cursor = threads.pageInfo.endCursor;
    if (!cursor) throw new Error('GitHub GraphQL omitted review thread cursor.');
    truncated = page === 5;
  }
  return { unresolved, truncated };
}

export async function getPullRequestCockpit(options = {}) {
  const repository = options.repository ?? (await resolveRepository(options.cwd, options.signal));
  const pullNumber = Number(options.pullNumber);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('pullNumber must be a positive integer.');
  }
  const pullRequest = await readPullRequest(repository, pullNumber, options.signal);
  const [checks, reviewThreads] = await Promise.all([
    listCheckRuns(repository, pullRequest.headRefOid ?? pullRequest.headRefName, options.signal),
    countUnresolvedReviewThreads(repository, pullNumber, options.signal),
  ]);
  return {
    repository,
    ...buildBlockers({ pullRequest, checks, unresolvedThreads: reviewThreads.unresolved }),
    reviewThreadsTruncated: reviewThreads.truncated,
  };
}

export const _private = { runCommand, runGhJson, resolveRepository };
