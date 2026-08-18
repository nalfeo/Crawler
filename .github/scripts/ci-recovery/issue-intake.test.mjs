import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  addIssueAssignees,
  buildIssueActorIds,
  buildRetroactivePlanComment,
  hasCopilotPlanComment,
  hasIntakeRequirementComment,
  intakeOpenedIssue,
  intakeUnblockedDependents,
  ISSUE_INTAKE_BODY,
  ISSUE_INTAKE_MARKER,
  ISSUE_RECOVERY_PLAN_MARKER,
  isTelemetryIssue,
  issueIntakeEligibility,
  openBlockingIssues,
  removeIssueAssignees,
  reviewThreadPlanIssueNumbers,
  runIssueIntake,
} from './issue-intake-lib.mjs';

const issue = {
  node_id: 'ISSUE_1067',
  number: 1067,
};

test('issue intake workflow subscribes to reopened issues', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/issue-copilot-intake.yml'), 'utf8');
  assert.match(workflow, /types:\s*\[opened,\s*reopened,\s*closed\]/);
});

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

test('telemetry issues are never eligible for Copilot assignment', () => {
  const telemetryIssue = {
    number: 3044,
    user: { login: 'nalfeo' },
    labels: [{ name: 'telemetry' }],
  };

  assert.equal(isTelemetryIssue(telemetryIssue), true);
  assert.deepEqual(issueIntakeEligibility(telemetryIssue, 'nalfeo'), {
    eligible: false,
    reason: 'telemetry issues are not assigned to Copilot',
  });
});

