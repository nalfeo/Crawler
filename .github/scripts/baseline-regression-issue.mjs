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

function issueSignatures(issue) {
  return Array.isArray(issue?.failureSignatures) ? issue.failureSignatures : [];
}

function issueSignaturesFromBody(body) {
  if (typeof body !== 'string') return [];
  return body
    .split('\n')
    .filter((line) => line.startsWith('- `') && line.endsWith('`'))
    .map((line) => line.slice(3, -1))
    .filter((signature) => signature.includes('|seed=') && signature.includes('|weapon='));
}

function signatureConfiguration(signature) {
  return signature.replace(/\|seed=[^|]*/, '');
}

function groupSignaturesByConfiguration(signatures) {
  const groups = new Map();
  for (const signature of signatures) {
    const configuration = signatureConfiguration(signature);
    const group = groups.get(configuration) || [];
    group.push(signature);
    groups.set(configuration, group);
  }
  return groups;
}

function isManagedReleaseRegressionIssue(issue) {
  const body = String(issue?.body || '');
  return (
    body.includes('<!-- release-baseline-regression:') && body.includes('### Failure signatures')
  );
}

function recurrenceComment(body, signatures) {
  return [
    '## Recurring Floor 1 release sweep loss',
    '',
    'The same sweep configuration occurred again in a later release. The original issue remains the canonical tracker for this configuration.',
    '',
    ...bodyForSignatures(body, signatures).split('\n'),
  ].join('\n');
}

function bodyForSignatures(body, signatures) {
  const lines = body.split('\n');
  const start = lines.indexOf('### Failure signatures');
  if (start < 0) return body;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('### '));
  const before = lines.slice(0, start);
  const after = end < 0 ? [] : lines.slice(end);
  return [
    ...before,
    '### Failure signatures',
    '',
    ...signatures.map((signature) => `- \`${signature}\``),
    '',
    ...after,
  ].join('\n');
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
  const openIssues = issues.filter((issue) => !issue.pull_request && isOpen(issue));
  const signatures = issueSignatures(decision.issue);
  if (signatures.length > 0) {
    const managedOpenIssues = openIssues
      .filter(isManagedReleaseRegressionIssue)
      .slice()
      .sort((left, right) => Number(left.number) - Number(right.number));
    const outcomes = [];
    for (const [configuration, configurationSignatures] of groupSignaturesByConfiguration(
      signatures,
    )) {
      const existing = managedOpenIssues.find((issue) =>
        issueSignaturesFromBody(issue.body).some(
          (signature) => signatureConfiguration(signature) === configuration,
        ),
      );
      const response = existing
        ? await requestFn(
            mutationToken,
            `/repos/${owner}/${repo}/issues/${existing.number}/comments`,
            {
              method: 'POST',
              body: {
                body: recurrenceComment(body, configurationSignatures),
              },
            },
          )
        : await requestFn(mutationToken, `/repos/${owner}/${repo}/issues`, {
            method: 'POST',
            body: {
              title,
              body: bodyForSignatures(body, configurationSignatures),
              labels: BASELINE_REGRESSION_LABELS,
            },
          });
      const issue = response.data;
      const action = existing ? 'commented' : 'created';
      if (existing) {
        if (!issue?.id) {
          throw new Error('GitHub commented response did not include a comment id');
        }
      } else if (!issue?.number || !issue?.node_id) {
        throw new Error(`GitHub created response did not include an issue number and node_id`);
      }
      const issueNumber = existing ? existing.number : issue.number;
      if (!issueNumber) {
        throw new Error(`GitHub ${action} response did not identify an issue`);
      }
      if (existing) {
        outcomes.push({ action, issueNumber });
      } else {
        const intake = await intakeFn({
          graphql: graphqlFn,
          paginate: paginateFn,
          request: requestFn,
          token: intakeToken,
          owner,
          repo,
          issue,
        });
        outcomes.push({ action, issueNumber, assignee: intake.assignee });
      }
    }
    return outcomes;
  }

  // A stable (non-commit-scoped) marker is long-lived, and the release workflow
  // is only serialized per head SHA, so two overlapping releases can each see
  // "no open marker match" and each create one. Converge deterministically on
  // the lowest-numbered (oldest) match and close the rest as duplicates, so the
  // race self-heals on the next release instead of leaving parallel issues.
  const markerMatches = openIssues
    .filter((issue) => String(issue.body || '').includes(marker))
    .sort((left, right) => Number(left.number) - Number(right.number));
  const existingOpen = markerMatches[0];
  const existing = existingOpen;
  const superseded = markerMatches.slice(1);

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
        },
      },
    );
    issue = response.data;
    action = 'updated';
  } else {
    const response = await requestFn(mutationToken, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: {
        title,
        body,
        labels: BASELINE_REGRESSION_LABELS,
      },
    });
    issue = response.data;
    action = 'created';
  }

  if (!issue?.number || !issue?.node_id) {
    throw new Error(`GitHub ${action} response did not include an issue number and node_id`);
  }
  for (const duplicate of superseded) {
    await requestFn(mutationToken, `/repos/${owner}/${repo}/issues/${duplicate.number}`, {
      method: 'PATCH',
      body: {
        state: 'closed',
        body: `${String(duplicate.body || '')}\n\nSuperseded by #${issue.number}, which now tracks this release-sweep finding.`,
      },
    });
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
  for (const issue of Array.isArray(outcome) ? outcome : [outcome]) {
    const assignment = issue.assignee ? `; assigned @${issue.assignee}` : '';
    process.stdout.write(
      `${issue.action} release regression issue #${issue.issueNumber}${assignment}\n`,
    );
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
