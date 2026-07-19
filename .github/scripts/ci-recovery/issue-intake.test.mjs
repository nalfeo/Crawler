import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addIssueAssignees,
  buildIssueActorIds,
  ISSUE_INTAKE_BODY,
  issueIntakeEligibility,
  removeIssueAssignees,
  runIssueIntake,
} from './issue-intake-lib.mjs';

const issue = {
  node_id: 'ISSUE_1067',
  number: 1067,
};

test('issue intake accepts only trusted opener and label combinations', () => {
  const cases = [
    { name: 'maintainer', login: 'nalfeo', labels: [], eligible: true },
    { name: 'maintainer case-insensitively', login: 'NALFEO', labels: [], eligible: true },
    { name: 'Copilot app login', login: 'app/copilot-swe-agent', labels: [], eligible: true },
    { name: 'Copilot REST bot login', login: 'copilot-swe-agent[bot]', labels: [], eligible: true },
    {
      name: 'Actions without automation',
      login: 'github-actions[bot]',
      labels: [],
      eligible: true,
    },
    {
      name: 'Actions with automation',
      login: 'GitHub-Actions[bot]',
      labels: ['automation'],
      eligible: true,
    },
    { name: 'arbitrary bot', login: 'dependabot[bot]', labels: [], eligible: false },
    {
      name: 'maintainer automation issue',
      login: 'nalfeo',
      labels: ['automation'],
      eligible: false,
    },
    {
      name: 'Copilot automation issue',
      login: 'copilot-swe-agent[bot]',
      labels: ['automation'],
      eligible: false,
    },
  ];

  for (const entry of cases) {
    const result = issueIntakeEligibility(
      {
        number: 123,
        user: { login: entry.login },
        labels: entry.labels.map((name) => ({ name })),
      },
      'nalfeo',
    );
    assert.equal(result.eligible, entry.eligible, entry.name);
  }
});

test('issue intake rejects missing issues and pull-request payloads', () => {
  assert.equal(issueIntakeEligibility(null).eligible, false);
  assert.equal(
    issueIntakeEligibility({
      number: 123,
      user: { login: 'nalfeo' },
      pull_request: { url: 'https://example.test/pr/123' },
    }).eligible,
    false,
  );
});

test('kickoff comment body includes the required planning instructions', () => {
  assert.match(ISSUE_INTAKE_BODY, /\*\*Before writing any code\*\*/);
  assert.match(ISSUE_INTAKE_BODY, /High-level design and approach for the work\./);
  assert.match(
    ISSUE_INTAKE_BODY,
    /Key decisions made \(e\.g\. which systems, skills, or libraries are involved; alternatives considered\)\./,
  );
  assert.match(ISSUE_INTAKE_BODY, /A checklist of the concrete steps you will take\./);
  assert.match(
    ISSUE_INTAKE_BODY,
    /Post this plan comment on the issue itself so the maintainer can review it before you open a PR\./,
  );
  assert.match(
    ISSUE_INTAKE_BODY,
    /Then, when you open the PR, include the same high-level summary in the PR description\./,
  );
});

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
            id: 'ISSUE_1067',
            state: 'OPEN',
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
            nodes: [{ login: 'nalfeo' }, { login: 'Copilot' }],
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
  assert.match(calls[2][2].body.body, /\*\*Before writing any code\*\*/);
  assert.match(
    calls[2][2].body.body,
    /Then, when you open the PR, include the same high-level summary in the PR description\./,
  );
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
          issue: { id: 'ISSUE_1067', state: 'OPEN', assignees: { nodes: [] } },
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

test('buildIssueActorIds preserves existing Copilot assignee ids when includeCopilot=true', () => {
  const actorIds = buildIssueActorIds({
    assignees: [
      { id: 'USER_NALFEO', login: 'nalfeo' },
      { id: 'BOT_LEGACY_COPILOT', login: 'Copilot' },
    ],
    copilotActorId: 'BOT_COPILOT_SWE_AGENT',
    includeCopilot: true,
  });
  assert.deepEqual(actorIds, ['USER_NALFEO', 'BOT_LEGACY_COPILOT']);
});

