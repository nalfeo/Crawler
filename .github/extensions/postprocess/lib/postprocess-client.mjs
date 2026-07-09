/**
 * postprocess-client.mjs — layer-2 orchestration for the postprocess debugger.
 *
 * This module composes an already-constructed sidecar client (from
 * `sidecar-client.mjs`) — it never re-implements URL builders or normalizers.
 * It owns exactly the two sidecar interactions the postprocess page needs on top
 * of the shared read APIs:
 *
 *   1. `relayLivePostprocess` — server-side relay of a live re-process. The
 *      browser computes the raw input PNG (a sheet-cell crop, or the stored raw
 *      cell as a fallback) and POSTs base64 to our loopback server; this relay
 *      resolves the run's `briefPath` from its summary and forwards it to the
 *      sidecar `POST /api/postprocess`. Mirrors the monolith `livePostprocess`
 *      body `{ briefPath, rawPng, options }` (`src/devtools-main.ts` ~442-466).
 *   2. `fetchPipelineManifest` — the pre-baked `<padded>.pipeline.json` fallback
 *      trace, normalized to `{ profile, sourceRunId, steps:[{id,label,file}] }`.
 *
 * Everything else (health, runs, summary, sheets, slice-map, image URLs) comes
 * straight off the injected sidecar client.
 *
 * @module postprocess/postprocess-client
 */

/**
 * Background-removal tolerance defaults — MUST stay identical to
 * `DEFAULT_BACKGROUND_TWEAKS` in `src/devtools-main.ts` and the sidecar's
 * `scripts/sprites/postprocess.ts` (guarded by `tests/unit/bg-remove.test.ts`).
 */
export const DEFAULT_BACKGROUND_TWEAKS = Object.freeze({
  colorToleranceSq: 4000,
  fringeToleranceSq: 12000,
});

/** Max squared tolerance = 255² · 3 (three 8-bit channels). Monolith parity. */
export const MAX_BACKGROUND_TOLERANCE_SQ = 255 * 255 * 3;

/** Two-digit zero-padded variant index (monolith `String(i).padStart(2,'0')`). */
export function padVariant(index) {
  return String(index).padStart(2, '0');
}

/**
 * Clamp a background tolerance to `[0, MAX_BACKGROUND_TOLERANCE_SQ]` (rounded).
 * Non-finite input returns `fallback` (default 0).
 * @param {number} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function clampTolerance(value, fallback = 0) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_BACKGROUND_TOLERANCE_SQ, Math.round(value)));
}

/**
 * Normalize a raw pipeline manifest into a stable shape, dropping steps without
 * a usable `file`. Mirrors the monolith filter + label fallback
 * (`label ?? id ?? file`).
 * @param {unknown} raw
 * @returns {{profile:string|null, sourceRunId:string|null, steps:Array<{id:string|null,label:string,file:string}>}}
 */
