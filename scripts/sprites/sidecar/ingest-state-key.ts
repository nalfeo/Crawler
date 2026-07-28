/**
 * Blob-store key for the asset-request ingest ledger — the read-modify-write
 * document tracking which issues have been claimed or rejected (see
 * `scripts/sprites/sidecar/issue-ingester-controller.ts`).
 *
 * Lives in its own dependency-free module so the cache policy
 * (`scripts/sprites/store/cache-policy.ts`) can classify it as a mutable
 * coordination document without importing the ingester controller, which
 * would create an import cycle through `store/types.js`.
 * `issue-ingester-controller.ts` re-exports this constant.
 */
export const INGEST_STATE_KEY = 'workflow-state/asset-request-ingest.json';
