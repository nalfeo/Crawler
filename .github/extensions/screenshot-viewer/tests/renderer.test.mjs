import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtml } from '../renderer.mjs';

const OPTS = { instanceId: 'screenshot-viewer-test', pollIntervalMs: 10_000 };

test('renders page title and main heading', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /<title>Screenshot Viewer/);
  assert.match(html, /<h1[^>]*>Screenshot Viewer/);
});

test('embeds the instanceId in the title (escaped)', () => {
  const html = renderHtml({ instanceId: '<b>xss</b>', pollIntervalMs: 10_000 });
  assert.ok(!html.includes('<b>xss</b>'), 'raw HTML must not appear in output');
  assert.match(html, /&lt;b&gt;xss&lt;\/b&gt;/);
});

test('includes gallery, status-bar, error-box, and lightbox elements', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /id="gallery"/);
  assert.match(html, /id="status-bar"/);
  assert.match(html, /id="error-box"/);
  assert.match(html, /id="lightbox"/);
  assert.match(html, /id="lightbox-close"/);
  assert.match(html, /id="lightbox-img"/);
});

test('includes SSE subscription (EventSource)', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /new EventSource/);
  assert.match(html, /\/events/);
});

test('derives token from location search and appends it to route URLs', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /new URLSearchParams\(window\.location\.search\)\.get\('token'\)/);
  assert.match(html, /const stateUrl = buildUrl\('\/api\/state'\)/);
  assert.match(html, /const refreshUrl = buildUrl\('\/api\/refresh'\)/);
  assert.match(html, /new EventSource\(buildUrl\('\/events'\)\)/);
  assert.match(html, /buildUrl\('\/img', \{ path: encodedPath \}\)/);
  assert.match(html, /if \(token\)\s+query\.set\('token', token\)/);
});

test('includes refresh button and polling interval', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /id="refresh-button"/);
  assert.match(html, /\/api\/refresh/);
  assert.match(html, /setInterval/);
  assert.match(html, /10000/);
});

test('includes API state URL', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /\/api\/state/);
});

test('includes /img image serving route reference', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /buildUrl\('\/img'/);
});

test('renders responsive grid CSS', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /auto-fill/);
  assert.match(html, /grid-template-columns/);
});

test('lightbox close is keyboard accessible (Escape handler)', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /Escape/);
  assert.match(html, /closeLightbox/);
});

test('does not embed credentials or external API URLs', () => {
  const html = renderHtml(OPTS);
  assert.doesNotMatch(html, /GH_TOKEN|GITHUB_TOKEN|api\.github\.com/);
});

test('escapes HTML in dynamic renderThumb output', () => {
  const html = renderHtml(OPTS);
  // The escapeHtml function must be present in the script
  assert.match(html, /function escapeHtml/);
  assert.match(html, /replaceAll\('&'/);
});

test('empty state message references browser_take_screenshot', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /browser_take_screenshot/);
});

test('live badge element is present', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /id="live-badge"/);
  assert.match(html, /status-badge--live/);
});

test('gallery cards expose button semantics for keyboard and assistive tech', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /class="thumb-card" tabindex="0" role="button"/);
  assert.match(html, /aria-label="Open screenshot:/);
});

test('image error handling cannot corrupt the thumbnail markup', () => {
  const html = renderHtml(OPTS);
  assert.doesNotMatch(html, /onerror=/);
  assert.match(html, /addEventListener\('error', handleThumbError\)/);
  assert.match(html, /function handleThumbError/);
});
