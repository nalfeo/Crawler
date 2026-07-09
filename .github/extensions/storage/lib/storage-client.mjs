/**
 * storage-client.mjs — Layer-2 domain adapter for the Azure storage-lifecycle
 * sidecar routes (`/api/storage/*`), the parity source for the `storage` canvas
 * extension. It mirrors what `src/devtools-main.ts` → `renderStorageLifecyclePage`
 * calls (`listStorageRuns` / `enrichStorageRuns` / `archiveStorageRuns` /
 * `deleteStorageRunsBatch`), but as a pure, dependency-injected module so it can
 * be unit-tested with a fake `fetchImpl` and reused by the extension server.
 *
 * DESTRUCTIVE OPS: `archiveRuns` / `deleteRuns` forward already-validated keys to
 * the sidecar. Callers MUST run `validateStorageKeys` first — the pure key
 * classifier here mirrors the sidecar's own `safeJoin` + split parsing EXACTLY so
 * a canvas request can never be looser than the monolith (project rule #12).
 *
 * @module storage/lib/storage-client
 */

// --- URL builders (pure) — 1:1 with scripts/sprites/sidecar/server.ts routes. ---

/**
 * @param {string} baseUrl
 * @param {{ scope?: string, search?: string }} [opts]
 * @returns {string}
 */
export function storageRunsUrl(baseUrl, opts = {}) {
  const params = new URLSearchParams();
  if (opts.scope) params.set('scope', opts.scope);
  if (typeof opts.search === 'string' && opts.search.length > 0) params.set('search', opts.search);
  const query = params.toString();
  return query ? `${baseUrl}/api/storage/runs?${query}` : `${baseUrl}/api/storage/runs`;
}

/** @param {string} baseUrl */
export function storageEnrichUrl(baseUrl) {
  return `${baseUrl}/api/storage/runs/enrich`;
}

/** @param {string} baseUrl */
export function storageArchiveUrl(baseUrl) {
  return `${baseUrl}/api/storage/runs/archive`;
}

/** @param {string} baseUrl */
export function storageDeleteUrl(baseUrl) {
  return `${baseUrl}/api/storage/runs/delete`;
}

// --- Key classification / validation (pure) — mirrors sidecar parse + safeJoin. ---

/**
 * A key segment is safe iff it is a non-empty string that is not `.`/`..` and
 * contains no backslash or NUL. Segments come from `split('/')` so they cannot
 * contain `/`. This matches `safeJoin` in scripts/sprites/sidecar/server.ts.
 * @param {unknown} segment
 * @returns {boolean}
 */
function isSafeSegment(segment) {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  );
}

/**
 * Classify a storage key exactly like the sidecar's archive/delete routes:
 *   - `archive/` prefix ⇒ archive-scope; remaining segments must be `briefId/runId`.
 *   - otherwise ⇒ active-scope; segments must be `briefId/runId`.
 * Returns the scope kind, or `null` if the key is malformed / unsafe.
 * @param {unknown} key
 * @returns {'active' | 'archive' | null}
 */
export function classifyStorageKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  const archive = key.startsWith('archive/');
  const parts = key.split('/');
  const scopeParts = archive ? parts.slice(1) : parts;
  if (scopeParts.length !== 2) return null;
  if (!isSafeSegment(scopeParts[0]) || !isSafeSegment(scopeParts[1])) return null;
  return archive ? 'archive' : 'active';
}

/**
 * Validate a batch of keys for a destructive op.
 *   - Empty / non-array ⇒ `{ ok:false, invalidKeys:[] }` with a message.
 *   - `allowArchive:false` (archive op) rejects any archive-scope key — the
 *     monolith archives ACTIVE runs only (`!key.startsWith('archive/')`).
 *   - `allowArchive:true` (delete op) accepts both scopes.
 * Any malformed key poisons the whole batch — we never forward a partial
 * destructive request. The offending keys are returned so the client can prune
 * its selection and tell the user which key was bad.
 * @param {unknown} keys
 * @param {{ allowArchive?: boolean }} [options]
 * @returns {{ ok: boolean, message?: string, invalidKeys: string[] }}
 */
export function validateStorageKeys(keys, options = {}) {
  const allowArchive = options.allowArchive === true;
  if (!Array.isArray(keys) || keys.length === 0) {
    return { ok: false, message: 'No keys provided.', invalidKeys: [] };
  }
  const invalidKeys = [];
  for (const key of keys) {
    const kind = classifyStorageKey(key);
    if (kind === null || (kind === 'archive' && !allowArchive)) {
      invalidKeys.push(typeof key === 'string' ? key : String(key));
    }
  }
  if (invalidKeys.length > 0) {
    return {
      ok: false,
      message: allowArchive
        ? 'One or more keys are malformed.'
        : 'One or more keys are not archivable active-scope keys.',
      invalidKeys,
    };
  }
  return { ok: true, invalidKeys: [] };
}

// --- Normalizers (defensive) — harden the trust boundary against odd payloads. ---

