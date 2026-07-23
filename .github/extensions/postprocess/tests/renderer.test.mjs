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
  // live-only offline upscale control + safe upscale pipeline behavior wiring
  assert.match(html, /upscaleFactor \(live\)/);
  assert.match(html, /upscale is live-only and does not persist/);
  assert.match(html, /if \(tolerancesChanged\) pendingMode = 'replace';/);
  assert.match(html, /reject\(err instanceof Error \? err : new Error\(String\(err\)\)\);/);
  assert.ok(!html.includes('upscaleFactor: currentLiveUpscaleFactor'));
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

test('boot renders exactly once (dedupes loadState vs SSE initial frame)', () => {
  const html = renderHtml('x');
  // dedup flags exist and both boot paths are guarded so the live relay fires once
  assert.match(html, /var bootRendered = false;/);
  assert.match(html, /var sseInitialSeen = false;/);
  // loadState skips its boot render if the SSE initial frame already rendered
  assert.match(html, /if \(isBoot && bootRendered\) return;/);
  // boot call is flagged, refresh is not (refresh must always re-render)
  assert.match(html, /loadState\(undefined, true\);/);
  assert.match(html, /loadState\('Refreshing\\u2026', false\);/);
  // SSE handler drops the one unconditional initial frame once boot has rendered,
  // but always renders subsequent (external pushState) frames
  assert.match(html, /if \(!sseInitialSeen\)/);
});

test('instanceId is HTML-escaped into the shell', () => {
  const html = renderHtml('a"><script>bad</script>');
  assert.ok(!html.includes('a"><script>bad'));
  assert.match(html, /data-instance="a&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
});

// ---------------------------------------------------------------------------
// C2 persist / mutation surface
// ---------------------------------------------------------------------------

test('the anchor + confirm helpers are injected verbatim (no placeholder left)', () => {
  const html = renderHtml('x');
  assert.ok(!html.includes('__ANCHOR_FNS__'), 'anchor injection placeholder replaced');
  for (const name of [
    'finalImageClickToAnchor',
    'anchorMarkerPercent',
    'middleAnchor',
    'isDestructivePersist',
  ]) {
    assert.ok(html.includes('var ' + name + ' = function'), 'injected: ' + name);
  }
});

test('the client wires the authoring / persist flow with parity controls', () => {
  const html = renderHtml('x');
  // panel + apply handler + persist relay endpoint
  assert.match(html, /function makeAuthoringPanel\(/);
  assert.match(html, /function applyChanges\(/);
  assert.match(html, /\/api\/persist-postprocess/);
  // the five controls: facing, apply-scope (this/all), anchor picker + x/y sync, reset
  assert.match(html, /Facing/);
  assert.match(html, /This variant/);
  assert.match(html, /All variants/);
  assert.match(html, /function syncAnchorFromInputs\(/);
  assert.match(html, /Apply changes/);
  assert.match(html, /Reset to defaults/);
  assert.match(html, /Reset anchor/);
  assert.match(html, /Set anchor to middle/);
  // local staging state machine (persist fires only on Apply)
  assert.match(html, /currentFacing/);
  assert.match(html, /currentScope/);
  assert.match(html, /currentAnchor/);
  assert.match(html, /pendingMode/);
});

test('pipeline controls are colocated and step images preserve natural aspect ratio', () => {
  const html = renderHtml('x');
  assert.match(html, /\.ba img \{ width: auto; height: auto; max-width: 160px; max-height: 160px;/);
  assert.match(html, /meta\.moduleId === 'background-removal'.*makeTuningPanel/s);
  assert.match(html, /\[label, wrap, makeAuthoringPanel\(state\)\]/);
  assert.match(html, /text: meta\.skipped \? 'Run step' : 'Skip step'/);
  assert.match(html, /disabledModules: Array\.from\(currentDisabledModules\)/);
});

test('slicer redraws after its card is mounted, including the warmed-image path', () => {
  const html = renderHtml('x');
  const mountAt = html.indexOf('app.replaceChildren(frag);');
  const redrawAt = html.indexOf('redrawOverlay(state, token);', mountAt);
  assert.ok(mountAt >= 0 && redrawAt > mountAt);
  assert.match(html, /canvas\.style\.display = 'block';/);
  assert.match(html, /overlayCanvas\.style\.display = 'block';/);
});

test('relocated native controls retain labels and keyboard activation semantics', () => {
  const html = renderHtml('x');
  for (const id of [
    'postprocess-color-tolerance',
    'postprocess-fringe-tolerance',
    'postprocess-upscale-factor',
    'postprocess-facing',
    'postprocess-scope',
    'postprocess-anchor-x',
    'postprocess-anchor-y',
  ]) {
    assert.match(html, new RegExp("for: '" + id + "'"));
    assert.match(html, new RegExp("id: '" + id + "'"));
  }
  assert.match(html, /h\('button', \{ type: 'button', text: 'Set anchor to middle' \}\)/);
  assert.match(html, /h\('button', \{[\s\S]*class: 'skip'/);
});

test('destructive persists are confirm-guarded with the shared pure predicate', () => {
  const html = renderHtml('x');
  // the SAME isDestructivePersist used in unit tests gates a window.confirm()
  assert.match(html, /isDestructivePersist\(\{/);
  assert.match(html, /window\.confirm\(/);
});

test('Apply changes is guarded against a double-submit (single POST in flight)', () => {
  const html = renderHtml('x');
  // an in-flight flag early-returns a re-click, and the Apply button is disabled
  // for the duration so a rapid double-click cannot fire two identical persists.
  assert.match(html, /var applyInFlight = false;/);
  assert.match(html, /if \(applyInFlight\) return;/);
  assert.match(html, /applyInFlight = true;/);
  assert.match(html, /applyInFlight = false;/);
  assert.match(html, /authoringApplyBtn\.disabled = true;/);
  assert.match(html, /authoringApplyBtn\.disabled = false;/);
});

test('successful embedded Apply notifies the parent Workflow with its refresh patch', () => {
  const html = renderHtml('x', '/postprocess', 'token');
  assert.match(html, /resp\.workflowPatch/);
  assert.match(html, /type: 'postprocess:applied'/);
  assert.match(html, /window\.parent\.postMessage/);
  assert.match(html, /window\.location\.origin/);
});

test('the final output image is clickable and draws the anchor marker', () => {
  const html = renderHtml('x');
  assert.match(html, /function redrawAnchorMarker\(/);
  assert.match(html, /finalImageClickToAnchor\(/);
  assert.match(html, /anchorMarkerPercent\(/);
});