test('review plan issue selection fails closed on unmatched explicit issue references', () => {
  const closingIssues = [{ number: 1307 }];
  const trustedRoot = (body) => ({
    body,
    author: { login: 'copilot-pull-request-reviewer' },
    authorAssociation: 'NONE',
  });

  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            trustedRoot('Issue #1307 required an implementation plan comment before the PR.'),
          ],
        },
      },
      closingIssues,
    ),
    [1307],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [trustedRoot('Issue #999 required an implementation plan comment before the PR.')],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            trustedRoot('Issue #13070 required an implementation plan comment before the PR.'),
          ],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [trustedRoot('The source issue required an implementation plan before the PR.')],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [trustedRoot('The implementation plan on #1307 is complete.')],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            trustedRoot('Issue #1307 requires no changes; the implementation plan is complete.'),
          ],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            trustedRoot(
              'Issue #1307: the implementation plan is complete; a checklist is required.',
            ),
          ],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            trustedRoot('Issue #1307 requires the issue comment itself to contain a checklist.'),
          ],
        },
      },
      closingIssues,
    ),
    [1307],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [trustedRoot('#999 required an implementation plan before the PR.')],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            trustedRoot(
              'Issue #1307 closes this PR, but #999 required an implementation plan before the PR.',
            ),
          ],
        },
      },
      closingIssues,
    ),
    [],
  );
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            {
              body: 'The source issue required an implementation plan before the PR.',
              author: { login: 'random-user' },
              authorAssociation: 'NONE',
            },
            trustedRoot('Issue #1307 required an implementation plan comment before the PR.'),
          ],
        },
      },
      closingIssues,
    ),
    [],
  );
  // Regression: reviewer used "required the detailed plan to be posted on the issue"
  // which the original regex (planSubject-only) did not match.
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [
            trustedRoot(
              'Issue #1307 explicitly required the detailed plan to be posted on the issue before any code was written. This note confirms that requirement was not met; recording the plan only in-session does not satisfy the issue-specific constraint. Since the timing requirement cannot be repaired retroactively, obtain an explicit maintainer waiver before approval.',
            ),
          ],
        },
      },
      closingIssues,
    ),
    [1307],
  );
  // Variation: "required a plan to be posted" (no adjective, no "the")
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [trustedRoot('Issue #1307 required a plan to be posted on the issue.')],
        },
      },
      closingIssues,
    ),
    [1307],
  );
  // Variation: "required the plan to be posted" (no adjective)
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [trustedRoot('Issue #1307 required the plan to be posted before merging.')],
        },
      },
      closingIssues,
    ),
    [1307],
  );
  // Non-matching: "plan" mentioned but not in a "plan to be posted" pattern
  assert.deepEqual(
    reviewThreadPlanIssueNumbers(
      {
        comments: {
          nodes: [trustedRoot('Issue #1307: please post a plan at your convenience.')],
        },
      },
      closingIssues,
    ),
    [],
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
  // A structured non-intake Copilot plan comment counts.
  assert.equal(
    hasCopilotPlanComment([
      {
        body: [
          '**High-level design and approach**',
          'Create the weapon brief in the shared catalog.',
          '',
          '**Key decisions and alternatives**',
          '- Keep the current manifest format.',
          '',
          '**Checklist**',
          '- [x] Add the brief.',
        ].join('\n'),
        user: { login: 'copilot-swe-agent' },
      },
    ]),
    true,
  );
  // Arbitrary Copilot status notes do NOT count as plan evidence.
  assert.equal(
    hasCopilotPlanComment([
      { body: 'Still investigating the failing review thread.', user: { login: 'copilot' } },
    ]),
    false,
  );
  assert.equal(
    hasCopilotPlanComment([
      {
        body: [
          'The reviewer requested high-level design, key decisions, and checklist details.',
          '- Still investigating.',
          'Progress update one.',
          'Progress update two.',
        ].join('\n'),
        user: { login: 'copilot-swe-agent' },
      },
    ]),
    false,
  );
  // Standalone non-plan headings reset section parsing and must not satisfy required sections.
  assert.equal(
    hasCopilotPlanComment([
      {
        body: [
          '**High-level design and approach**',
          '## Status',
          'Still investigating.',
          '**Key decisions and alternatives**',
          '- Keep the current manifest format.',
          '**Checklist**',
          '- [x] Add the brief.',
        ].join('\n'),
        user: { login: 'copilot-swe-agent' },
      },
    ]),
    false,
  );
  assert.equal(
    hasCopilotPlanComment([
      {
        body: [
          '**High-level design and approach**',
          'Create the weapon brief in the shared catalog.',
          '',
          '**Key decisions and alternatives**',
          '- Keep the current manifest format.',
          '',
          '**Checklist**',
          '',
          '## Status',
          '- [x] Still investigating.',
        ].join('\n'),
        user: { login: 'copilot-swe-agent' },
      },
    ]),
    false,
  );
  // Trusted recovery plan marker counts.
  assert.equal(
    hasCopilotPlanComment([
      {
        body: `${ISSUE_RECOVERY_PLAN_MARKER}\n\nRetroactive plan...`,
        user: { login: 'nalfeo' },
        author_association: 'OWNER',
      },
    ]),
    true,
  );
  // Untrusted recovery marker spoof does not count.
  assert.equal(
    hasCopilotPlanComment([
      {
        body: `${ISSUE_RECOVERY_PLAN_MARKER}\n\nRetroactive plan...`,
        user: { login: 'random-user' },
        author_association: 'NONE',
      },
    ]),
    false,
  );
});

test('buildRetroactivePlanComment embeds required plan content and PR reference', () => {
  const body = buildRetroactivePlanComment(
    42,
    'feat: add quarterstaff',
    'https://github.com/o/r/pull/42',
    [
      'Repair-agent sessions lack `issues: write`, so the reconciler must post the plan itself.',
      '',
      '## Changes',
      '- Add trusted plan detection helpers.',
      '- Post the retroactive plan from reconcile.',
    ].join('\n'),
  );
  assert.ok(body.includes(ISSUE_RECOVERY_PLAN_MARKER));
  assert.ok(body.includes('#42'));
  assert.ok(body.includes('feat: add quarterstaff'));
  assert.ok(body.includes('https://github.com/o/r/pull/42'));
  assert.match(body, /\*\*High-level design and approach\*\*/);
  assert.match(body, /\*\*Key decisions and alternatives\*\*/);
  assert.match(body, /\*\*Checklist\*\*/);
  assert.match(body, /- \[x\] Add trusted plan detection helpers\./);
});

