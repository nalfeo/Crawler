import { createHash } from 'node:crypto';

export const REVIEW_REQUEST_MARKER = '<!-- crawler-review-request:v1';
export const REVIEW_CONFLICT_MARKER = '<!-- crawler-review-conflict:v1';
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
    const match = String(comment?.body || '').trim().match(pattern);
    return match ? [project(match)] : [];
  });
}

export function reviewRequestMarkers(comments) {
  return parseTrustedComments(comments, REQUEST_PATTERN, (match) => ({
    headSha: match[1],
    reason: match[2],
    episode: match[3] || null,
  })).filter(
    (marker) =>
      (marker.reason === 'conflict-resolved') === Boolean(marker.episode),
  );
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

export function unrecordedConflictEpisode({ pr, hasMergeConflict, comments }) {
  if (!hasMergeConflict) return null;
  const headSha = normalized(pr?.head?.sha);
  const baseSha = normalized(pr?.base?.sha);
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
}) {
  if (normalized(pr?.state) !== 'open' || pr?.draft) return null;

  const headSha = normalized(pr?.head?.sha);
  const requests = reviewRequestMarkers(comments);
  if (requests.some((request) => request.headSha === headSha)) return null;

  const normalRequests = requests.filter((request) => request.reason !== 'conflict-resolved');
  if (INITIAL_TRIGGERS.has(normalized(trigger)) && normalRequests.length === 0) {
    return { reason: 'ready', episode: null, requestReviewer: false };
  }
  if (
    hasMergeConflict ||
    !requiredChecksPassing ||
    (blockers || []).length > 0 ||
    normalRequests.length === 0
  ) {
    return null;
  }

  const episodes = conflictEpisodeMarkers(comments);
  const latestEpisode = episodes.at(-1);
  if (
    latestEpisode &&
    !requests.some(
      (request) =>
        request.reason === 'conflict-resolved' &&
        request.episode === latestEpisode.episode,
    )
  ) {
    return {
      reason: 'conflict-resolved',
      episode: latestEpisode.episode,
      requestReviewer: true,
    };
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
    try {
      await deleteMarker(markerComment.id);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Copilot review request failed and marker ${markerComment.id} could not be rolled back`,
      );
    }
    throw error;
  }
}
