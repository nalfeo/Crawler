import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  getEnv,
  githubGraphql,
  githubRequest,
  loadRepoConfig,
  parseBoolean,
  readJsonFile,
} from './utils.mjs';

const workspace = getEnv('GITHUB_WORKSPACE', process.cwd());
const repository = getEnv('GITHUB_REPOSITORY', '');
const [owner, repo] = repository.split('/');
const prNumber = Number.parseInt(getEnv('PR_NUMBER', ''), 10);
const mode = getEnv('REPAIR_MODE', 'auto');
const trigger = getEnv('REPAIR_TRIGGER', 'unknown');
const command = getEnv('REPAIR_COMMAND', '');
const outputDir = path.join(workspace, '.github', 'scripts', 'codex', 'runtime');
const promptPath = path.join(outputDir, 'prompt.md');
const contextPath = path.join(outputDir, 'context.json');

if (!owner || !repo || !Number.isFinite(prNumber)) {
  throw new Error('Missing owner/repo/pr_number context for gather-context');
}

fs.mkdirSync(outputDir, { recursive: true });

const repoConfig = loadRepoConfig(workspace);
const instructions = {};
for (const fileName of [
  'AGENTS.md',
  'CONTRIBUTING.md',
  path.join('.github', 'copilot-instructions.md'),
  path.join('.github', 'codex-instructions.md'),
]) {
  const absolute = path.join(workspace, fileName);
  if (fs.existsSync(absolute)) {
    instructions[fileName] = fs.readFileSync(absolute, 'utf8');
  }
}

const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);
const commits = await githubRequest(
  `/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`,
);
const files = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
const issueComments = await githubRequest(
  `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
);
const reviewComments = await githubRequest(
  `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
);
const reviews = await githubRequest(
  `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
);
const checkRunsPayload = await githubRequest(
  `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
);
const checkRuns = checkRunsPayload?.check_runs || [];

const diffText = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  accept: 'application/vnd.github.v3.diff',
});

const threadsQuery = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          viewerCanResolve
          comments(first: 100) {
            nodes {
              id
              body
              path
              line
              originalLine
              diffHunk
              createdAt
              author { login }
              authorAssociation
            }
          }
        }
      }
    }
  }
}`;

const unresolvedThreads = [];
let cursor = null;
do {
  const data = await githubGraphql(threadsQuery, {
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
      unresolvedThreads.push(thread);
    }
  }

  cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
} while (cursor);

let failedJobs = [];
try {
  const workflowRuns = await githubRequest(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${pr.head.sha}&status=completed&per_page=10`,
  );
  const failedRun = (workflowRuns?.workflow_runs || []).find((run) => run.conclusion === 'failure');
  if (failedRun?.id) {
    const jobs = await githubRequest(
      `/repos/${owner}/${repo}/actions/runs/${failedRun.id}/jobs?per_page=100`,
    );
    failedJobs = (jobs?.jobs || [])
      .filter((job) => job.conclusion === 'failure')
      .map((job) => ({
        id: job.id,
        name: job.name,
        html_url: job.html_url,
        failing_steps: (job.steps || [])
          .filter((step) => step.conclusion === 'failure')
          .map((step) => step.name),
      }));
  }
} catch {
  failedJobs = [];
}

const mergeConflictStatus = {
  mergeable: pr.mergeable,
  mergeable_state: pr.mergeable_state,
  has_conflicts: pr.mergeable_state === 'dirty',
};

const gitHistory = execSync('git log --oneline -n 30', { cwd: workspace, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

const context = {
  trigger,
  mode,
  command,
  pr: {
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    html_url: pr.html_url,
    base_ref: pr.base?.ref,
    head_ref: pr.head?.ref,
    head_sha: pr.head?.sha,
    draft: pr.draft,
  },
  changed_files: files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch || '',
  })),
  commits: commits.map((commit) => ({
    sha: commit.sha,
    message: commit.commit?.message || '',
    author: commit.commit?.author?.name || commit.author?.login || '',
  })),
  git_history: gitHistory,
  unresolved_review_threads: unresolvedThreads,
  review_comments: reviewComments,
  reviews,
  issue_comments: issueComments,
  failed_checks: checkRuns.filter(
    (check) => check.conclusion === 'failure' || check.status !== 'completed',
  ),
  failed_ci_jobs: failedJobs,
  merge_conflict_status: mergeConflictStatus,
  diff: diffText,
  repository_instructions: instructions,
  repo_config: repoConfig,
};

fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

const maxDiffLines = Number.parseInt(getEnv('CODEX_MAX_DIFF_LINES', '1800'), 10);
let trimmedDiff = diffText;
const diffLines = diffText.split('\n');
if (diffLines.length > maxDiffLines) {
  trimmedDiff = `${diffLines.slice(0, maxDiffLines).join('\n')}\n\n[diff truncated]`;
}

const threadChecklist = unresolvedThreads
  .map((thread) => {
    const top = thread.comments?.nodes?.[0];
    return `- Thread ${thread.id} (${top?.path || 'unknown path'}:${top?.line || top?.originalLine || '?'})`;
  })
  .join('\n');

const promptSections = [
  '# Autonomous PR Repair Task',
  '',
  `Trigger: ${trigger}`,
  `Mode: ${mode}`,
  `Command: ${command || '(automatic)'}`,
  `PR: #${pr.number} ${pr.title}`,
  '',
  '## Objectives',
  '- Inspect the repository and understand reviewer intent.',
  '- Address unresolved review feedback where appropriate.',
  '- Fix failing CI checks relevant to this PR.',
  '- Resolve merge conflicts if present and safe.',
  '- Minimize unrelated edits and preserve project style.',
  '- Explain anything you could not fully fix.',
  '- Run project validation commands before finishing.',
  '',
  '## Required deliverables in this run',
  '- Apply code changes directly on the checked-out PR branch when needed.',
  '- Write a machine-readable result JSON file to .github/scripts/codex/runtime/codex-result.json with:',
  '  - summary (string)',
  '  - work_attempted (string[])',
  '  - validation_commands (string[])',
  '  - validation_results (array of {command, success, output_excerpt})',
  '  - unresolved_blockers (string[])',
  '  - thread_responses (array of {thread_id, addressed, should_resolve, response})',
  '',
  '## Unresolved review threads',
  threadChecklist || '- None',
  '',
  '## Repository instructions',
  'Follow AGENTS.md, CONTRIBUTING.md, .github/copilot-instructions.md, and .github/codex-instructions.md if present.',
  '',
  '## PR title',
  pr.title,
  '',
  '## PR description',
  pr.body || '(empty)',
  '',
  '## Failed checks summary',
  JSON.stringify(context.failed_checks, null, 2),
  '',
  '## Failed CI jobs summary',
  JSON.stringify(failedJobs, null, 2),
  '',
  '## Changed files',
  JSON.stringify(
    context.changed_files.map((f) => f.filename),
    null,
    2,
  ),
  '',
  '## Commit history',
  JSON.stringify(context.commits, null, 2),
  '',
  '## Unresolved review threads detail',
  JSON.stringify(unresolvedThreads, null, 2),
  '',
  '## Review comments',
  JSON.stringify(reviewComments, null, 2),
  '',
  '## Issue comments',
  JSON.stringify(issueComments, null, 2),
  '',
  '## Merge conflict status',
  JSON.stringify(mergeConflictStatus, null, 2),
  '',
  '## PR diff',
  '```diff',
  trimmedDiff,
  '```',
  '',
  '## Validation guidance',
  parseBoolean(repoConfig?.validation?.skip, false)
    ? 'Validation is explicitly disabled by repo config (validation.skip=true).'
    : 'Run repository validation commands; use configured override commands when provided.',
];

fs.writeFileSync(promptPath, `${promptSections.join('\n')}\n`);

process.stdout.write(`prompt_path=${promptPath}\n`);
process.stdout.write(`context_path=${contextPath}\n`);
