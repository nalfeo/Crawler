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
    'Run / rerun unresolved items on GitHub',
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

test('never lets a set id reach the DOM unescaped', () => {
  const html = renderHtml({ instanceId: 'review-1', setId: '</script><img>', token: 't' });
  assert.ok(!html.includes('</script><img>'));
  assert.match(html, /\\u003c\/script>/);
});
