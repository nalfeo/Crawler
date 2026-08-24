/**
 * markers.mjs — Single source of truth for all managed-comment marker strings.
 *
 * Every managed HTML comment written to GitHub PRs/issues by the CI-recovery
 * and merge-train automation MUST be defined here.
 *
 * Naming invariant: every marker string MUST start with '<!-- crawler-'.
 * This lets the ci-recovery-router YAML filter use a single prefix match
 * instead of listing every marker individually, making a new marker a
 * one-file edit: add it here and the YAML filter covers it automatically.
 *
 * Import map:
 *   ci-recovery scripts        → import from './markers.mjs'
 *   merge-train scripts        → import from '../ci-recovery/markers.mjs'
 *   ci-conflict-coordinator    → import from '../ci-recovery/markers.mjs'
 */

// ---------------------------------------------------------------------------
// CI-recovery state comment
// ---------------------------------------------------------------------------

/** Leading marker for the authoritative CI-recovery state comment on a PR. */
export const STATE_MARKER = '<!-- crawler-ci-state:v1 -->';

/** Inline data prefix embedded in CI-recovery state comments. */
export const STATE_DATA_PREFIX = '<!-- crawler-ci-state-data:';

// ---------------------------------------------------------------------------
// CI-recovery task comment
// ---------------------------------------------------------------------------

/**
 * Leading prefix for Copilot task comments posted by the reconciler.
 * Note: the full comment format is `<!-- crawler-ci-task:v1 fingerprint=<hex> -->`;
 * use TASK_COMMENT_MARKER as the prefix to detect these comments.
 */
export const TASK_COMMENT_MARKER = '<!-- crawler-ci-task:v1';

/** Leading marker for repository-level CI incident issues. */
export const CI_INCIDENT_MARKER = '<!-- crawler-ci-incident:v1 -->';

// ---------------------------------------------------------------------------
// Merge-train status comments
// ---------------------------------------------------------------------------

/** Leading marker for merge-train queue-status comments on a PR. */
export const MERGE_TRAIN_STATUS_MARKER = '<!-- crawler-merge-train:v1 -->';

/** Leading marker for the durable landed-completion comment on a PR. */
export const MERGE_TRAIN_LANDED_MARKER = '<!-- crawler-merge-train-landed:v1 -->';

/** Leading marker for merge-train empty-queue incident issues. */
export const MERGE_TRAIN_EMPTY_INCIDENT_MARKER = '<!-- crawler-merge-train-empty-incident:v1 -->';

// ---------------------------------------------------------------------------
// Review-request / conflict comments
// ---------------------------------------------------------------------------

/**
 * Leading prefix for review-request comments.
 * Full format: `<!-- crawler-review-request:v1 head=<sha> reason=<reason> ... -->`.
 */
export const REVIEW_REQUEST_MARKER = '<!-- crawler-review-request:v1';

/**
 * Leading prefix for review-conflict-episode comments.
 * Full format: `<!-- crawler-review-conflict:v1 episode=<hash> head=<sha> base=<sha> -->`.
 */
export const REVIEW_CONFLICT_MARKER = '<!-- crawler-review-conflict:v1';

// ---------------------------------------------------------------------------
// PR-lifecycle comment
// ---------------------------------------------------------------------------

/** Leading marker for the authoritative PR-lifecycle state comment. */
export const LIFECYCLE_MARKER = '<!-- crawler-pr-lifecycle:v1 -->';

/** Inline data prefix embedded in PR-lifecycle comments. */
export const LIFECYCLE_DATA_PREFIX = '<!-- crawler-pr-lifecycle-data:';

// ---------------------------------------------------------------------------
// Issue-intake / recovery-plan comments
// ---------------------------------------------------------------------------

/** Leading marker for issue-intake status comments. */
export const ISSUE_INTAKE_MARKER = '<!-- crawler-issue-intake:v1 -->';

/**
 * Leading marker for retroactive CI-recovery plan comments posted by the
 * reconciler when a linked issue has an intake requirement but no plan comment
 * exists yet. Used as an idempotency key.
 */
export const ISSUE_RECOVERY_PLAN_MARKER = '<!-- crawler-ci-recovery-plan:v1 -->';

/**
 * Leading prefix for CI-recovery-created follow-up backlog issues. Full format:
 * `<!-- crawler-ci-followup-backlog:v1 sourceIssue=<n> pr=<n> thread=<id> -->`.
 */
export const FOLLOWUP_BACKLOG_MARKER = '<!-- crawler-ci-followup-backlog:v1';

