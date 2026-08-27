import assert from 'node:assert/strict';
import test from 'node:test';

import { nodeMarker } from './epic-create.mjs';
import {
  blockedIssueNumbers,
  copilotOwnershipStatus,
  getLinkedPullRequests,
  isManagedOpenEpicNode,
  reprocessEpicNodes,
} from './epic-reprocess.mjs';
import { BLOCKED_LABEL } from '../merge-train/state.mjs';

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

test('reads every textual epic blocker once', () => {
  assert.deepEqual(
    blockedIssueNumbers({ body: 'Ignored\nBlocked by #1, #2, #1\nIgnored' }),
    [1, 2],
  );
  assert.deepEqual(blockedIssueNumbers({ body: 'Blocked by #not-a-number' }), []);
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
      if (path === '/repos/nalfeo/Crawler/issues/1') return { data: { state: 'closed' } };
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

test('does not activate a node while a textual epic blocker is open', async () => {
  const blockedNode = { ...managedNode, body: `${managedNode.body}\nBlocked by #1` };
  const results = await reprocessEpicNodes({
    graphqlFn: async () => {
      throw new Error('intake must not run');
    },
    paginateFn: async (_token, path) => {
      if (path.includes('labels=epic')) return [blockedNode];
      throw new Error(`unexpected paginate path: ${path}`);
    },
    requestFn: async () => ({ data: { state: 'open' } }),
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
  });

  assert.deepEqual(results, [{ number: 12, assigned: false, reason: 'blocked by open #1' }]);
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
    requestFn: async () => ({ data: { state: 'closed' } }),
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
  });

  assert.deepEqual(results, [
    { number: 12, error: 'assignment failed' },
    { number: 13, error: 'assignment failed' },
  ]);
});

test('getLinkedPullRequests paginates closedByPullRequestsReferences fully', async () => {
  const calls = [];
  const graphqlFn = async (_token, _query, variables) => {
    calls.push(variables);
    if (!variables.cursor) {
      return {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
              nodes: [{ number: 100, state: 'CLOSED', labels: { nodes: [] } }],
            },
          },
        },
      };
    }
    return {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 101,
                state: 'OPEN',
                labels: { nodes: [{ name: BLOCKED_LABEL }] },
              },
            ],
          },
        },
      },
    };
  };

  const linked = await getLinkedPullRequests({
    graphqlFn,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    issueNumber: 3542,
  });

  assert.deepEqual(linked, [
    { number: 100, state: 'CLOSED', labels: [] },
    { number: 101, state: 'OPEN', labels: [{ name: BLOCKED_LABEL }] },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'CURSOR_1');
});

test('copilotOwnershipStatus: not stale when Copilot is not assigned', () => {
  const status = copilotOwnershipStatus({ assignees: [{ login: 'nalfeo' }] }, []);
  assert.equal(status.stale, false);
  assert.match(status.reason, /not currently assigned/);
});

test('copilotOwnershipStatus: not stale when no PR has been opened yet', () => {
  const status = copilotOwnershipStatus({ assignees: [{ login: 'Copilot' }] }, []);
  assert.equal(status.stale, false);
  assert.match(status.reason, /no linked PR yet/);
});

