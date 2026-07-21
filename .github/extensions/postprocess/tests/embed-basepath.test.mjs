/**
 * Unit tests for `renderHtml`'s `basePath`/`mutationToken` parameterization
 * (the embed-postprocess-workflow consolidation): standalone behavior
 * (basePath omitted) must stay byte-identical in shape to before, and the
 * embedded shape (a non-empty basePath) must namespace EVERY transport path
 * — HTML/root is the caller's responsibility (workflow/extension.mjs writes
 * it directly), state/select/runs/live-postprocess/persist-postprocess/
 * images/SSE all live in the CLIENT SCRIPT this module renders — plus wire
 * the same-origin postMessage 'postprocess:ready' / 'postprocess:select'
 * bridge that ONLY activates when embedded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../renderer.mjs';

test('standalone (no basePath) keeps root-relative transport, unchanged from before', () => {
  const html = renderHtml('x');
  assert.match(html, /var BASE = "";/);
  assert.match(html, /var EMBED_TOKEN = "";/);
  assert.match(html, /var EMBEDDED = !!BASE;/);
  assert.doesNotMatch(html, /__POSTPROCESS_BASE_PATH__/);
  assert.doesNotMatch(html, /__POSTPROCESS_MUTATION_TOKEN__/);
  assert.match(html, /BASE \+ '\/api\/select\?briefId=/);
  assert.match(html, /fetch\(BASE \+ '\/api\/state'\)/);
  assert.match(html, /new EventSource\(BASE \+ '\/events'\)/);
  assert.match(html, /BASE \+ '\/img\/' \+ kind/);
});

test('an embedded basePath namespaces every transport call site', () => {
  const html = renderHtml('x', '/postprocess', 'tok-123');
  assert.match(html, /var BASE = "\/postprocess";/);
  assert.match(html, /var EMBED_TOKEN = "tok-123";/);
  for (const needle of [
    "fetch(BASE + '/api/state')",
    "BASE + '/api/select?briefId=",
    "fetch(BASE + '/api/live-postprocess'",
    "fetch(BASE + '/api/persist-postprocess'",
    "new EventSource(BASE + '/events')",
    "BASE + '/img/' + kind",
  ]) {
    assert.ok(html.includes(needle), `missing namespaced call site: ${needle}`);
  }
});

test('the mutation token is sent ONLY on the persisting Apply-changes write, and only when non-empty', () => {
  const embedded = renderHtml('x', '/postprocess', 'tok-123');
  assert.match(
    embedded,
    /if \(EMBED_TOKEN\) persistHeaders\['x-workflow-mutation-token'\] = EMBED_TOKEN;/,
  );
  assert.match(
    embedded,
    /fetch\(BASE \+ '\/api\/persist-postprocess', \{\s*\n\s*method: 'POST', headers: persistHeaders,/,
  );
  // live-postprocess (a non-persisting preview) never carries the token.
  assert.doesNotMatch(
    embedded.slice(
      embedded.indexOf("fetch(BASE + '/api/live-postprocess'"),
      embedded.indexOf("fetch(BASE + '/api/live-postprocess'") + 400,
    ),
    /x-workflow-mutation-token/,
  );
});

test('the standalone canvas guards the embedded postMessage bridge behind EMBEDDED (BASE non-empty) — no-op parent chatter when standalone', () => {
  const html = renderHtml('x');
  // The functions exist unconditionally (same client script for both
  // surfaces), but are behaviorally inert without a basePath: notifyReady()
  // no-ops immediately, and the 'postprocess:select' listener is only
  // REGISTERED when EMBEDDED.
  assert.match(html, /if \(!EMBEDDED\) return;/);
  assert.match(html, /if \(EMBEDDED\) \{\s*\n\s*window\.addEventListener\('message'/);
});

test('an embedded document notifies the same-origin parent after every completed selection render', () => {
  const html = renderHtml('x', '/postprocess', 'tok');
  assert.match(html, /function notifyReady\(state\)/);
  assert.match(html, /if \(!EMBEDDED\) return;/);
  assert.doesNotMatch(html, /readyNotified/);
  assert.match(html, /typeof window\.parent\.__workflowPostprocessReady === 'function'/);
  assert.match(html, /window\.parent\.__workflowPostprocessReady\(context\)/);
  assert.match(html, /type: 'postprocess:ready'/);
  assert.match(html, /window\.parent\.postMessage\(\{/);
  assert.match(html, /window\.location\.origin\);/);
  // notifyReady is called from every render() exit that actually painted.
  const notifyCalls = (html.match(/notifyReady\(state\);/g) || []).length;
  assert.equal(
    notifyCalls,
    3,
    'degraded, no-runs, and the full pipeline paint must all signal ready',
  );
});

test('an embedded document listens for a same-origin "postprocess:select" message and retargets via the EXISTING select()', () => {
  const html = renderHtml('x', '/postprocess', 'tok');
  assert.match(html, /window\.addEventListener\('message', function \(ev\) \{/);
  assert.match(
    html,
    /if \(ev\.source !== window\.parent \|\| ev\.origin !== window\.location\.origin\) return;/,
  );
  assert.match(html, /if \(!msg \|\| msg\.type !== 'postprocess:select'\) return;/);
  // Reuses select() — no separate document-reload retargeting path.
  assert.match(
    html,
    /select\(\s*\n\s*msg\.briefId, msg\.runId,\s*\n\s*typeof msg\.variantIndex === 'number' \? msg\.variantIndex : undefined,\s*\n\s*msg\.sheet \|\| null\s*\n\s*\);/,
  );
});

test('a retarget arriving during an in-flight selection coalesces to the latest context instead of being dropped', () => {
  const html = renderHtml('x', '/postprocess', 'tok');
  assert.match(html, /var pendingSelection = null;/);
  assert.match(
    html,
    /if \(selecting\) \{\s*\n\s*pendingSelection = \{ briefId: briefId, runId: runId, variant: variant, sheet: sheet \};\s*\n\s*return;/,
  );
  assert.match(html, /function runPendingSelection\(\)/);
  assert.match(html, /if \(runPendingSelection\(\)\) return;\s*\n\s*render\(state\);/);
  assert.match(
    html,
    /\.catch\(function \(\) \{\s*\n\s*selecting = false;\s*\n\s*setBusy\(false\);\s*\n\s*runPendingSelection\(\);/,
  );
});
