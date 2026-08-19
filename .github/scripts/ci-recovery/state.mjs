import { createHash } from 'node:crypto';

import { STATE_DATA_PREFIX, STATE_MARKER } from './markers.mjs';

export { STATE_MARKER, STATE_DATA_PREFIX };
export const OWNER_LABEL_PREFIX = 'ci-owner-pr-';
export const WAITING_LABEL = 'ci-recovery-waiting';
export const WAITING_TRANSITION_LABEL = 'ci-recovery-waiting-transition';
export const DEFAULT_LEASE_TTL_MINUTES = 30;
export const DEFAULT_LEASE_GRACE_MINUTES = 5;
export const AUTOMATION_STALE_MINUTES = 30;

// A check-run named "merge-train" is only real promotion provenance when it
// was published by the trusted repository App and its external_id is a
// fingerprint-shaped SHA-256 hex digest (see ci.yml, security-review.yml, and
// merge-train/reconcile.mjs, which all gate a shortcut on this same evidence).
// Anyone able to post an untrusted check-run named "merge-train" must not be
// able to fake promotion evidence.
const TRAIN_PROMOTION_FINGERPRINT_SHAPE = /^[0-9a-f]{64}$/;
const COPILOT_REVIEWER_LOGINS = new Set([
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
]);
const COPILOT_NO_FILES_REVIEW =
  /^copilot wasn['’]t able to review any files in this pull request\.\s*$/i;
const SUBMITTED_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
const ASSET_PROMOTE_BRANCH = 'assets/promote';

function isSubstantiveReviewText(value) {
  const body = String(value || '').trim();
  return body.length > 0 && !COPILOT_NO_FILES_REVIEW.test(body);
}

export function isSubstantiveCopilotReview(review) {
  const author = String(review?.author?.login || '').toLowerCase();
  const state = String(review?.state || '').toUpperCase();
  if (!COPILOT_REVIEWER_LOGINS.has(author) || !SUBMITTED_REVIEW_STATES.has(state)) {
    return false;
  }

  if (isSubstantiveReviewText(review.body)) {
    return true;
  }

  return (review.comments?.nodes || []).some((comment) => isSubstantiveReviewText(comment.body));
}

export function hasSubstantiveCopilotReview(reviews) {
  return (reviews || []).some(isSubstantiveCopilotReview);
}

function normalizedChangedPath(file) {
  const path = String(file?.filename ?? file?.path ?? file ?? '')
    .trim()
    .replace(/^\/+/, '');
  return path;
}

function isApprovedArtOnlyPath(path) {
  return (
    path.startsWith('public/assets/generated/') ||
    path === 'src/shared/data/sprite-catalog.json' ||
    path.startsWith('docs/')
  );
}

export function isApprovedArtOnlyDiff(changedFiles) {
  const paths = (changedFiles || []).map(normalizedChangedPath).filter(Boolean);
  return paths.length > 0 && paths.every(isApprovedArtOnlyPath);
}

export function shouldSkipSubstantiveReview(pr, changedFiles) {
  return (
    String(pr?.head?.ref || '').trim() === ASSET_PROMOTE_BRANCH &&
    isApprovedArtOnlyDiff(changedFiles)
  );
}

export function admissionWaitReasons(
  requiredChecks,
  reviews,
  { skipSubstantiveReview = false } = {},
) {
  return [
    ...(requiredChecks || []),
    ...(!skipSubstantiveReview && !hasSubstantiveCopilotReview(reviews)
      ? ['substantive-copilot-review']
      : []),
  ];
}

// Phase enum for the authoritative lifecycle FSM. The lifecycle owner
// (pr-lifecycle.mjs) is the sole writer of these phases; the merge train and
// conflict coordinator are demoted to pure predicates over them.
export const LIFECYCLE_PHASES = {
  REPAIRING: 'repairing',
  QUEUED: 'queued',
  ORDERING: 'ordering',
  MERGING: 'merging',
  DONE: 'done',
  QUARANTINED: 'quarantined',
  ABANDONED: 'abandoned',
};

// QUARANTINED is intentionally NOT terminal: a human can revive a quarantined
// PR to QUEUED by commenting "KEEP" (see parseDispositionCommand). Only DONE
// and ABANDONED are true dead ends with no further lifecycle transitions.
export const TERMINAL_PHASES = new Set([LIFECYCLE_PHASES.DONE, LIFECYCLE_PHASES.ABANDONED]);

// Structurally non-blocking phases (D11): a PR in one of these can never be a
// merge-train admission candidate, a conflict-cluster leader, or an ordering
// predecessor, so it can never dead-head another PR.
export const NON_BLOCKING_PHASES = new Set([
  LIFECYCLE_PHASES.QUARANTINED,
  LIFECYCLE_PHASES.ABANDONED,
]);

export const DEFAULT_REQUIRED_CHECKS = ['ci', 'Security checks'];

/**
 * Returns the required check names that are not completed+successful on the
 * supplied check runs. Latest attempt per logical name wins, mirroring
 * `collapseCheckRunsByName` so a green rerun supersedes an earlier failure.
 *
 * Kept local to this module (rather than importing merge-train's
 * `unsatisfiedChecks`) so `merge-train/state.mjs` can import from here without
 * creating an import cycle.
 *
 * @param {object[]} checkRuns
 * @param {string[]} requiredNames
 * @returns {string[]} unsatisfied required check names
 */
export function unsatisfiedChecksFromRuns(checkRuns, requiredNames = DEFAULT_REQUIRED_CHECKS) {
  const latest = new Map();
  for (const run of collapseCheckRunsByName(checkRuns || [])) {
    latest.set(compact(run.name).toLowerCase(), run);
  }
  return (requiredNames || []).filter((name) => {
    const check = latest.get(compact(name).toLowerCase());
    return check?.status !== 'completed' || check.conclusion !== 'success';
  });
}

/**
 * Pure admission evaluator — takes current PR facts, returns {eligible, reasons[]}.
 * Uses current-facts only (no async state comment required). This eliminates D1
 * (admission deadlock from a stale state comment / wrong enrollment order): the
 * answer is derived from live PR facts rather than from a label whose write
 * order is itself the deadlock.
 *
 * @param {object} prFacts
 * @param {string} [prFacts.headSha]
 * @param {string} [prFacts.baseRef]
 * @param {string} prFacts.state - 'open' | 'closed' | 'merged'
 * @param {boolean} prFacts.draft
 * @param {boolean} [prFacts.mergeable] - true when GitHub API says PR is mergeable
 * @param {boolean} [prFacts.hasMergeConflict] - true when PR has a merge conflict
 * @param {object} [prFacts.stack] - GitHub's stacked-PR `stack` object, present when
 *   this PR belongs to a stack (another open PR is based on its head branch, or it
 *   is itself based on another open PR's head branch). Non-null blocks admission:
 *   see the `stacked-pr` reason below.
 * @param {object[]} [prFacts.checkRuns] - check runs with {name, status, conclusion}
 * @param {object[]} [prFacts.reviewThreads] - review threads with {isResolved}
 * @param {object[]} [prFacts.reviews] - reviews, for hasSubstantiveCopilotReview
 * @param {string[]} [prFacts.requiredChecks] - required check names
 * @param {string|null} [prFacts.humanApprovalDisposition] - non-null means approval pending
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function evaluateAdmission(prFacts, config = {}) {
  const {
    state,
    draft,
    mergeable,
    hasMergeConflict = false,
    stack = null,
    checkRuns = [],
    reviewThreads = [],
    reviews = [],
    requiredChecks = config.requiredChecks || DEFAULT_REQUIRED_CHECKS,
    lifecyclePhase = null,
    humanApprovalDisposition = null,
    skipSubstantiveReview = config.skipSubstantiveReview ?? false,
  } = prFacts || {};

  const reasons = [];

  if (lifecyclePhase && NON_BLOCKING_PHASES.has(lifecyclePhase)) {
    return { eligible: false, reasons: [`lifecycle-phase:${lifecyclePhase}`] };
  }

  if (state !== 'open') reasons.push('pr-not-open');
  if (draft) reasons.push('pr-is-draft');
  // Accept either the GitHub API mergeable=false or a hasMergeConflict flag
  // (used when the caller already computed the conflict state from mergeable_state).
  if (mergeable === false || hasMergeConflict === true) reasons.push('not-mergeable');
  // GitHub's classic synchronous merge endpoint (used by mergePullRequest / the
  // sequential squash-merge promotion loop) 403s on ANY pull request that is
  // part of a stack -- "Merging stacked PRs via this endpoint is not supported.
  // Use the asynchronous merge endpoint instead." That is a hard, ambiguous
  // (non-retryable) failure in createMergePullRequest, and previously escaped
  // admission entirely: a stacked PR could be admitted, reach the merge PUT,
  // 403, and crash the whole reconcile run -- blocking every other queued PR
  // behind it (see incident: PR #3027, stacked under #3033, parked the train
  // for 24h+). Reject a stacked PR at admission so it is dequeued with a clear
  // reason instead of ever reaching the merge call. A stacked PR should be
  // rebased/un-stacked onto `main` before it re-enters the queue -- either the
  // child PR merges/closes first (dissolving the stack) or a human detaches it.
  if (stack) reasons.push('stacked-pr');

  reasons.push(
    ...admissionWaitReasons(unsatisfiedChecksFromRuns(checkRuns, requiredChecks), reviews, {
      skipSubstantiveReview,
    }),
  );

  const unresolvedCount = (reviewThreads || []).filter((thread) => !thread.isResolved).length;
  if (unresolvedCount > 0) reasons.push(`unresolved-threads:${unresolvedCount}`);

  if (humanApprovalDisposition) reasons.push('human-approval-pending');

  return { eligible: reasons.length === 0, reasons };
}

export function isTrustedTrainPromotionCheck(check, trustedAppId) {
  return Boolean(
    check &&
    check.name === 'merge-train' &&
    check.status === 'completed' &&
    check.conclusion === 'success' &&
    Number.isInteger(trustedAppId) &&
    Number(check.app?.id) === trustedAppId &&
    typeof check.external_id === 'string' &&
    TRAIN_PROMOTION_FINGERPRINT_SHAPE.test(check.external_id),
  );
}

export function hasTrustedTrainPromotionCheck(checkRuns, trustedAppId) {
  return (checkRuns || []).some((check) => isTrustedTrainPromotionCheck(check, trustedAppId));
}

/**
 * A push-triggered `CI` run whose head carries an attested successful
 * merge-train check took the fast path (`docs_only=true`; heavy jobs
 * skipped). Its own trivially-green conclusion is not evidence that the
 * broad suite passed, so it must not be treated as authoritative main-health
 * evidence (merge-train/reconcile.mjs circuit breaker) and must not be
 * allowed to auto-close a real CI incident opened by an earlier full-CI
 * failure (incident.mjs).
 */
export function isTrainFastPathPushRun(run, trustedAppId, checkRuns) {
  return (
    run?.event === 'push' &&
    run?.name === 'CI' &&
    hasTrustedTrainPromotionCheck(checkRuns, trustedAppId)
  );
}

// Workflow files whose parked (`action_required`) runs the automation can
// retrigger by itself (see action-required-retrigger.mjs). Identity is the
// immutable workflow *path*, never the mutable display name: renaming "CI"
// must not change recovery behaviour, and an unrelated workflow that happens
// to be named "CI" must not inherit it.
export const AUTO_RETRIGGER_WORKFLOW_PATHS = Object.freeze([
  '.github/workflows/ci.yml',
  '.github/workflows/security-review.yml',
]);

export function isAutoRetriggerWorkflowRun(run) {
  const path = String(run?.path ?? '')
    .trim()
    .toLowerCase();
  return AUTO_RETRIGGER_WORKFLOW_PATHS.includes(path);
}

// A repository incident needs a human/admin hand when automation cannot get
// the run moving again on its own: a startup failure, or a parked run in a
// workflow the auto-retrigger path does not cover.
export function requiresAdminIntervention(run) {
  const conclusion = String(run?.conclusion ?? '');
  if (conclusion === 'startup_failure') return true;
  return conclusion === 'action_required' && !isAutoRetriggerWorkflowRun(run);
}

const validOwners = new Set(['automation', 'shepherd', 'none']);
export const RECOVERY_STATUSES = Object.freeze([
  'active',
  'dispatched',
  'escalated',
  'idle',
  'waiting',
]);
const validStatuses = new Set(RECOVERY_STATUSES);

export function shouldMutateRecoveryState(mode, operation) {
  return mode === 'live' || (mode === 'dry-run' && operation.startsWith('lease-'));
}

function compact(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeBlockers(blockers) {
  return blockers
    .map((blocker) => ({
      kind: compact(blocker.kind),
      id: compact(blocker.id),
      summary: compact(blocker.summary),
      ...(blocker.url ? { url: compact(blocker.url) } : {}),
      ...(blocker.threadId ? { threadId: compact(blocker.threadId) } : {}),
      ...(blocker.path ? { path: compact(blocker.path) } : {}),
      ...(blocker.line !== undefined && blocker.line !== null
        ? {
            line:
              typeof blocker.line === 'number' && Number.isFinite(blocker.line)
                ? blocker.line
                : compact(blocker.line),
          }
        : {}),
      ...(blocker.isOutdated === true ? { isOutdated: true } : {}),
    }))
    .sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`));
}

export function blockerFingerprint(blockers) {
  const normalized = normalizeBlockers(blockers);
  // NOTE: `line` is display-only metadata. Diff-position lines drift whenever
  // surrounding code changes (e.g. INDEX regeneration), so it must not
  // participate in blocker identity hashing.
  //
  // NOTE: `url` is also display-only metadata. A `ci-failure`/`ci-retrigger`
  // blocker's `url` is a check-run/workflow-run permalink that embeds a fresh
  // run/job ID on every rerun of the SAME failing check (same name, same
  // conclusion) — including retries dispatched by this very automation.
  // Hashing `url` therefore produced a NEW fingerprint on every retry cycle
  // even when nothing about the underlying blocker changed, which
  // `automationStallAction` (see below) reads as `'progressed'`: it resets the
  // attempt counter to 0 and refreshes `progressAt` to now on every cycle, so
  // the automation-stale ceiling (`attempt >= 2`) and lease-reaper takeover
  // window can never be reached — an effectively immortal ownership lock.
  // Observed in production on PR #1809 (10:09 / 10:44 / 11:29 UTC cycle): the
  // persisted state's `attempt` stayed pinned at 1 forever because each retry
  // was misclassified as new progress solely due to a new run URL.
  //
  // NOTE: `ci-failure copilot` (kind='ci-failure', id='copilot') is also
  // excluded from the fingerprint. GitHub creates a check named "copilot"
  // whenever the CI recovery assigns @copilot to a PR (via the dynamic
  // copilot-swe-agent workflow). When that session fails at session.create
  // (e.g. a deprecated model), the check concludes `failure` and first
  // appears as a NEW blocker on the next reconcile sweep. Including this
  // self-generated blocker in the fingerprint causes `automationStallAction`
  // to return 'progressed' on the FIRST cycle after a failed dispatch —
  // resetting the attempt counter and granting exactly one extra dispatch
  // cycle before the loop incident is filed (3 cycles instead of the
  // intended 2). Excluding it from
  // the fingerprint lets the stale-retry path count correctly: the attempt
  // counter increments normally across cycles where the only new "change" is
  // this self-generated failure (the underlying blockers that caused the
  // dispatch are unchanged). The blocker is still persisted to state for
  // display/evidence; it is only invisible to the fingerprint hash.
  // Observed in production on PR #1939 / incident #2268 (model
  // "claude-sonnet-4.5" deprecated 2026-05-06; incident filed 2026-07-29).
  const fingerprintBlockers = normalized
    .filter((b) => !(b.kind === 'ci-failure' && b.id === 'copilot'))
    .map(({ line: _line, url: _url, ...rest }) => rest);
  return createHash('sha256')
    .update(JSON.stringify({ blockers: fingerprintBlockers }))
    .digest('hex');
}

function normalizeThreadComments(thread) {
  // Recovery attempts that post non-marker diagnostics in the same review
  // thread should not count as blocker progress: they can churn comment digests
  // forever while leaving the underlying blocker unchanged. Keep marker replies
  // in digest identity, but ignore known recovery-agent replies that do not
  // carry a resolution marker.
  const knownRecoveryReplyLogins = new Set([
    'copilot',
    'copilot[bot]',
    'app/copilot',
    'copilot-swe-agent',
    'copilot-swe-agent[bot]',
    'app/copilot-swe-agent',
  ]);
  const hasResolutionMarker = (body) => {
    // Strip quoted lines (lines starting with ">") before testing — a recovery
    // reply may quote a prior task body that itself contains a stale marker SHA,
    // and testing the raw body would incorrectly classify such a reply as
    // marker-bearing.  Same normalization as reconcile.mjs:1926-1929.
    const unquotedText = String(body ?? '')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('>'))
      .join('\n');
    // Use extractAddressedMarkerSha rather than the raw pattern so that a bare
    // "✅ Addressed in invalid-token" (no parseable SHA/URL) is not treated as
    // a resolution marker.
    return Boolean(extractAddressedMarkerSha(unquotedText) || hasNotApplicableMarker(unquotedText));
  };
  return (thread?.comments?.nodes ?? [])
    .filter((comment) => {
      const authorLogin = String(comment?.author?.login ?? '').toLowerCase();
      if (!knownRecoveryReplyLogins.has(authorLogin)) return true;
      return hasResolutionMarker(comment?.body);
    })
    .map((comment) => [
      compact(comment.id),
      String(comment.body ?? ''),
      compact(comment.author?.login),
      compact(comment.authorAssociation),
    ]);
}

export function reviewThreadCommentDigest(thread) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeThreadComments(thread)))
    .digest('hex');
}

export function reviewThreadBlockerId(thread) {
  return `review-thread:${compact(thread?.id)}:${reviewThreadCommentDigest(thread)}`;
}

export function ownerLabel(prNumber) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  return `${OWNER_LABEL_PREFIX}${prNumber}`;
}

export function automationProgressKey(headSha, fingerprint) {
  return createHash('sha256')
    .update(JSON.stringify({ headSha: compact(headSha), fingerprint: compact(fingerprint) }))
    .digest('hex');
}

export function makeState({
  prNumber,
  headSha,
  fingerprint,
  owner,
  status,
  leaseId = null,
  trigger = '',
  blockers = [],
  attempt = 0,
  progressKey = null,
  progressAt = null,
  updatedAt,
}) {
  const state = {
    version: 1,
    prNumber,
    headSha: compact(headSha),
    fingerprint: compact(fingerprint),
    owner: compact(owner),
    status: compact(status),
    leaseId: leaseId ? compact(leaseId) : null,
    trigger: compact(trigger),
    blockers: normalizeBlockers(blockers),
    attempt,
    ...(progressKey ? { progressKey: compact(progressKey), progressAt: compact(progressAt) } : {}),
    updatedAt: compact(updatedAt),
  };
  validateState(state);
  return state;
}

export function validateState(state) {
  if (state?.version !== 1) {
    throw new Error('CI recovery state must use version 1');
  }
  if (!Number.isInteger(state.prNumber) || state.prNumber <= 0) {
    throw new Error('CI recovery state has an invalid PR number');
  }
  if (!state.headSha || !state.fingerprint || !state.updatedAt) {
    throw new Error('CI recovery state is missing head, fingerprint, or timestamp');
  }
  if (!validOwners.has(state.owner) || !validStatuses.has(state.status)) {
    throw new Error('CI recovery state has an invalid owner or status');
  }
  if (state.owner === 'shepherd' && !state.leaseId) {
    throw new Error('A shepherd lease requires a lease ID');
  }
  if (state.status === 'waiting' && (state.owner !== 'none' || state.leaseId)) {
    throw new Error('A waiting recovery state cannot own the PR or carry a lease');
  }
  if (!Array.isArray(state.blockers) || !Number.isInteger(state.attempt)) {
    throw new Error('CI recovery state has invalid blockers or attempt count');
  }
  if (Boolean(state.progressKey) !== Boolean(state.progressAt)) {
    throw new Error('CI recovery state must carry progress key and timestamp together');
  }
  if (state.progressAt && Number.isNaN(Date.parse(state.progressAt))) {
    throw new Error('CI recovery progress timestamp is invalid');
  }
  if (Number.isNaN(Date.parse(state.updatedAt))) {
    throw new Error('CI recovery state timestamp is invalid');
  }
  return state;
}

// Triggers that carry behavioral state even in an otherwise-idle context.
// These must NOT be normalized away during semantic equality checks because
// reconcile.mjs reads them back from persisted state (e.g. the predecessor PR
// number in a cumulative-conflict signal).
const BEHAVIORAL_IDLE_TRIGGER = /^merge-train-cumulative-conflict:\d+$/;

function semanticState(state) {
  const { updatedAt: _updatedAt, ...semantic } = validateState(state);
  if (semantic.status === 'waiting') {
    semantic.trigger = semantic.status;
  } else if (
    semantic.status === 'idle' &&
    semantic.blockers.length === 0 &&
    !BEHAVIORAL_IDLE_TRIGGER.test(semantic.trigger)
  ) {
    semantic.trigger = semantic.status;
  }
  return semantic;
}

export function isRecoveryStateSemanticallyEqual(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(semanticState(left)) === JSON.stringify(semanticState(right));
}

export function renderStateComment(state) {
  validateState(state);
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  const blockerSummary =
    state.blockers.length === 0
      ? 'none'
      : state.blockers.map((blocker) => `${blocker.kind}:${blocker.id}`).join(', ');
  return [
    STATE_MARKER,
    `${STATE_DATA_PREFIX}${encoded} -->`,
    '## Crawler CI recovery state',
    '',
    `- Owner: \`${state.owner}\``,
    `- Status: \`${state.status}\``,
    `- Head: \`${state.headSha}\``,
    `- Fingerprint: \`${state.fingerprint}\``,
    `- Blockers: ${blockerSummary}`,
    ...(state.progressAt
      ? [`- Automation attempt: ${state.attempt}`, `- Progress observed: ${state.progressAt}`]
      : []),
    `- Updated: ${state.updatedAt}`,
    '',
    '_This comment is managed by the trusted CI recovery workflow._',
  ].join('\n');
}

export function parseStateComment(body) {
  if (!String(body).includes(STATE_MARKER)) {
    return null;
  }
  const pattern = new RegExp(
    `${STATE_DATA_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([A-Za-z0-9_-]+)\\s*-->`,
  );
  const match = String(body).match(pattern);
  if (!match) {
    throw new Error('CI recovery state marker has no encoded payload');
  }
  let state;
  try {
    state = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error(`CI recovery state payload is invalid: ${error.message}`);
  }
  return validateState(state);
}

export function isLeaseExpired(
  state,
  now = new Date(),
  ttlMinutes = DEFAULT_LEASE_TTL_MINUTES,
  graceMinutes = DEFAULT_LEASE_GRACE_MINUTES,
) {
  if (state.owner !== 'shepherd' || state.status !== 'active') {
    return false;
  }
  const expiresAt = Date.parse(state.updatedAt) + (ttlMinutes + graceMinutes) * 60 * 1000;
  return now.getTime() > expiresAt;
}

export function assertOwnershipInvariant({ labelExists, state }) {
  const active = state && state.owner !== 'none' && state.status !== 'idle';
  if (Boolean(labelExists) !== Boolean(active)) {
    throw new Error(
      `CI recovery ownership is inconsistent: label=${labelExists} state=${state?.owner ?? 'missing'}/${state?.status ?? 'missing'}`,
    );
  }
}

export function isDuplicateDispatch(state, fingerprint) {
  return Boolean(
    state &&
    state.owner === 'automation' &&
    ['active', 'dispatched', 'escalated'].includes(state.status) &&
    state.fingerprint === fingerprint,
  );
}

export function automationStallAction({
  state,
  headSha,
  fingerprint,
  now = new Date(),
  staleMinutes = AUTOMATION_STALE_MINUTES,
}) {
  if (
    !state ||
    state.owner !== 'automation' ||
    !['active', 'dispatched', 'escalated'].includes(state.status)
  ) {
    return 'new';
  }

  const liveHead = compact(headSha);
  const stateHead = compact(state.headSha);
  if (liveHead && stateHead && liveHead !== stateHead) {
    return 'progressed';
  }

  const currentFingerprint = compact(fingerprint);
  if (compact(state.fingerprint) !== currentFingerprint) {
    return 'progressed';
  }

  const progressAt = Date.parse(state.progressAt || state.updatedAt);
  if (now.getTime() - progressAt < staleMinutes * 60 * 1000) {
    return 'wait';
  }
  // Legacy v1 automation comments pre-date `progressKey` and used `attempt`
  // as a cumulative dispatch count (not a per-progress-key retry count).
  // Treating legacy `attempt >= 2` as an exhausted retry would skip the
  // promised one retry immediately after rollout.  Only count toward the
  // exhaustion threshold when `progressKey` is present (written by the new
  // stale-retry logic) so legacy states always receive a single retry.
  const stallAttempt = state.progressKey ? state.attempt : 0;
  return stallAttempt >= 2 ? 'release' : 'retry';
}

// True only for a live *shepherd* lease — a human/session-driven owner that is
// actively editing the branch. Routine `automation` ownership is deliberately
// excluded.
//
// Incident 2026-07-27: the conflict coordinator's `activeSafe` gate used
// `isHealthyRecoveryOwner`, which also returns true for ordinary
// `owner=automation` states. Because the coordinator dispatches CI recovery for
// its own active slot, every dispatch immediately made the slot "healthy",
// which forced `activeSafe=false`, left `activeNumber=null`, and re-fenced the
// whole group. A 12-PR cluster sat with `ORDER_WAIT` on every member and a
// clean (`proof=applied`) leader that could never promote. Splitting the
// shepherd case out restores the behaviour the coordinator comment always
// described. See issue #2095.
export function isHealthyShepherdLease({ prNumber, state, now = new Date() }) {
  if (!state || state.prNumber !== prNumber) return false;
  if (state.owner !== 'shepherd') return false;
  return state.status === 'active' && !isLeaseExpired(state, now);
}

export function isHealthyRecoveryOwner({ prNumber, state, headSha = null, now = new Date() }) {
  if (!state || state.prNumber !== prNumber) return false;
  if (state.owner === 'shepherd') {
    return state.status === 'active' && !isLeaseExpired(state, now);
  }
  if (
    state.owner !== 'automation' ||
    !['active', 'dispatched', 'escalated'].includes(state.status)
  ) {
    return false;
  }
  const liveHead = String(headSha || '').toLowerCase();
  const stateHead = String(state.headSha || '').toLowerCase();
  // Some shared callers only know the persisted state and freshness window.
  // When a live PR head is available, require it to match before automation
  // ownership can suppress new work; otherwise preserve the legacy freshness-only
  // fallback for callers that do not have a head SHA to compare against.
  if (liveHead && stateHead !== liveHead) {
    return false;
  }
  const progressAt = Date.parse(state.progressAt || state.updatedAt);
  return now.getTime() - progressAt < AUTOMATION_STALE_MINUTES * 60 * 1000;
}

export function shouldDispatchMergeTrainFill(alreadyQueued) {
  return !alreadyQueued;
}

export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const TRUSTED_BOT_LOGINS = new Set([
  'copilot-swe-agent[bot]',
  'copilot-swe-agent',
  'github-actions[bot]',
  'copilot',
]);

const addressedInPrefixPattern = /✅\s*addressed\s+in\s+<?([^\s>]+)>?/i;
const notApplicablePattern = /^\s*✅\s*not\s+applicable\s*(?::|—|–)\s*\S/i;
const hexShaPattern = /^[0-9a-f]{7,40}$/i;

function parseMarkerShaToken(rawToken) {
  // Marker replies often leave copied SHAs/URLs with trailing Markdown
  // punctuation or balanced inline-code wrappers. Normalize only those outer
  // delimiters before applying the existing strict SHA/commit-URL validation.
  let token = String(rawToken ?? '')
    .replace(/[):.,;!?]+$/g, '')
    .trim();
  if (!token) return null;
  if (token.startsWith('`') || token.endsWith('`')) {
    const inlineCode = token.match(/^(`+)([^`\r\n]+)\1$/);
    if (!inlineCode) return null;
    token = inlineCode[2].trim();
  }
  if (hexShaPattern.test(token)) {
    return token.toLowerCase();
  }
  // Handle slash-separated SHA pairs like "9adef25/28f3d0f" (agents sometimes
  // write two SHAs when a fix spans multiple commits). Require exactly two
  // hex-SHA components; return the second (later) SHA so its ancestry proves
  // the complete pair is present.
  const slashParts = token.split('/');
  if (slashParts.length === 2) {
    const [firstPart, secondPart] = slashParts;
    if (hexShaPattern.test(firstPart) && hexShaPattern.test(secondPart)) {
      return secondPart.toLowerCase();
    }
  }
  try {
    const parsed = new URL(token);
    const commitMatch = parsed.pathname.match(/\/commit\/([0-9a-f]{7,40})\b/i);
    if (!commitMatch) return null;
    return commitMatch[1].toLowerCase();
  } catch {
    return null;
  }
}

