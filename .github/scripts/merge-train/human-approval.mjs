export const HUMAN_APPROVAL_LABEL = 'human-approval-required';
export const HUMAN_APPROVAL_PHRASE = 'APPROVED FOR CHECK-IN';

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
  return (comments || []).some(
    (comment) =>
      String(comment?.user?.login || '').toLowerCase() === owner &&
      String(comment?.body || '').trim() === HUMAN_APPROVAL_PHRASE,
  );
}

/**
 * Returns true when the repository owner has submitted a real GitHub pull-request
 * review whose latest decision is `APPROVED`.
 *
 * Only the owner's most recent *decisive* review counts: `COMMENTED` and
 * `PENDING` reviews carry no verdict and are ignored, while a later
 * `CHANGES_REQUESTED` or `DISMISSED` review revokes an earlier approval.
 * Reviews are ordered by `submitted_at` when available, falling back to the
 * API's chronological array order (and `id` as a final tiebreak) so the helper
 * works with either shape.
 *
 * @param {Array<{user?:{login?:string}, state?:string, submitted_at?:string, id?:number}>} reviews
 * @param {string} ownerLogin
 */
export function hasOwnerApprovalReview(reviews, ownerLogin) {
  const owner = String(ownerLogin || '').toLowerCase();
  const decisive = (reviews || [])
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => String(review?.user?.login || '').toLowerCase() === owner)
    .filter(({ review }) => {
      const state = String(review?.state || '').toUpperCase();
      return state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED';
    });
  if (decisive.length === 0) return false;
  const latest = decisive.reduce((best, candidate) => {
    const bestTime = Date.parse(best.review?.submitted_at || '');
    const candidateTime = Date.parse(candidate.review?.submitted_at || '');
    if (Number.isFinite(bestTime) && Number.isFinite(candidateTime) && bestTime !== candidateTime) {
      return candidateTime > bestTime ? candidate : best;
    }
    return candidate.index > best.index ? candidate : best;
  });
  return String(latest.review?.state || '').toUpperCase() === 'APPROVED';
}

/**
 * True when the repository owner granted approval either by submitting a real
 * `APPROVED` pull-request review or by posting the exact approval comment.
 */
export function hasHumanApproval({ comments, reviews, ownerLogin }) {
  return hasOwnerApprovalReview(reviews, ownerLogin) || hasOwnerApproval(comments, ownerLogin);
}

/**
 * Async wrapper around {@link humanApprovalRejection} that fetches the PR's
 * reviews only when the gate actually applies.  Gated PRs are rare, so callers
 * avoid an extra `/pulls/{n}/reviews` request on every ungated PR.
 *
 * @param {() => Promise<Array>} fetchReviews - lazily loads the PR's reviews
 */
export async function resolveHumanApprovalRejection({
  pullRequest,
  closingIssues,
  comments,
  ownerLogin,
  fetchReviews,
}) {
  if (!requiresHumanApproval(pullRequest, closingIssues)) return null;
  if (hasOwnerApproval(comments, ownerLogin)) return null;
  const reviews = await fetchReviews();
  return humanApprovalRejection({ pullRequest, closingIssues, comments, reviews, ownerLogin });
}

export function humanApprovalRejection({
  pullRequest,
  closingIssues,
  comments,
  reviews = [],
  ownerLogin,
}) {
  if (!requiresHumanApproval(pullRequest, closingIssues)) return null;
  return hasHumanApproval({ comments, reviews, ownerLogin })
    ? null
    : `waiting for ${ownerLogin} to approve this PR in review, or comment exactly: ${HUMAN_APPROVAL_PHRASE}`;
}
