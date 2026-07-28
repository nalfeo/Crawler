import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHtml } from '../renderer.mjs';

test('renders the four review phases, revision controls, coverage, and workflow actions', () => {
  const html = renderHtml({
    instanceId: 'review-1',
    setId: 'classic-fantasy',
    token: 'secret-token',
  });
  for (const phrase of [
    'sprite-sheets',
    'variant-approval',
    'expectedRevision',
    'coveredSlotCount',
    "work.withArtifacts ? 'Regenerate' : 'Generate'",
    'Re-judge collection cohesion on GitHub',
    'Publish complete set atomically on GitHub',
    'Initialize set on GitHub',
  ]) {
    assert.match(html, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('exposes the authored plan path for an uninitialized set', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: 'classic-fantasy', token: 'secret' });
  assert.match(html, /data\/theme-equipment-sets\//);
  assert.match(html, /action: 'init'/);
});
test('ships the set index, creation, and roster-editing surfaces', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: null, token: 'secret' });
  for (const phrase of [
    '+ New theme',
    'Theme equipment sets',
    'Synthesize roster',
    'Save plan to repo',
    'weapon types',
    '/api/select',
    '/api/synth-roster',
    '/api/save-plan',
    '/api/sets',
  ]) {
    assert.match(html, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('boots into the set index when the canvas opens without a set', () => {
  const withSet = renderHtml({ instanceId: 'review-1', setId: 'classic-fantasy', token: 't' });
  const withoutSet = renderHtml({ instanceId: 'review-1', setId: null, token: 't' });
  assert.match(withSet, /"setId":"classic-fantasy"/);
  assert.match(withoutSet, /"setId":null/);
  assert.match(withoutSet, /if \(currentSetId\) load\(\); else loadIndex\(\);/);
});

test('scopes advancement controls to the active phase tab with a header refresh fallback', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: 'classic-fantasy', token: 't' });
  // Phase controls (Run / Approve remaining / Advance) render only on the tab matching the durable phase.
  assert.match(html, /selectedPhase === state\.phase \?/);
  // The gate must structurally wrap the Phase controls section (guards against the condition
  // decaying into dead code that always/never renders the controls).
  assert.match(
    html,
    /selectedPhase === state\.phase \?\s*'<section class="panel"><div class="panel-head"><div><strong>Phase controls/,
  );
  // Non-active phase tabs show a review-only pointer to the active phase instead of the controls.
  assert.match(html, /Advancement controls for the active phase/);
  assert.match(html, /an earlier, completed phase/);
  assert.match(html, /a later phase, not yet active/);
  // A generic Refresh lives in the header so it stays reachable from every tab.
  assert.match(html, /← All sets<\/button><button data-refresh /);
});

test('never lets a set id reach the DOM unescaped', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: '</script><img>', token: 't' });
  assert.ok(!html.includes('</script><img>'));
  assert.match(html, /\\u003c\/script>/);
});

test('the init button reports progress instead of looking inert', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: 'classic-fantasy', token: 'secret' });
  // Busy state on the button itself: a dispatch takes several seconds.
  assert.match(html, /Dispatching…/);
  assert.match(html, /dispatchNotice/);
  // Failures land in the panel rather than a bare alert().
  assert.match(html, /notice = \{ tone: 'error', text: error\.message \}/);
  // And the pane promises the automatic switch the server-side watch delivers.
  assert.match(html, /switches to the board on its own/);
});

test('leaving the set clears any dispatch notice', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: 'classic-fantasy', token: 'secret' });
  assert.match(html, /dispatchNotice = null; loadIndex\(\)/);
});

test('a late init result never repaints a pane the user already left', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: 'classic-fantasy', token: 'secret' });
  assert.match(html, /const dispatchedSetId = currentSetId/);
  assert.match(html, /view === 'board' && currentSetId === dispatchedSetId && state === null/);
  assert.match(html, /if \(stillHere\(\)\) \{/);
});

test('state arriving over SSE mid-dispatch wins over the uninitialized pane', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: 'classic-fantasy', token: 'secret' });
  // A watch left over from an earlier dispatch can broadcast state while the
  // second dispatch is still awaiting its HTTP response; the board that the
  // SSE handler drew must not be overwritten by the stale error pane.
  assert.match(html, /currentSetId === dispatchedSetId && state === null/);
});
