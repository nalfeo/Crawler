/**
 * renderer.mjs unit tests — assert the served iframe document has the structural
 * contract the harness + host rely on, without a browser. These are deterministic
 * string checks (the risky pure LOGIC lives in `overrides-model.mjs` and is tested
 * there); here we only pin the document shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../renderer.mjs';

test('renderHtml returns a complete HTML document', () => {
  const html = renderHtml('achievements-1');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<\/body><\/html>$/);
});

test('header (title + description) renders before the #app mount point', () => {
  const html = renderHtml('achievements-1');
  const h1Index = html.indexOf('<h1>Achievements Editor</h1>');
  const appIndex = html.indexOf('<div id="app"');
  assert.ok(h1Index >= 0, 'expected an <h1> title');
  assert.ok(appIndex >= 0, 'expected the #app mount point');
  assert.ok(h1Index < appIndex, 'the header must come before #app');
  // Matches the monolith DevTool entry description verbatim.
  assert.match(
    html,
    /View all Floor 1 achievements, edit title\/criteria\/flavor\/reward overrides, and review icon \+ loot-box art backlog\./,
  );
});

test('#app carries the instanceId in a data-instance attribute', () => {
  const html = renderHtml('achievements-1');
  assert.match(html, /<div id="app" data-instance="achievements-1">/);
});

test('the instanceId is HTML-escaped into data-instance (no attribute break-out)', () => {
  const html = renderHtml('a"><script>evil()</script>');
  assert.ok(
    !html.includes('data-instance="a"><script>evil()'),
    'raw instanceId must not break the attribute',
  );
  assert.match(html, /data-instance="a&quot;&gt;&lt;script&gt;evil\(\)&lt;\/script&gt;"/);
});

test('the client is an ES module that imports the served pure override model', () => {
  const html = renderHtml('achievements-1');
  assert.match(html, /<script type="module">/);
  assert.match(html, /from '\.\/lib\/overrides-model\.mjs'/);
});

test('renderHtml is deterministic for a given instanceId', () => {
  assert.equal(renderHtml('achievements-1'), renderHtml('achievements-1'));
});
