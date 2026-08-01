import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';
import { runNightlyBalanceIssue } from '../nightly-balance-issue/nightly-balance-issue.mjs';

export const ISSUE_TITLE = 'velocity: nightly bottleneck scan + fix proposal';
export const ISSUE_LABELS = Object.freeze([
  'automation',
  'telemetry',
  'ai',
  'tooling',
  HUMAN_APPROVAL_LABEL,
]);

export function buildIssueBody(issueNumber = '<this issue number>') {
  return `## Objective
Run the nightly velocity-engineer workflow to identify where feature delivery loses the most time, then propose the smallest measurable fix for the top bottleneck.

## Required approach
- Start with deterministic bottleneck evidence from merged-PR/process telemetry (queue vs active time, cycle-time by size, deny-rate hotspots).
- If no actionable bottleneck is found, document that outcome and close the issue.
- If a fix is proposed or landed, include measurable before/after evidence and links to artifacts.
- Keep broad evaluations and sweeps on GitHub infrastructure (workflow-dispatch/CI), not local compute.

## Delivery requirements
- Follow AGENTS.md and the repository's normal verification/review-harness requirements.
- Any implementation PR must include \`Refs nalfeo/Crawler#${issueNumber}\` and avoid closing-keyword forms for this tracking issue.

@copilot Please run the velocity-engineer / bottleneck-scan loop for this issue.`;
}

export async function runNightlyVelocityIssue({
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
