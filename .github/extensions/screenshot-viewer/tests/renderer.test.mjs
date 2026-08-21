import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtml } from '../renderer.mjs';

const OPTS = { instanceId: 'screenshot-viewer-test', pollIntervalMs: 10_000 };

test('renders A|B UX Testing title and main heading', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /<title>A\|B UX Testing/);
  assert.match(html, /<h1[^>]*>A\|B UX Testing/);
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

test('includes Before/After review and feedback controls', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /Before \/ After/);
  assert.match(html, /id="feedback-pair"/);
  assert.match(html, /id="feedback-scope"/);
  assert.match(html, /Promote to reusable guidance/);
  assert.match(html, /\/api\/feedback/);
  assert.match(html, /id="pairs"/);
  assert.match(html, /id="feedback-target"/);
  assert.match(html, /pairsEl\.innerHTML/);
});

test('supports both 1-100 wrapped reviews and 1-5 Azure surface reviews', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /review\.scale \?\? 100/);
});

test('labels feedback controls for assistive technology', () => {
  const html = renderHtml(OPTS);
  for (const id of ['feedback-pair', 'feedback-scope', 'feedback-target', 'feedback-comment']) {
    assert.match(html, new RegExp(`<label for="${id}">`));
  }
});

test('keeps feedback controls outside gallery render ownership', () => {
  const html = renderHtml(OPTS);
  const galleryIndex = html.indexOf('<div id="gallery">');
  const feedbackIndex = html.indexOf('<section class="feedback-panel"');
  assert.ok(galleryIndex >= 0 && feedbackIndex < galleryIndex);
  assert.ok(html.slice(feedbackIndex, galleryIndex).includes('</section>'));
});

test('places review feedback directly under the Before / After pane', () => {
  const html = renderHtml(OPTS);
  const pairsIndex = html.indexOf('<div id="pairs">');
  const feedbackIndex = html.indexOf('<section class="feedback-panel"');
  const galleryIndex = html.indexOf('<div id="gallery">');
  assert.ok(pairsIndex >= 0 && feedbackIndex > pairsIndex);
  assert.ok(galleryIndex > feedbackIndex);
});

test('gallery cards expose button semantics for keyboard and assistive tech', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /class="thumb-card" tabindex="0" role="button"/);
  assert.match(html, /aria-label="Open screenshot:/);
});

test('before and after pair images expose click-to-zoom semantics', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /class="pair-image" tabindex="0" role="button"/);
  assert.match(html, /aria-label="Zoom ' \+ side \+ ' screenshot/);
  assert.match(html, /pairsEl\.addEventListener\('click'/);
  assert.match(html, /pairsEl\.addEventListener\('keydown'/);
  assert.match(html, /click to zoom/);
});

test('stacks lineage comparisons and labels each concrete variant', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /grid-template-columns: 1fr/);
  assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /pair-image-label/);
  assert.match(html, /live \(dev\)/);
  assert.match(html, /pair\.scenarioLabel/);
  assert.match(html, /live-dev/);
});

test('uses delegated image error handling instead of inline fallback markup', () => {
  const html = renderHtml(OPTS);
  assert.doesNotMatch(html, /onerror=/);
  assert.match(html, /document\.addEventListener\('error'/);
  assert.match(html, /Unable to load image/);
  assert.match(html, /image\?\.closest\('\.thumb-img-wrap'\)/);
  assert.match(html, /image\?\.classList\.contains\('pair-image'\)/);
});

test('exposes a manifest-driven scenario filter for comparing treatments in one session', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /id="scenario-filter"/);
  assert.match(html, /state\.scenarios/);
  assert.match(html, /scenario\.id/);
  assert.match(html, /All scenarios/);
  assert.match(html, /scenarioFilter\.addEventListener\('change'/);
});

test('shows capture time for each A/B screenshot', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /formatTime\(pair\[side\]\.takenAt\)/);
  assert.match(html, /time unknown/);
});

test('renders judge score details and full raw response expanders', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /Score details \+ judge comments/);
  assert.match(html, /Full raw judge response JSON/);
  assert.match(html, /JSON\.stringify\(details\.rawReview, null, 2\)/);
  assert.match(html, /renderReviewDetails\(review, reviewKey\)/);
  assert.match(html, /data-details-key/);
  assert.match(html, /openDetails/);
});

test('warns that the panel is stale when the backend is unreachable', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /showing STALE content/);
});

test('renders pairs in backend order without client-side re-sorting', () => {
  const html = renderHtml(OPTS);
  assert.match(html, /const orderedPairs = comparablePairs;/);
  assert.doesNotMatch(html, /orderedPairs\.push/);
  assert.match(html, /pair\.before && pair\.after/);
});
