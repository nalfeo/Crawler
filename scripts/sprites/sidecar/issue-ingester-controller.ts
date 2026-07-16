import { parseAssetRequestIssueBody, type ParsedAssetRequestIssue } from '../asset-request.js';
import type { AssetQueue, IssueAssetRequest } from '../queue/types.js';
import { isSizeVariant, type SizeVariant } from '../size-variants.js';
import type { RunStore } from '../store/types.js';
import type { AssetRequestIssueApi, OpenAssetRequestIssue } from './asset-request-issue-api.js';

const INGEST_STATE_KEY = 'workflow-state/asset-request-ingest.json';

/**
 * Blob-store key prefix the sprite worker pipeline uses to write per-issue
 * status docs (see `scripts/sprites/issue-pipeline.ts`). Exported here so the
 * ingester's stale-claim TTL check can find them, and so tests + the CLI can
 * pin against the same constant.
 */
export const ISSUE_STATUS_KEY_PREFIX = 'workflow-state/asset-request-jobs';

export async function isIssueRequestRejectedIngestState(
  store: RunStore,
  issueNumber: number,
  fingerprint: string,
): Promise<boolean> {
  const key = `${issueNumber}:${fingerprint}`;
  if (!(await store.has(INGEST_STATE_KEY))) return false;
  try {
    const parsed = JSON.parse((await store.get(INGEST_STATE_KEY)).toString('utf8')) as {
      rejected?: unknown;
    };
    const rejected =
      parsed && typeof parsed === 'object' && parsed.rejected && typeof parsed.rejected === 'object'
        ? parsed.rejected
        : null;
    if (!rejected) return false;
    return Object.prototype.hasOwnProperty.call(rejected, key);
  } catch {
    return false;
  }
}

interface IngestState {
  readonly version: 2;
  readonly claims: Record<
    string,
    {
      issueNumber: number;
      fingerprint: string;
      claimedAt: string;
      name: string;
      briefSentence: string;
      sizeVariant?: SizeVariant;
    }
  >;
  readonly rejected: Record<
    string,
    {
      issueNumber: number;
      fingerprint: string;
      rejectedAt: string;
      reason: string | null;
      name: string;
      briefSentence: string;
      sizeVariant?: SizeVariant;
    }
  >;
}

type LegacyStateComparableRequest = Pick<
  ParsedAssetRequestIssue,
  'name' | 'briefSentence' | 'sizeVariant' | 'fingerprint' | 'legacyFingerprint'
>;

export interface IssueIngesterStatus {
  readonly running: boolean;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly lastPollAt: string | null;
  readonly lastError: string | null;
  readonly enqueued: number;
  readonly skippedDuplicate: number;
  /**
   * Count of stale claims dropped this session, allowing the issue to be
   * re-enqueued the same pass. Populated only when `staleClaimTtlMs` is set on
   * the controller. See `CreateIssueIngesterOptions.staleClaimTtlMs`.
   */
  readonly reclaimedStale: number;
  /**
   * Count of enqueue-time comments the ingester posted to the source issue in
   * this session (see `CreateIssueIngesterOptions.postEnqueueComment`).
   * Independent of `enqueued` because comment posting can fail (e.g. `gh` 403)
   * without failing the enqueue itself.
   */
  readonly enqueueCommentsPosted: number;
  /**
   * Count of enqueue-time comment posts that FAILED this session. Tracked
   * separately from `lastError` on purpose: a best-effort notification failure
   * must NOT fail the ingest step (the enqueue + claim are already committed
   * and the drain worker must still run), so it must never flow into
   * `exitCodeForStatus` via `lastError`. See the enqueue-comment loop below.
   */
  readonly enqueueCommentErrors: number;
  /**
   * Most recent enqueue-comment failure message this session, or `null` if
   * none. Purely diagnostic — surfaced in the CLI status JSON so a comment
   * failure stays visible in CI logs without being fatal.
   */
  readonly lastEnqueueCommentError: string | null;
}

