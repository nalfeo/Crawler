import fs from 'node:fs';
import path from 'node:path';
import {
  getEnv,
  githubGraphql,
  githubPaginate,
  githubRequest,
  parseBoolean,
  parseStatusStateFromBody,
  readJsonFile,
} from './utils.mjs';

const workspace = getEnv('GITHUB_WORKSPACE', process.cwd());
const repository = getEnv('GITHUB_REPOSITORY', '');
const [owner, repo] = repository.split('/');
const prNumber = Number.parseInt(getEnv('PR_NUMBER', ''), 10);
const trigger = getEnv('REPAIR_TRIGGER', 'unknown');
const command = getEnv('REPAIR_COMMAND', '');
const mode = getEnv('REPAIR_MODE', 'auto');
const explicit = parseBoolean(getEnv('IS_EXPLICIT_COMMAND', 'false'), false);
const runUrl = `${getEnv('GITHUB_SERVER_URL', 'https://github.com')}/${repository}/actions/runs/${getEnv('GITHUB_RUN_ID', '')}`;
const changedFilesRaw = getEnv('CHANGED_FILES', '');
const changedFiles = changedFilesRaw ? changedFilesRaw.split(',').filter(Boolean) : [];
const validationSucceeded = parseBoolean(getEnv('VALIDATION_SUCCEEDED', 'false'), false);
const codexSucceeded = parseBoolean(getEnv('CODEX_SUCCEEDED', 'false'), false);
const resultPath = path.join(
  workspace,
  '.github',
  'scripts',
  'codex',
  'runtime',
  'codex-result.json',
);
const validationPath = path.join(
  workspace,
  '.github',
  'scripts',
  'codex',
  'runtime',
  'validation-report.json',
);

if (!owner || !repo || !Number.isFinite(prNumber)) {
  throw new Error('Missing repository/pr context for report generation');
}

const result = fs.existsSync(resultPath)
  ? readJsonFile(resultPath)
  : {
      summary: 'No codex-result.json was generated.',
      work_attempted: [],
      validation_commands: [],
      validation_results: [],
      unresolved_blockers: ['Missing codex-result.json'],
      thread_responses: [],
    };

const validation = fs.existsSync(validationPath)
  ? readJsonFile(validationPath)
  : { commands: [], results: [], all_passed: validationSucceeded };

const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);
const checkRuns = await githubPaginate(
  `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
  { extract: (page) => page.check_runs },
);
const failingChecks = checkRuns.filter(
  (check) => check.conclusion === 'failure' || check.status !== 'completed',
);

const unresolvedThreadsQuery = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          viewerCanResolve
        }
      }
    }
  }
}`;

const unresolvedThreadIds = [];
let cursor = null;
do {
  const data = await githubGraphql(unresolvedThreadsQuery, {
    owner,
    repo,
    number: prNumber,
    cursor,
  });
  const connection = data.repository?.pullRequest?.reviewThreads;
  if (!connection) {
    break;
  }

  for (const thread of connection.nodes || []) {
    if (!thread.isResolved) {
      unresolvedThreadIds.push(thread.id);
    }
  }

  cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
} while (cursor);

const replyMutation = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { id }
  }
}`;

const resolveMutation = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

let resolvedCount = 0;
let repliedCount = 0;
for (const threadReply of result.thread_responses || []) {
  if (!threadReply?.thread_id || !threadReply.response) {
    continue;
  }

  try {
    await githubGraphql(replyMutation, {
      threadId: threadReply.thread_id,
      body: `✅ Addressed\n\n${threadReply.response}`,
    });
    repliedCount += 1;
  } catch {
    // Ignore per-thread reply failures so summary still posts.
  }

  if (threadReply.should_resolve && validationSucceeded) {
    try {
      await githubGraphql(resolveMutation, { threadId: threadReply.thread_id });
      resolvedCount += 1;
    } catch {
      // Ignore resolver failures for threads that cannot be resolved by token.
    }
  }
}

const comments = await githubPaginate(
  `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
);
const existingStatus = comments.find(
  (comment) =>
    (comment.user?.login || '').toLowerCase() === 'github-actions[bot]' &&
    String(comment.body || '').includes('<!-- codex-repair-status -->'),
);
const priorState = existingStatus ? parseStatusStateFromBody(existingStatus.body) || {} : {};

const runSucceeded = codexSucceeded && validationSucceeded;
const state = {
  totalAttempts: Number(priorState.totalAttempts || 0) + 1,
  autoAttempts: Number(priorState.autoAttempts || 0) + (explicit ? 0 : 1),
  autoFailureStreak: runSucceeded
    ? 0
    : explicit
      ? Number(priorState.autoFailureStreak || 0)
      : Number(priorState.autoFailureStreak || 0) + 1,
  lastRunConclusion: runSucceeded ? 'success' : 'failure',
  lastHeadSha: pr.head.sha,
  updatedAt: new Date().toISOString(),
};

const blockers = [...(result.unresolved_blockers || [])];
if (!validationSucceeded) {
  blockers.push('Validation failed');
}

const summaryBody = [
  '<!-- codex-repair-status -->',
  `## Codex Status (${runSucceeded ? '✅ success' : '⚠️ needs attention'})`,
  '',
  `- Trigger: ${trigger}`,
  `- Command: ${command || '(automatic)'}`,
  `- Mode: ${mode}`,
  `- Work attempted: ${(result.work_attempted || []).join('; ') || 'none'}`,
  `- Files modified: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'none'}`,
  `- Validation executed: ${(validation.commands || []).join('; ') || 'none detected'}`,
  `- Validation result: ${validationSucceeded ? 'passed' : 'failed'}`,
  `- Review threads replied: ${repliedCount}`,
  `- Review threads resolved this run: ${resolvedCount}`,
  `- Review threads remaining: ${unresolvedThreadIds.length}`,
  `- Failing checks: ${failingChecks.length}`,
  `- Remaining manual work: ${blockers.length > 0 ? blockers.join('; ') : 'none'}`,
  `- Run: ${runUrl}`,
  '',
  '### Codex summary',
  String(result.summary || 'No summary provided.'),
  '',
  '<details>',
  '<summary>Validation results</summary>',
  '',
  '```json',
  JSON.stringify(validation.results || [], null, 2),
  '```',
  '</details>',
  '',
  '<!-- codex-repair-state: ' + JSON.stringify(state) + ' -->',
  '',
].join('\n');

if (existingStatus) {
  await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existingStatus.id}`, {
    method: 'PATCH',
    body: { body: summaryBody },
  });
} else {
  await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: { body: summaryBody },
  });
}
