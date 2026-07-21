import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtml } from '../renderer.mjs';

test('uses app theme tokens and includes live state controls', () => {
  const html = renderHtml({ instanceId: 'ci-health-1', refreshIntervalMs: 30_000 });
  assert.match(html, /--background-color-default/);
  assert.match(html, /--border-color-default/);
  assert.match(html, /new EventSource/);
  assert.match(html, /\/api\/refresh/);
  assert.match(html, /Refresh every 30s/);
  assert.match(html, /Visible hosted runners/);
  assert.match(html, /active runs/);
  assert.match(html, /hosted jobs running/);
});

test('escapes the instance id embedded into renderer HTML', () => {
  const html = renderHtml({
    instanceId: '<img src=x onerror=alert(1)>',
    refreshIntervalMs: 30_000,
  });
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('creates external links with noreferrer protection', () => {
  const html = renderHtml({ instanceId: 'ci-health-1', refreshIntervalMs: 30_000 });
  assert.match(html, /rel = 'noreferrer'/);
  assert.match(html, /target = '_blank'/);
});