test('buildRetroactivePlanComment stays below the GitHub comment limit for oversized PR bodies', () => {
  const prUrl = 'https://github.com/nalfeo/Crawler/pull/1604';
  const oversizedBody = [
    '## Fix',
    'x'.repeat(65_000),
    '',
    '## Changes',
    ...Array.from({ length: 100 }, (_, index) => `- ${index}: ${'y'.repeat(1_000)}`),
  ].join('\n');

  const body = buildRetroactivePlanComment(1604, 'Permission gap recovery', prUrl, oversizedBody);

  assert.ok(body.length < 65_536, `expected body below GitHub limit, got ${body.length}`);
  assert.ok(body.includes(`**PR:** ${prUrl}`), 'truncation must preserve the source PR link');
  assert.match(body, /\*\*High-level design and approach\*\*/);
  assert.match(body, /\*\*Key decisions and alternatives\*\*/);
  assert.match(body, /\*\*Checklist\*\*/);
  assert.match(body, /Review remaining implementation details/);
  // Must not include untrusted HTML comment injection.
  const injected = buildRetroactivePlanComment(
    1,
    '<!-- injected -->',
    'https://example.com/p/1',
    '<!-- hidden -->\n\n## Changes\n- keep visible',
  );
  assert.ok(!injected.includes('<!-- injected -->'));
  assert.ok(!injected.includes('<!-- hidden -->'));
});

// --- blocked_by gate + auto-assign-on-unblock -----------------------------

function makeSuccessfulIntakeFakes() {
  const graphql = async (_token, query) => {
    if (query.includes('suggestedActors')) {
      return {
        repository: {
          suggestedActors: {
            nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent', __typename: 'Bot' }],
          },
          issue: { id: 'ISSUE_NODE', state: 'OPEN', assignees: { nodes: [] } },
        },
      };
    }
    return {
      replaceActorsForAssignable: {
        assignable: { assignees: { nodes: [{ login: 'copilot-swe-agent' }] } },
      },
    };
  };
  const paginate = async () => [];
  const request = async (_token, _path, _options) => ({ data: { id: 1 } });
  return { graphql, paginate, request };
}

test('openBlockingIssues keeps only open dependencies, case-insensitively', () => {
  assert.deepEqual(openBlockingIssues(undefined), []);
  assert.deepEqual(openBlockingIssues([]), []);
  assert.deepEqual(
    openBlockingIssues([
      { number: 1, state: 'open' },
      { number: 2, state: 'closed' },
    ]),
    [{ number: 1, state: 'open' }],
  );
  assert.deepEqual(openBlockingIssues([{ number: 3, state: 'OPEN' }]), [
    { number: 3, state: 'OPEN' },
  ]);
});

