const WORKFLOW_EVENT_ALLOWLIST = new Map([
  ['.github/workflows/ci.yml', new Set(['pull_request', 'pull_request_target'])],
  ['.github/workflows/commit-lint.yml', new Set(['pull_request', 'pull_request_target'])],
  [
    '.github/workflows/ci-recovery-router.yml',
    new Set(['pull_request_review', 'pull_request_review_comment']),
  ],
]);

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

  return null;
}
