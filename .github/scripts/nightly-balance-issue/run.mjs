import { buildIssueBody, runNightlyBalanceIssue } from './nightly-balance-issue.mjs';
import { resolveLatestReleaseBaselineSafely } from './release-baseline.mjs';

// The baseline the session must analyze is the newest release sweep on the
// `baselines` branch, which is always in git. Resolving it here is a read-only
// lookup that stamps the exact payload into the issue body; if it fails the
// issue is still filed and the body tells the session how to resolve it.
const baseline = await resolveLatestReleaseBaselineSafely({
  token: process.env.GITHUB_TOKEN || '',
  repository: process.env.GITHUB_REPOSITORY || '',
});
process.stdout.write(
  `release baseline: ${baseline.status}${baseline.baseline ? ` commit=${baseline.baseline.commit}` : ''}${baseline.reason ? ` reason=${baseline.reason}` : ''}\n`,
);

const result = await runNightlyBalanceIssue({
  githubToken: process.env.GITHUB_TOKEN || '',
  intakeToken: process.env.CRAWLER_CI_PAT || '',
  repository: process.env.GITHUB_REPOSITORY || '',
  buildIssueBodyFn: (issueNumber) => buildIssueBody(issueNumber, baseline.baseline),
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
