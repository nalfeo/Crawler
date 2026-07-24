import { getSpriteSidecarBaseUrl } from '../shared/session-server-env.js';

const SIDECAR_BASE = getSpriteSidecarBaseUrl();

export interface SidecarRunListEntry {
  readonly briefId: string;
  readonly runId: string;
  readonly timestamp: string | null;
  readonly briefHash: string | null;
  readonly chosenIndex: number | null;
  readonly candidateCount: number | null;
  readonly hasJudge: boolean;
  readonly promotionState: 'promoted' | 'not-promoted';
}

export interface SidecarStorageRunEntry {
  readonly briefId: string;
  readonly runId: string;
  readonly timestamp: string | null;
  readonly summaryKey: string;
}

export interface SidecarStorageRunListResponse {
  readonly scope: 'active' | 'archive';
  readonly runs: SidecarStorageRunEntry[];
}

interface SidecarRunListResponse {
  readonly runs: SidecarRunListEntry[];
}

export interface LatestRunLookup {
  readonly briefId: string;
  readonly runId: string;
  readonly timestamp: string | null;
}

interface LatestRunLookupResponse {
  readonly run: LatestRunLookup | null;
}

export interface ApproveResponse {
  readonly briefId: string;
  readonly spriteName: string;
  readonly assetPath: string;
  readonly approvedAt: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly anchor: { readonly x: number; readonly y: number; readonly source: string } | null;
  readonly sensorScore: string;
  readonly judgeScore: string | null;
  /**
   * Outcome of the durable `assets/queue` push the sidecar performs right after
   * writing the approved asset to disk (PR1). A `'failed'` status means the local
   * catalog write succeeded but the edit is NOT yet safe across worktrees/sessions
   * — the UI must surface this so the worktree isn't discarded and the approval
   * lost. Absent when the sidecar build predates queue-commit or the push was a
   * no-op with no field emitted.
   */
  readonly queueCommit?:
    | {
        readonly status: 'committed' | 'noop';
        readonly branch: string;
        readonly commit?: string;
        readonly attempts: number;
      }
    | { readonly status: 'failed'; readonly error: string };
}

interface ApproveErrorBody {
  readonly error?: string;
  readonly message?: string;
}

/**
 * Error thrown by `postApprove` for a non-2xx sidecar response. Carries the HTTP
 * `status` and machine-readable `errorCode` (the sidecar's `error` field, e.g.
 * `already-approved`) so callers can branch on the conflict case without parsing
 * the human message. The `message` keeps the historical
 * `approve failed (<status>): <detail>` contract.
 */
export class ApproveRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApproveRequestError';
  }
}

/** One published asset, as reported by the sidecar `/api/checkin` route. */
export interface CheckinAsset {
  readonly assetPath: string;
  readonly manifestKey: string | null;
  readonly briefId: string | null;
  readonly variantIndex: number | null;
}

/**
 * Successful `/api/checkin` payload: the pushed `assets/<slug>` branch, the URL
 * of the filed `asset-checkin` tracking issue, the filed issue contents, and
 * the assets it covers.
 */
export interface CheckinResponse {
  readonly branch: string;
  readonly issueUrl: string;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly assets: readonly CheckinAsset[];
}

/**
 * Error thrown by `postCheckin` for a non-2xx sidecar response. Carries the HTTP
 * `status` and machine-readable `errorCode` (the sidecar's `error` field, e.g.
 * `nothing-to-checkin`, `ci-refused`) so callers can give a friendly message for
 * the benign "nothing to check in" case without parsing the human text.
 */
export class CheckinRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'CheckinRequestError';
  }
}

/**
 * Actionable guidance shown when the sidecar answers a check-in route with a bare
 * 404 — the tell-tale sign it is a long-lived process running code from before the
 * route existed (the `tsx` sidecar does not hot-reload). Restarting it reloads the
 * route table.
 */
export const STALE_SIDECAR_HINT =
  'The sprite sidecar is running out-of-date code (a check-in route is missing). ' +
  'Restart it to pick up the latest routes: stop the current process (Ctrl-C) and ' +
  'run `npm run sprites:gallery` again.';

