/**
 * Unit tests for the postprocess renderer shell (renderHtml). Asserts the
 * standalone document + persistent toolbar (so it survives app.replaceChildren),
 * that the pure slice-overlay helpers are serialized into the client verbatim
 * (no leftover injection placeholder, no drift from hand-copied math), that the
 * parity-critical client wiring is present, and that the instanceId is escaped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../renderer.mjs';

test('renderHtml returns a complete standalone document', () => {
  const html = renderHtml('postprocess-1');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/body><\/html>$/);
  assert.match(html, /<div id="app" data-instance="postprocess-1">/);
  assert.match(html, /<title>Postprocess Debugger<\/title>/);
});

test('the persistent toolbar (refresh + busy) sits before #app', () => {
  const html = renderHtml('x');
  const toolbarAt = html.indexOf('class="toolbar"');
  const appAt = html.indexOf('id="app"');
  assert.ok(toolbarAt >= 0 && appAt >= 0, 'toolbar + app present');
  assert.ok(toolbarAt < appAt, 'toolbar rendered outside/before #app');
  assert.match(html, /id="refresh-btn"/);
  assert.match(html, /id="busy"[^>]*hidden/);
  assert.match(html, /class="spinner"/);
});

test('the slice-overlay helpers are injected verbatim (no placeholder left)', () => {
  const html = renderHtml('x');
  assert.ok(!html.includes('__OVERLAY_FNS__'), 'injection placeholder replaced');
  // each pure helper appears as a serialized declaration
  for (const name of [
    'computeOverlayScale',
    'computeDisplayDims',
    'projectCell',
    'indicesTrustworthy',
    'resolveSelectedCell',
    'classifyCell',
    'buildSliceStatusText',
    'hitTestCell',
    'shouldApplyResponse',
  ]) {
    assert.ok(html.includes('var ' + name + ' = function'), 'injected: ' + name);
  }
});

test('the client wires the parity-critical postprocess flow', () => {
  const html = renderHtml('x');
  // live relay + stale-seq guard + browser-side crop input
  assert.match(html, /\/api\/live-postprocess/);
  assert.match(html, /function computeInput\(/);
  assert.match(html, /function runLive\(/);
  assert.match(html, /function startPipeline\(/);
  assert.match(html, /shouldApplyResponse\(mySeq, liveSeq\)/);
  // slicing overlay draw + canonical badge + click-to-select
  assert.match(html, /function drawSliceOverlay\(/);
  assert.match(html, /Canonical \(v2\)/);
  // background tuning knobs with monolith defaults + max
  assert.match(html, /colorToleranceSq: 4000/);
  assert.match(html, /fringeToleranceSq: 12000/);
  assert.match(html, /255 \* 255 \* 3/);
  // pre-baked fallback affordance
  assert.match(html, /No pipeline trace available/);
  // slice-map load failure surfaces its error in the overlay status instead of a
  // bogus "undefined×undefined grid" — regression guard for the ok:false branch
  assert.match(html, /Failed to load slice map\./);
});

test('the client script wires busy state, loadState, and refresh', () => {
  const html = renderHtml('x');
  assert.match(html, /function setBusy\(/);
  assert.match(html, /function loadState\(/);
  assert.match(html, /refreshBtn\.addEventListener\('click'/);
  assert.match(html, /Loading sheet from Azure/);
});

test('instanceId is HTML-escaped into the shell', () => {
  const html = renderHtml('a"><script>bad</script>');
  assert.ok(!html.includes('a"><script>bad'));
  assert.match(html, /data-instance="a&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
});