test('copilotOwnershipStatus: stale (abandoned) when every linked PR is closed', () => {
  const status = copilotOwnershipStatus({ assignees: [{ login: 'Copilot' }] }, [
    { number: 100, state: 'CLOSED', labels: [] },
    { number: 105, state: 'CLOSED', labels: [] },
  ]);
  assert.equal(status.stale, true);
  assert.match(status.reason, /^abandoned:/);
  assert.match(status.reason, /#100/);
  assert.match(status.reason, /#105/);
});

test('copilotOwnershipStatus: not stale when a linked PR is MERGED (never mistake a merge for abandonment)', () => {
  // A merged PR is definitive proof the work landed. GitHub's issue
  // auto-close on merge can lag the merge event, so this reprocess pass can
  // observe the issue still open with its PR already merged -- forcing a
  // restart in that window would be a disruptive, wasted re-implementation.
  const status = copilotOwnershipStatus({ assignees: [{ login: 'Copilot' }] }, [
    { number: 100, state: 'MERGED', labels: [] },
  ]);
  assert.equal(status.stale, false);
  assert.match(status.reason, /merged/);
  assert.match(status.reason, /#100/);
});

test('copilotOwnershipStatus: a MERGED PR outranks other closed/unmerged siblings', () => {
  const status = copilotOwnershipStatus({ assignees: [{ login: 'Copilot' }] }, [
    { number: 100, state: 'CLOSED', labels: [] },
    { number: 105, state: 'MERGED', labels: [] },
  ]);
  assert.equal(status.stale, false);
});

test('copilotOwnershipStatus: stale (quarantined) when every open linked PR is merge-train-blocked', () => {
  const status = copilotOwnershipStatus({ assignees: [{ login: 'Copilot' }] }, [
    { number: 3588, state: 'OPEN', labels: [{ name: BLOCKED_LABEL }] },
  ]);
  assert.equal(status.stale, true);
  assert.match(status.reason, /^quarantined:/);
  assert.match(status.reason, /#3588/);
});

test('copilotOwnershipStatus: not stale when a healthy replacement PR is also open', () => {
  const status = copilotOwnershipStatus({ assignees: [{ login: 'Copilot' }] }, [
    { number: 3588, state: 'OPEN', labels: [{ name: BLOCKED_LABEL }] },
    { number: 3609, state: 'OPEN', labels: [] },
  ]);
  assert.equal(status.stale, false);
  assert.match(status.reason, /open and not quarantined/);
});

test('reprocessEpicNodes forces a restart when the only linked PR is quarantined', async () => {
  const quarantinedNode = {
    ...managedNode,
    assignees: [
      { login: 'nalfeo', id: 'USER_NALFEO' },
      { login: 'Copilot', id: 'BOT_COPILOT' },
    ],
  };
  const graphqlCalls = [];
  const graphqlFn = async (_token, query, variables) => {
    graphqlCalls.push(query.includes('closedByPullRequestsReferences') ? 'linked-prs' : query);
    if (query.includes('closedByPullRequestsReferences')) {
      return {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { number: 3588, state: 'OPEN', labels: { nodes: [{ name: BLOCKED_LABEL }] } },
              ],
            },
          },
        },
      };
    }
    if (query.includes('suggestedActors')) {
      return {
        repository: {
          suggestedActors: { nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent' }] },
          issue: {
            id: 'ISSUE_12',
            state: 'OPEN',
            labels: { nodes: [] },
            assignees: {
              nodes: [
                { id: 'USER_NALFEO', login: 'nalfeo' },
                { id: 'BOT_COPILOT', login: 'copilot-swe-agent' },
              ],
            },
          },
        },
      };
    }
    if (query.includes('removeAssigneesFromAssignable')) {
      return { removeAssigneesFromAssignable: { assignable: { assignees: { nodes: [] } } } };
    }
    return {
      replaceActorsForAssignable: {
        assignable: { assignees: { nodes: [{ login: 'nalfeo' }, { login: 'copilot-swe-agent' }] } },
      },
    };
  };

  const results = await reprocessEpicNodes({
    graphqlFn,
    paginateFn: async (_token, path) => {
      if (path.includes('labels=epic')) return [quarantinedNode];
      if (path.includes('/dependencies/blocked_by')) return [];
      if (path.endsWith('/comments')) return [];
      throw new Error(`unexpected paginate path: ${path}`);
    },
    requestFn: async (_token, path) => ({ data: { id: 9, node_id: 'COMMENT_9' } }),
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
      restarted: true,
      staleReason: `quarantined: linked PR(s) #3588 blocked by the merge train (${BLOCKED_LABEL})`,
    },
  ]);
  // The restart path must actually unassign before reassigning, or the
  // reassignment is a same-set no-op that never restarts the session.
  assert.ok(graphqlCalls.some((query) => query.includes('removeAssigneesFromAssignable')));
});

test('reprocessEpicNodes does not restart a node whose linked PR is open and healthy', async () => {
  const healthyNode = {
    ...managedNode,
    assignees: [{ login: 'Copilot', id: 'BOT_COPILOT' }],
  };
  const graphqlFn = async (_token, query) => {
    if (query.includes('closedByPullRequestsReferences')) {
      return {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ number: 3600, state: 'OPEN', labels: { nodes: [] } }],
            },
          },
        },
      };
    }
    return {
      repository: {
        suggestedActors: { nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent' }] },
        issue: {
          id: 'ISSUE_12',
          state: 'OPEN',
          labels: { nodes: [] },
          assignees: { nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent' }] },
        },
      },
      replaceActorsForAssignable: {
        assignable: { assignees: { nodes: [{ login: 'copilot-swe-agent' }] } },
      },
    };
  };

  const results = await reprocessEpicNodes({
    graphqlFn,
    paginateFn: async (_token, path) => {
      if (path.includes('labels=epic')) return [healthyNode];
      if (path.includes('/dependencies/blocked_by')) return [];
      if (path.endsWith('/comments')) return [];
      throw new Error(`unexpected paginate path: ${path}`);
    },
    requestFn: async () => ({ data: { id: 9 } }),
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].restarted, undefined);
});
