import { graphql, paginate, request } from './github.mjs';
import { runIssueIntake } from './issue-intake-lib.mjs';

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

if (!issue || issue.pull_request) {
  process.stdout.write('skip: event has no eligible issue payload\n');
  process.exit(0);
}

if (String(issue.user?.login || '').toLowerCase() !== issueOwner) {
  process.stdout.write(`skip: opener @${issue.user?.login || 'unknown'} != @${issueOwner}\n`);
  process.exit(0);
}

const automationLabels = (issue.labels || []).map((l) => String(l.name || '').toLowerCase());
if (automationLabels.includes('automation')) {
  process.stdout.write(
    `skip: issue #${issue.number} has automation label — already managed by CI automation\n`,
  );
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

process.stdout.write(
  `intake-complete issue=#${issue.number} opener=@${issue.user?.login} assignee=@${result.assignee} comment=${result.comment}\n`,
);
