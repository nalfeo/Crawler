/**
 * AssetQueue — abstraction for the sprite-generation request queue.
 *
 * Producers (sidecar, CLI) call `enqueue` to request a new generation run.
 * A worker process calls `dequeue` in a loop, processes the request, and
 * calls `ack` to remove the message from the queue.
 *
 * The no-op implementation (`NoopAssetQueue`) is the default for local dev:
 * requests are logged but not persisted. Use `SPRITES_ASSET_QUEUE=azure-queue`
 * to route through Azure Storage Queue.
 */

import { SPRITE_TYPES } from '../brief-schema.js';

export interface AssetRequestBase {
  /** `brief.name` slug (e.g. `'iron-sword'`). */
  readonly requestedBy: string;
  /** ISO-8601 timestamp at which the request was submitted. */
  readonly requestedAt: string;
  /** Generation priority. Workers MAY honour this; there is no SLA. */
  readonly priority: 'normal' | 'high';
}

/** Existing queue job shape: generate from an already-authored brief YAML path. */
export interface BriefPathAssetRequest extends AssetRequestBase {
  readonly kind: 'brief-path';
  /** `brief.name` slug (e.g. `'iron-sword'`). */
  readonly briefId: string;
  /** Repo-relative path to the brief YAML (e.g. `'briefs/weapons/iron-sword.yaml'`). */
  readonly briefPath: string;
}

/** New queue job shape: generate from an `asset-request` GitHub issue. */
export interface IssueAssetRequest extends AssetRequestBase {
  readonly kind: 'issue-request';
  /** Source issue number (for comments + idempotency). */
  readonly issueNumber: number;
  /** Requested asset name from the issue contract. */
  readonly name: string;
  /** One-sentence brief from the issue contract. */
  readonly briefSentence: string;
  /** Optional sprite type from the issue contract (weapon/enemy/item/tile/vfx/character). */
  readonly type?: string;
  /** Optional dungeon floor intensity. Defaults to 1 downstream. */
  readonly floor?: number;
  /** Stable hash of normalized issue payload (`name + briefSentence`, plus `floor` when floor > 1). */
  readonly fingerprint: string;
  /** ISO-8601 timestamp when the ingester claimed/enqueued this issue payload. */
  readonly claimedAt: string;
}

/** A request to generate sprites for a specific brief or issue-originated job. */
export type AssetRequest = BriefPathAssetRequest | IssueAssetRequest;

/**
 * Back-compat parser:
 * - v2 union messages use explicit `kind`.
 * - legacy messages (pre-union) had `{ briefId, briefPath, ... }` only.
 */
export function normalizeAssetRequest(value: unknown): AssetRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const priority = v.priority === 'high' ? 'high' : v.priority === 'normal' ? 'normal' : null;
  if (typeof v.requestedBy !== 'string' || typeof v.requestedAt !== 'string' || !priority) {
    return null;
  }
  if (v.kind === 'issue-request') {
    if (
      typeof v.issueNumber !== 'number' ||
      !Number.isInteger(v.issueNumber) ||
      v.issueNumber < 1 ||
      typeof v.name !== 'string' ||
      v.name.trim() === '' ||
      typeof v.briefSentence !== 'string' ||
      v.briefSentence.trim() === '' ||
      typeof v.fingerprint !== 'string' ||
      v.fingerprint === '' ||
      typeof v.claimedAt !== 'string'
    ) {
      return null;
    }
    if (
      'floor' in v &&
      (typeof v.floor !== 'number' || !Number.isInteger(v.floor) || v.floor < 1 || v.floor > 20)
    ) {
      return null;
    }
    return {
      kind: 'issue-request',
      issueNumber: v.issueNumber,
      name: v.name,
      briefSentence: v.briefSentence,
      ...(typeof v.type === 'string' &&
      v.type.trim() !== '' &&
      (SPRITE_TYPES as readonly string[]).includes(v.type.trim().toLowerCase())
        ? { type: v.type.trim().toLowerCase() }
        : {}),
      ...(typeof v.floor === 'number' && Number.isInteger(v.floor) && v.floor >= 1 && v.floor <= 20
        ? { floor: v.floor }
        : {}),
      fingerprint: v.fingerprint,
      claimedAt: v.claimedAt,
      requestedBy: v.requestedBy,
      requestedAt: v.requestedAt,
      priority,
    };
  }
  // Legacy or explicit brief-path message.
  if (typeof v.briefId !== 'string' || typeof v.briefPath !== 'string') {
    return null;
  }
  /**
   * Free-form identifier for the requestor — agent session ID, username, or
   * process name. Used for audit logging only; not validated.
   */
  return {
    kind: 'brief-path',
    briefId: v.briefId,
    briefPath: v.briefPath,
    requestedBy: v.requestedBy,
    requestedAt: v.requestedAt,
    priority,
  };
}

/**
 * A dequeued message. Call `ack()` after successfully processing the request
 * to remove it from the queue. If `ack()` is never called (e.g. the worker
 * crashes) the message becomes visible again after the queue's visibility
 * timeout, which Azure Storage Queue handles automatically.
 */
export interface DequeuedMessage {
  readonly request: AssetRequest;
  /**
   * How many times this message has been dequeued, including the current
   * delivery. Azure Storage Queue reports this as `dequeueCount` (1 on the
   * first receive, incrementing each time the visibility timeout re-surfaces
   * an un-acked message). The worker uses it to cap retries so a
   * deterministically-failing "poison" message cannot loop forever. Queue
   * backends that cannot track redelivery should report `1`.
   */
  readonly dequeueCount: number;
  ack(): Promise<void>;
}

export interface AssetQueue {
  /** Add a generation request to the tail of the queue. */
  enqueue(request: AssetRequest): Promise<void>;
  /**
   * Fetch the next available message.
   * Returns `null` when the queue is empty.
   * The message is invisible to other consumers until `ack()` is called or
   * the visibility timeout expires.
   */
  dequeue(): Promise<DequeuedMessage | null>;
  /**
   * Peek at up to `maxCount` messages (default 1) without making them
   * invisible. Useful for dashboards; not safe for processing (no ack).
   */
  peek(maxCount?: number): Promise<readonly AssetRequest[]>;
  /** Human-readable backend tag surfaced in /api/health. */
  readonly backend: 'noop' | 'azure-queue';
}