/** Extracts the SHA from a trusted marker body:
 *  "✅ Addressed in <sha-or-commit-url>".
 *  Returns null when no valid marker payload exists. */
export function extractAddressedMarkerSha(body) {
  const match = String(body ?? '').match(addressedInPrefixPattern);
  if (!match) return null;
  return parseMarkerShaToken(match[1]);
}

/** Returns true if body contains a "✅ Not applicable" marker, which signals
 *  that the reviewer's finding has been deterministically assessed as
 *  inapplicable to the current code (no fix needed, no SHA to reference). */
export function hasNotApplicableMarker(body) {
  return notApplicablePattern.test(String(body ?? ''));
}

/** Returns true if body contains "✅ Addressed in <sha-or-commit-url>" and the
 *  extracted commit names the current head (full or ≥7-char prefix), or is a
 *  known ancestor from reachableCommitShas. */
export function markerNamesHead(body, headSha, reachableCommitShas = null) {
  const markerSha = extractAddressedMarkerSha(body);
  if (!markerSha) return false;
  const head = String(headSha ?? '').toLowerCase();
  if (head.length >= markerSha.length && head.startsWith(markerSha)) {
    return true;
  }
  if (!reachableCommitShas) return false;
  return reachableCommitShas.has(markerSha);
}

function isTrustedComment(comment) {
  return (
    TRUSTED_ASSOCIATIONS.has(String(comment.authorAssociation ?? '').toUpperCase()) ||
    TRUSTED_BOT_LOGINS.has(String(comment.author?.login ?? '').toLowerCase())
  );
}

