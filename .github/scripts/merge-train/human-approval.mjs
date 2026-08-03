export const HUMAN_APPROVAL_LABEL = 'human-approval-required';
export const HUMAN_APPROVAL_PHRASE = 'APPROVED FOR CHECK-IN';

// Broad prefix intentionally covers both legacy naming
// ('copilot/balance-telemetry-driven-improvement-sweep') and the current
// naming ('copilot/balance-telemetry-improvement-sweep').  Balance-sweep
// agents choose branch names autonomously so pinning to a full name is fragile.
const NIGHTLY_BALANCE_BRANCH_PREFIX = 'copilot/balance-telemetry';

// Per-line pattern: optional list/ordered-list bullet, optional owner/repo
// prefix, closing verb, then #N.  Anchored at both ends so only lines whose
// entire content is a single closing-keyword reference are matched; lines that
// embed the keyword alongside other prose are left untouched.
const CLOSING_KEYWORD_LINE_RE =
  /^\s*(?:[-*]|\d+\.)?\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[a-z0-9._-]+\/[a-z0-9._-]+)?#(\d+)\s*$/i;

function labelNames(labels) {
  const entries = Array.isArray(labels) ? labels : labels?.nodes || [];
  return new Set(entries.map((label) => String(label?.name || '')));
}

export function requiresHumanApproval(pullRequest, closingIssues = []) {
  if (labelNames(pullRequest?.labels).has(HUMAN_APPROVAL_LABEL)) return true;
  if (String(pullRequest?.head?.ref || '').startsWith(NIGHTLY_BALANCE_BRANCH_PREFIX)) return true;
  return closingIssues.some((issue) => labelNames(issue?.labels).has(HUMAN_APPROVAL_LABEL));
}

/**
 * Returns the subset of `closingIssues` that are propagating
 * `human-approval-required` to the PR via a closing-keyword reference — i.e.
 * the PR itself does not carry the label and is not a nightly-balance branch.
 * These issues are safe to de-link by stripping the closing-keyword lines from
 * the PR body (see `stripClosingKeywordsForIssues`).
 */
export function closingIssuesPropagatingHumanApproval(pullRequest, closingIssues = []) {
  // If the PR already has the label directly or is a nightly-balance branch the
  // human-approval gate is intentional and must not be auto-bypassed.
  if (labelNames(pullRequest?.labels).has(HUMAN_APPROVAL_LABEL)) return [];
  if (String(pullRequest?.head?.ref || '').startsWith(NIGHTLY_BALANCE_BRANCH_PREFIX)) return [];
  return (closingIssues || []).filter((issue) =>
    labelNames(issue?.labels).has(HUMAN_APPROVAL_LABEL),
  );
}

/**
 * Strips lines from a PR body that consist solely of a GitHub closing-keyword
 * reference (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved)
 * pointing to one of the given `issueNumbers`.  Lines that embed the keyword
 * alongside other prose are preserved.  Non-closing `Refs`/`See` references
 * are always preserved.
 *
 * @param {string|null|undefined} body - PR body text
 * @param {number[]} issueNumbers - issue numbers whose closing refs to remove
 * @returns {string} cleaned body
 */
export function stripClosingKeywordsForIssues(body, issueNumbers) {
  if (!issueNumbers || issueNumbers.length === 0) return String(body ?? '');
  const targets = new Set(issueNumbers.map(Number));
  return String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      const m = line.match(CLOSING_KEYWORD_LINE_RE);
      if (!m) return true;
      return !targets.has(Number(m[1]));
    })
    .join('\n');
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
