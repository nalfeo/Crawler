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
// Lifecycle-ownership lease comment
// ---------------------------------------------------------------------------

/** Leading marker for the authoritative lifecycle-ownership lease comment. */
export const LIFECYCLE_LEASE_MARKER = '<!-- crawler-lifecycle-lease:v1 -->';

/** Inline data prefix embedded in lifecycle-ownership lease comments. */
export const LIFECYCLE_LEASE_DATA_PREFIX = '<!-- crawler-lifecycle-lease-data:';

// ---------------------------------------------------------------------------
// Issue-intake / recovery-plan comments
// ---------------------------------------------------------------------------

/** Leading marker for issue-intake status comments. */
export const ISSUE_INTAKE_MARKER = '<!-- crawler-issue-intake:v1 -->';

/** Leading marker for recurring release baseline regression comments. */
export const BASELINE_RECURRENCE_MARKER = '<!-- crawler-baseline-recurrence:v1 -->';

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
// Quarantine-repair (merge-train) notice comment
// ---------------------------------------------------------------------------

/**
 * Leading prefix for the quarantine-repair supersede-notice comment that
 * `merge-train/quarantine-repair.mjs` posts on the ORIGINAL quarantined PR
 * once a writable replacement PR exists for it. Full format:
 * `<!-- crawler-quarantine-repair-notice:v1 replacement=<prNumber> -->`.
 *
 * This MUST be the first thing written in the comment body (see
 * `buildSupersedeNoticeBody`), not merely present somewhere inside it: the
 * `ci-recovery-router` workflow's job-level `if:` filters `issue_comment`
 * events by `startsWith(comment.body, MANAGED_COMMENT_PREFIX)`, and a marker
 * that isn't the leading text does not satisfy `startsWith` -- which would
 * otherwise let this automation's own notice comment trigger an unnecessary
 * CI-recovery run every time a repair notice is posted.
 */
export const QUARANTINE_REPAIR_NOTICE_MARKER_PREFIX = '<!-- crawler-quarantine-repair-notice:v1';
export const LEGACY_QUARANTINE_REPAIR_NOTICE_MARKER_PREFIX =
  '<!-- crawler-quarantine-repair-notice:';

export function quarantineRepairNoticeMarker(replacementPrNumber) {
  return `${QUARANTINE_REPAIR_NOTICE_MARKER_PREFIX} replacement=${replacementPrNumber} -->`;
}

export function hasQuarantineRepairNoticeMarker(body, replacementPrNumber) {
  const expected = quarantineRepairNoticeMarker(replacementPrNumber);
  if (String(body || '').includes(expected)) return true;
  return String(body || '').includes(
    `${LEGACY_QUARANTINE_REPAIR_NOTICE_MARKER_PREFIX}${replacementPrNumber} -->`,
  );
}

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

/**
 * Leading prefix for the epic-create summary comment posted on the pull
 * request that introduced a `*.epic.json` file, listing the issue numbers it
 * produced. Full format:
 * `<!-- crawler-epic-issues:<epicId>:<hash>:<issue numbers> -->`.
 *
 * The issue-number set is part of the marker so the review-only phase and the
 * later materialized-nodes phase each post exactly one comment, while repeated
 * (hourly/dispatch) runs that produce the same set never post a duplicate.
 */
export const EPIC_ISSUES_COMMENT_MARKER_PREFIX = '<!-- crawler-epic-issues:';

export function epicIssuesCommentMarker(epicId, hash, issueNumbers) {
  return `${EPIC_ISSUES_COMMENT_MARKER_PREFIX}${epicId}:${hash}:${[...issueNumbers].join(',')} -->`;
}

// ---------------------------------------------------------------------------
// Goobers lifecycle-progress comments
// ---------------------------------------------------------------------------

/**
 * Leading prefix for the Goobers run-start comment posted on an approved
 * issue when `.github/workflows/goobers-run.yml` claims it. Full format:
 * `<!-- crawler-goobers-run-start:v1 run-id=<id> workflow=<name> -->`.
 *
 * This MUST be the first line of the comment body, not merely present
 * somewhere inside it: `ci-recovery-router.yml`'s `issue_comment` job filters
 * with `startsWith(comment.body, MANAGED_COMMENT_PREFIX)`, and a marker that
 * isn't the leading text does not satisfy `startsWith`.
 */
export const GOOBERS_RUN_START_MARKER_PREFIX = '<!-- crawler-goobers-run-start:v1';