// ---------------------------------------------------------------------------
// CI-conflict-coordinator comment
// ---------------------------------------------------------------------------

/** Leading marker for CI-conflict-coordinator status comments on a PR. */
export const COORDINATOR_MARKER = '<!-- crawler-ci-conflict-coordinator:v1 -->';

/** Inline data prefix embedded in coordinator comments. */
export const COORDINATOR_DATA_PREFIX = '<!-- crawler-ci-conflict-coordinator-data:';

// ---------------------------------------------------------------------------
// PR loop-incident issue markers
// ---------------------------------------------------------------------------

/** Leading marker for PR recovery loop-incident issues. */
export const LOOP_INCIDENT_MARKER = '<!-- crawler-pr-loop-incident:v1 -->';

/** Inline data prefix embedded in PR recovery loop-incident issues. */
export const LOOP_INCIDENT_FINGERPRINT_PREFIX = '<!-- crawler-pr-loop-fingerprint:';

// ---------------------------------------------------------------------------
// Already-landed detection comments
// ---------------------------------------------------------------------------

/**
 * Leading marker for already-landed detection comments posted on a PR.
 * Posted when all (or some) of a PR's changed files are detected to be
 * byte-identical to the content already on `main`.
 */
export const ALREADY_LANDED_COMMENT_MARKER = '<!-- crawler-ci-already-landed:v1 -->';

// ---------------------------------------------------------------------------
// Stale stacked-base recovery comments
// ---------------------------------------------------------------------------

/** Leading marker for CI Recovery's automatic stale-base retarget explanation. */
export const STALE_BASE_RETARGET_MARKER = '<!-- crawler-ci-stale-base-retarget:v1';

// ---------------------------------------------------------------------------
// Epic-create issue markers
// ---------------------------------------------------------------------------

/** Leading prefix for epic-create human-review issues. */
export const EPIC_REVIEW_MARKER_PREFIX = '<!-- crawler-epic-review:';

/** Leading prefix for epic-create materialized node issues. */
export const EPIC_NODE_MARKER_PREFIX = '<!-- crawler-epic-node:';

export function epicReviewMarker(epicId, hash) {
  return `${EPIC_REVIEW_MARKER_PREFIX}${epicId}:${hash} -->`;
}

export function epicNodeMarker(epicId, hash, nodeId) {
  return `${EPIC_NODE_MARKER_PREFIX}${epicId}:${hash}:${nodeId} -->`;
}

// ---------------------------------------------------------------------------
// Shared prefix & router filter list
// ---------------------------------------------------------------------------

/**
 * All managed-comment markers share this HTML-comment prefix.
 * The ci-recovery-router YAML `if:` filter uses a single `startsWith` check
 * against this prefix to suppress bot-to-bot comment loops, so new markers
 * are automatically covered without editing the workflow file.
 */
export const MANAGED_COMMENT_PREFIX = '<!-- crawler-';

/**
 * Explicit inventory of every exported managed marker/prefix string. When a new
 * managed marker is added above, update this array in the same file; tests
 * verify the inventory covers every exported string that shares the managed
 * comment prefix.
 *
 * Used by tests. The YAML-level filter and `isManagedCommentEvent()` in router.mjs
 * both use `MANAGED_COMMENT_PREFIX` (the shared prefix) instead of iterating this
 * array, so routing stays a one-file edit.
 */
export const MANAGED_COMMENT_MARKERS = [
  STATE_MARKER,
  TASK_COMMENT_MARKER,
  CI_INCIDENT_MARKER,
  STATE_DATA_PREFIX,
  MERGE_TRAIN_STATUS_MARKER,
  MERGE_TRAIN_LANDED_MARKER,
  MERGE_TRAIN_EMPTY_INCIDENT_MARKER,
  REVIEW_REQUEST_MARKER,
  REVIEW_CONFLICT_MARKER,
  LIFECYCLE_MARKER,
  LIFECYCLE_DATA_PREFIX,
  COORDINATOR_MARKER,
  COORDINATOR_DATA_PREFIX,
  ISSUE_INTAKE_MARKER,
  ISSUE_RECOVERY_PLAN_MARKER,
  FOLLOWUP_BACKLOG_MARKER,
  LOOP_INCIDENT_MARKER,
  LOOP_INCIDENT_FINGERPRINT_PREFIX,
  ALREADY_LANDED_COMMENT_MARKER,
  STALE_BASE_RETARGET_MARKER,
  EPIC_REVIEW_MARKER_PREFIX,
  EPIC_NODE_MARKER_PREFIX,
];
