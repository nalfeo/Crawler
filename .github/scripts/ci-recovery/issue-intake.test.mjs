import assert from 'node:assert/strict';
import test from 'node:test';

import { ISSUE_INTAKE_BODY, issueIntakeEligibility, runIssueIntake } from './issue-intake-lib.mjs';

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

import {
  buildRetroactivePlanComment,
  hasCopilotPlanComment,
  hasIntakeRequirementComment,
  ISSUE_INTAKE_MARKER,
  ISSUE_RECOVERY_PLAN_MARKER,
} from './issue-intake-lib.mjs';

test('hasIntakeRequirementComment returns true only for trusted intake-marker comments', () => {
  assert.equal(hasIntakeRequirementComment([]), false);
  assert.equal(
    hasIntakeRequirementComment([
      { body: 'no marker here', user: { login: 'nalfeo' }, author_association: 'OWNER' },
    ]),
    false,
  );
  assert.equal(
    hasIntakeRequirementComment([
      {
        body: `${ISSUE_INTAKE_MARKER}\n@copilot\nPlease handle...`,
        user: { login: 'nalfeo' },
        author_association: 'OWNER',
      },
    ]),
    true,
  );
  // Intake marker from untrusted author (non-member) does not count.
  assert.equal(
    hasIntakeRequirementComment([
      {
        body: `${ISSUE_INTAKE_MARKER}\n@copilot\nPlease handle...`,
        user: { login: 'random-user' },
        author_association: 'NONE',
      },
    ]),
    false,
  );
  // Trusted bot login also counts.
  assert.equal(
    hasIntakeRequirementComment([
      {
        body: `${ISSUE_INTAKE_MARKER}\n@copilot\nPlease handle...`,
        user: { login: 'github-actions[bot]' },
        author_association: 'NONE',
      },
    ]),
    true,
  );
});

test('hasCopilotPlanComment recognises existing Copilot plan and recovery plan markers', () => {
  assert.equal(hasCopilotPlanComment([]), false);
  // Intake comment from Copilot does NOT count as a plan comment.
  assert.equal(
    hasCopilotPlanComment([
      {
        body: `${ISSUE_INTAKE_MARKER}\n@copilot`,
        user: { login: 'copilot-swe-agent' },
      },
    ]),
    false,
  );
  // A non-intake Copilot comment counts.
  assert.equal(
    hasCopilotPlanComment([
      { body: 'Plan: create a weapon brief...', user: { login: 'copilot-swe-agent' } },
    ]),
    true,
  );
  // copilot[bot] login also counts.
  assert.equal(
    hasCopilotPlanComment([{ body: 'My implementation plan is...', user: { login: 'copilot' } }]),
    true,
  );
  // Recovery plan marker from any author counts (idempotency sentinel).
  assert.equal(
    hasCopilotPlanComment([
      {
        body: `${ISSUE_RECOVERY_PLAN_MARKER}\n\nRetroactive plan...`,
        user: { login: 'nalfeo' },
      },
    ]),
    true,
  );
});

test('buildRetroactivePlanComment embeds recovery marker and PR reference', () => {
  const body = buildRetroactivePlanComment(
    42,
    'feat: add quarterstaff',
    'https://github.com/o/r/pull/42',
  );
  assert.ok(body.includes(ISSUE_RECOVERY_PLAN_MARKER));
  assert.ok(body.includes('#42'));
  assert.ok(body.includes('feat: add quarterstaff'));
  assert.ok(body.includes('https://github.com/o/r/pull/42'));
  // Must not include untrusted HTML comment injection.
  const injected = buildRetroactivePlanComment(1, '<!-- injected -->', 'https://example.com/p/1');
  assert.ok(!injected.includes('<!-- injected -->'));
});