export interface IssueIngesterController {
  start(): { readonly started: boolean; readonly status: IssueIngesterStatus };
  stop(): Promise<IssueIngesterStatus>;
  status(): IssueIngesterStatus;
  /**
   * Run a single ingest poll and resolve once it completes. Unlike {@link start},
   * this does NOT arm the background timer — callers use it for one-shot CI runs
   * where they need to await ingestion (so `process.exit` doesn't cut off an
   * in-flight enqueue / state save). Safe to call when the background loop is
   * not running; the underlying poll uses the same state lock, so a caller that
   * accidentally interleaves it with a running loop won't corrupt state.
   */
  pollOnce(): Promise<IssueIngesterStatus>;
  listRequests(
    state?: 'all' | 'pending' | 'claimed' | 'rejected',
  ): Promise<readonly AssetRequestManifestEntry[]>;
  rejectRequest(input: {
    issueNumber: number;
    fingerprint: string;
    reason?: string;
  }): Promise<AssetRequestManifestEntry | null>;
}

export interface AssetRequestManifestEntry {
  readonly key: string;
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly name: string;
  readonly briefSentence: string;
  readonly sizeVariant?: SizeVariant;
  readonly state: 'pending' | 'claimed' | 'rejected';
  readonly claimedAt: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly isOpen: boolean;
}

export interface EnqueueCommentContext {
  readonly issueNumber: number;
  readonly name: string;
  readonly briefSentence: string;
  readonly sizeVariant?: SizeVariant;
  readonly fingerprint: string;
  readonly claimedAt: string;
  /** True iff a prior stale claim was dropped and this is a re-enqueue. */
  readonly reclaimed: boolean;
}

export interface CreateIssueIngesterOptions {
  readonly queue: AssetQueue;
  readonly store: RunStore;
  readonly issues: AssetRequestIssueApi;
  readonly requestedBy: string;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  /**
   * When set, `pollOnce` fetches this specific issue by number via
   * {@link AssetRequestIssueApi.getIssue} in addition to running the normal
   * sweep. This is how the CI workflow bypasses the GraphQL search-indexing
   * lag on the issue that actually triggered the run — REST fetch-by-id is
   * immediately consistent, whereas `gh issue list --label` (search-backed)
   * can miss issues filed within the last ~1–2 minutes.
   *
   * Setting this to a rejected/completed/duplicate issue is a no-op — the
   * sweep-side dedup still applies.
   */
  readonly targetIssueNumber?: number;
  /**
   * When set and a claim's `claimedAt` is older than this many milliseconds,
   * the claim is treated as stale and dropped IFF the pipeline never wrote a
   * `completed` status doc for that issueNumber+fingerprint. Dropping the
   * claim lets `pollOnce` re-enqueue the request in the same pass so a stuck
   * or crashed worker doesn't leave an issue in limbo forever.
   *
   * Skipped when unset — preserves the strictly-monotonic dedup semantics
   * that local dev + the historical sidecar rely on. CI sets this to the
   * expected worst-case pipeline duration (e.g. 45 min).
   *
   * Callers should also provide `issueStatusPrefix` so the ingester knows
   * where the pipeline writes its status doc. If missing, the TTL check
   * degrades to "no status doc = stale after TTL" which is still safe (the
   * pipeline updates the doc on every stage transition) but slightly more
   * aggressive.
   */
  readonly staleClaimTtlMs?: number;
  /**
   * Blob-store key prefix the pipeline uses to write its per-issue status
   * doc (see `scripts/sprites/issue-pipeline.ts`'s `ISSUE_STATUS_PREFIX`).
   * The ingester reads `<prefix>/<issueNumber>-<fingerprint>.json` to
   * distinguish "stale claim, safe to reclaim" from "actively running,
   * leave alone" during TTL evaluation.
   */
  readonly issueStatusPrefix?: string;
  /**
   * Optional callback that, when it returns a non-empty string, causes the
   * ingester to post that string as a comment on the source issue right
   * after a successful enqueue + state save. Returning `null`/empty skips
   * the comment (used to noop the hook in local dev). A thrown/rejected
   * error is logged as `lastError` and does NOT roll back the enqueue —
   * the claim is already committed and the queue message is already sent,
   * so a comment failure must not surface as a pipeline failure.
   */
  readonly postEnqueueComment?: (context: EnqueueCommentContext) => string | null;
}

