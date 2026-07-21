/**
 * postprocess-client.mjs — layer-2 orchestration for the postprocess debugger.
 *
 * This module composes an already-constructed sidecar client (from
 * `sidecar-client.mjs`) — it never re-implements URL builders or normalizers.
 * It owns exactly the sidecar interactions the postprocess page needs on top
 * of the shared read APIs:
 *
 *   1. `relayLivePostprocess` — server-side relay of a live re-process. The
 *      browser computes the raw input PNG (a sheet-cell crop, or the stored raw
 *      cell as a fallback) and POSTs base64 to our loopback server; this relay
 *      resolves the run's `briefPath` from its summary and forwards it to the
 *      sidecar `POST /api/postprocess`. Mirrors the monolith `livePostprocess`
 *      body `{ briefPath, rawPng, options }` (`src/devtools-main.ts` ~442-466).
 *   2. `relayPersistPostprocess` — server-side relay of the "Apply changes"
 *      persist write to `POST /api/runs/:briefId/:runId/postprocess`, re-fetching
 *      the run summary afterward for read-back. Paired with the PURE
 *      `normalizePersistRequest` (validate) + `buildPersistPostprocessPayload`
 *      (byte-parity body) + `isDestructivePersist` (confirm predicate) exports.
 *   3. `fetchPipelineManifest` — the pre-baked `<padded>.pipeline.json` fallback
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
 * Collect the sorted, unique variant indices from a run summary's candidates.
 * Extracted (not duplicated) so both the standalone Postprocess canvas AND the
 * embedded `/postprocess/*` surface under the Sprite Generation Workflow canvas
 * build the exact same variant-picker list from the same run summary shape.
 * @param {unknown} summary
 * @returns {number[]}
 */
export function collectVariantIndices(summary) {
  const candidates =
    summary && typeof summary === 'object' && Array.isArray(summary.candidates)
      ? summary.candidates
      : [];
  const seen = new Set();
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof c.index === 'number' && c.index >= 0) {
      seen.add(c.index);
    }
  }
  return [...seen].sort((a, b) => a - b);
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

/**
 * Extract the run's persisted facing override, if any. Reads
 * `summary.postprocessOverrides.facing.{direction,applyToAllVariants}` (monolith
 * `src/devtools-main.ts` ~5988-5998). `direction` must be `'left'|'right'` or
 * `null` is returned (caller then seeds the default `'right'`).
 * @param {unknown} summary
 * @returns {{direction:'left'|'right', applyToAllVariants:boolean}|null}
 */
export function extractAppliedFacing(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const overrides = summary.postprocessOverrides;
  if (!overrides || typeof overrides !== 'object') return null;
  const facing = overrides.facing;
  if (!facing || typeof facing !== 'object') return null;
  const direction =
    facing.direction === 'left' ? 'left' : facing.direction === 'right' ? 'right' : null;
  if (!direction) return null;
  return { direction, applyToAllVariants: facing.applyToAllVariants === true };
}

/**
 * Extract the run's persisted manual anchor, if any. Reads
 * `summary.postprocessOverrides.manualAnchor.{variantIndex,x,y,applyToAllVariants}`
 * (monolith `src/devtools-main.ts` ~5999-6019). `variantIndex`/`x`/`y` must all be
 * numbers or `null` is returned.
 * @param {unknown} summary
 * @returns {{variantIndex:number, x:number, y:number, applyToAllVariants:boolean}|null}
 */
export function extractAppliedManualAnchor(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const overrides = summary.postprocessOverrides;
  if (!overrides || typeof overrides !== 'object') return null;
  const manual = overrides.manualAnchor;
  if (!manual || typeof manual !== 'object') return null;
  const { variantIndex, x, y } = manual;
  if (typeof variantIndex !== 'number' || typeof x !== 'number' || typeof y !== 'number') {
    return null;
  }
  return { variantIndex, x, y, applyToAllVariants: manual.applyToAllVariants === true };
}

/**
 * True when a persist would clobber existing overrides and so deserves a confirm
 * prompt: a `reset` (clears all overrides) or any `applyToAll` write (stamps every
 * variant). The monolith itself has no confirm; this extra guard is an
 * intentional safety affordance for the canvas tool.
 * @param {{mode?:string, applyToAll?:boolean}} args
 * @returns {boolean}
 */
export function isDestructivePersist(args) {
  if (!args || typeof args !== 'object') return false;
  return args.mode === 'reset' || args.applyToAll === true;
}

/**
 * Validate + normalize a raw `/api/persist-postprocess` request body into the
 * argument bag the pure payload builder consumes. Pure (no I/O) so the server's
 * highest-risk branch (never trust the client) is unit-testable. Returns
 * `{ok:true, args}` or `{ok:false, error}`.
 *
 * A `reset` needs only `briefId`/`runId`. A `replace` additionally requires a
 * non-negative integer `variantIndex` and a `facingDirection` of `'left'|'right'`;
 * `manualAnchor` is honored only when NOT clearing and both coords are finite
 * (mirrors the monolith `syncManualAnchorFromInputs` no-op on NaN), and tolerances
 * are clamped with the shared defaults.
 * @param {unknown} body
 * @returns {{ok:true, args:object}|{ok:false, error:string}}
 */
