/**
 * Blob-store key prefix the sprite worker pipeline uses to write per-issue
 * checkpoint/status docs (see `scripts/sprites/issue-pipeline-checkpoint.ts`).
 *
 * Lives in its own module (no imports) so both the checkpoint controller and
 * the issue ingester can depend on it without creating a circular import
 * between those two modules. `issue-ingester-controller.ts` re-exports this
 * constant for backward-compatible imports.
 */
export const ISSUE_STATUS_KEY_PREFIX = 'workflow-state/asset-request-jobs';
