import { graphql, paginate, request } from './github.mjs';
import {
  issueIntakeEligibility,
  removeCopilotAssignment,
  runIssueIntake,
} from './issue-intake-lib.mjs';

const token = process.env.CRAWLER_CI_PAT || '';
const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const eventPath = process.env.GITHUB_EVENT_PATH;
const issueOwner = String(process.env.ISSUE_OWNER || 'nalfeo').toLowerCase();

if (!token || !owner || !repo || !eventPath) {
  throw new Error('Missing CRAWLER_CI_PAT, repository, or event payload');
}

const payload = JSON.parse(await (await import('node:fs/promises')).readFile(eventPath, 'utf8'));
const issue = payload.issue;

const eligibility = issueIntakeEligibility(issue, issueOwner);
if (!eligibility.eligible) {
  if (eligibility.blocking === true) {
    const removed = await removeCopilotAssignment({ graphql, token, owner, repo, issue });
    process.stdout.write(`skip: ${eligibility.reason}; copilot_removed=${removed}\n`);
    process.exit(0);
  }
  process.stdout.write(`skip: ${eligibility.reason}\n`);
  process.exit(0);
}

const result = await runIssueIntake({
  graphql,
  paginate,
  request,
  token,
  owner,
  repo,
  issue,
});

// Re-check live labels to close the opened/labeled race: a blocking label applied
// between event delivery and Copilot assignment would otherwise persist unnoticed.
const liveResponse = await request(token, `/repos/${owner}/${repo}/issues/${issue.number}`);
const liveIssue = liveResponse.data ?? liveResponse;
const recheckEligibility = issueIntakeEligibility(liveIssue, issueOwner);
if (!recheckEligibility.eligible && recheckEligibility.blocking === true) {
  const removed = await removeCopilotAssignment({ graphql, token, owner, repo, issue: liveIssue });
  process.stdout.write(`live-recheck: blocked; copilot_removed=${removed}\n`);
  process.exit(0);
}

process.stdout.write(
  `intake-complete issue=#${issue.number} opener=@${issue.user?.login} assignee=@${result.assignee} comment=${result.comment}\n`,
);
