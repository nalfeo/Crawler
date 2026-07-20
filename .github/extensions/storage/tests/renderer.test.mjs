/**
 * Unit tests for the storage renderer shell (`renderHtml`). These assert the
 * DESTRUCTIVE-OPS safety contract deterministically — the EXACT monolith
 * `window.confirm` strings, both destructive buttons present, the per-instance
 * mutation token embedded + escaped, the mutation-token request header, and that
 * destructive buttons are health-gated — without ever issuing a real mutation
 * (project rule #10 + the Slice E destructive-ops brief).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../renderer.mjs';

test('renderHtml returns a complete standalone document with the app root', () => {
  const html = renderHtml('storage-1');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/body><\/html>$/);
  assert.match(html, /<div id="app" data-instance="storage-1" data-mutation-token="">/);
});

test('the mutation token is embedded into #app and HTML-escaped', () => {
  assert.match(renderHtml('x', { mutationToken: 'TESTTOKEN' }), /data-mutation-token="TESTTOKEN"/);
  const escaped = renderHtml('x', { mutationToken: 'a"><b' });
  assert.ok(!escaped.includes('data-mutation-token="a"><b"'));
  assert.match(escaped, /data-mutation-token="a&quot;&gt;&lt;b"/);
});

test('instanceId is HTML-escaped into the shell', () => {
  const html = renderHtml('a"><script>bad</script>');
  assert.ok(!html.includes('a"><script>bad'));
  assert.match(html, /data-instance="a&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
});

test('the toolbar exposes scope / search / sort / filter and both destructive buttons', () => {
  const html = renderHtml('x');
  assert.match(html, /id="scope-select"/);
  assert.match(html, /<option value="active">/);
  assert.match(html, /<option value="archive">/);
  assert.match(html, /id="search-input"/);
  assert.match(html, /id="refresh-btn"/);
  assert.match(html, /id="sort-select"/);
  assert.match(html, /id="filter-select"/);
  assert.match(html, /id="archive-btn"/);
  assert.match(html, /id="delete-btn"/);
});

test('archive + delete use the EXACT monolith confirm strings (safety-critical)', () => {
  const html = renderHtml('x');
  // These strings are the irreversible-op guard the monolith shows — they must be
  // byte-identical so the canvas is never a looser destructive UX (rule #12).
  assert.ok(html.includes("window.confirm('Archive ' + keys.length + ' run(s)?')"));
  assert.ok(
    html.includes(
      "window.confirm('Permanently delete ' + keys.length + ' run(s)? This cannot be undone.')",
    ),
  );
  // Exactly two confirm gates — no destructive path bypasses one.
  assert.equal(html.split('window.confirm(').length - 1, 2);
});

test('empty-selection guards match the monolith (no confirm, no request)', () => {
  const html = renderHtml('x');
  assert.ok(html.includes('Select at least one active run to archive.'));
  assert.ok(html.includes('Select at least one run to delete.'));
});

test('destructive buttons are health-gated (disabled unless sidecar is up)', () => {
  const html = renderHtml('x');
  assert.match(html, /archiveBtn\.disabled = !up;/);
  assert.match(html, /deleteBtn\.disabled = !up;/);
});

test('destructive requests carry the mutation-token header', () => {
  const html = renderHtml('x');
  assert.match(html, /'x-storage-mutation-token': mutationToken/);
});

test('the client talks only to the extension proxy routes, never the raw sidecar', () => {
  const html = renderHtml('x');
  assert.ok(html.includes("fetch('/api/runs?scope='"));
  assert.ok(html.includes("fetch('/api/enrich'"));
  assert.ok(html.includes("'/api/archive'"));
  assert.ok(html.includes("'/api/delete'"));
  // The iframe must NOT reach the sidecar's own /api/storage/* routes directly —
  // every mutation flows through the token-guarded, health-gated proxy.
  assert.ok(!html.includes('/api/storage/'));
});

test('the client is request-sequenced (stale list/enrich responses are dropped)', () => {
  const html = renderHtml('x');
  assert.match(html, /var requestSeq = 0;/);
  assert.match(html, /if \(seq !== requestSeq\) return;/);
});

test('reload() clears the busy counter BEFORE dropping a stale response (no phantom leak)', () => {
  // Regression guard: setBusy(true) is paired with setBusy(false) on EVERY reload
  // completion — including a stale one. If the stale-sequence `return` ran before
  // setBusy(false), the inflight counter would leak and permanently disable refresh.
  const html = renderHtml('x');
  // .then arm: setBusy(false) immediately precedes the stale-drop guard.
  assert.match(html, /setBusy\(false\);\s*if \(seq !== requestSeq\) return; \/\/ stale response/);
  // .catch arm: setBusy(false) precedes its stale guard too.
  assert.match(
    html,
    /setBusy\(false\);\s*if \(seq !== requestSeq\) return;\s*statusEl\.textContent = 'Failed to load runs:/,
  );
  // The buggy ordering (guard then setBusy) must NOT be present.
  assert.ok(!/return; \/\/ stale response — drop it\s*setBusy\(false\)/.test(html));
});

test('status strings mirror the monolith', () => {
  const html = renderHtml('x');
  assert.ok(html.includes("'Loaded ' + currentRuns.length + ' ' + scope + ' run(s).'"));
  assert.ok(html.includes("'Failed to load runs: '"));
  assert.ok(html.includes('enrichment unavailable: '));
});

test('the client script is template-literal-free (no un-escaped ${} interpolation)', () => {
  // renderHtml is one String.raw literal + string concat; a stray `${` would mean
  // an interpolation leaked into the emitted document.
  assert.ok(!renderHtml('x').includes('${'));
});

test('renderDegrade with state=starting shows "Starting sprite service" panel', () => {
  const html = renderHtml('x');
  // The renderDegrade function is inline in the client script; check that the
  // starting-state branch and its text are present in the generated document.
  assert.ok(html.includes("su.state === 'starting'"));
  assert.ok(html.includes('Starting sprite service'));
});

test('renderDegrade with error state shows error message and logPath', () => {
  const html = renderHtml('x');
  // The error branch must reference su.error and su.logPath.
  assert.ok(html.includes('su.error'));
  assert.ok(html.includes('su.logPath'));
  assert.ok(html.includes('Sprite service unavailable'));
});

test('app_showDegrade receives startup from payload and passes to renderDegrade', () => {
  const html = renderHtml('x');
  // The reload() .then handler must extract sidecarStartup from payload and pass it.
  assert.ok(html.includes('payload.sidecarStartup'));
  // app_showDegrade must accept startup as first param and pass it to renderDegrade.
  assert.match(html, /function app_showDegrade\(startup, errorText\)/);
  assert.match(html, /renderDegrade\(startup\)/);
});
