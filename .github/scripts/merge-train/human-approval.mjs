export const HUMAN_APPROVAL_LABEL = 'human-approval-required';
export const HUMAN_APPROVAL_PHRASE = 'APPROVED FOR CHECK-IN';
export const HUMAN_APPROVAL_PHRASE_VARIANT = 'APPROVED FOR CHECKIN';

// Broad prefix intentionally covers both legacy naming
// ('copilot/balance-telemetry-driven-improvement-sweep') and the current
// naming ('copilot/balance-telemetry-improvement-sweep').  Balance-sweep
// agents choose branch names autonomously so pinning to a full name is fragile.
const NIGHTLY_BALANCE_BRANCH_PREFIX = 'copilot/balance-telemetry';

// Per-line pattern: optional list/ordered-list bullet, optional owner/repo
// prefix (captured as group 1), closing verb, then #N (captured as group 2).
// Anchored at both ends so only lines whose entire content is a single
// closing-keyword reference are matched; lines that embed the keyword alongside
// other prose are left untouched.
const CLOSING_KEYWORD_LINE_RE =
  /^\s*(?:[-*]|\d+\.)?\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([a-z0-9._-]+\/[a-z0-9._-]+))?#(\d+)\s*$/i;

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
 * the PR is not a nightly-balance branch.
 * These issues are safe to de-link by stripping the closing-keyword lines from
 * the PR body (see `stripClosingKeywordsForIssues`).
 *
 * Note: a direct `human-approval-required` label on the PR is NOT treated as
 * proof of intentional gating.  The reconciler adds that label whenever a
 * closing issue triggers the gate, so a previously-reconciled PR always
 * carries the direct label even when propagation is the sole root cause.
 */
export function closingIssuesPropagatingHumanApproval(pullRequest, closingIssues = []) {
  // Nightly-balance branches have an intentional human-approval gate that must
  // not be auto-bypassed via keyword stripping.
  if (String(pullRequest?.head?.ref || '').startsWith(NIGHTLY_BALANCE_BRANCH_PREFIX)) return [];
  return (closingIssues || []).filter((issue) =>
    labelNames(issue?.labels).has(HUMAN_APPROVAL_LABEL),
  );
}

/**
 * Strips lines from a PR body that consist solely of a GitHub closing-keyword
 * reference (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved)
 * pointing to one of the given target issues.  Lines that embed the keyword
 * alongside other prose are preserved.  Non-closing `Refs`/`See` references
 * are always preserved.
 *
 * @param {string|null|undefined} body - PR body text
 * @param {Array<number|{repository:string, number:number}>} targets - issues whose
 *   closing refs to remove.  A plain number matches by issue number alone (legacy /
 *   single-repo callers).  An object `{repository, number}` restricts matching to
 *   that exact owner/repo so that `Fixes other/repo#42` is not removed when the
 *   target is `{repository: 'this/repo', number: 42}`.
 * @param {string} [currentRepo] - owner/repo of the current repository (e.g.
 *   `'nalfeo/Crawler'`).  Used to resolve unqualified `#N` references when targets
 *   are `{repository, number}` objects.  Defaults to `''` (match any repo) for
 *   backwards-compatibility with plain-number callers.
 * @returns {string} cleaned body
 */
export function stripClosingKeywordsForIssues(body, targets, currentRepo = '') {
  if (!targets || targets.length === 0) return String(body ?? '');
  const repo = currentRepo.toLowerCase();
  return String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      const m = line.match(CLOSING_KEYWORD_LINE_RE);
      if (!m) return true;
      // Group 1: optional owner/repo prefix; group 2: issue number.
      const lineRepo = m[1] ? m[1].toLowerCase() : repo;
      const lineNumber = Number(m[2]);
      return !targets.some((t) => {
        if (typeof t === 'number') return t === lineNumber;
        return (
          Number(t.number) === lineNumber && String(t.repository || '').toLowerCase() === lineRepo
        );
      });
    })
    .join('\n');
}

export function hasOwnerApproval(comments, ownerLogin) {
  const owner = String(ownerLogin || '').toLowerCase();
  const acceptedPhrases = new Set([HUMAN_APPROVAL_PHRASE, HUMAN_APPROVAL_PHRASE_VARIANT]);
  return (comments || []).some(
    (comment) =>
      String(comment?.user?.login || '').toLowerCase() === owner &&
      acceptedPhrases.has(String(comment?.body || '').trim()),
  );
}

export function humanApprovalRejection({ pullRequest, closingIssues, comments, ownerLogin }) {
  if (!requiresHumanApproval(pullRequest, closingIssues)) return null;
  return hasOwnerApproval(comments, ownerLogin)
    ? null
    : `waiting for ${ownerLogin} to comment exactly: ${HUMAN_APPROVAL_PHRASE}`;
}
