import process from 'node:process';

import { EPIC_NODE_MARKER_PREFIX } from '../ci-recovery/markers.mjs';
import { graphql, paginate, request } from '../ci-recovery/github.mjs';
import {
  IssueClaimedByGoobersError,
  IssueNoLongerOpenError,
  intakeOpenedIssue,
} from '../ci-recovery/issue-intake-lib.mjs';

export function isManagedOpenEpicNode(issue) {
  return (
    String(issue?.state || '').toLowerCase() === 'open' &&
    String(issue?.body || '').includes(EPIC_NODE_MARKER_PREFIX)
  );
}

export function blockedIssueNumbers(issue) {
  return [
    ...new Set(
      [...String(issue?.body || '').matchAll(/^Blocked by (.+)$/gm)]
        .flatMap((match) => [...match[1].matchAll(/#(\d+)/g)])
        .map((match) => Number.parseInt(match[1], 10)),
    ),
  ];
}

async function openTextBlockers({ requestFn, token, owner, repo, issue }) {
  const blockers = [];
  for (const issueNumber of blockedIssueNumbers(issue)) {
    const response = await requestFn(token, `/repos/${owner}/${repo}/issues/${issueNumber}`);
    if (String(response.data?.state || '').toLowerCase() === 'open') {
      blockers.push(issueNumber);
    }
  }
  return blockers;
}

export async function reprocessEpicNodes({
  graphqlFn,
  paginateFn,
  requestFn,
  token,
  owner,
  repo,
  maintainerLogin = 'nalfeo',
}) {
  const issues = await paginateFn(
    token,
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent('epic')}`,
  );
  const results = [];
  for (const issue of issues.filter(isManagedOpenEpicNode)) {
    try {
      const blockers = await openTextBlockers({ requestFn, token, owner, repo, issue });
      if (blockers.length > 0) {
        results.push({
          number: issue.number,
          assigned: false,
          reason: `blocked by open ${blockers.map((blocker) => `#${blocker}`).join(', ')}`,
        });
        continue;
      }
      const result = await intakeOpenedIssue({
        graphql: graphqlFn,
        paginate: paginateFn,
        request: requestFn,
        token,
        owner,
        repo,
        issue,
        maintainerLogin,
      });
      results.push({ number: issue.number, ...result });
    } catch (error) {
      if (error instanceof IssueNoLongerOpenError || error instanceof IssueClaimedByGoobersError) {
        results.push({
          number: issue.number,
          assigned: false,
          reason:
            error instanceof IssueNoLongerOpenError
              ? 'node closed during processing'
              : 'node claimed by Goobers during processing',
        });
        continue;
      }
      results.push({
        number: issue.number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function main() {
  const token = process.env.CRAWLER_CI_PAT || '';
  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  if (!token || !owner || !repo) {
    throw new Error('CRAWLER_CI_PAT and GITHUB_REPOSITORY are required');
  }

  const results = await reprocessEpicNodes({
    graphqlFn: graphql,
    paginateFn: paginate,
    requestFn: request,
    token,
    owner,
    repo,
    maintainerLogin: process.env.ISSUE_OWNER || 'nalfeo',
  });
  let errors = 0;
  for (const result of results) {
    if (result.error) {
      errors += 1;
      process.stdout.write(`epic-node issue=#${result.number} error=${result.error}\n`);
    } else if (result.assigned) {
      process.stdout.write(
        `epic-node issue=#${result.number} assigned assignee=@${result.assignee} comment=${result.comment}\n`,
      );
    } else {
      process.stdout.write(`epic-node issue=#${result.number} skip: ${result.reason}\n`);
    }
  }
  process.stdout.write(`epic-reprocess nodes=${results.length} errors=${errors}\n`);
  if (errors > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `epic-reprocess failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
