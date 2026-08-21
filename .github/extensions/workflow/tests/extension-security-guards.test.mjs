/**
 * Source-wiring guards for extension.mjs's mutating routes. Mirrors the
 * pattern the (now-removed) standalone Sprite Review canvas used: these are
 * intentionally SOURCE-TEXT assertions (not live HTTP calls) because
 * `extension.mjs` performs a top-level `joinSession()` side effect on import,
 * so it cannot be safely `import`-ed in a plain unit test. The actual runtime
 * behavior of the shared guards themselves (token/origin/content-type checks,
 * body-size limit) is covered by
 * `../../shared/tests/sprite-feedback-request*.test.mjs` and
 * `mutation-security*.test.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, '..', 'extension.mjs');

test('the /api/feedback mutation route enforces token, origin, and content-type guards', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /path: '\/api\/feedback'/);
  assert.match(source, /isTrustedMutationOrigin\(req, entry\)/);
  assert.match(source, /forbidden-origin/);
  assert.match(source, /x-workflow-mutation-token/);
  assert.match(source, /isJsonContentType\(req\)/);
  assert.match(source, /unsupported-media-type/);
  assert.match(source, /body-too-large/);
});

test('REGRESSION (HARD GATE): the /api/feedback handler never calls buildState()/pushState() — a confirm must not recreate the loaded sheet', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  const routeStart = source.indexOf("path: '/api/feedback'");
  assert.ok(routeStart >= 0, 'the /api/feedback route must exist');
  // Slice from the route declaration to the START of the next route/handler
  // block (the /api/accept route immediately follows it) so this assertion is
  // scoped to ONLY the feedback handler's body, not the whole file.
  const nextRouteStart = source.indexOf("path: '/api/accept'", routeStart);
  assert.ok(nextRouteStart > routeStart, 'the /api/accept route must follow /api/feedback');
  const handlerSource = source.slice(routeStart, nextRouteStart);
  assert.doesNotMatch(
    handlerSource,
    /buildState\(instanceId\)/,
    'the feedback handler must not rebuild full state — that recreates the sheet <img>/loading UI on every confirm',
  );
  assert.doesNotMatch(
    handlerSource,
    /pushState\?\.\(/,
    'the feedback handler must not broadcast a full state via SSE on every confirm',
  );
  // The response IS the scoped patch — verify it stays a bare { feedback } reply.
  assert.match(handlerSource, /return \{ json: \{ feedback \} \};/);
});

test('the /api/accept mutation route enforces the mutation-token guard', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /path: '\/api\/accept'/);
  assert.match(
    source,
    /tokensMatch\(req\.headers\['x-workflow-mutation-token'\], entry\.mutationToken\)/,
  );
});

test('authoring mutations reuse token, origin, and JSON guards without a queue-consumer route', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  for (const route of [
    'request',
    'synthesize',
    'brief',
    'generate',
    'postprocess',
    'judge',
    'approve',
    'metadata',
    'rewind',
  ]) {
    assert.match(source, new RegExp(`path: '\\/api\\/workflow\\/${route}'`));
  }
  assert.match(source, /function workflowMutationRoute\(/);
  assert.match(source, /isTrustedMutationOrigin\(req, entry\)/);
  assert.match(source, /isJsonContentType\(req\)/);
  assert.match(
    source,
    /tokensMatch\(req\.headers\['x-workflow-mutation-token'\], entry\.mutationToken\)/,
  );
  assert.match(source, /path: '\/api\/workflow\/refresh'/);
  assert.match(source, /method: 'POST',\s*\n\s*path: '\/api\/workflow\/refresh'/);
  assert.doesNotMatch(source, /workflow\/worker\/start/);
});

test('Azure polling pushes an iframe update only when a queued generation completes', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /let changed = false/);
  assert.match(source, /changed = true/);
  assert.match(source, /\.then\(\(\{ changed \}\) => \(changed \? forceLiveState/);
  assert.match(source, /\.then\(\(state\) => \(state \? entry\.pushState\(state\) : null\)\)/);
});

test('transient authoring phases recover to their prior retryable phase with an error', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /path: '\/api\/workflow\/synthesize'/);
  assert.match(source, /stage: 'draft',\s*lastError: error\?\.message/);
  assert.match(source, /path: '\/api\/workflow\/postprocess'/);
  assert.match(source, /stage: 'sheet',\s*lastError: error\?\.message/);
  assert.match(source, /path: '\/api\/workflow\/judge'/);
  assert.match(source, /stage: 'postprocessed',\s*lastError: error\?\.message/);
  assert.match(source, /path: '\/api\/workflow\/metadata'/);
  assert.match(source, /stage: priorStage,\s*lastError: error\?\.message/);
});

test('feedback and plan/brief content routes import the shared (not duplicated) helpers', () => {
  const source = readFileSync(EXTENSION_PATH, 'utf8');
  assert.match(source, /from '\.\.\/shared\/sprite-feedback-store\.mjs'/);
  assert.match(source, /from '\.\.\/shared\/sprite-feedback-request\.mjs'/);
});