test('buildIssueActorIds adds discovered Copilot actor when none is currently assigned', () => {
  const actorIds = buildIssueActorIds({
    assignees: [{ id: 'USER_NALFEO', login: 'nalfeo' }],
    copilotActorId: 'BOT_COPILOT_SWE_AGENT',
    includeCopilot: true,
  });
  assert.deepEqual(actorIds, ['USER_NALFEO', 'BOT_COPILOT_SWE_AGENT']);
});

test('addIssueAssignees sends correct mutation field, variables, and parses returned logins', async () => {
  const captured = [];
  const fakeGraphql = async (_token, query, variables) => {
    captured.push({ query, variables });
    return {
      addAssigneesToAssignable: {
        assignable: {
          assignees: {
            nodes: [{ login: 'nalfeo' }, { login: 'copilot-swe-agent' }],
          },
        },
      },
    };
  };

  const result = await addIssueAssignees({
    graphql: fakeGraphql,
    token: 'token',
    assignableId: 'ISSUE_NODE_ID',
    actorIds: ['USER_NALFEO', 'BOT_COPILOT'],
  });

  assert.equal(captured.length, 1);
  assert.ok(
    /^\s*mutation\b/.test(captured[0].query.trim()),
    'operation must be declared as a mutation, not a query',
  );
  assert.ok(
    captured[0].query.includes('addAssigneesToAssignable'),
    'mutation must use addAssigneesToAssignable field',
  );
  assert.ok(
    captured[0].query.includes('$assignableId') && captured[0].query.includes('$assigneeIds'),
    'mutation must accept $assignableId and $assigneeIds variables',
  );
  assert.deepEqual(captured[0].variables, {
    assignableId: 'ISSUE_NODE_ID',
    assigneeIds: ['USER_NALFEO', 'BOT_COPILOT'],
  });
  assert.deepEqual(result, ['nalfeo', 'copilot-swe-agent']);
});

test('removeIssueAssignees sends correct mutation field, variables, and parses returned logins', async () => {
  const captured = [];
  const fakeGraphql = async (_token, query, variables) => {
    captured.push({ query, variables });
    return {
      removeAssigneesFromAssignable: {
        assignable: {
          assignees: {
            nodes: [{ login: 'nalfeo' }],
          },
        },
      },
    };
  };

  const result = await removeIssueAssignees({
    graphql: fakeGraphql,
    token: 'token',
    assignableId: 'ISSUE_NODE_ID',
    actorIds: ['BOT_COPILOT'],
  });

  assert.equal(captured.length, 1);
  assert.ok(
    /^\s*mutation\b/.test(captured[0].query.trim()),
    'operation must be declared as a mutation, not a query',
  );
  assert.ok(
    captured[0].query.includes('removeAssigneesFromAssignable'),
    'mutation must use removeAssigneesFromAssignable field',
  );
  assert.ok(
    captured[0].query.includes('$assignableId') && captured[0].query.includes('$assigneeIds'),
    'mutation must accept $assignableId and $assigneeIds variables',
  );
  assert.deepEqual(captured[0].variables, {
    assignableId: 'ISSUE_NODE_ID',
    assigneeIds: ['BOT_COPILOT'],
  });
  assert.deepEqual(result, ['nalfeo']);
});

test('addIssueAssignees returns empty array when response is missing the assignees field', async () => {
  const fakeGraphql = async () => ({ addAssigneesToAssignable: { assignable: {} } });
  const result = await addIssueAssignees({
    graphql: fakeGraphql,
    token: 'token',
    assignableId: 'ISSUE_NODE_ID',
    actorIds: ['USER_NALFEO'],
  });
  assert.deepEqual(result, []);
});

test('removeIssueAssignees returns empty array when response is missing the assignees field', async () => {
  const fakeGraphql = async () => ({ removeAssigneesFromAssignable: { assignable: {} } });
  const result = await removeIssueAssignees({
    graphql: fakeGraphql,
    token: 'token',
    assignableId: 'ISSUE_NODE_ID',
    actorIds: ['BOT_COPILOT'],
  });
  assert.deepEqual(result, []);
});
