/**
 * Source-wiring guards for the EMBEDDED Postprocess Debugger's `/postprocess/*`
 * routes in extension.mjs. Mirrors `extension-security-guards.test.mjs`'s
 * pattern: these are intentionally SOURCE-TEXT assertions (not live HTTP
 * calls) because `extension.mjs` performs a top-level `joinSession()` side
 * effect on import, so it cannot be safely `import`-ed in a plain unit test.
 *
 * The actual runtime behavior of the shared guards (token/origin/content-type
 * checks, ownership/staleness) is covered by:
 *   - `postprocess-embed-persist-http.test.mjs` (real HTTP server, full guard
 *     chain for `/postprocess/api/persist-postprocess`).
 *   - `postprocess-embed-selection-ownership.test.mjs` (the versioned
 *     selection-ownership guard, reproduced against a fake sidecar client).
 *   - `../../postprocess/tests/*.test.mjs` (the underlying pure modules this
 *     canvas reuses verbatim — `postprocess-client.mjs`, `run-selection.mjs`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, '..', 'extension.mjs');
const source = readFileSync(EXTENSION_PATH, 'utf8');

test('the embedded Postprocess Debugger reuses ONE sidecar connection and ONE sidecar-startup owner', () => {
  // No second createSidecarClient/beginSpriteSidecarStartup call for postprocess.
  assert.match(source, /createPostprocessClient\(\{ sidecarClient: client \}\)/);
  assert.match(source, /createPostprocessClient\(\{ sidecarClient: entry\.client \}\)/);
  const beginCalls = (source.match(/beginSpriteSidecarStartup\(/g) || []).length;
  assert.equal(
    beginCalls,
    1,
    'exactly one sidecar-startup owner for both Workflow and embedded Postprocess',
  );
  // Rebind must rebuild the postprocess client alongside entry.client so it
  // never holds a stale closed-over sidecar client after a restart.
  const rebindStart = source.indexOf('rebindClients: (url) => {');
  const rebindEnd = source.indexOf('},', rebindStart);
  const rebindBody = source.slice(rebindStart, rebindEnd);
  assert.match(rebindBody, /entry\.client = createSidecarClient/);
  assert.match(rebindBody, /entry\.postprocess\.client = createPostprocessClient/);
});

test('entry.postprocess carries its OWN versioned selection substate, initialized alongside the rest of entry', () => {
  assert.match(source, /postprocess: \{\s*\n\s*client: createPostprocessClient/);
  assert.match(
    source,
    /selectionVersion: 0,\s*\n\s*stateCache: new Map\(\),\s*\n\s*revalidatingKeys: new Set\(\),\s*\n\s*sseClients: new Set\(\)/,
  );
});

test('every Postprocess transport path is namespaced under /postprocess/*', () => {
  for (const routePath of [
    "path: '/postprocess/'",
    "path: '/postprocess/api/state'",
    "path: '/postprocess/api/select'",
    "path: '/postprocess/api/runs'",
    "path: '/postprocess/api/live-postprocess'",
    "path: '/postprocess/api/persist-postprocess'",
    "path: '/postprocess/events'",
    "imageRoute('/postprocess/img/sheet', 'sheet')",
    "imageRoute('/postprocess/img/processed', 'processed')",
    "imageRoute('/postprocess/img/raw', 'raw')",
  ]) {
    assert.ok(source.includes(routePath), `missing namespaced route: ${routePath}`);
  }
});

test('the /postprocess/ HTML route seeds entry.postprocess.requested/selected from its OWN query string before rendering', () => {
  const routeStart = source.indexOf("path: '/postprocess/'");
  const routeEnd = source.indexOf("path: '/postprocess/api/state'");
  const body = source.slice(routeStart, routeEnd);
  assert.match(body, /url\.searchParams\.get\('briefId'\)/);
  assert.match(body, /url\.searchParams\.get\('runId'\)/);
  assert.match(body, /url\.searchParams\.get\('variantIndex'\)/);
  assert.match(body, /url\.searchParams\.get\('sheet'\)/);
  assert.match(body, /pp\.selectionVersion \+= 1/);
  assert.match(body, /renderPostprocessHtml\(instanceId, '\/postprocess', entry\.mutationToken\)/);
  // Writes text/html directly and returns undefined so the harness's
  // `res.headersSent` early-return applies (no double JSON envelope).
  assert.match(body, /'Content-Type': 'text\/html; charset=utf-8'/);
  assert.match(body, /return undefined;/);
});

test('/postprocess/api/persist-postprocess enforces the FULL mutation guard chain (origin, token, content-type, body-size, error-shape)', () => {
  const routeStart = source.indexOf("path: '/postprocess/api/persist-postprocess'");
  const routeEnd = source.indexOf("path: '/postprocess/events'");
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const body = source.slice(routeStart, routeEnd);
  assert.match(body, /isTrustedMutationOrigin\(req, entry\)/);
  assert.match(body, /forbidden-origin/);
  assert.match(
    body,
    /tokensMatch\(req\.headers\['x-workflow-mutation-token'\], entry\.mutationToken\)/,
  );
  assert.match(body, /isJsonContentType\(req\)/);
  assert.match(body, /unsupported-media-type/);
  assert.match(body, /body-too-large/);
  assert.match(body, /normalizePersistRequest\(body\)/);
  assert.match(body, /buildPersistPostprocessPayload\(normalized\.args\)/);
  // Success bumps selectionVersion and re-seeds — same pattern as /api/select.
  assert.match(body, /pp\.selectionVersion \+= 1/);
});

test('/postprocess/api/live-postprocess is origin-checked but NOT token-gated (non-persisting preview relay, matches the standalone canvas)', () => {
  const routeStart = source.indexOf("path: '/postprocess/api/live-postprocess'");
  const routeEnd = source.indexOf("path: '/postprocess/api/persist-postprocess'");
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const body = source.slice(routeStart, routeEnd);
  assert.match(body, /isTrustedMutationOrigin\(req, entry\)/);
  assert.doesNotMatch(body, /tokensMatch\(/);
  assert.match(body, /readJsonBody\(req, 8 \* 1024 \* 1024\)/);
});

test('/postprocess/api/select and success paths do NOT double-broadcast over /postprocess/events (avoids a duplicate live-postprocess relay)', () => {
  const selectStart = source.indexOf("path: '/postprocess/api/select'");
  const selectEnd = source.indexOf("path: '/postprocess/api/runs'");
  const selectBody = source.slice(selectStart, selectEnd);
  assert.doesNotMatch(selectBody, /sseClients/);
  const persistStart = source.indexOf("path: '/postprocess/api/persist-postprocess'");
  const persistEnd = source.indexOf("path: '/postprocess/events'");
  const persistBody = source.slice(persistStart, persistEnd);
  assert.doesNotMatch(persistBody, /for \(const client of/);
});

test('buildPostprocessState captures a version BEFORE awaiting and only commits entry.postprocess.selected if nothing newer landed', () => {
  const fnStart = source.indexOf('async function buildPostprocessState(instanceId,');
  const fnEnd = source.indexOf('/** Relay a sidecar image');
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const body = source.slice(fnStart, fnEnd);
  assert.match(body, /const versionAtCall = pp\.selectionVersion;/);
  assert.ok(
    body.indexOf('const versionAtCall = pp.selectionVersion;') <
      body.indexOf('await entry.client.probeHealth()'),
    'selection ownership must be captured before the first sidecar await',
  );
  assert.match(body, /if \(pp\.selectionVersion === versionAtCall\) \{/);
});

test('exact Postprocess contexts paint cache-first while a single background revalidation refreshes the immutable run view', () => {
  const fnStart = source.indexOf('async function buildPostprocessState(instanceId,');
  const fnEnd = source.indexOf('/** Relay a sidecar image');
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const body = source.slice(fnStart, fnEnd);
  assert.match(body, /pp\.stateCache\.has\(targetKey\)/);
  assert.match(body, /return \{ \.\.\.cached, stale: true \};/);
  assert.match(body, /pp\.revalidatingKeys\.has\(targetKey\)/);
  assert.match(body, /buildPostprocessState\(instanceId, \{ bypassCache: true \}\)/);
  assert.match(source, /pp\.stateCache\.clear\(\);/);
});

test('the embedded img routes reuse the SAME imageRoute handler (same entry.client + shared imageCache) — no duplicated cache/state', () => {
  const binaryRoutesStart = source.indexOf('const binaryRoutes = [');
  const binaryRoutesEnd = source.indexOf('async function ensureServer(ctx)');
  const body = source.slice(binaryRoutesStart, binaryRoutesEnd);
  assert.match(body, /imageRoute\('\/img\/sheet', 'sheet'\)/);
  assert.match(body, /imageRoute\('\/postprocess\/img\/sheet', 'sheet'\)/);
  assert.match(body, /imageRoute\('\/postprocess\/img\/processed', 'processed'\)/);
  assert.match(body, /imageRoute\('\/postprocess\/img\/raw', 'raw'\)/);
});
