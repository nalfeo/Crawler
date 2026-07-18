import { createHash } from 'node:crypto';

export const STATE_MARKER = '<!-- crawler-ci-state:v1 -->';
export const STATE_DATA_PREFIX = '<!-- crawler-ci-state-data:';
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

export function admissionWaitReasons(requiredChecks, reviews) {
  return [
    ...(requiredChecks || []),
    ...(!hasSubstantiveCopilotReview(reviews) ? ['substantive-copilot-review'] : []),
  ];
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

const validOwners = new Set(['automation', 'shepherd', 'none']);
const validStatuses = new Set(['active', 'dispatched', 'escalated', 'idle', 'waiting']);

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
      ...(Number.isFinite(blocker.line) ? { line: blocker.line } : {}),
    }))
    .sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`));
}

export function blockerFingerprint(blockers) {
  const normalized = normalizeBlockers(blockers);
  return createHash('sha256')
    .update(JSON.stringify({ blockers: normalized }))
    .digest('hex');
}

function normalizeThreadComments(thread) {
  return (thread?.comments?.nodes ?? []).map((comment) => [
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

  const currentProgressKey = automationProgressKey(headSha, fingerprint);
  const storedProgressKey =
    state.progressKey || automationProgressKey(state.headSha, state.fingerprint);
  if (storedProgressKey !== currentProgressKey) {
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

export function isHealthyRecoveryOwner({ prNumber, state, now = new Date() }) {
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
 * Returns true when the thread should be resolved by the reconcile loop.
 *
 * Two conditions each independently satisfy resolution:
 *
 * 1. **Outdated thread** (`isOutdated: true`) — GitHub marks a thread outdated
 *    when the code at that location changed after the review comment was posted.
 *    The comment no longer refers to current code, so the thread is
 *    deterministically non-applicable and can be resolved automatically.
 *
 * 2. **Trusted addressed marker** — the last comment in the thread is from a
 *    trusted author and explicitly names the current head SHA (full or ≥7-char
 *    prefix). A reopened thread with later reviewer feedback keeps returning
 *    false even if an earlier comment had a valid marker.
 */
export function shouldResolveThread(thread, headSha, reachableCommitShas = null) {
  if (thread.isOutdated) return true;
  const comments = thread.comments?.nodes ?? [];
  if (comments.length === 0) return false;
  const last = comments[comments.length - 1];
  return isTrustedComment(last) && markerNamesHead(last.body, headSha, reachableCommitShas);
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

export function shouldSkipRepoIncidentWorkflowRun(run) {
  const event = compact(run?.event);
  return (
    event === 'pull_request' ||
    event === 'pull_request_target' ||
    (Array.isArray(run?.pull_requests) && run.pull_requests.length > 0)
  );
}