export function normalizePipelineManifest(raw) {
  const empty = { profile: null, sourceRunId: null, steps: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  const steps = [];
  for (const step of rawSteps) {
    if (!step || typeof step !== 'object') continue;
    if (typeof step.file !== 'string' || step.file.length === 0) continue;
    const id = typeof step.id === 'string' && step.id.length > 0 ? step.id : null;
    const label =
      typeof step.label === 'string' && step.label.length > 0 ? step.label : (id ?? step.file);
    steps.push({ id, label, file: step.file });
  }
  return {
    profile: typeof raw.profile === 'string' && raw.profile.length > 0 ? raw.profile : null,
    sourceRunId:
      typeof raw.sourceRunId === 'string' && raw.sourceRunId.length > 0 ? raw.sourceRunId : null,
    steps,
  };
}

/**
 * Extract the run's persisted background tolerances from a run summary, if any.
 * Reads `summary.postprocessOverrides.options.background.{colorToleranceSq,
 * fringeToleranceSq}` (monolith `src/devtools-main.ts` ~5973-5987). Both must be
 * numbers or `null` is returned (caller then falls back to the defaults).
 * @param {unknown} summary
 * @returns {{colorToleranceSq:number, fringeToleranceSq:number}|null}
 */
export function extractAppliedBackgroundTweaks(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const overrides = summary.postprocessOverrides;
  if (!overrides || typeof overrides !== 'object') return null;
  const options = overrides.options;
  if (!options || typeof options !== 'object') return null;
  const bg = options.background;
  if (!bg || typeof bg !== 'object') return null;
  const { colorToleranceSq, fringeToleranceSq } = bg;
  if (typeof colorToleranceSq !== 'number' || typeof fringeToleranceSq !== 'number') return null;
  return { colorToleranceSq, fringeToleranceSq };
}

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the orchestration client. Composes a sidecar client; never duplicates
 * its builders. `fetchImpl` defaults to the global `fetch` (injectable for
 * tests).
 * @param {{ sidecarClient: object, fetchImpl?: typeof fetch }} deps
 */
export function createPostprocessClient(deps) {
  const sidecarClient = deps && deps.sidecarClient;
  if (!sidecarClient || typeof sidecarClient.baseUrl !== 'string') {
    throw new Error('createPostprocessClient requires a sidecarClient with a baseUrl');
  }
  const doFetch = (deps && deps.fetchImpl) || fetch;

  /**
   * Relay a live re-process to the sidecar. Never throws — any failure is
   * returned as `{ ok:false, reason, message }` so the client can degrade to the
   * pre-baked pipeline.
   * @param {{briefId:string, runId:string, rawPngBase64:string, options?:object}} args
   * @returns {Promise<{ok:true, finalPng:string, steps:Array<{id:string|null,label:string,png:string}>}|{ok:false, reason:string, message:string, status?:number|null}>}
   */
  async function relayLivePostprocess(args) {
    const { briefId, runId, rawPngBase64, options } = args || {};
    if (typeof rawPngBase64 !== 'string' || rawPngBase64.length === 0) {
      return { ok: false, reason: 'no-input', message: 'Missing raw PNG input.' };
    }
    let summary;
    try {
      summary = await sidecarClient.fetchRunSummary(briefId, runId);
    } catch (err) {
      return { ok: false, reason: 'summary-failed', message: errMessage(err) };
    }
    const briefPath =
      summary && typeof summary.briefPath === 'string' && summary.briefPath.length > 0
        ? summary.briefPath
        : null;
    if (!briefPath) {
      return {
        ok: false,
        reason: 'no-brief-path',
        message: 'Run summary has no briefPath; live re-processing is unavailable for this run.',
      };
    }
    const body = JSON.stringify({
      briefPath,
      rawPng: rawPngBase64,
      ...(options ? { options } : {}),
    });
    let res;
    try {
      res = await doFetch(sidecarClient.baseUrl + '/api/postprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      return { ok: false, reason: 'network', message: errMessage(err) };
    }
    if (!res || !res.ok) {
      let message = res ? `http-${res.status}` : 'no-response';
      try {
        const errBody = await res.json();
        if (errBody && typeof errBody.message === 'string') message = errBody.message;
      } catch {
        /* non-JSON error body — keep the http-<status> message */
      }
      return {
        ok: false,
        reason: 'postprocess-failed',
        message,
        status: res ? res.status : null,
      };
    }
    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      return { ok: false, reason: 'bad-response', message: errMessage(err) };
    }
    const finalPng =
      payload && typeof payload.finalPng === 'string' && payload.finalPng.length > 0
        ? payload.finalPng
        : null;
    if (!finalPng) {
      return { ok: false, reason: 'bad-response', message: 'Sidecar response missing finalPng.' };
    }
    const steps = Array.isArray(payload.steps)
      ? payload.steps
          .filter((s) => s && typeof s.png === 'string' && s.png.length > 0)
          .map((s) => ({
            id: typeof s.id === 'string' ? s.id : null,
            label:
              typeof s.label === 'string' && s.label.length > 0
                ? s.label
                : typeof s.id === 'string'
                  ? s.id
                  : '',
            png: s.png,
          }))
      : [];
    return { ok: true, finalPng, steps };
  }

  /**
   * Fetch + normalize the pre-baked pipeline manifest for a variant. Returns
   * `null` on any network/parse failure (caller shows "no trace available").
   * @param {string} briefId
   * @param {string} runId
   * @param {string} padded  two-digit variant index
   * @returns {Promise<ReturnType<typeof normalizePipelineManifest>|null>}
   */
  async function fetchPipelineManifest(briefId, runId, padded) {
    const url = sidecarClient.urls.processed(briefId, runId, `${padded}.pipeline.json`);
    let res;
    try {
      res = await doFetch(url, { cache: 'no-store' });
    } catch {
      return null;
    }
    if (!res || !res.ok) return null;
    let raw;
    try {
      raw = await res.json();
    } catch {
      return null;
    }
    return normalizePipelineManifest(raw);
  }

  return { relayLivePostprocess, fetchPipelineManifest };
}
