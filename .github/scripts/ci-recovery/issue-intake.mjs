import { graphql, paginate, request } from './github.mjs';
import {
  intakeOpenedIssue,
  intakeUnblockedDependents,
  isTelemetryIssue,
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

if (!issue) {
  process.stdout.write('skip: event payload has no issue\n');
  process.exit(0);
}

if (isTelemetryIssue(issue)) {
  process.stdout.write(`skip: issue #${issue.number} is telemetry feedback\n`);
  process.exit(0);
}

if (payload.action === 'closed') {
  const results = await intakeUnblockedDependents({
    graphql,
    paginate,
    request,
    token,
    owner,
    repo,
    closedIssue: issue,
    maintainerLogin: issueOwner,
  });

  let assignedCount = 0;
  let errorCount = 0;
  for (const result of results) {
    if (result.error) {
      errorCount += 1;
      process.stdout.write(`unblock-dependent issue=#${result.number} error=${result.error}\n`);
    } else if (result.assigned) {
      assignedCount += 1;
      process.stdout.write(
        `unblock-dependent issue=#${result.number} assigned assignee=@${result.assignee} comment=${result.comment}\n`,
      );
    } else {
      process.stdout.write(`unblock-dependent issue=#${result.number} skip: ${result.reason}\n`);
    }
  }

  process.stdout.write(
    `unblock-sweep closed=#${issue.number} dependents=${results.length} assigned=${assignedCount} errors=${errorCount}\n`,
  );
  if (errorCount > 0) {
    process.exitCode = 1;
  }
} else {
  const result = await intakeOpenedIssue({
    graphql,
    paginate,
    request,
    token,
    owner,
    repo,
    issue,
    maintainerLogin: issueOwner,
  });

  if (!result.assigned) {
    process.stdout.write(`skip: ${result.reason}\n`);
    process.exit(0);
  }

  process.stdout.write(
    `intake-complete issue=#${issue.number} opener=@${issue.user?.login} assignee=@${result.assignee} comment=${result.comment}\n`,
  );
}
