import { runNightlyVelocityIssue } from './nightly-velocity-issue.mjs';

const result = await runNightlyVelocityIssue({
  githubToken: process.env.GITHUB_TOKEN || '',
  intakeToken: process.env.CRAWLER_CI_PAT || '',
  repository: process.env.GITHUB_REPOSITORY || '',
});

if (result.status === 'existing') {
  process.stdout.write(`no-op: issue #${result.issue.number} is already open\n`);
} else if (result.status === 'resumed') {
  process.stdout.write(
    `resumed: issue #${result.issue.number} had no completed intake; retried intake assignee=@${result.intake.assignee} comment=${result.intake.comment}\n`,
  );
} else {
  process.stdout.write(
    `created: issue #${result.issue.number}; intake assignee=@${result.intake.assignee} comment=${result.intake.comment}\n`,
  );
}
