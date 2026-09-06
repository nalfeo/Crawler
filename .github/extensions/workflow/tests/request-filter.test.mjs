import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterWorkflowItems } from '../lib/request-filter.mjs';

const ITEMS = [
  { id: 'one', name: 'Goblin', requestedType: 'enemy', stage: 'draft' },
  { id: 'two', name: 'Torch', requestedType: 'prop', stage: 'done' },
  { id: 'three', name: 'Golem', requestedType: 'enemy', stage: 'generating' },
];

test('filters all canonical stages without mutating the source list', () => {
  const original = ITEMS.slice();
  assert.deepEqual(filterWorkflowItems(ITEMS, 'generating', ''), [ITEMS[2]]);
  assert.deepEqual(filterWorkflowItems(ITEMS, 'all', 'GOLEM'), [ITEMS[2]]);
  assert.deepEqual(ITEMS, original);
});

test('composes stage and case-insensitive text filters', () => {
  assert.deepEqual(filterWorkflowItems(ITEMS, 'draft', 'ENEMY'), [ITEMS[0]]);
  assert.deepEqual(filterWorkflowItems(undefined, 'all', 'x'), []);
});