/**
 * True when `err` is a check-in failure caused by the sidecar lacking the route —
 * i.e. a stale, pre-route sidecar process. Deliberately matches Fastify's default
 * missing-route reply specifically (HTTP 404 + `error: 'Not Found'` + a
 * `Route <METHOD>:<url> not found` message naming an `/api/checkin` route) so that
 * an unrelated 404 — a misconfigured `SIDECAR_BASE`, a different local service on
 * the port — cannot be mistaken for a stale sidecar and silently trigger the
 * pre-flight fallback.
 */
export function isSidecarRouteMissing(err: unknown): boolean {
  if (
    !(err instanceof CheckinRequestError) ||
    err.status !== 404 ||
    err.errorCode !== 'Not Found'
  ) {
    return false;
  }
  const message = err.message.toLowerCase();
  return (
    /route\s+\w+:/.test(message) &&
    message.includes('not found') &&
    message.includes('/api/checkin')
  );
}

function runSummaryUrl(briefId: string, runId: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}`;
}

function runApproveUrl(briefId: string, runId: string): string {
  return `${runSummaryUrl(briefId, runId)}/approve`;
}

export async function listSidecarRuns(
  options: { promoted?: 'all' | 'promoted' | 'not-promoted' } = {},
  fetcher: typeof fetch = fetch,
): Promise<SidecarRunListEntry[]> {
  const params = new URLSearchParams();
  if (options.promoted && options.promoted !== 'all') {
    params.set('promoted', options.promoted);
  }
  const url =
    params.size > 0 ? `${SIDECAR_BASE}/api/runs?${params.toString()}` : `${SIDECAR_BASE}/api/runs`;
  const response = await fetcher(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load sidecar runs (${response.status} ${response.statusText})`);
  }
  const payload = (await response.json()) as SidecarRunListResponse;
  return payload.runs ?? [];
}

export async function fetchRunSummary(
  briefId: string,
  runId: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(runSummaryUrl(briefId, runId), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load run summary (${response.status} ${response.statusText})`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function fetchLatestRunForBriefSince(
  briefId: string,
  requestedAt: string,
  fetcher: typeof fetch = fetch,
): Promise<LatestRunLookup | null> {
  const params = new URLSearchParams({ briefId, requestedAt });
  const response = await fetcher(`${SIDECAR_BASE}/api/workflow/latest-run?${params.toString()}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Failed to look up latest run (${response.status} ${response.statusText})`);
  }
  const payload = (await response.json()) as LatestRunLookupResponse;
  return payload.run ?? null;
}

export function extractVariantIndices(summary: Record<string, unknown>): number[] {
  const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
  const indices: number[] = [];
  for (const [fallbackIndex, candidate] of candidates.entries()) {
    if (candidate && typeof candidate === 'object') {
      const value = (candidate as { index?: unknown }).index;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        indices.push(value);
        continue;
      }
    }
    indices.push(fallbackIndex);
  }
  return [...new Set(indices)];
}

/**
 * Posts `variantIndex` to the sidecar approve endpoint and returns the created
 * manifest entry payload. Error text intentionally mirrors the previous lab
 * helper so existing call sites and tests keep the same contract.
 */
export async function postApprove(
  briefId: string,
  runId: string,
  variantIndex: number,
  fetcher: typeof fetch = fetch,
): Promise<ApproveResponse> {
  const response = await fetcher(runApproveUrl(briefId, runId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variantIndex }),
  });
  if (!response.ok) {
    let detail = '';
    let errorCode: string | null = null;
    try {
      const body = (await response.json()) as ApproveErrorBody;
      detail = body.message ?? body.error ?? '';
      errorCode = body.error ?? null;
    } catch {
      // Body wasn't JSON; fall through with status text only.
    }
    throw new ApproveRequestError(
      response.status,
      errorCode,
      `approve failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return (await response.json()) as ApproveResponse;
}

/**
 * The manifest entry returned by a successful unapprove/eviction request.
 * Mirrors `ManifestEntry` from `approve.ts` — the removed entry is returned
 * so callers can display what was evicted without a follow-up fetch.
 */
export interface UnapproveResponse {
  readonly briefId: string;
  readonly spriteName: string;
  readonly assetPath: string;
  readonly approvedAt: string;
  readonly variantIndex: number;
}

/**
 * Error thrown by `deleteApprovedVariant` for a non-2xx sidecar response.
 * Carries the HTTP `status` and machine-readable `errorCode` (the sidecar's
 * `error` field, e.g. `not-found`) so callers can branch on error type.
 */
export class UnapproveRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'UnapproveRequestError';
  }
}

