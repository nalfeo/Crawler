/**
 * Unit tests for the renderer shell (renderHtml). Asserts the persistent toolbar
 * (refresh button + busy indicator) lives OUTSIDE #app so it survives the
 * app.replaceChildren re-render, the loading affordances are wired, and the
 * instanceId is HTML-escaped into the shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../renderer.mjs';

test('renderHtml returns a complete standalone document', () => {
  const html = renderHtml('sprite-review-1');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/body><\/html>$/);
  assert.match(html, /<div id="app" data-instance="sprite-review-1">/);
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

test('the client script wires busy state, loadState, and refresh', () => {
  const html = renderHtml('x');
  assert.match(html, /function setBusy\(/);
  assert.match(html, /function loadState\(/);
  assert.match(html, /refreshBtn\.addEventListener\('click'/);
  assert.match(html, /Refreshing…/);
  assert.match(html, /Loading sheet from Azure…/);
});

test('instanceId is HTML-escaped into the shell', () => {
  const html = renderHtml('a"><script>bad</script>');
  assert.ok(!html.includes('a"><script>bad'));
  assert.match(html, /data-instance="a&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
});
