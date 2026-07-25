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
  ]) {
    assert.match(html, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