test('intakeOpenedIssue is blocked while an open blocker exists and never assigns', async () => {
  let graphqlCalled = false;
  const graphql = async () => {
    graphqlCalled = true;
    return {};
  };
  const paginate = async (_token, path) => {
    assert.ok(path.includes('/dependencies/blocked_by'));
    return [
      { number: 1851, state: 'open' },
      { number: 1857, state: 'closed' },
    ];
  };
  const request = async () => {
    throw new Error('request must not be called by the blocked_by dependency fetch');
  };

  const result = await intakeOpenedIssue({
    graphql,
    paginate,
    request,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    issue: { number: 1892, node_id: 'ISSUE_1892', user: { login: 'nalfeo' }, labels: [] },
  });

  assert.equal(result.assigned, false);
  assert.match(result.reason, /blocked by open #1851/);
  assert.equal(graphqlCalled, false, 'must never call graphql while blocked');
});

test('intakeOpenedIssue proceeds with assignment when eligible and unblocked', async () => {
  const fakes = makeSuccessfulIntakeFakes();
  const paginate = async (_token, path) => {
    if (path.includes('/dependencies/blocked_by')) {
      return [];
    }
    return fakes.paginate(_token, path);
  };

  const result = await intakeOpenedIssue({
    graphql: fakes.graphql,
    paginate,
    request: fakes.request,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    issue: { number: 1900, node_id: 'ISSUE_1900', user: { login: 'nalfeo' }, labels: [] },
  });

  assert.deepEqual(result, {
    assigned: true,
    reason: 'trusted issue opener',
    assignee: 'copilot-swe-agent',
    comment: 'posted',
  });
});

test('intakeOpenedIssue skips ineligible openers before ever querying dependencies', async () => {
  let paginateCalled = false;
  const result = await intakeOpenedIssue({
    graphql: async () => ({}),
    paginate: async () => {
      paginateCalled = true;
      return [];
    },
    request: async () => ({ data: [] }),
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    issue: { number: 1901, node_id: 'ISSUE_1901', user: { login: 'random-user' }, labels: [] },
  });

  assert.equal(result.assigned, false);
  assert.equal(paginateCalled, false, 'eligibility must short-circuit before the dependency query');
});

test('intakeOpenedIssue rejects a telemetry-labeled dependent even from the unblock sweep', async () => {
  let paginateCalled = false;
  const result = await intakeOpenedIssue({
    graphql: async () => ({}),
    paginate: async () => {
      paginateCalled = true;
      return [];
    },
    request: async () => ({ data: [] }),
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    issue: {
      number: 1905,
      node_id: 'ISSUE_1905',
      user: { login: 'nalfeo' },
      labels: [{ name: 'telemetry' }],
    },
    fromUnblockSweep: true,
  });

  assert.deepEqual(result, {
    assigned: false,
    reason: 'telemetry issues are not assigned to Copilot',
  });
  assert.equal(
    paginateCalled,
    false,
    'telemetry guard must short-circuit before the dependency query',
  );
});

test('intakeUnblockedDependents assigns eligible unblocked dependents and skips the rest', async () => {
  const fakes = makeSuccessfulIntakeFakes();
  const closedIssue = { number: 1851 };
  // depA mirrors the real #1892 payload: owner-opened with the automation label.
  // The unblock-sweep must assign it despite the automation label (which the
  // regular intake gate rejects when the opener is not github-actions[bot]).
  const depA = {
    number: 1892,
    node_id: 'ISSUE_1892',
    state: 'open',
    user: { login: 'nalfeo' },
    labels: [{ name: 'automation' }],
    repository: { full_name: 'nalfeo/Crawler' },
  };
  const depB = {
    number: 1902,
    node_id: 'ISSUE_1902',
    state: 'open',
    user: { login: 'nalfeo' },
    labels: [],
    repository: { full_name: 'nalfeo/Crawler' },
  };
  const depC = {
    number: 1903,
    node_id: 'ISSUE_1903',
    state: 'closed',
    user: { login: 'nalfeo' },
    labels: [],
    repository: { full_name: 'nalfeo/Crawler' },
  };
  const depD = {
    number: 1904,
    node_id: 'ISSUE_1904',
    state: 'open',
    user: { login: 'nalfeo' },
    labels: [],
    repository: { full_name: 'other/repo' },
  };

  const paginate = async (_token, path) => {
    if (path === '/repos/nalfeo/Crawler/issues/1851/dependencies/blocking') {
      return [depA, depB, depC, depD];
    }
    if (path === '/repos/nalfeo/Crawler/issues/1892/dependencies/blocked_by') {
      return [];
    }
    if (path === '/repos/nalfeo/Crawler/issues/1902/dependencies/blocked_by') {
      return [{ number: 1857, state: 'open' }];
    }
    return fakes.paginate(_token, path);
  };

  const results = await intakeUnblockedDependents({
    graphql: fakes.graphql,
    paginate,
    request: fakes.request,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    closedIssue,
  });

  assert.deepEqual(
    results.map((r) => r.number),
    [1892, 1902, 1903, 1904],
  );
  assert.equal(
    results[0].assigned,
    true,
    'automation-labeled owner-opened dependent should be assigned in unblock sweep',
  );
  assert.equal(results[0].assignee, 'copilot-swe-agent');
  assert.equal(results[1].assigned, false);
  assert.match(results[1].reason, /blocked by open #1857/);
  assert.equal(results[2].assigned, false);
  assert.equal(results[2].reason, 'dependent not open');
  assert.equal(results[3].assigned, false);
  assert.equal(results[3].reason, 'dependent in a different repository');
});

test('intakeOpenedIssue propagates a blocked_by fetch error instead of assuming unblocked', async () => {
  await assert.rejects(
    intakeOpenedIssue({
      graphql: async () => ({}),
      paginate: async () => {
        throw new Error('GitHub GET failed (500): boom');
      },
      request: async () => ({ data: [] }),
      token: 'token',
      owner: 'nalfeo',
      repo: 'Crawler',
      issue: { number: 1905, node_id: 'ISSUE_1905', user: { login: 'nalfeo' }, labels: [] },
    }),
    /boom/,
  );
});

test('intakeUnblockedDependents records a per-dependent error without stopping other dependents', async () => {
  const depOk = {
    number: 2001,
    node_id: 'ISSUE_2001',
    state: 'open',
    user: { login: 'nalfeo' },
    labels: [],
    repository: { full_name: 'nalfeo/Crawler' },
  };
  const depFails = {
    number: 2002,
    node_id: 'ISSUE_2002',
    state: 'open',
    user: { login: 'nalfeo' },
    labels: [],
    repository: { full_name: 'nalfeo/Crawler' },
  };
  const fakes = makeSuccessfulIntakeFakes();

  const paginate = async (_token, path) => {
    if (path === '/repos/nalfeo/Crawler/issues/1851/dependencies/blocking') {
      return [depOk, depFails];
    }
    if (path === '/repos/nalfeo/Crawler/issues/2001/dependencies/blocked_by') {
      return [];
    }
    if (path === '/repos/nalfeo/Crawler/issues/2002/dependencies/blocked_by') {
      throw new Error('GitHub GET failed (503): transient');
    }
    return fakes.paginate(_token, path);
  };

  const results = await intakeUnblockedDependents({
    graphql: fakes.graphql,
    paginate,
    request: fakes.request,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    closedIssue: { number: 1851 },
  });

  assert.deepEqual(
    results.map((r) => r.number),
    [2001, 2002],
  );
  assert.equal(results[0].assigned, true);
  assert.equal(results[1].assigned, false);
  assert.match(results[1].error, /transient/);
});

test('intakeUnblockedDependents reports a dependent that closed mid-sweep as a skip, not an error', async () => {
  const depRacing = {
    number: 3001,
    node_id: 'ISSUE_3001',
    state: 'open',
    user: { login: 'nalfeo' },
    labels: [],
    repository: { full_name: 'nalfeo/Crawler' },
  };
  const graphql = async (_token, query) => {
    if (query.includes('suggestedActors')) {
      return {
        repository: {
          suggestedActors: {
            nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent', __typename: 'Bot' }],
          },
          // The issue closed between our blocked_by check and this live fetch.
          issue: { id: 'ISSUE_3001', state: 'CLOSED', assignees: { nodes: [] } },
        },
      };
    }
    throw new Error('must not attempt assignment mutation for a closed issue');
  };
  const paginate = async (_token, path) => {
    if (path === '/repos/nalfeo/Crawler/issues/1851/dependencies/blocking') {
      return [depRacing];
    }
    if (path === '/repos/nalfeo/Crawler/issues/3001/dependencies/blocked_by') {
      return [];
    }
    return [];
  };

  const results = await intakeUnblockedDependents({
    graphql,
    paginate,
    request: async () => ({ data: [] }),
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    closedIssue: { number: 1851 },
  });

  assert.deepEqual(results, [
    { number: 3001, assigned: false, reason: 'dependent closed during processing' },
  ]);
});

test('runIssueIntake refuses to assign an issue that is no longer open', async () => {
  const graphql = async () => ({
    repository: {
      suggestedActors: {
        nodes: [{ id: 'BOT_COPILOT', login: 'copilot-swe-agent', __typename: 'Bot' }],
      },
      issue: { id: 'ISSUE_1067', state: 'CLOSED', assignees: { nodes: [] } },
    },
  });

  await assert.rejects(
    runIssueIntake({
      graphql,
      paginate: async () => [],
      request: async () => ({ data: { id: 1 } }),
      token: 'token',
      owner: 'nalfeo',
      repo: 'Crawler',
      issue,
    }),
    /no longer open/,
  );
});