/**
 * Returns true only when the last comment in the thread is a trusted marker
 * that either explicitly names the current head SHA (full or ≥7-char prefix),
 * or carries a "✅ Not applicable" marker signalling the finding is
 * deterministically inapplicable (no code change needed, no SHA to reference).
 * A reopened thread with later reviewer feedback keeps returning false even if
 * an earlier comment had a valid marker.
 */
export function shouldResolveThread(thread, headSha, reachableCommitShas = null) {
  const comments = thread.comments?.nodes ?? [];
  if (comments.length === 0) return false;
  const last = comments[comments.length - 1];
  if (!isTrustedComment(last)) return false;
  return (
    markerNamesHead(last.body, headSha, reachableCommitShas) || hasNotApplicableMarker(last.body)
  );
}

/**
 * Returns one entry per logical check name, keeping the run with the highest
 * id (latest attempt). Ensures a successful rerun supersedes a previously
 * failed attempt before any blocker classification.
 */
export function collapseCheckRunsByName(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns) {
    const name = String(run.name ?? '');
    const existing = latest.get(name);
    if (!existing || run.id > existing.id) {
      latest.set(name, run);
    }
  }
  return [...latest.values()];
}

// Workflow files that belong to the CI Recovery automation itself. A failed job
// in one of these is an infrastructure fault in the recovery pipeline, never
// something a PR author (or the recovery agent acting on the PR) can fix by
// changing the branch, so such checks must never become PR blockers -- doing so
// hands recovery a permanently unclearable blocker and the loop stalls until
// attempts exhaust.
//
// Identity is the immutable workflow *path*, never the mutable display name
// (same rationale as AUTO_RETRIGGER_WORKFLOW_PATHS). The pre-existing
// name-substring filter in reconcile.mjs only matched jobs whose *job* name
// contains "CI recovery"; the router's job is named `route`, which slipped
// through and produced the `ci-failure route` blocker behind the PR #2952
// recovery-loop incident.
export const SELF_RECOVERY_WORKFLOW_PATHS = Object.freeze([
  '.github/workflows/ci-recovery.yml',
  '.github/workflows/ci-recovery-router.yml',
  '.github/workflows/ci-recovery-incidents.yml',
  '.github/workflows/ci-recovery-review-wake-bridge.yml',
]);

