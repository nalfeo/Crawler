export const HUMAN_APPROVAL_LABEL = 'human-approval-required';
export const HUMAN_APPROVAL_PHRASE = 'APPROVED FOR CHECK-IN';

const NIGHTLY_BALANCE_BRANCH_PREFIX = 'copilot/balance-telemetry-driven-improvement-sweep';

function labelNames(labels) {
  const entries = Array.isArray(labels) ? labels : labels?.nodes || [];
  return new Set(entries.map((label) => String(label?.name || '')));
}

export function requiresHumanApproval(pullRequest, closingIssues = []) {
  if (labelNames(pullRequest?.labels).has(HUMAN_APPROVAL_LABEL)) return true;
  if (String(pullRequest?.head?.ref || '').startsWith(NIGHTLY_BALANCE_BRANCH_PREFIX)) return true;
  return closingIssues.some((issue) => labelNames(issue?.labels).has(HUMAN_APPROVAL_LABEL));
}

export function hasOwnerApproval(comments, ownerLogin) {
  const owner = String(ownerLogin || '').toLowerCase();
  return (comments || []).some(
    (comment) =>
      String(comment?.user?.login || '').toLowerCase() === owner &&
      String(comment?.body || '').trim() === HUMAN_APPROVAL_PHRASE,
  );
}

export function humanApprovalRejection({ pullRequest, closingIssues, comments, ownerLogin }) {
  if (!requiresHumanApproval(pullRequest, closingIssues)) return null;
  return hasOwnerApproval(comments, ownerLogin)
    ? null
    : `waiting for ${ownerLogin} to comment exactly: ${HUMAN_APPROVAL_PHRASE}`;
}