export function createIssueIngesterController(
  options: CreateIssueIngesterOptions,
): IssueIngesterController {
  const pollMs = options.pollIntervalMs ?? 15_000;
  const now = options.now ?? (() => new Date());
  let running = false;
  let startedAt: string | null = null;
  let stoppedAt: string | null = null;
  let lastPollAt: string | null = null;
  let lastError: string | null = null;
  let enqueued = 0;
  let skippedDuplicate = 0;
  let reclaimedStale = 0;
  let enqueueCommentsPosted = 0;
  let enqueueCommentErrors = 0;
  let lastEnqueueCommentError: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stateLock: Promise<void> = Promise.resolve();

  async function withStateLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = stateLock;
    let release!: () => void;
    stateLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  const snapshot = (): IssueIngesterStatus => ({
    running,
    startedAt,
    stoppedAt,
    lastPollAt,
    lastError,
    enqueued,
    skippedDuplicate,
    reclaimedStale,
    enqueueCommentsPosted,
    enqueueCommentErrors,
    lastEnqueueCommentError,
  });

  const claimKey = (issueNumber: number, fingerprint: string): string =>
    `${issueNumber}:${fingerprint}`;

  const sameLegacyStateSemantics = (
    row: IngestState['claims'][string] | IngestState['rejected'][string] | undefined,
    payload: LegacyStateComparableRequest,
  ): boolean =>
    row !== undefined &&
    row.name === payload.name &&
    row.briefSentence === payload.briefSentence &&
    row.sizeVariant === payload.sizeVariant;

  const matchingStateRow = <T extends IngestState['claims'] | IngestState['rejected']>(
    table: T,
    issueNumber: number,
    payload: LegacyStateComparableRequest,
  ): { readonly key: string; readonly row: T[string] | undefined } => {
    const key = claimKey(issueNumber, payload.fingerprint);
    const current = table[key];
    if (current) return { key, row: current };
    const legacyKey =
      payload.legacyFingerprint && payload.legacyFingerprint !== payload.fingerprint
        ? claimKey(issueNumber, payload.legacyFingerprint)
        : null;
    if (legacyKey && sameLegacyStateSemantics(table[legacyKey], payload)) {
      return { key: legacyKey, row: table[legacyKey] };
    }
    return { key, row: undefined };
  };

  async function loadState(): Promise<IngestState> {
    if (!(await options.store.has(INGEST_STATE_KEY))) {
      return { version: 2, claims: {}, rejected: {} };
    }
    try {
      const parsed = JSON.parse((await options.store.get(INGEST_STATE_KEY)).toString('utf8')) as {
        version?: unknown;
        claims?: unknown;
        rejected?: unknown;
      };
      if (!parsed || typeof parsed !== 'object') {
        return { version: 2, claims: {}, rejected: {} };
      }
      const claimsRaw =
        typeof parsed.claims === 'object' && parsed.claims !== null ? parsed.claims : {};
      const rejectedRaw =
        typeof parsed.rejected === 'object' && parsed.rejected !== null ? parsed.rejected : {};
      const claims: IngestState['claims'] = {};
      for (const [key, value] of Object.entries(claimsRaw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        if (
          typeof row.issueNumber !== 'number' ||
          !Number.isInteger(row.issueNumber) ||
          row.issueNumber < 1 ||
          typeof row.fingerprint !== 'string' ||
          row.fingerprint === '' ||
          typeof row.claimedAt !== 'string'
        ) {
          continue;
        }
        claims[key] = {
          issueNumber: row.issueNumber,
          fingerprint: row.fingerprint,
          claimedAt: row.claimedAt,
          name: typeof row.name === 'string' ? row.name : '',
          briefSentence: typeof row.briefSentence === 'string' ? row.briefSentence : '',
          ...(isSizeVariant(row.sizeVariant) ? { sizeVariant: row.sizeVariant } : {}),
        };
      }
      const rejected: IngestState['rejected'] = {};
      for (const [key, value] of Object.entries(rejectedRaw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        if (
          typeof row.issueNumber !== 'number' ||
          !Number.isInteger(row.issueNumber) ||
          row.issueNumber < 1 ||
          typeof row.fingerprint !== 'string' ||
          row.fingerprint === '' ||
          typeof row.rejectedAt !== 'string'
        ) {
          continue;
        }
        rejected[key] = {
          issueNumber: row.issueNumber,
          fingerprint: row.fingerprint,
          rejectedAt: row.rejectedAt,
          reason:
            typeof row.reason === 'string' && row.reason.trim() !== '' ? row.reason.trim() : null,
          name: typeof row.name === 'string' ? row.name : '',
          briefSentence: typeof row.briefSentence === 'string' ? row.briefSentence : '',
          ...(isSizeVariant(row.sizeVariant) ? { sizeVariant: row.sizeVariant } : {}),
        };
      }
      return { version: 2, claims, rejected };
    } catch {
      return { version: 2, claims: {}, rejected: {} };
    }
  }

  async function saveState(state: IngestState): Promise<void> {
    await options.store.put(INGEST_STATE_KEY, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  }

  async function readCompletionStage(
    issueNumber: number,
    fingerprint: string,
  ): Promise<{ readonly stage: string; readonly updatedAt: string | null } | null> {
    if (!options.issueStatusPrefix) return null;
    const key = `${options.issueStatusPrefix}/${issueNumber}-${fingerprint}.json`;
    if (!(await options.store.has(key))) return null;
    try {
      const parsed = JSON.parse((await options.store.get(key)).toString('utf8')) as {
        stage?: unknown;
        updatedAt?: unknown;
      };
      if (!parsed || typeof parsed !== 'object') return null;
      const stage = typeof parsed.stage === 'string' ? parsed.stage : '';
      const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
      return { stage, updatedAt };
    } catch {
      return null;
    }
  }

  /**
   * Decide whether a claim should be dropped and re-enqueued on this pass.
   *
   * "Stale" is a two-signal check to avoid re-enqueuing an actively-running
   * worker (which could then race a second worker on the same issue):
   *
   *   1. The claim itself is older than `staleClaimTtlMs`.
   *   2. Either there's no pipeline status doc yet (worker never got the
   *      message, or crashed before its first `setStatus` call) OR the doc
   *      exists but its `updatedAt` heartbeat is also older than TTL/2 (the
   *      pipeline is not writing status transitions — worker likely dead).
   *
   * A `stage === 'completed'` status doc always short-circuits to "not
   * stale" — the request is already done and re-enqueueing would produce a
   * duplicate sprite.
   */
  async function isClaimStale(input: {
    readonly claim: {
      readonly claimedAt: string;
      readonly issueNumber: number;
      readonly fingerprint: string;
    };
    readonly ttlMs: number;
    readonly nowMs: number;
  }): Promise<boolean> {
    const claimAgeMs = input.nowMs - Date.parse(input.claim.claimedAt);
    if (!Number.isFinite(claimAgeMs) || claimAgeMs < input.ttlMs) return false;
    const status = await readCompletionStage(input.claim.issueNumber, input.claim.fingerprint);
    if (!status) return true;
    if (status.stage === 'completed') return false;
    if (!status.updatedAt) return true;
    const heartbeatAgeMs = input.nowMs - Date.parse(status.updatedAt);
    if (!Number.isFinite(heartbeatAgeMs)) return true;
    return heartbeatAgeMs >= input.ttlMs / 2;
  }

  async function pollOnce(): Promise<void> {
    lastPollAt = now().toISOString();
    const swept = await options.issues.listOpenAssetRequestIssues();
    // Prepend the workflow-triggering issue (fetched via REST for
    // immediate consistency) so a fresh issue that hasn't propagated to the
    // GraphQL search index yet still gets enqueued in this run. Deduped by
    // `issue.number` against the sweep list — if the sweep already saw it
    // we don't double-process here.
    let issuesToProcess: readonly OpenAssetRequestIssue[] = swept;
    if (typeof options.targetIssueNumber === 'number') {
      const targetNumber = options.targetIssueNumber;
      const alreadyInSweep = swept.some((issue) => issue.number === targetNumber);
      if (!alreadyInSweep) {
        const priority = await options.issues.getIssue(targetNumber);
        if (priority) {
          issuesToProcess = [priority, ...swept];
        }
      }
    }
    // Collect enqueue-completion notifications outside the state lock so we
    // don't hold it across a network call to `gh issue comment` (posts can
    // take ~1s each and would serialize with any other state operation).
    const enqueueComments: EnqueueCommentContext[] = [];
    await withStateLock(async () => {
      const state = await loadState();
      for (const issue of issuesToProcess) {
        const payload = parseAssetRequestIssueBody(issue.body);
        if (!payload) continue;
        const fingerprint = payload.fingerprint;
        const key = claimKey(issue.number, fingerprint);
        const rejectedMatch = matchingStateRow(state.rejected, issue.number, payload);
        if (rejectedMatch.row) {
          skippedDuplicate += 1;
          continue;
        }
        let reclaimed = false;
        const claimMatch = matchingStateRow(state.claims, issue.number, payload);
        const existingClaim = claimMatch.row;
        if (existingClaim) {
          const shouldReclaim =
            typeof options.staleClaimTtlMs === 'number' &&
            options.staleClaimTtlMs > 0 &&
            (await isClaimStale({
              claim: {
                claimedAt: existingClaim.claimedAt,
                issueNumber: existingClaim.issueNumber,
                fingerprint: existingClaim.fingerprint,
              },
              ttlMs: options.staleClaimTtlMs,
              nowMs: now().getTime(),
            }));
          if (!shouldReclaim) {
            skippedDuplicate += 1;
            continue;
          }
          delete state.claims[claimMatch.key];
          reclaimedStale += 1;
          reclaimed = true;
          // The in-memory delete is only persisted by the per-issue saveState
          // below, which runs AFTER a successful enqueue. If enqueue throws we
          // return before saving, so the stale-claim delete is discarded when
          // withStateLock reloads next poll — never a delete without a matching
          // re-enqueue.
        }
        const claimedAt = now().toISOString();
        const message: IssueAssetRequest = {
          kind: 'issue-request',
          issueNumber: issue.number,
          name: payload.name,
          briefSentence: payload.briefSentence,
          ...(payload.type ? { type: payload.type } : {}),
          ...(typeof payload.floor === 'number' &&
          Number.isInteger(payload.floor) &&
          payload.floor >= 1 &&
          payload.floor <= 20
            ? { floor: payload.floor }
            : {}),
          ...(payload.sizeVariant ? { sizeVariant: payload.sizeVariant } : {}),
          fingerprint,
          claimedAt,
          requestedBy: options.requestedBy,
          requestedAt: claimedAt,
          priority: 'normal',
        };
        await options.queue.enqueue(message);
        state.claims[key] = {
          issueNumber: issue.number,
          fingerprint,
          claimedAt,
          name: payload.name,
          briefSentence: payload.briefSentence,
          ...(payload.sizeVariant ? { sizeVariant: payload.sizeVariant } : {}),
        };
        enqueued += 1;
        // Persist immediately (not batched at loop end) so a committed enqueue
        // survives a LATER issue's enqueue failure in the same poll. A batched
        // save was skipped entirely when a subsequent enqueue threw, orphaning
        // already-sent queue messages and re-enqueuing them (→ duplicate sprite
        // generation) on the next poll.
        await saveState(state);
        if (options.postEnqueueComment) {
          enqueueComments.push({
            issueNumber: issue.number,
            name: payload.name,
            briefSentence: payload.briefSentence,
            ...(payload.sizeVariant ? { sizeVariant: payload.sizeVariant } : {}),
            fingerprint,
            claimedAt,
            reclaimed,
          });
        }
      }
    });
    // Fire enqueue-completion comments after the state lock releases. Each
    // failure is recorded on `enqueueCommentErrors`/`lastEnqueueCommentError`
    // (NOT `lastError`) so a best-effort notification failure never fails the
    // ingest step or rolls back the already-committed enqueue. We continue
    // posting remaining comments to avoid silently dropping notifications for
    // issues after the first failure.
    if (options.postEnqueueComment && enqueueComments.length > 0) {
      for (const context of enqueueComments) {
        try {
          const body = options.postEnqueueComment(context);
          if (typeof body === 'string' && body.trim() !== '') {
            await options.issues.comment(context.issueNumber, body);
            enqueueCommentsPosted += 1;
          }
        } catch (err) {
          enqueueCommentErrors += 1;
          lastEnqueueCommentError = `enqueue-comment failed for issue #${context.issueNumber}: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }
  }

  function schedule(): void {
    if (!running) return;
    timer = setTimeout(async () => {
      try {
        await pollOnce();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        schedule();
      }
    }, pollMs);
  }

  return {
    start() {
      if (running) return { started: false, status: snapshot() };
      running = true;
      startedAt = now().toISOString();
      stoppedAt = null;
      void pollOnce()
        .catch((err) => {
          lastError = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          schedule();
        });
      return { started: true, status: snapshot() };
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      stoppedAt = now().toISOString();
      return snapshot();
    },
    async pollOnce() {
      try {
        await pollOnce();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      return snapshot();
    },
    status: snapshot,
    async listRequests(state = 'all') {
      return withStateLock(async () => {
        const ingestState = await loadState();
        const open = await options.issues.listOpenAssetRequestIssues();
        const out = new Map<string, AssetRequestManifestEntry>();
        const matchedRejectedKeys = new Set<string>();
        for (const issue of open) {
          const payload = parseAssetRequestIssueBody(issue.body);
          if (!payload) continue;
          const key = claimKey(issue.number, payload.fingerprint);
          const claimed = matchingStateRow(ingestState.claims, issue.number, payload).row;
          const rejectedMatch = matchingStateRow(ingestState.rejected, issue.number, payload);
          const rejected = rejectedMatch.row;
          if (rejected) matchedRejectedKeys.add(rejectedMatch.key);
          out.set(key, {
            key,
            issueNumber: issue.number,
            fingerprint: payload.fingerprint,
            name: payload.name,
            briefSentence: payload.briefSentence,
            ...(payload.sizeVariant ? { sizeVariant: payload.sizeVariant } : {}),
            state: rejected ? 'rejected' : claimed ? 'claimed' : 'pending',
            claimedAt: claimed?.claimedAt ?? null,
            rejectedAt: rejected?.rejectedAt ?? null,
            rejectionReason: rejected?.reason ?? null,
            isOpen: true,
          });
        }
        if (state === 'all' || state === 'rejected') {
          for (const [key, rejected] of Object.entries(ingestState.rejected)) {
            if (out.has(key) || matchedRejectedKeys.has(key)) continue;
            out.set(key, {
              key,
              issueNumber: rejected.issueNumber,
              fingerprint: rejected.fingerprint,
              name: rejected.name,
              briefSentence: rejected.briefSentence,
              ...(rejected.sizeVariant ? { sizeVariant: rejected.sizeVariant } : {}),
              state: 'rejected',
              claimedAt: null,
              rejectedAt: rejected.rejectedAt,
              rejectionReason: rejected.reason,
              isOpen: false,
            });
          }
        }
        const values = [...out.values()].filter((entry) => {
          if (state === 'all') return true;
          return entry.state === state;
        });
        values.sort((a, b) => {
          const aTs = a.rejectedAt ?? a.claimedAt ?? '';
          const bTs = b.rejectedAt ?? b.claimedAt ?? '';
          if (aTs !== bTs) return aTs < bTs ? 1 : -1;
          return b.issueNumber - a.issueNumber;
        });
        return values;
      });
    },
    async rejectRequest(input) {
      return withStateLock(async () => {
        const issueNumber = input.issueNumber;
        let fingerprint = input.fingerprint;
        const reason =
          typeof input.reason === 'string' && input.reason.trim() !== ''
            ? input.reason.trim()
            : null;
        const ingestState = await loadState();

        let name = '';
        let briefSentence = '';
        let sizeVariant: SizeVariant | undefined;
        const open = await options.issues.listOpenAssetRequestIssues();
        for (const issue of open) {
          if (issue.number !== issueNumber) continue;
          const payload = parseAssetRequestIssueBody(issue.body);
          if (!payload) continue;
          const matchedCurrent = payload.fingerprint === fingerprint;
          const matchedLegacy = payload.legacyFingerprint === fingerprint;
          if (!matchedCurrent && !matchedLegacy) continue;
          name = payload.name;
          briefSentence = payload.briefSentence;
          sizeVariant = payload.sizeVariant;
          fingerprint = payload.fingerprint;
          break;
        }
        const key = claimKey(issueNumber, fingerprint);
        const payloadForStateMatch =
          name !== '' && briefSentence !== ''
            ? { name, briefSentence, sizeVariant, fingerprint }
            : undefined;
        const existingClaim = payloadForStateMatch
          ? matchingStateRow(ingestState.claims, issueNumber, payloadForStateMatch)
          : { key, row: ingestState.claims[key] };
        const existingRejected = payloadForStateMatch
          ? matchingStateRow(ingestState.rejected, issueNumber, payloadForStateMatch)
          : { key, row: ingestState.rejected[key] };
        const resolvedName =
          name !== '' ? name : (existingRejected.row?.name ?? existingClaim.row?.name ?? '');
        const resolvedBriefSentence =
          briefSentence !== ''
            ? briefSentence
            : (existingRejected.row?.briefSentence ?? existingClaim.row?.briefSentence ?? '');
        const resolvedSizeVariant =
          sizeVariant ?? existingRejected.row?.sizeVariant ?? existingClaim.row?.sizeVariant;
        if (existingClaim.row && existingClaim.key !== key) {
          delete ingestState.claims[existingClaim.key];
        }
        if (existingRejected.row && existingRejected.key !== key) {
          delete ingestState.rejected[existingRejected.key];
        }
        ingestState.rejected[key] = {
          issueNumber,
          fingerprint,
          rejectedAt: now().toISOString(),
          reason,
          name: resolvedName,
          briefSentence: resolvedBriefSentence,
          ...(resolvedSizeVariant ? { sizeVariant: resolvedSizeVariant } : {}),
        };
        delete ingestState.claims[key];
        await saveState(ingestState);
        return {
          key,
          issueNumber,
          fingerprint,
          name: ingestState.rejected[key]!.name,
          briefSentence: ingestState.rejected[key]!.briefSentence,
          ...(ingestState.rejected[key]!.sizeVariant
            ? { sizeVariant: ingestState.rejected[key]!.sizeVariant }
            : {}),
          state: 'rejected',
          claimedAt: null,
          rejectedAt: ingestState.rejected[key]!.rejectedAt,
          rejectionReason: ingestState.rejected[key]!.reason,
          isOpen:
            open.find((issue) => {
              if (issue.number !== issueNumber) return false;
              const payload = parseAssetRequestIssueBody(issue.body);
              return (
                payload?.fingerprint === fingerprint || payload?.legacyFingerprint === fingerprint
              );
            }) !== undefined,
        };
      });
    },
  };
}
