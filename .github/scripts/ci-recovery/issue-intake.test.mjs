import assert from 'node:assert/strict';
import test from 'node:test';

import { ISSUE_INTAKE_BODY, runIssueIntake } from './issue-intake-lib.mjs';

const issue = {
  node_id: 'ISSUE_1067',
  number: 1067,
};

test('assigns Copilot through GraphQL before posting the kickoff comment', async () => {
  const calls = [];
  const graphql = async (_token, query, variables) => {
    if (query.includes('suggestedActors')) {
      calls.push(['discover', variables]);
      return {
        repository: {
          suggestedActors: {
            nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent', __typename: 'Bot' }],
          },
        },
      };
    }

    calls.push(['assign', variables]);
    return {
      replaceActorsForAssignable: {
        assignable: {
          assignees: {
            nodes: [{ login: 'copilot-swe-agent' }],
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
    return { data: {} };
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
  assert.deepEqual(
    calls.map(([name]) => name),
    ['discover', 'assign', 'comments', 'request'],
  );
  assert.deepEqual(calls[1][1], {
    assignableId: 'ISSUE_1067',
    actorIds: ['BOT_COPILOT'],
  });
  assert.equal(calls[3][1], '/repos/nalfeo/Crawler/issues/1067/comments');
  assert.deepEqual(calls[3][2], {
    method: 'POST',
    body: { body: ISSUE_INTAKE_BODY },
  });
});

test('does not post a kickoff comment when assignment does not persist', async () => {
  let commentsRead = false;
  let requestMade = false;
  let graphqlCall = 0;
  const graphql = async () => {
    graphqlCall += 1;
    if (graphqlCall === 1) {
      return {
        repository: {
          suggestedActors: {
            nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent', __typename: 'Bot' }],
          },
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
      paginate: async () => {
        commentsRead = true;
        return [];
      },
      request: async () => {
        requestMade = true;
        return { data: {} };
      },
      token: 'token',
      owner: 'nalfeo',
      repo: 'Crawler',
      issue,
    }),
    /Copilot assignment did not persist on issue #1067/,
  );
  assert.equal(commentsRead, false);
  assert.equal(requestMade, false);
});
