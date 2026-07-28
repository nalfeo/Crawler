import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';
import { runNightlyBalanceIssue } from '../nightly-balance-issue/nightly-balance-issue.mjs';

export const ISSUE_TITLE = 'perf: nightly gameplay-neutral optimization pass';
export const ISSUE_LABELS = Object.freeze([
  'automation',
  'performance',
  'ai',
  HUMAN_APPROVAL_LABEL,
]);

export function buildIssueBody(issueNumber = '<this issue number>') {
  return `## Objective
Run the nightly perf-optimizer pass to find gameplay-neutral resource optimizations that improve runtime/load efficiency without changing gameplay outcomes.

## Required approach
- Measure first, then land only optimizations backed by evidence.
- Preserve behavior: require a byte-identical covered \`RunStats\` fingerprint for accepted changes.
- If no safe win is found, document the no-change result and close the issue.
- Keep broad sweeps and benchmark sampling on GitHub infrastructure (workflow-dispatch/CI), not local compute.

## Delivery requirements
- Follow AGENTS.md and the repository's normal verification/review-harness requirements.
- Any implementation PR must include \`Closes #${issueNumber}\`.

@copilot Please run the perf-optimizer loop for this issue.`;
}

export async function runNightlyPerfIssue({
  githubToken,
  intakeToken,
  repository,
  requestFn,
  paginateFn,
  graphqlFn,
  intakeFn,
}) {
  return runNightlyBalanceIssue({
    githubToken,
    intakeToken,
    repository,
    issueTitle: ISSUE_TITLE,
    issueLabels: ISSUE_LABELS,
    buildIssueBodyFn: buildIssueBody,
    requestFn,
    paginateFn,
    graphqlFn,
    intakeFn,
  });
}
