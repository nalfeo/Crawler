/**
 * Unit tests for the renderer shell (renderHtml). Asserts the persistent toolbar
 * (refresh button + busy indicator) lives OUTSIDE #app so it survives the
 * app.replaceChildren re-render, that the tab bar + all three read surfaces are
 * wired (Queue + Requests moved to the B2 write slice), that the instanceId is
 * HTML-escaped into the shell, and that the refresh button re-points at
 * /api/reload (which invalidates the fs-static cache) while the initial load
 * uses the cached /api/state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../renderer.mjs';

test('renderHtml returns a complete standalone document', () => {
  const html = renderHtml('workflow-1');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/body><\/html>$/);
  assert.match(html, /<div id="app" data-instance="workflow-1">/);
});

test('the persistent toolbar (refresh + busy) sits before #app so it survives re-render', () => {
  const html = renderHtml('x');
  const toolbarAt = html.indexOf('class="toolbar"');
  const appAt = html.indexOf('id="app"');
  assert.ok(toolbarAt >= 0, 'toolbar present');
  assert.ok(appAt >= 0, 'app present');
  assert.ok(toolbarAt < appAt, 'toolbar rendered outside/before #app');
  assert.match(html, /id="refresh-btn"/);
  assert.match(html, /id="busy"[^>]*hidden/);
  assert.match(html, /id="busy-label"/);
  assert.match(html, /class="spinner"/);
});

test('the client script wires busy state, load/reload, and refresh', () => {
  const html = renderHtml('x');
  assert.match(html, /function setBusy\(/);
  assert.match(html, /function loadState\(/);
  assert.match(html, /function reloadState\(/);
  // Refresh must invalidate the fs-static cache via /api/reload, not /api/state.
  assert.match(html, /refreshBtn\.addEventListener\('click', function \(\) \{ reloadState/);
  assert.match(html, /fetchState\('\/api\/reload'/);
  assert.match(html, /fetchState\('\/api\/state'/);
  assert.match(html, /Refreshing…/);
});

test('the client script wires the tab bar and all three read surfaces', () => {
  const html = renderHtml('x');
  assert.match(html, /function renderTabs\(/);
  assert.match(html, /function renderBacklog\(/);
  assert.match(html, /function renderFiles\(/);
  assert.match(html, /function renderRuns\(/);
  // B1 is the READ surface only — Queue + Requests tabs are the B2 follow-up.
  assert.doesNotMatch(html, /function renderQueue\(/);
  assert.doesNotMatch(html, /function renderRequests\(/);
});

test('the client script wires SSE + run selection', () => {
  const html = renderHtml('x');
  assert.match(html, /new EventSource\('\/events'\)/);
  assert.match(html, /\/api\/select\?briefId=/);
});

test('the run cards expose every current judge axis', () => {
  const html = renderHtml('x');
  for (const key of [
    'designLanguage',
    'referenceStyleMatch',
    'briefMatch',
    'readability',
    'poseOrientation',
    'bossPresence',
    'presentation',
    'themeAdherence',
  ]) {
    assert.match(html, new RegExp(`key: '${key}'`));
  }
});

test('instanceId is HTML-escaped into the shell', () => {
  const html = renderHtml('a"><script>bad</script>');
  assert.ok(!html.includes('a"><script>bad'));
  assert.match(html, /data-instance="a&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
});
