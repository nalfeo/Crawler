import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHtml } from '../renderer.mjs';

test('renders cloud run controls, polling state, and existing aggregate views', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /id="run-select"/);
  assert.match(html, /id="source-select"/);
  assert.match(html, /Local session/);
  assert.match(html, /Floors: /);
  assert.match(html, /Invalid local result files/);
  assert.match(html, /source-select'\)\.disabled = state\.refreshing/);
  assert.match(html, /auto-refresh 30s/);
  assert.match(html, /Per-weapon summary/);
  assert.match(html, /Per-seed outcomes/);
  assert.match(html, /new URLSearchParams\(location\.search\)/);
});

test('does not embed GitHub credentials or authenticated API URLs', () => {
  const html = renderHtml('sweep-test');
  assert.doesNotMatch(html, /GH_TOKEN|GITHUB_TOKEN|api\.github\.com|Bearer /);
});
