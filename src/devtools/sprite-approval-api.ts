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
 * Triggers the sidecar check-in: publishes every locally-approved asset that
 * differs from `origin/main` as a dedicated `assets/<slug>` branch + an
 * `asset-checkin` tracking issue (NO PR). This is the step that actually creates
 * the GitHub issue — approve alone only mutates local files. Mirrors
 * `postApprove`'s error contract, surfacing the sidecar `error` code so callers
 * can special-case the benign `nothing-to-checkin` (409) conflict.
 */
export async function postCheckin(fetcher: typeof fetch = fetch): Promise<CheckinResponse> {
  const response = await fetcher(`${SIDECAR_BASE}/api/checkin`, {
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
      `check-in failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return (await response.json()) as CheckinResponse;
}
