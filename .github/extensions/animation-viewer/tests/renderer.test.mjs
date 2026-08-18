import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, renderHtml, toScriptLiteral } from '../renderer.mjs';

const BASE_STATE = {
  sheetB64: 'QUJD',
  sheetPath: 'public/assets/generated/player-walk-cycle-female.png',
  repoRoot: '/repo',
  rows: 1,
  cols: 8,
  frameRate: 8,
  name: 'Walk cycle',
  outputW: 96,
  outputH: 144,
};

const CATALOG = [
  { label: 'player-walk-cycle-female', sheetPath: 'public/assets/generated/x.png' },
  { label: 'player-walk-cycle-male', sheetPath: 'public/assets/generated/y.png' },
];

test('escapeHtml neutralizes HTML metacharacters', () => {
  assert.equal(escapeHtml(`<b>"x"&'y'</b>`), '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
});

test('renders non-square output dimensions independently', () => {
  const html = renderHtml(BASE_STATE, []);
  assert.match(html, /const OUT_W = 96;/);
  assert.match(html, /const OUT_H = 144;/);
  assert.ok(!html.includes('const OUT_H = 96;'), 'height must not reuse the width value');
});

test('uses the per-frame dimensions for both thumbnails and zoomed playback', () => {
  const html = renderHtml(BASE_STATE, []);
  assert.match(html, /fc\.width = OUT_W; fc\.height = OUT_H;/);
  assert.match(html, /animCanvas\.width = OUT_W \* zoom;/);
  assert.match(html, /animCanvas\.height = OUT_H \* zoom;/);
});

test('escapes the caller-supplied name in the title and heading', () => {
  const html = renderHtml({ ...BASE_STATE, name: '<img src=x onerror=alert(1)>' }, []);
  assert.ok(!html.includes('<img src=x'), 'raw HTML must not appear in output');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('escapes catalog labels so repository JSON cannot inject markup', () => {
  const html = renderHtml(BASE_STATE, [
    { label: `</option><script>alert(1)</script>`, sheetPath: 'public/assets/generated/x.png' },
  ]);
  assert.ok(!html.includes('</option><script>alert(1)'), 'raw label markup must not be emitted');
  assert.match(html, /&lt;\/option&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('marks the loaded sheet as the selected catalog option', () => {
  const html = renderHtml({ ...BASE_STATE, sheetPath: 'public/assets/generated/y.png' }, CATALOG);
  assert.match(html, /<option value="1" selected>player-walk-cycle-male<\/option>/);
  assert.match(html, /<option value="0">player-walk-cycle-female<\/option>/);
});

test('registers the selector listener even when no sheet is loaded', () => {
  const html = renderHtml(
    { rows: 1, cols: 1, frameRate: 8, outputW: 128, outputH: 128, sheetB64: null },
    CATALOG,
  );
  assert.match(html, /id="animation-select"/);
  assert.match(html, /animationSelect\?\.addEventListener\('change'/);
  assert.match(html, /No sheet loaded yet/);
  assert.ok(!html.includes('const SHEET_B64'), 'no playback script without a sheet');
});

test('shows the empty catalog message when nothing is available', () => {
  const html = renderHtml({ rows: 1, cols: 1, frameRate: 8, outputW: 128, outputH: 128 }, []);
  assert.match(html, /No generated animations are available/);
  assert.ok(!html.includes('id="animation-select"'), 'no selector without catalog entries');
});

test('reports the total frame count from rows × cols', () => {
  const html = renderHtml({ ...BASE_STATE, rows: 2, cols: 4 }, []);
  assert.match(html, /Frame 0 \/ 8/);
});

test('emits the sheet payload as an escaped script-safe literal', () => {
  const html = renderHtml({ ...BASE_STATE, sheetB64: `A"</script><script>alert(1)` }, []);
  assert.ok(!html.includes('</script><script>alert(1)'), 'payload must not close the script tag');
  assert.match(html, /const SHEET_B64 = "A\\"\\u003c\/script\\u003e/);
});

test('toScriptLiteral escapes quotes and angle brackets', () => {
  assert.equal(toScriptLiteral('a"b<c>d&e'), '"a\\"b\\u003cc\\u003ed\\u0026e"');
});
