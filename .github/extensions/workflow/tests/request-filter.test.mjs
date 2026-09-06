import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterWorkflowItems } from '../lib/request-filter.mjs';
import { WORKFLOW_STAGES } from '../lib/authoring-state.mjs';
import { renderHtml } from '../renderer.mjs';

const ITEMS = [
  { id: 'one', name: 'Goblin', requestedType: 'enemy', stage: 'draft' },
  { id: 'two', name: 'Torch', requestedType: 'prop', stage: 'done' },
  { id: 'three', name: 'Golem', requestedType: 'enemy', stage: 'generating' },
];

test('exposes and filters every canonical stage without mutating the source list', () => {
  const original = ITEMS.slice();
  const html = renderHtml('workflow-test');
  for (const stage of WORKFLOW_STAGES) {
    assert.match(html, new RegExp(`['"]${stage}['"]`), `stage ${stage} is exposed`);
    const item = { id: stage, name: stage, requestedType: 'enemy', stage };
    assert.deepEqual(filterWorkflowItems([item], stage, ''), [item]);
  }
  assert.deepEqual(filterWorkflowItems(ITEMS, 'generating', ''), [ITEMS[2]]);
  assert.deepEqual(filterWorkflowItems(ITEMS, 'all', 'GOLEM'), [ITEMS[2]]);
  assert.deepEqual(ITEMS, original);
});

test('composes stage and case-insensitive text filters', () => {
  assert.deepEqual(filterWorkflowItems(ITEMS, 'draft', 'ENEMY'), [ITEMS[0]]);
  assert.deepEqual(filterWorkflowItems(undefined, 'all', 'x'), []);
});
