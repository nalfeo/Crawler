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
}

interface SidecarRunListResponse {
  readonly runs: SidecarRunListEntry[];
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

function runSummaryUrl(briefId: string, runId: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}`;
}

function runApproveUrl(briefId: string, runId: string): string {
  return `${runSummaryUrl(briefId, runId)}/approve`;
}

export async function listSidecarRuns(
  fetcher: typeof fetch = fetch,
): Promise<SidecarRunListEntry[]> {
  const response = await fetcher(`${SIDECAR_BASE}/api/runs`, { cache: 'no-store' });
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