/**
 * Evicts a previously approved variant via
 * `DELETE /api/manifest/:variantId`. Removes the manifest entry, catalog
 * entry, and on-disk PNG. Returns the removed manifest entry on success,
 * and throws `UnapproveRequestError` on any non-2xx sidecar response.
 */
export async function deleteApprovedVariant(
  variantId: string,
  fetcher: typeof fetch = fetch,
): Promise<UnapproveResponse> {
  const url = `${SIDECAR_BASE}/api/manifest/${encodeURIComponent(variantId)}`;
  const response = await fetcher(url, { method: 'DELETE' });
  if (!response.ok) {
    let detail = '';
    let errorCode: string | null = null;
    try {
      const body = (await response.json()) as ApproveErrorBody;
      detail = body.message ?? body.error ?? '';
      errorCode = body.error ?? null;
    } catch {
      // Body wasn't JSON; fall through with status text only.
    }
    throw new UnapproveRequestError(
      response.status,
      errorCode,
      `unapprove failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return (await response.json()) as UnapproveResponse;
}

/** Sidecar confirmation for a single-run delete. */
export interface DeleteRunResponse {
  /** The `briefId/runId` key the sidecar removed. */
  readonly deleted: string;
}

/**
 * Deletes exactly one run's artifacts from the sidecar store via
 * `DELETE /api/runs/:briefId/:runId`. Scoped to the single `briefId/runId`
 * pair — it never touches other runs, other briefs, or the workflow queue
 * state. Returns the `briefId/runId` key the sidecar confirms it removed, and
 * throws on any non-2xx response (e.g. `404` when the run no longer exists).
 */
export async function deleteSidecarRun(
  briefId: string,
  runId: string,
  fetcher: typeof fetch = fetch,
): Promise<DeleteRunResponse> {
  const response = await fetcher(runSummaryUrl(briefId, runId), { method: 'DELETE' });
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as ApproveErrorBody;
      detail = body.message ?? body.error ?? '';
    } catch {
      // Body wasn't JSON; fall through with status text only.
    }
    throw new Error(`delete failed (${response.status}): ${detail || response.statusText}`);
  }
  return (await response.json()) as DeleteRunResponse;
}

export async function listStorageRuns(
  scope: 'active' | 'archive',
  search = '',
  fetcher: typeof fetch = fetch,
): Promise<SidecarStorageRunListResponse> {
  const params = new URLSearchParams({ scope });
  if (search.trim().length > 0) {
    params.set('search', search.trim());
  }
  const response = await fetcher(`${SIDECAR_BASE}/api/storage/runs?${params.toString()}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`storage list failed (${response.status}): ${response.statusText}`);
  }
  return (await response.json()) as SidecarStorageRunListResponse;
}

