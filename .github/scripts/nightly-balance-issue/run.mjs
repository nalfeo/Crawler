import { ensureCanonicalBaselineSweepSafely } from './canonical-baseline.mjs';
import { runNightlyBalanceIssue } from './nightly-balance-issue.mjs';

const result = await runNightlyBalanceIssue({
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

// Copilot sessions cannot dispatch workflows, so the filer starts the canonical
// baseline sweep the session's evidence gate requires. It runs only after the
// issue decision: an already-open issue means the prior night's work is still
// active, and that nightly no-op must not re-dispatch a 600-sim sweep.
if (result.status === 'existing') {
  process.stdout.write('canonical baseline sweep: skipped reason=issue-already-open\n');
} else {
  const baseline = await ensureCanonicalBaselineSweepSafely({
    token: process.env.CRAWLER_CI_PAT || '',
    repository: process.env.GITHUB_REPOSITORY || '',
  });
  process.stdout.write(
    `canonical baseline sweep: ${baseline.status}${baseline.headSha ? ` head=${baseline.headSha}` : ''}${baseline.runId ? ` run=${baseline.runId}` : ''}${baseline.reason ? ` reason=${baseline.reason}` : ''}\n`,
  );
}