/**
 * @param {unknown} payload
 * @returns {Array<{ briefId: string, runId: string, timestamp: string | null, summaryKey: string | null }>}
 */
export function normalizeStorageRuns(payload) {
  const runs = payload && Array.isArray(payload.runs) ? payload.runs : [];
  return runs
    .filter((run) => run && typeof run.briefId === 'string' && typeof run.runId === 'string')
    .map((run) => ({
      briefId: run.briefId,
      runId: run.runId,
      timestamp: typeof run.timestamp === 'string' ? run.timestamp : null,
      summaryKey: typeof run.summaryKey === 'string' ? run.summaryKey : null,
    }));
}

/**
 * Enrichment is transported as an ARRAY (never an object map) so a hostile
 * `briefId`/`runId` cannot smuggle a `__proto__` key; the client builds its own
 * Map from this array.
 * @param {unknown} payload
 * @returns {Array<{ briefId: string, runId: string, variantCount: number | null, sheetFile: string | null, approvedCount: number, firstApproved: { runId: string, variantIndex: number } | null, briefStored: boolean }>}
 */
export function normalizeEnrichment(payload) {
  const enriched = payload && Array.isArray(payload.enriched) ? payload.enriched : [];
  return enriched
    .filter((e) => e && typeof e.briefId === 'string' && typeof e.runId === 'string')
    .map((e) => ({
      briefId: e.briefId,
      runId: e.runId,
      variantCount: typeof e.variantCount === 'number' ? e.variantCount : null,
      sheetFile: typeof e.sheetFile === 'string' ? e.sheetFile : null,
      approvedCount: typeof e.approvedCount === 'number' ? e.approvedCount : 0,
      firstApproved:
        e.firstApproved &&
        typeof e.firstApproved === 'object' &&
        typeof e.firstApproved.runId === 'string' &&
        typeof e.firstApproved.variantIndex === 'number'
          ? { runId: e.firstApproved.runId, variantIndex: e.firstApproved.variantIndex }
          : null,
      briefStored: e.briefStored === true,
    }));
}

// --- Client (I/O via injectable fetchImpl). ---

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Create a storage client bound to a sidecar base URL.
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch }} config
 */
export function createStorageClient(config = {}) {
  const { baseUrl } = config;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('createStorageClient requires a non-empty baseUrl');
  }
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new TypeError('createStorageClient requires a fetch implementation');
  }

  /**
   * @param {{ scope?: string, search?: string }} [opts]
   */
  async function listRuns(opts = {}) {
    const scope = opts.scope === 'archive' ? 'archive' : 'active';
    const search = typeof opts.search === 'string' ? opts.search : '';
    const response = await doFetch(storageRunsUrl(baseUrl, { scope, search }), {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`storage list failed: HTTP ${response.status}`);
    }
    return normalizeStorageRuns(await readJson(response));
  }

  /**
   * @param {'active' | 'archive'} scope
   * @param {ReadonlyArray<{ briefId: string, runId: string }>} runs
   */
  async function enrichRuns(scope, runs) {
    const body = JSON.stringify({
      scope: scope === 'archive' ? 'archive' : 'active',
      runs: (Array.isArray(runs) ? runs : []).map((run) => ({
        briefId: run.briefId,
        runId: run.runId,
      })),
    });
    const response = await doFetch(storageEnrichUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`storage enrich failed: HTTP ${response.status}`);
    }
    return normalizeEnrichment(await readJson(response));
  }

  /**
   * Forward a validated ARCHIVE batch to the sidecar. Keys MUST be pre-validated
   * with `validateStorageKeys(keys, { allowArchive: false })`.
   * @param {string[]} keys
   */
  async function archiveRuns(keys) {
    const response = await doFetch(storageArchiveUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
      cache: 'no-store',
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const detail = payload && typeof payload.message === 'string' ? ` (${payload.message})` : '';
      throw new Error(`storage archive failed: HTTP ${response.status}${detail}`);
    }
    return {
      ok: Boolean(payload && payload.ok === true),
      archived: payload && Array.isArray(payload.archived) ? payload.archived : [],
      skipped: payload && Array.isArray(payload.skipped) ? payload.skipped : [],
    };
  }

  /**
   * Forward a validated DELETE batch to the sidecar. Keys MUST be pre-validated
   * with `validateStorageKeys(keys, { allowArchive: true })`.
   * @param {string[]} keys
   */
  async function deleteRuns(keys) {
    const response = await doFetch(storageDeleteUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
      cache: 'no-store',
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const detail = payload && typeof payload.message === 'string' ? ` (${payload.message})` : '';
      throw new Error(`storage delete failed: HTTP ${response.status}${detail}`);
    }
    return {
      ok: Boolean(payload && payload.ok === true),
      deleted: payload && Array.isArray(payload.deleted) ? payload.deleted : [],
    };
  }

  return { baseUrl, listRuns, enrichRuns, archiveRuns, deleteRuns };
}