export async function archiveStorageRuns(
  keys: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ archived: string[]; skipped: string[] }> {
  const response = await fetcher(`${SIDECAR_BASE}/api/storage/runs/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
  if (!response.ok) {
    throw new Error(`archive failed (${response.status}): ${response.statusText}`);
  }
  return (await response.json()) as { archived: string[]; skipped: string[] };
}

export async function deleteStorageRunsBatch(
  keys: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ deleted: string[] }> {
  const response = await fetcher(`${SIDECAR_BASE}/api/storage/runs/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
  if (!response.ok) {
    throw new Error(`delete batch failed (${response.status}): ${response.statusText}`);
  }
  return (await response.json()) as { deleted: string[] };
}

/** Per-run enrichment for the storage lifecycle page (thumbnails + badges). */
export interface StorageRunEnrichment {
  readonly briefId: string;
  readonly runId: string;
  /** Candidate count from the run summary, or null when unavailable. */
  readonly variantCount: number | null;
  /** First `sheet-NN.png` filename for the run (active scope only), else null. */
  readonly sheetFile: string | null;
  /** Number of approved variants recorded for the brief. */
  readonly approvedCount: number;
  /** Lowest-index approved variant for the brief, with its source run. */
  readonly firstApproved: { readonly runId: string; readonly variantIndex: number } | null;
  /** Whether the brief YAML is still stored (on disk or mirrored in the store). */
  readonly briefStored: boolean;
}

export interface StorageRunEnrichmentResponse {
  readonly scope: 'active' | 'archive';
  readonly enriched: StorageRunEnrichment[];
}

/**
 * Fetches enrichment (sheet thumbnail, approved-variant count + first approved
 * variant, brief-stored flag) for a batch of storage runs. Kept separate from
 * `listStorageRuns` so the list renders instantly and enrichment fills in after.
 */
export async function enrichStorageRuns<
  T extends { readonly briefId: string; readonly runId: string },
>(
  scope: 'active' | 'archive',
  runs: ReadonlyArray<T>,
  fetcher: typeof fetch = fetch,
): Promise<StorageRunEnrichmentResponse> {
  const response = await fetcher(`${SIDECAR_BASE}/api/storage/runs/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      runs: runs.map((run) => ({ briefId: run.briefId, runId: run.runId })),
    }),
  });
  if (!response.ok) {
    throw new Error(`storage enrich failed (${response.status}): ${response.statusText}`);
  }
  return (await response.json()) as StorageRunEnrichmentResponse;
}

/**
 * Triggers the sidecar check-in: publishes every locally-approved asset that
 * differs from `origin/main` as a dedicated `assets/<slug>` branch + an
 * `asset-checkin` tracking issue (NO PR). This is the step that actually creates
 * the GitHub issue — approve alone only mutates local files. Mirrors
 * `postApprove`'s error contract, surfacing the sidecar `error` code so callers
 * can special-case the benign `nothing-to-checkin` (409) conflict.
 */
export async function postCheckin(
  slug?: string,
  fetcher: typeof fetch = fetch,
): Promise<CheckinResponse> {
  const response = await fetcher(`${SIDECAR_BASE}/api/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slug ? { slug } : {}),
  });
  if (!response.ok) {
    let detail = '';
    let errorCode: string | null = null;
    try {
      const body = (await response.json()) as ApproveErrorBody;
      detail = body.message ?? body.error ?? '';
      errorCode = body.error ?? null;
    } catch {
      // Body wasn't JSON; fall through with status text only.
    }
    throw new CheckinRequestError(
      response.status,
      errorCode,
      `check-in failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return (await response.json()) as CheckinResponse;
}

/**
 * Pre-flight check for check-in: detects what will be checked in without
 * performing the slow git push / GitHub issue operations. Returns immediately
 * to provide fast feedback on asset count and estimated time.
 */
export interface CheckinPrepareResponse {
  readonly assetCount: number;
  readonly branch: string;
  readonly slug: string;
  readonly assets: readonly CheckinAsset[];
  readonly estimatedDuration: string;
}

export async function prepareCheckin(
  fetcher: typeof fetch = fetch,
): Promise<CheckinPrepareResponse> {
  const response = await fetcher(`${SIDECAR_BASE}/api/checkin/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    let detail = '';
    let errorCode: string | null = null;
    try {
      const body = (await response.json()) as ApproveErrorBody;
      detail = body.message ?? body.error ?? '';
      errorCode = body.error ?? null;
    } catch {
      // Body wasn't JSON; fall through with status text only.
    }
    throw new CheckinRequestError(
      response.status,
      errorCode,
      `prepare failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return (await response.json()) as CheckinPrepareResponse;
}
