import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterRequests } from '../lib/request-filter.mjs';

const ITEMS = [
  {
    id: 'a',
    name: 'Goblin Warrior',
    kebabName: 'goblin-warrior',
    requester: 'alice',
    stage: 'draft',
  },
  {
    id: 'b',
    name: 'Goblin Archer',
    kebabName: 'goblin-archer',
    requester: 'bob',
    stage: 'candidates',
  },
  { id: 'c', name: 'Rat Boss', kebabName: 'rat-boss', requester: 'alice', stage: 'done' },
];

test('an empty query and "all" stage returns every request', () => {
  assert.equal(filterRequests(ITEMS, 'all', '').length, 3);
  assert.equal(filterRequests(ITEMS, 'all', '   ').length, 3);
});

test('filters by an exact stage match', () => {
  const result = filterRequests(ITEMS, 'draft', '');
  assert.deepEqual(
    result.map((r) => r.id),
    ['a'],
  );
});

test('filters case-insensitively by a name substring', () => {
  const result = filterRequests(ITEMS, 'all', 'GOBLIN');
  assert.deepEqual(
    result.map((r) => r.id),
    ['a', 'b'],
  );
});

test('filters case-insensitively by a kebabName substring', () => {
  const result = filterRequests(ITEMS, 'all', 'rat-boss');
  assert.deepEqual(
    result.map((r) => r.id),
    ['c'],
  );
});

test('filters by a requester substring', () => {
  const result = filterRequests(ITEMS, 'all', 'bob');
  assert.deepEqual(
    result.map((r) => r.id),
    ['b'],
  );
});

test('composes (ANDs) the stage filter with the search query', () => {
  const result = filterRequests(ITEMS, 'done', 'alice');
  assert.deepEqual(
    result.map((r) => r.id),
    ['c'],
  );
  assert.deepEqual(filterRequests(ITEMS, 'draft', 'bob'), []);
});

test('a query with no matches returns an empty array', () => {
  assert.deepEqual(filterRequests(ITEMS, 'all', 'no-such-request'), []);
});

test('an unknown stage value returns an empty array (exact match only)', () => {
  assert.deepEqual(filterRequests(ITEMS, 'checked-in', ''), []);
});

test('tolerates a missing/undefined items array', () => {
  assert.deepEqual(filterRequests(undefined, 'all', 'x'), []);
});

test('tolerates null/malformed entries in the items array', () => {
  assert.deepEqual(filterRequests([null, undefined, ITEMS[0]], 'all', 'goblin warrior'), [
    ITEMS[0],
  ]);
});
