import assert from 'node:assert/strict';
import test from 'node:test';

import { ISSUE_INTAKE_BODY, runIssueIntake } from './issue-intake-lib.mjs';

const issue = {
  node_id: 'ISSUE_1067',
  number: 1067,
};

test('posts kickoff comment before assigning Copilot and preserves existing assignees', async () => {
  const calls = [];
  const graphql = async (_token, query, variables) => {
    if (query.includes('suggestedActors')) {
      calls.push(['discover', variables]);
      return {
        repository: {
          suggestedActors: {
            nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent', __typename: 'Bot' }],
          },
          issue: {
            assignees: { nodes: [{ id: 'USER_NALFEO', login: 'nalfeo' }] },
          },
        },
      };
    }

    calls.push(['assign', variables]);
    return {
      replaceActorsForAssignable: {
        assignable: {
          assignees: {
            nodes: [{ login: 'nalfeo' }, { login: 'copilot-swe-agent' }],
          },
        },
      },
    };
  };
  const paginate = async () => {
    calls.push(['comments']);
    return [];
  };
  const request = async (_token, path, options) => {
    calls.push(['request', path, options]);
    return { data: { id: 12345 } };
  };

  const result = await runIssueIntake({
    graphql,
    paginate,
    request,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    issue,
  });

  assert.deepEqual(result, { assignee: 'copilot-swe-agent', comment: 'posted' });
  // comment is posted before assignment so Copilot sees it at session start
  assert.deepEqual(
    calls.map(([name]) => name),
    ['discover', 'comments', 'request', 'assign'],
  );
  // existing assignee is preserved alongside Copilot
  assert.deepEqual(calls[3][1], {
    assignableId: 'ISSUE_1067',
    actorIds: ['USER_NALFEO', 'BOT_COPILOT'],
  });
  assert.equal(calls[2][1], '/repos/nalfeo/Crawler/issues/1067/comments');
  assert.deepEqual(calls[2][2], {
    method: 'POST',
    body: { body: ISSUE_INTAKE_BODY },
  });
});

test('deletes the kickoff comment when assignment does not persist', async () => {
  const requestCalls = [];
  let graphqlCall = 0;
  const graphql = async () => {
    graphqlCall += 1;
    if (graphqlCall === 1) {
      return {
        repository: {
          suggestedActors: {
            nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent', __typename: 'Bot' }],
          },
          issue: { assignees: { nodes: [] } },
        },
      };
    }
    return {
      replaceActorsForAssignable: {
        assignable: {
          assignees: {
            nodes: [],
          },
        },
      },
    };
  };

  await assert.rejects(
    runIssueIntake({
      graphql,
      paginate: async () => [],
      request: async (_token, path, options) => {
        requestCalls.push({ path, method: options?.method });
        return { data: { id: 12345 } };
      },
      token: 'token',
      owner: 'nalfeo',
      repo: 'Crawler',
      issue,
    }),
    /Copilot assignment did not persist on issue #1067/,
  );
  // comment is posted then cleaned up so no misleading instruction comment lingers
  assert.equal(requestCalls.length, 2);
  assert.equal(requestCalls[0].method, 'POST');
  assert.equal(requestCalls[1].method, 'DELETE');
  assert.ok(requestCalls[1].path.includes('/12345'));
});
