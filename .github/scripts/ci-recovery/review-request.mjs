import { createHash } from 'node:crypto';

import { REVIEW_CONFLICT_MARKER, REVIEW_REQUEST_MARKER } from './markers.mjs';

export { REVIEW_REQUEST_MARKER, REVIEW_CONFLICT_MARKER };
export const REVIEWER_LOGIN = 'copilot-pull-request-reviewer';

const SHA_PATTERN = '[0-9a-f]{40}';
const EPISODE_PATTERN = '[0-9a-f]{64}';
const REQUEST_PATTERN = new RegExp(
  `^${REVIEW_REQUEST_MARKER} head=(${SHA_PATTERN}) reason=(ready|synchronize|conflict-resolved)(?: episode=(${EPISODE_PATTERN}))? -->$`,
);
const CONFLICT_PATTERN = new RegExp(
  `^${REVIEW_CONFLICT_MARKER} episode=(${EPISODE_PATTERN}) head=(${SHA_PATTERN}) base=(${SHA_PATTERN}) -->$`,
);
const TRUSTED_ASSOCIATIONS = new Set(['owner', 'member', 'collaborator']);
const INITIAL_TRIGGERS = new Set([
  'pull_request_target:opened',
  'pull_request_target:reopened',
  'pull_request_target:ready_for_review',
]);

function normalized(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function trustedComment(comment) {
  return TRUSTED_ASSOCIATIONS.has(
    normalized(comment?.author_association || comment?.authorAssociation),
  );
}

function parseTrustedComments(comments, pattern, project) {
  return (comments || []).flatMap((comment) => {
    if (!trustedComment(comment)) return [];
    const match = String(comment?.body || '')
      .trim()
      .match(pattern);
    return match ? [project(match)] : [];
  });
}

export function reviewRequestMarkers(comments) {
  return parseTrustedComments(comments, REQUEST_PATTERN, (match) => ({
    headSha: match[1],
    reason: match[2],
    episode: match[3] || null,
  })).filter((marker) => (marker.reason === 'conflict-resolved') === Boolean(marker.episode));
}

export function conflictEpisodeMarkers(comments) {
  return parseTrustedComments(comments, CONFLICT_PATTERN, (match) => ({
    episode: match[1],
    headSha: match[2],
    baseSha: match[3],
  }));
}

export function conflictEpisodeId({ headSha, baseSha }) {
  const normalizedHead = normalized(headSha);
  const normalizedBase = normalized(baseSha);
  if (!new RegExp(`^${SHA_PATTERN}$`).test(normalizedHead)) {
    throw new Error(`Invalid conflict head SHA: ${headSha}`);
  }
  if (!new RegExp(`^${SHA_PATTERN}$`).test(normalizedBase)) {
    throw new Error(`Invalid conflict base SHA: ${baseSha}`);
  }
  return createHash('sha256').update(`${normalizedHead}:${normalizedBase}`).digest('hex');
}

function isSha(value) {
  return new RegExp(`^${SHA_PATTERN}$`).test(normalized(value));
}

export function unrecordedConflictEpisode({ pr, hasMergeConflict, comments }) {
  if (!hasMergeConflict) return null;
  const headSha = normalized(pr?.head?.sha);
  const baseSha = normalized(pr?.base?.sha);
  if (!isSha(headSha) || !isSha(baseSha)) return null;
  const episode = conflictEpisodeId({ headSha, baseSha });
  if (conflictEpisodeMarkers(comments).some((marker) => marker.episode === episode)) {
    return null;
  }
  return { episode, headSha, baseSha };
}

export function shouldRequestReview({
  trigger,
  pr,
  hasMergeConflict,
  requiredChecksPassing,
  blockers,
  comments,
  hasInitialReviewEvidence = false,
}) {
  if (normalized(pr?.state) !== 'open' || pr?.draft) return null;

  const headSha = normalized(pr?.head?.sha);
  const requests = reviewRequestMarkers(comments);
  const normalRequests = requests.filter((request) => request.reason !== 'conflict-resolved');
  const initialTrigger = INITIAL_TRIGGERS.has(normalized(trigger));
  if (initialTrigger && normalRequests.length === 0) {
    return { reason: 'ready', episode: null, requestReviewer: false };
  }
  if (hasMergeConflict || !requiredChecksPassing || (blockers || []).length > 0) {
    return null;
  }

  // Conflict-episode check runs before normal head-based deduplication so that a
  // conflict-resolved review can fire even when the current head was already normally
  // reviewed (the same head can carry a new unreviewed conflict episode).
  const episodes = conflictEpisodeMarkers(comments);
  const latestEpisode = episodes.at(-1);
  if (
    latestEpisode &&
    !requests.some(
      (request) =>
        request.reason === 'conflict-resolved' && request.episode === latestEpisode.episode,
    )
  ) {
    return {
      reason: 'conflict-resolved',
      episode: latestEpisode.episode,
      requestReviewer: true,
    };
  }

  // Head-based deduplication applies only to normal (non-conflict) requests.
  if (normalRequests.some((request) => request.headSha === headSha)) return null;

  if (normalRequests.length === 0) {
    return hasInitialReviewEvidence
      ? { reason: 'ready', episode: null, requestReviewer: false }
      : null;
  }

  if (normalRequests.length >= 3) return null;
  return { reason: 'synchronize', episode: null, requestReviewer: true };
}

export function reviewRequestMarker({ headSha, reason, episode }) {
  const suffix = episode ? ` episode=${episode}` : '';
  return `${REVIEW_REQUEST_MARKER} head=${normalized(headSha)} reason=${reason}${suffix} -->`;
}

export function conflictEpisodeMarker({ episode, headSha, baseSha }) {
  return `${REVIEW_CONFLICT_MARKER} episode=${episode} head=${normalized(headSha)} base=${normalized(baseSha)} -->`;
}

export async function executeReviewDecision({
  decision,
  marker,
  createMarker,
  deleteMarker,
  requestReviewer,
}) {
  const markerComment = await createMarker(marker);
  if (!decision.requestReviewer) return markerComment;

  try {
    await requestReviewer();
    return markerComment;
  } catch (error) {
    const status = Number(error?.status);
    const ambiguousMutationOutcome =
      error?.markerRollbackSafe !== true &&
      (!Number.isFinite(status) ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500);
    if (ambiguousMutationOutcome) {
      throw error;
    }
    try {
      await deleteMarker(markerComment.id);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Copilot review request failed and marker ${markerComment.id} could not be rolled back`,
      );
    }
    // A 422/403 means the reviewer login itself cannot be requested (e.g. it is not a
    // collaborator on this repository) -- a deterministic, non-retryable rejection of an
    // optional mutation, not a sign the PR/reconcile state is ambiguous. The marker has
    // already been rolled back above, so swallow this failure instead of aborting the
    // caller: requesting an optional reviewer must never block reconcile's state
    // convergence, label attach, or thread reconciliation.
    if (status === 422 || status === 403) {
      process.stderr.write(
        `review-request-skipped reason=reviewer-not-requestable status=${status}\n`,
      );
      return;
    }
    throw error;
  }
}
