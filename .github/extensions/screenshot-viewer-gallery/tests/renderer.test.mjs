import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtml } from '../renderer.mjs';

test('renders only the screenshot gallery surface', () => {
  const html = renderHtml({ instanceId: 'test', pollIntervalMs: 10_000 });
  assert.match(html, /<h1>All Screenshots<\/h1>/);
  assert.match(html, /id="gallery"/);
  assert.doesNotMatch(html, /Before \/ After|scenario-filter|feedback-pair/);
});