/**
 * Leading prefix for the Goobers run-result comment posted once a claimed
 * run finishes. Full format:
 * `<!-- crawler-goobers-run-result:v1 run-id=<id> attempt=<n> lane=<n> slot=<n> goobers-run=<id> workflow=<name> -->`.
 * Same leading-line requirement as `GOOBERS_RUN_START_MARKER_PREFIX`.
 *
 * The key is per lane/slot/Goobers-run because up to four runs share one
 * Actions run id, and per ATTEMPT because each attempt uploads its own journal
 * artifact and this comment names that artifact by name.
 *
 * NOTE: this comment's body embeds Goobers journal text, which is written by
 * the agent under test rather than by the workflow. `goobers-run.yml` collapses
 * embedded newlines out of that text before rendering it, so a journal message
 * can never own a line of an Actions-authored comment — see the reservation
 * receipt markers below for why that matters.
 */
export const GOOBERS_RUN_RESULT_MARKER_PREFIX = '<!-- crawler-goobers-run-result:v1';

/**
 * Leading prefix for the reservation ADOPTION receipt that
 * `.github/workflows/goobers-run.yml`'s recovery lane posts on the reserved
 * issue before it takes ownership of `goobers/status:in-review`. Full format:
 * `<!-- crawler-goobers-reservation-adopted:v1 run-id=<id> attempt=<n> issue=<n> -->`.
 *
 * This receipt is the deterministic evidence `release-unstarted-reservation`
 * reads: its ABSENCE proves no lane ever adopted the reservation (the receipt
 * is written before the adopting lane exports any recovery metadata, so a lane
 * that failed to write it never ran a slot), which is the only state in which
 * that job may remove the reservation label. It is also the DURABLE lease a
 * later dispatch reads before re-adopting the issue at all, because an Actions
 * run can report `completed` while a session-detached stage is still pushing.
 *
 * `attempt` is part of the lease key, not decoration: re-running a failed
 * Actions run keeps the same run id, so without it a re-run's adoption would
 * be closed by the previous attempt's disposal.
 *
 * Parsing is exact and author-checked in
 * `scripts/agent/goobers-reservation-lease.sh` — a whole-line match on a
 * comment written by the GitHub Actions identity — because issue comments are
 * public and this text is predictable. Same leading-line requirement as
 * `GOOBERS_RUN_START_MARKER_PREFIX`.
 */
export const GOOBERS_RESERVATION_ADOPTED_MARKER_PREFIX =
  '<!-- crawler-goobers-reservation-adopted:v1';

/**
 * Leading prefix for the reservation DISPOSAL receipt, appended into the same
 * comment body once the adopting lane has proved both that its stage tree was
 * reaped and that its run disposition was applied. Full format:
 * `<!-- crawler-goobers-reservation-disposed:v1 run-id=<id> attempt=<n> issue=<n> -->`.
 *
 * A disposal closes only the lease whose run id AND attempt it names, and only
 * when it lives in THAT ADOPTION'S OWN COMMENT BODY. Trusted authorship alone is
 * not sufficient: `goobers-run.yml` posts other Actions-authored comments that
 * embed free-form Goobers journal text, so a disposal accepted from any trusted
 * comment could be injected through a stage error message and would close a live
 * lease. Both writers resolve the receipt comment through the same reader the
 * guards use, so the comment a disposal is written into is by construction the
 * comment a later read sees it in.
 *
 * Adopted-without-disposed is the "a descendant may still be live" state:
 * `release-unstarted-reservation` refuses to remove the reservation label in
 * that case, and the next dispatch refuses to select the issue at all, rather
 * than handing a possibly still-running issue to a second agent. It is
 * deliberately not the leading line of the comment (the adoption marker keeps
 * that position for the router's `startsWith` filter).
 */
export const GOOBERS_RESERVATION_DISPOSED_MARKER_PREFIX =
  '<!-- crawler-goobers-reservation-disposed:v1';

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
  LIFECYCLE_LEASE_MARKER,
  LIFECYCLE_LEASE_DATA_PREFIX,
  COORDINATOR_MARKER,
  COORDINATOR_DATA_PREFIX,
  ISSUE_INTAKE_MARKER,
  BASELINE_RECURRENCE_MARKER,
  ISSUE_RECOVERY_PLAN_MARKER,
  FOLLOWUP_BACKLOG_MARKER,
  LOOP_INCIDENT_MARKER,
  LOOP_INCIDENT_FINGERPRINT_PREFIX,
  ALREADY_LANDED_COMMENT_MARKER,
  STALE_BASE_RETARGET_MARKER,
  QUARANTINE_REPAIR_NOTICE_MARKER_PREFIX,
  LEGACY_QUARANTINE_REPAIR_NOTICE_MARKER_PREFIX,
  EPIC_REVIEW_MARKER_PREFIX,
  EPIC_NODE_MARKER_PREFIX,
  EPIC_ISSUES_COMMENT_MARKER_PREFIX,
  GOOBERS_RUN_START_MARKER_PREFIX,
  GOOBERS_RUN_RESULT_MARKER_PREFIX,
  GOOBERS_RESERVATION_ADOPTED_MARKER_PREFIX,
  GOOBERS_RESERVATION_DISPOSED_MARKER_PREFIX,
];
