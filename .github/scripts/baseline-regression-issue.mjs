import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { graphql, paginate, request } from './ci-recovery/github.mjs';
import { runIssueIntake } from './ci-recovery/issue-intake-lib.mjs';

export const BASELINE_REGRESSION_LABELS = Object.freeze(['bug', 'automation', 'ai']);

function isOpen(issue) {
  return String(issue?.state || '').toLowerCase() === 'open';
}

function validateDecision(decision) {
  if (!decision?.regression || !decision.issue?.marker || !decision.issue?.title) {
    throw new Error('baseline regression decision does not contain a fileable issue');
  }
  if (!String(decision.issue.body || '').includes(decision.issue.marker)) {
    throw new Error('baseline regression issue body is missing its idempotency marker');
  }
}

export async function fileBaselineRegressionIssue({
  requestFn,
  paginateFn,
  intakeFn,
  graphqlFn,
  mutationToken,
  intakeToken,
  owner,
  repo,
  decision,
}) {
  validateDecision(decision);
  const { marker, title, body } = decision.issue;
  const issues = await paginateFn(
    mutationToken,
    `/repos/${owner}/${repo}/issues?state=all&labels=automation`,
  );
  const matches = issues.filter(
    (issue) => !issue.pull_request && String(issue.body || '').includes(marker),
  );
  const existingOpen = matches.find(isOpen);
  const existingClosed = [...matches]
    .filter((issue) => !isOpen(issue))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
  const existing = existingOpen ?? existingClosed;

  let issue;
  let action;
  if (existing) {
    const response = await requestFn(
      mutationToken,
      `/repos/${owner}/${repo}/issues/${existing.number}`,
      {
        method: 'PATCH',
        body: {
          title,
          body,
          labels: BASELINE_REGRESSION_LABELS,
          ...(existingOpen ? {} : { state: 'open' }),
        },
      },
    );
    issue = response.data;
    action = existingOpen ? 'updated' : 'reopened';
  } else {
    const response = await requestFn(mutationToken, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: { title, body, labels: BASELINE_REGRESSION_LABELS },
    });
    issue = response.data;
    action = 'created';
  }

  if (!issue?.number || !issue?.node_id) {
    throw new Error(`GitHub ${action} response did not include an issue number and node_id`);
  }
  const intake = await intakeFn({
    graphql: graphqlFn,
    paginate: paginateFn,
    request: requestFn,
    token: intakeToken,
    owner,
    repo,
    issue,
  });
  return { action, issueNumber: issue.number, assignee: intake.assignee };
}

async function main() {
  const mutationToken = process.env.GITHUB_TOKEN || '';
  const intakeToken = process.env.CRAWLER_CI_PAT || '';
  const repository = process.env.GITHUB_REPOSITORY || '';
  const resultPath = process.env.BASELINE_REGRESSION_RESULT || '';
  const [owner, repo] = repository.split('/');
  if (!mutationToken || !intakeToken || !owner || !repo || !resultPath) {
    throw new Error(
      'GITHUB_TOKEN, CRAWLER_CI_PAT, GITHUB_REPOSITORY, and BASELINE_REGRESSION_RESULT are required',
    );
  }
  const decision = JSON.parse(await readFile(resultPath, 'utf8'));
  const outcome = await fileBaselineRegressionIssue({
    requestFn: request,
    paginateFn: paginate,
    intakeFn: runIssueIntake,
    graphqlFn: graphql,
    mutationToken,
    intakeToken,
    owner,
    repo,
    decision,
  });
  process.stdout.write(
    `${outcome.action} release regression issue #${outcome.issueNumber}; assigned @${outcome.assignee}\n`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
