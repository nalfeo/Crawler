import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHtml } from '../renderer.mjs';

test('renders cloud run controls, polling state, and existing aggregate views', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /id="run-select"/);
  assert.match(html, /id="source-select"/);
  assert.match(html, /Local session/);
  assert.match(html, /Repository branch/);
  assert.match(html, /id="branch-select"/);
  assert.match(html, /Floors: /);
  assert.match(html, /Invalid local result files/);
  assert.match(html, /source-select'\)\.disabled = state\.refreshing/);
  assert.match(html, /auto-refresh 30s/);
  assert.match(html, /Per-weapon summary/);
  assert.match(html, /Per-seed outcomes/);
  assert.match(html, /new URLSearchParams\(location\.search\)/);
});

test('renders repository baseline controls and baseline tables', () => {
  const html = renderHtml('benchmark-test');
  assert.match(html, /select-repository-branch/);
  assert.match(html, /select-repository-artifact/);
  assert.match(html, /renderBaselineResults/);
  assert.match(html, /Baseline summary/);
  assert.match(html, /Per-weapon win rate/);
});

test('does not embed GitHub credentials or authenticated API URLs', () => {
  const html = renderHtml('sweep-test');
  assert.doesNotMatch(html, /GH_TOKEN|GITHUB_TOKEN|api\.github\.com|Bearer /);
});

test('render includes AI sweep leaderboard section markers', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /renderAiSweepLeaderboard/);
  assert.match(html, /renderAiJobPhases/);
  assert.match(html, /phase-grid/);
  assert.match(html, /AI Sweep Eval Results/);
});

test('run label includes [AI] or [W] type prefix', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /\[AI\]|\[W\]/);
});

test('page-title element is present and updated dynamically', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /id="page-title"/);
  assert.match(html, /titleEl\.textContent/);
  assert.match(html, /AI Sweep Eval Results/);
});

test('run selector aria-label is generic (not weapon-sweep-specific)', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /aria-label="Cloud sweep run"/);
  assert.doesNotMatch(html, /aria-label="Cloud weapon-sweep run"/);
});

test('render includes baseline-sweep section markers and title, with a graceful missing fun-report path', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /renderBaselineSweepResults/);
  assert.match(html, /Release Baseline Results/);
  assert.match(html, /Release baseline/);
  assert.match(html, /Fun evaluation/);
  assert.match(
    html,
    /Fun evaluation report is not available for this run \(captured before fun evaluation existed, or scoring failed for this release\)\./,
  );
  assert.match(html, /baseline-sweep.*Release Baseline Results/);
});

test('render includes criterion-level fun evaluation details', () => {
  const html = renderHtml('sweep-test');
  assert.match(
    html,
    /<th>Criterion<\/th><th>Status<\/th><th>Observed<\/th><th>Target<\/th><th>Reason<\/th>/,
  );
  assert.match(html, /Object\.entries\(report\.criteria\)/);
});

test('runLabel prefixes baseline-sweep runs with [B]', () => {
  const html = renderHtml('sweep-test');
  assert.match(html, /baseline-sweep.*\[B\]/);
});

test('run selector prepends explicit option for baseline-sweep run absent from state.runs', () => {
  const html = renderHtml('sweep-test');
  // Verify the JS code handles a selected run absent from state.runs (explicit cloud option pattern).
  assert.match(html, /explicitRun/);
  assert.match(html, /runs\.some.*run\.id.*selectedId/);
  // Empty-list cloud path: show selected run if available.
  assert.match(html, /cloud && state\.selectedRun/);
});
