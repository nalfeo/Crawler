const WORKFLOW_EVENT_ALLOWLIST = new Map([
  ['.github/workflows/ci.yml', new Set(['pull_request', 'pull_request_target'])],
  [
    '.github/workflows/ci-recovery-router.yml',
    new Set(['pull_request_review', 'pull_request_review_comment']),
  ],
]);

// Workflow paths that correspond to admission-required CI checks (ci only; commit-lint
// was removed in PR #1109). These paths are in the allowlist but are never approvable
// via the GitHub workflow-approval endpoint (which applies only to fork PRs). When
// reconcile.mjs encounters an action_required run whose normalized path is in this set
// it escalates a ci-retrigger blocker instead of silently logging a skip.
export const REQUIRED_CHECK_WORKFLOW_PATHS = new Set(['.github/workflows/ci.yml']);

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function workflowApprovalRejection({
  run,
  repository,
  prNumber,
  prHeadRepository,
  changedFiles = [],
  expectedChangedFiles = null,
}) {
  if (normalize(prHeadRepository) !== normalize(repository)) {
    return 'fork';
  }

  const runPrs = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  if (!runPrs.some((pullRequest) => pullRequest.number === prNumber)) {
    return 'pr-not-listed';
  }

  const workflowPath = normalize(run?.path);
  const allowedEvents = WORKFLOW_EVENT_ALLOWLIST.get(workflowPath);
  if (!allowedEvents) {
    return 'not-in-allowlist';
  }
  if (Number.isInteger(expectedChangedFiles) && expectedChangedFiles !== changedFiles.length) {
    return 'changed-files-incomplete';
  }
  if (
    changedFiles.some(
      (file) =>
        normalize(file?.filename) === workflowPath ||
        normalize(file?.previous_filename) === workflowPath,
    )
  ) {
    return 'workflow-modified';
  }

  const event = normalize(run?.event);
  if (!allowedEvents.has(event)) {
    return `event=${run?.event}`;
  }

  // GitHub's workflow-approval endpoint applies only to fork PRs; same-repository
  // runs cannot be unblocked via that endpoint.  CI recovery already rejects fork
  // PRs at ingress, so this path is only reached for same-repository runs.
  // reconcile.mjs escalates runs whose path is in REQUIRED_CHECK_WORKFLOW_PATHS
  // as ci-retrigger blockers; non-required runs (e.g. the CI Recovery Router)
  // are logged and skipped.
  return 'same-repository';
}