const SELF_RECOVERY_WORKFLOW_PATH_SET = new Set(
  SELF_RECOVERY_WORKFLOW_PATHS.map((path) => path.toLowerCase()),
);

/**
 * Extracts the owning workflow run id from an Actions check run. Actions check
 * runs expose a job URL of the form
 * `https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>`, so the
 * run id is recoverable without an extra API call.
 *
 * @param {object} check
 * @returns {number|null} run id, or null when the URL is absent/unparseable
 * (e.g. a check posted by a non-Actions App).
 */
export function checkRunWorkflowRunId(check) {
  const url = String(check?.html_url || check?.details_url || '');
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Returns the ids of the supplied workflow runs that belong to the CI Recovery
 * automation itself.
 *
 * @param {object[]} workflowRuns runs from `/actions/runs?head_sha=...`
 * @returns {Set<number>}
 */
export function selfRecoveryWorkflowRunIds(workflowRuns) {
  const ids = new Set();
  for (const run of workflowRuns || []) {
    const path = compact(run?.path).toLowerCase();
    if (SELF_RECOVERY_WORKFLOW_PATH_SET.has(path)) {
      ids.add(Number(run.id));
    }
  }
  return ids;
}

/**
 * True when the check run was produced by a CI Recovery workflow, so it must be
 * excluded from PR blocker classification.
 *
 * @param {object} check
 * @param {Set<number>} selfRecoveryRunIds from `selfRecoveryWorkflowRunIds`
 * @returns {boolean}
 */
export function isSelfRecoveryCheckRun(check, selfRecoveryRunIds) {
  const runId = checkRunWorkflowRunId(check);
  if (runId !== null && selfRecoveryRunIds?.has(runId)) return true;
  // Fallback for the case where the owning run is not in the caller's run list
  // (e.g. more than one page of runs on the head SHA): the recovery reconcile
  // job carries "CI recovery" in its job name.
  return compact(check?.name).toLowerCase().includes('ci recovery');
}

export function shouldSkipRepoIncidentWorkflowRun(run) {
  const event = compact(run?.event);
  return (
    event === 'pull_request' ||
    event === 'pull_request_target' ||
    (Array.isArray(run?.pull_requests) && run.pull_requests.length > 0)
  );
}

// ---------------------------------------------------------------------------
// Disposition labels and markers
// ---------------------------------------------------------------------------

/** Label applied to PRs that a human or agent explicitly proposes for abandonment. */
export const ABANDON_CANDIDATE_LABEL = 'abandon-candidate';

/**
 * Marker written into the quarantine human-decision comment so the revival
 * handler can identify it. Different from STATE_MARKER so the two comment
 * types are never confused.
 */
export const QUARANTINE_COMMENT_MARKER = '<!-- crawler-ci-quarantine:v1 -->';

/**
 * Parse a PR comment body for an exact-match KEEP or ABANDON disposition
 * command posted by the PR owner.
 *
 * Rules (acceptance criterion: "human-gated revival is exact-match"):
 *   - Comment body trimmed must equal "KEEP" or "ABANDON" (case-sensitive,
 *     standalone — no quoted text, no substrings, no other authors).
 *   - Returns 'KEEP', 'ABANDON', or null.
 *   - A non-owner comment, a substring match, or any other text returns null.
 *
 * @param {string} commentBody - raw comment body text
 * @returns {'KEEP' | 'ABANDON' | null}
 */
export function parseDispositionCommand(commentBody) {
  const trimmed = String(commentBody ?? '').trim();
  if (trimmed === 'KEEP') return 'KEEP';
  if (trimmed === 'ABANDON') return 'ABANDON';
  return null;
}
