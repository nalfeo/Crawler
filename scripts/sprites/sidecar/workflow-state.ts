/**
 * Pure helpers for the sidecar's durable workflow-state endpoints.
 *
 * The DevTools sprite-generation workflow keeps its queue (briefs, stages,
 * chosen candidate paths, candidate YAML, approval pointers) in the browser.
 * That state is wiped by worktree checkpoints, so we mirror it into the
 * `RunStore` (Azure Blob in production, local fs in tests) under a single
 * blob key. The sidecar owns the source of truth; the browser keeps a cache.
 *
 * Everything here is pure and storage-agnostic so it can be unit-tested in
 * isolation from Fastify and from the Azure SDK. The HTTP wiring lives in
 * `server.ts`; the durability semantics (key, ETag, (de)serialisation,
 * precondition checks) live here.
 *
 * ETag model
 * ----------
 * The ETag is a content hash (`sha256` hex) of the exact bytes we store, NOT
 * the Azure blob's native ETag. A content hash is identical across the local
 * and Azure backends, needs no change to the `RunStore` interface, and is
 * trivially unit-testable. Because clients only ever echo back an ETag the
 * sidecar previously issued, the client and server never need to agree on a
 * canonical serialisation independently.
 */

import { createHash } from 'node:crypto';

/** Single global blob key for the workflow queue. Reuses `generated-runs`. */
export const WORKFLOW_STATE_KEY = 'workflow-state/queue.json';

/**
 * Key prefix under which draft/candidate brief YAML is mirrored into the store
 * so promote + generate can re-materialise a brief that a worktree checkpoint
 * wiped from the local `briefs/draft/…` tree (which is fully gitignored).
 */
export const WORKFLOW_BRIEFS_PREFIX = 'workflow-state/briefs/';

/**
 * Map a repo-relative POSIX path (e.g. `briefs/draft/items/foo/foo-v1.yaml`)
 * to its mirror key in the store. The full repo-relative path is preserved so
 * the mapping is unambiguous and reversible.
 */
export function workflowBriefKey(repoRelativePath: string): string {
  return `${WORKFLOW_BRIEFS_PREFIX}${repoRelativePath}`;
}

/** Result of reading the persisted state back out of the store. */
export interface WorkflowStateEnvelope {
  /** Parsed workflow state, or `null` when absent/unparseable. */
  readonly state: unknown;
}

/**
 * Compute the content-hash ETag for a set of stored bytes.
 *
 * Deterministic and order-sensitive: identical bytes always yield the same
 * hash, and any difference (including key reordering in the underlying JSON)
 * yields a different hash.
 */
export function computeStateEtag(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Serialise workflow state to the canonical bytes we persist. `undefined`
 * normalises to `null` so the stored document is always valid JSON.
 */
export function serializeWorkflowState(state: unknown): Buffer {
  return Buffer.from(JSON.stringify(state ?? null), 'utf8');
}

/**
 * Parse persisted bytes back into an envelope. Never throws: malformed or
 * truncated JSON (e.g. an interrupted write) surfaces as `{ state: null }`
 * so the caller can decide whether to overwrite.
 */
export function parseWorkflowState(bytes: Buffer): WorkflowStateEnvelope {
  try {
    return { state: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { state: null };
  }
}

/**
 * Optimistic-concurrency precondition for `PUT /api/workflow/state`.
 *
 * Returns `true` when the write MUST be rejected as a conflict:
 *   - `If-Match` absent/empty → unconditional write, never rejected.
 *   - `If-Match: *`           → requires the resource to already exist.
 *   - any other value         → must equal the current ETag exactly.
 *
 * `currentEtag` is `null` when no state has been stored yet.
 */
export function etagPreconditionFails(
  ifMatch: string | undefined | null,
  currentEtag: string | null,
): boolean {
  if (ifMatch == null || ifMatch === '') return false;
  if (ifMatch === '*') return currentEtag === null;
  return ifMatch !== currentEtag;
}

/**
 * Create-only precondition for `PUT /api/workflow/state`.
 *
 * A client that has never seen any state has no ETag to send, so an
 * `If-Match`-only contract would let two first writers silently overwrite each
 * other. `If-None-Match: *` closes that hole:
 *   - absent/empty     → no create-only requirement, never rejected.
 *   - `*`              → requires the resource to NOT exist yet.
 *   - any other value  → standard HTTP: rejected when it equals the current ETag.
 */
export function ifNoneMatchPreconditionFails(
  ifNoneMatch: string | undefined | null,
  currentEtag: string | null,
): boolean {
  if (ifNoneMatch == null || ifNoneMatch === '') return false;
  if (ifNoneMatch === '*') return currentEtag !== null;
  return ifNoneMatch === currentEtag;
}

/** True when the caller asked for create-only (`If-None-Match: *`) semantics. */
export function isCreateOnlyWrite(ifNoneMatch: string | undefined | null): boolean {
  return ifNoneMatch === '*';
}