export function normalizePersistRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const briefId = typeof body.briefId === 'string' && body.briefId.length > 0 ? body.briefId : null;
  const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : null;
  if (!briefId || !runId) return { ok: false, error: 'briefId and runId are required' };
  const mode = body.mode === 'reset' ? 'reset' : body.mode === 'replace' ? 'replace' : null;
  if (!mode) return { ok: false, error: 'mode must be "replace" or "reset"' };
  if (mode === 'reset') return { ok: true, args: { briefId, runId, mode: 'reset' } };

  const variantIndex = Number(body.variantIndex);
  if (!Number.isInteger(variantIndex) || variantIndex < 0) {
    return { ok: false, error: 'variantIndex must be a non-negative integer' };
  }
  const facingDirection =
    body.facingDirection === 'left' ? 'left' : body.facingDirection === 'right' ? 'right' : null;
  if (!facingDirection) return { ok: false, error: 'facingDirection must be "left" or "right"' };
  const applyToAll = body.applyToAll === true;
  const manualAnchorClear = body.manualAnchorClear === true;
  let manualAnchor;
  if (!manualAnchorClear && body.manualAnchor && typeof body.manualAnchor === 'object') {
    const x = Number(body.manualAnchor.x);
    const y = Number(body.manualAnchor.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      manualAnchor = { x: Math.trunc(x), y: Math.trunc(y) };
    }
  }
  const colorToleranceSq = clampTolerance(
    Number(body.colorToleranceSq),
    DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
  );
  const fringeToleranceSq = clampTolerance(
    Number(body.fringeToleranceSq),
    DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
  );
  return {
    ok: true,
    args: {
      briefId,
      runId,
      mode: 'replace',
      variantIndex,
      applyToAll,
      facingDirection,
      manualAnchorClear,
      manualAnchor,
      colorToleranceSq,
      fringeToleranceSq,
    },
  };
}

/**
 * Build the exact sidecar persist payload from normalized args. PURE — byte-for-byte
 * parity with the monolith "Apply changes" body (`src/devtools-main.ts` ~5717-5754):
 *   - `reset` → `{ mode:'reset' }` (all extras ignored).
 *   - `replace` → `{ mode:'replace', options.background{...clamped}, facing{variantIndex,
 *     direction, applyToAllVariants?}, manualAnchor?, variantIndexes? }` where
 *     `manualAnchor` is tri-state (null=clear, {x,y}=set, omitted=leave) and
 *     `variantIndexes:[variantIndex]` is present ONLY for a single-variant write.
 * @param {object} args  output of {@link normalizePersistRequest}'s `args`
 * @returns {object}
 */
export function buildPersistPostprocessPayload(args) {
  if (!args || typeof args !== 'object' || args.mode === 'reset') {
    return { mode: 'reset' };
  }
  const {
    variantIndex,
    applyToAll,
    facingDirection,
    colorToleranceSq,
    fringeToleranceSq,
    manualAnchorClear,
    manualAnchor,
  } = args;
  const payload = {
    mode: 'replace',
    options: {
      background: {
        colorToleranceSq: clampTolerance(
          colorToleranceSq,
          DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
        ),
        fringeToleranceSq: clampTolerance(
          fringeToleranceSq,
          DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
        ),
      },
    },
    facing: {
      variantIndex,
      direction: facingDirection,
      ...(applyToAll ? { applyToAllVariants: true } : {}),
    },
  };
  let manualAnchorPayload;
  if (manualAnchorClear) {
    manualAnchorPayload = null;
  } else if (manualAnchor && Number.isFinite(manualAnchor.x) && Number.isFinite(manualAnchor.y)) {
    manualAnchorPayload = {
      variantIndex,
      x: manualAnchor.x,
      y: manualAnchor.y,
      ...(applyToAll ? { applyToAllVariants: true } : {}),
    };
  } else {
    manualAnchorPayload = undefined;
  }
  if (manualAnchorPayload !== undefined) payload.manualAnchor = manualAnchorPayload;
  if (!applyToAll) payload.variantIndexes = [variantIndex];
  return payload;
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
   * Relay a persist-postprocess write to the sidecar, then re-fetch the run
   * summary so the caller can seed the panel from the freshly-persisted overrides.
   * Never throws — any failure is `{ ok:false, reason, message }`. On success the
   * read-back summary is best-effort: a persist that succeeded but whose re-fetch
   * failed still returns `{ ok:true, summary:null }` (the write DID happen).
   * @param {{briefId:string, runId:string, payload:object}} args
   * @returns {Promise<{ok:true, summary:object|null}|{ok:false, reason:string, message:string, status?:number|null}>}
   */
  async function relayPersistPostprocess(args) {
    const { briefId, runId, payload } = args || {};
    if (typeof briefId !== 'string' || !briefId || typeof runId !== 'string' || !runId) {
      return { ok: false, reason: 'bad-request', message: 'briefId and runId are required' };
    }
    if (!payload || typeof payload !== 'object') {
      return { ok: false, reason: 'bad-request', message: 'payload is required' };
    }
    let res;
    try {
      res = await doFetch(sidecarClient.urls.runPostprocess(briefId, runId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
        reason: 'persist-failed',
        message,
        status: res ? res.status : null,
      };
    }
    // Write succeeded — read back the summary so the caller reflects the new
    // persisted overrides. Best-effort: a failed re-fetch does not undo the write.
    let summary = null;
    try {
      summary = await sidecarClient.fetchRunSummary(briefId, runId);
    } catch {
      summary = null;
    }
    return { ok: true, summary };
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

  return { relayLivePostprocess, relayPersistPostprocess, fetchPipelineManifest };
}
