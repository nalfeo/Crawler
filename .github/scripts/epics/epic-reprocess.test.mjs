import assert from 'node:assert/strict';
import test from 'node:test';

import { nodeMarker } from './epic-create.mjs';
import { isManagedOpenEpicNode, reprocessEpicNodes } from './epic-reprocess.mjs';

const managedNode = {
  number: 12,
  state: 'open',
  node_id: 'ISSUE_12',
  user: { login: 'github-actions[bot]' },
  labels: [{ name: 'epic' }],
  body: nodeMarker('example-epic', '1234567890abcdef', 'slice-1'),
};

test('identifies only open managed epic nodes', () => {
  assert.equal(isManagedOpenEpicNode(managedNode), true);
  assert.equal(isManagedOpenEpicNode({ ...managedNode, state: 'closed' }), false);
  assert.equal(isManagedOpenEpicNode({ ...managedNode, body: 'ordinary issue' }), false);
});

test('reprocesses managed epic nodes and ignores unrelated issues', async () => {
  const calls = [];
  const results = await reprocessEpicNodes({
    graphqlFn: async () => ({
      repository: {
        suggestedActors: { nodes: [{ login: 'copilot-swe-agent', id: 'COPILOT' }] },
        issue: {
          id: 'ISSUE_12',
          state: 'OPEN',
          labels: { nodes: [] },
          assignees: { nodes: [] },
        },
      },
      replaceActorsForAssignable: {
        assignable: { assignees: { nodes: [{ login: 'copilot-swe-agent' }] } },
      },
    }),
    paginateFn: async (_token, path) => {
      calls.push(path);
      if (path.includes('labels=epic')) {
        return [managedNode, { number: 13, state: 'open', body: 'ordinary issue' }];
      }
      if (path.includes('/dependencies/blocked_by')) return [];
      if (path.endsWith('/comments')) return [];
      throw new Error(`unexpected paginate path: ${path}`);
    },
    requestFn: async (_token, path, options) => {
      calls.push(`${options.method} ${path}`);
      return { data: { id: 9 } };
    },
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
  });

  assert.deepEqual(results, [
    {
      number: 12,
      assigned: true,
      reason: 'trusted issue opener',
      assignee: 'copilot-swe-agent',
      comment: 'posted',
    },
  ]);
  assert.ok(calls.some((call) => call.includes('/issues/12/dependencies/blocked_by')));
  assert.ok(calls.some((call) => call === 'POST /repos/nalfeo/Crawler/issues/12/comments'));
});

test('continues reprocessing after an individual managed node fails', async () => {
  const secondNode = { ...managedNode, number: 13, node_id: 'ISSUE_13' };
  const results = await reprocessEpicNodes({
    graphqlFn: async () => {
      throw new Error('assignment failed');
    },
    paginateFn: async (_token, path) => {
      if (path.includes('labels=epic')) return [managedNode, secondNode];
      if (path.includes('/dependencies/blocked_by')) return [];
      throw new Error(`unexpected paginate path: ${path}`);
    },
    requestFn: async () => ({ data: {} }),
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
  });

  assert.deepEqual(results, [
    { number: 12, error: 'assignment failed' },
    { number: 13, error: 'assignment failed' },
  ]);
});
