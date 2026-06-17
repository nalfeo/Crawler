import { getSpriteSidecarBaseUrl } from '../shared/session-server-env.js';
const SIDECAR_BASE = getSpriteSidecarBaseUrl();
function runSummaryUrl(briefId, runId) {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}`;
}
function runApproveUrl(briefId, runId) {
  return `${runSummaryUrl(briefId, runId)}/approve`;
}
export async function listSidecarRuns(fetcher = fetch) {
  const response = await fetcher(`${SIDECAR_BASE}/api/runs`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load sidecar runs (${response.status} ${response.statusText})`);
  }
  const payload = await response.json();
  return payload.runs ?? [];
}
export async function fetchRunSummary(briefId, runId, fetcher = fetch) {
  const response = await fetcher(runSummaryUrl(briefId, runId), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load run summary (${response.status} ${response.statusText})`);
  }
  return await response.json();
}
export function extractVariantIndices(summary) {
  const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
  const indices = [];
  for (const [fallbackIndex, candidate] of candidates.entries()) {
    if (candidate && typeof candidate === 'object') {
      const value = candidate.index;
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
export async function postApprove(briefId, runId, variantIndex, fetcher = fetch) {
  const response = await fetcher(runApproveUrl(briefId, runId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variantIndex }),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.message ?? body.error ?? '';
    } catch {
      // Body wasn't JSON; fall through with status text only.
    }
    throw new Error(`approve failed (${response.status}): ${detail || response.statusText}`);
  }
  return await response.json();
}
//# sourceMappingURL=sprite-approval-api.js.map
