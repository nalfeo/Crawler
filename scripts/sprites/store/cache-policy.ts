/**
 * Cacheability policy for {@link CachingRunStore}.
 *
 * Why this module exists
 * ----------------------
 * The shared cache in front of Azure is an **indefinitely persistent,
 * cross-session, per-machine** cache with NO remote revalidation on a hit
 * (`CachingRunStore.get` returns cached bytes directly). Its coherence
 * protocol — a per-key mutation token plus a global list epoch — is written
 * to the local cache directory, so it can only ever observe writers on THIS
 * machine. A writer somewhere else (most importantly a GitHub Actions runner
 * executing the same pipeline) can never invalidate a local entry.
 *
 * That is safe for artifacts, whose bytes are only ever consumed as content.
 * It is NOT safe for a *coordination document*: a small, mutable JSON blob
 * whose current value drives a correctness decision — an optimistic-locking
 * revision, an ETag, or a claim. Serving a stale copy of one of those does
 * not merely show old data, it makes the caller compute the WRONG decision
 * from it.
 *
 * This was not hypothetical. `theme-sets/<id>/state.json` was cached like an
 * artifact, so a local machine pinned revision 40 while CI had advanced the
 * authoritative blob to revision 59. Every local read was permanently stale,
 * and `saveThemeEquipmentSetState`'s check-then-write fallback validated its
 * `expectedRevision` against that same stale cache — concluding "no conflict"
 * and standing ready to overwrite CI's work with no error raised.
 *
 * Policy
 * ------
 * Coordination documents are **never cacheable**; everything else is. The
 * registry below is the single place that distinction is expressed, so adding
 * a new mutable coordination document is a one-line change next to its
 * siblings instead of a defect discovered months later.
 *
 * Deliberately still cacheable (audited, not overlooked)
 * -----------------------------------------------------
 * Two key families are mutable but remain cacheable on purpose:
 *
 *  - `<briefId>/<runId>/summary.json` — rewritten by reruns and issue-metadata
 *    attachment.
 *  - `workflow-state/briefs/<path>` — durable brief mirrors can be rewritten
 *    under the same key.
 *
 * Neither is read to make a locking/claim decision; they are content that a
 * same-machine `put()` already invalidates and republishes coherently. They
 * are also exactly the bytes the gallery and offline mode depend on being
 * warm, and offline mode serves reads ONLY from the cache — marking them
 * non-cacheable would make them unreadable with `CRAWLER_AZURE_OFFLINE=1`.
 * The residual risk is bounded: a cross-machine rewrite shows one generation
 * late in a read-only view, which is not a correctness failure.
 */

import { WORKFLOW_STATE_KEY } from '../sidecar/workflow-state.js';
import { ISSUE_STATUS_KEY_PREFIX } from '../sidecar/issue-status-key.js';
import { INGEST_STATE_KEY } from '../sidecar/ingest-state-key.js';

/**
 * Durable state for one theme equipment set — `theme-sets/<setId>/state.json`.
 *
 * Anchored so it matches ONLY the state document. Sibling artifacts under
 * `theme-sets/<setId>/artifacts/**` (brief YAML, sprite sheets) are immutable
 * content and stay cacheable.
 */
const THEME_SET_STATE_KEY_PATTERN = /^theme-sets\/[^/]+\/state\.json$/;

/**
 * Predicates identifying mutable coordination documents. Each entry names the
 * document and why its cached value would drive a wrong decision.
 */
const COORDINATION_KEY_PREDICATES: readonly ((key: string) => boolean)[] = [
  // Sidecar workflow queue: read-modify-write under an ETag-derived token.
  (key) => key === WORKFLOW_STATE_KEY,
  // Theme equipment set state: carries `stateRevision`, the optimistic-locking
  // token compared by `saveThemeEquipmentSetState`.
  (key) => THEME_SET_STATE_KEY_PATTERN.test(key),
  // Asset-request ingest ledger: read-modify-write of claims and rejections.
  (key) => key === INGEST_STATE_KEY,
  // Per-issue pipeline checkpoints: rewritten before and after every stage,
  // then read back to decide whether a stage may be skipped or resumed.
  (key) => key.startsWith(`${ISSUE_STATUS_KEY_PREFIX}/`),
];

/**
 * True when `key` is a mutable coordination document whose cached value could
 * drive an incorrect locking, claim, or resume decision.
 */
export function isCoordinationKey(key: string): boolean {
  return COORDINATION_KEY_PREDICATES.some((matches) => matches(key));
}

/**
 * Default cacheability predicate: cache everything EXCEPT mutable coordination
 * documents (see {@link isCoordinationKey}).
 */
export function isCacheableKey(key: string): boolean {
  return !isCoordinationKey(key);
}
