export const REVIEW_REQUEST_MARKER = '<!-- crawler-review-request:v1';
export const REVIEWER_LOGIN = 'copilot-pull-request-reviewer';

function normalized(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function reviewRequestMarkers(comments) {
  return (comments || [])
    .map((comment) => String(comment?.body || ''))
    .filter((body) => body.trimStart().startsWith(REVIEW_REQUEST_MARKER));
}

function checksPass(checkRuns) {
  return (
    Array.isArray(checkRuns) &&
    checkRuns.length > 0 &&
    checkRuns.every(
      (check) =>
        normalized(check?.status) === 'completed' && normalized(check?.conclusion) === 'success',
    )
  );
}

export function shouldRequestReview({ trigger, pr, checkRuns, blockers, comments, previousState }) {
  if (normalized(pr?.state) !== 'open' || pr?.draft) return null;
  if (reviewRequestMarkers(comments).some((body) => body.includes(`head=${pr?.head?.sha}`))) {
    return null;
  }

  const triggerText = normalized(trigger);
  const ready =
    triggerText.endsWith(':ready_for_review') ||
    triggerText.endsWith(':opened') ||
    triggerText.endsWith(':reopened');
  const conflictResolved =
    triggerText.endsWith(':synchronize') &&
    normalized(pr?.mergeable_state) === 'clean' &&
    (blockers || []).length === 0 &&
    Array.isArray(previousState?.blockers) &&
    previousState.blockers.some((blocker) => blocker?.kind === 'merge-conflict');
  const passingSynchronize =
    triggerText.endsWith(':synchronize') && checksPass(checkRuns) && (blockers || []).length === 0;

  if (!ready && !conflictResolved && !passingSynchronize) return null;

  const synchronizeRequests = reviewRequestMarkers(comments).filter((body) =>
    body.includes('reason=synchronize'),
  ).length;
  if (passingSynchronize && !conflictResolved && synchronizeRequests >= 2) return null;

  return ready ? 'ready' : conflictResolved ? 'conflict-resolved' : 'synchronize';
}

export function reviewRequestMarker({ headSha, reason }) {
  return `${REVIEW_REQUEST_MARKER} head=${headSha} reason=${reason} -->`;
}
