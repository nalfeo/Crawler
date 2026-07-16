import { runNightlyBalanceIssue } from './nightly-balance-issue.mjs';

const result = await runNightlyBalanceIssue({
  githubToken: process.env.GITHUB_TOKEN || '',
  intakeToken: process.env.CRAWLER_CI_PAT || '',
  repository: process.env.GITHUB_REPOSITORY || '',
});

if (result.status === 'existing') {
  process.stdout.write(`no-op: issue #${result.issue.number} is already open\n`);
} else {
  process.stdout.write(
    `created: issue #${result.issue.number}; intake assignee=@${result.intake.assignee} comment=${result.intake.comment}\n`,
  );
}
