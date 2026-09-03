import assert from 'node:assert/strict';
import test from 'node:test';

import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';
import { runNightlyAgentIssue } from './nightly-agent-issue.mjs';

const repository = 'nalfeo/Crawler';
const githubToken = 'github-token';
const intakeToken = 'intake-token';
const ISSUE_TITLE = 'test: recurring agent task';
const ISSUE_LABELS = Object.freeze(['automation', HUMAN_APPROVAL_LABEL]);
const buildIssueBody = (issueNumber = '<this issue number>') => `Agent task #${issueNumber}`;
const ISSUE_BODY = buildIssueBody();

function createHarness({
  labelExists = true,
  // Per-call queues so multi-run scenarios (e.g. a failing run followed by a
  // successful resume) can script each intake/close call independently. An
  // undefined/falsy entry at a given call index means that call succeeds.
  intakeErrors = [],
  updateErrors = [],
  closeErrors = [],
  initialIssues = [],
} = {}) {
  const calls = [];
  const openIssues = [...initialIssues];
  let nextIssueNumber = 1203;
  let intakeCallCount = 0;
  let updateCallCount = 0;
  let closeCallCount = 0;

  const paginateFn = async (token, path) => {
    calls.push({ kind: 'paginate', token, path });
    return [...openIssues];
  };

  const requestFn = async (token, path, options = {}) => {
    calls.push({ kind: 'request', token, path, options });
    if (path.endsWith(`/labels/${HUMAN_APPROVAL_LABEL}`) && !labelExists) {
      const error = new Error('label not found');
      error.status = 404;
      throw error;
    }
    if (path.endsWith('/issues') && options.method === 'POST') {
      // Mirror the real GitHub REST shape so ownership/proof checks in
      // production code (opener login, labels, assignees) have real inputs
      // to evaluate rather than undefined fields.
      const issue = {
        number: nextIssueNumber,
        node_id: `ISSUE_${nextIssueNumber}`,
        title: options.body.title,
        body: options.body.body,
        user: { login: 'github-actions[bot]' },
        labels: (options.body.labels || []).map((name) => ({ name })),
        assignees: [],
      };
      nextIssueNumber += 1;
      openIssues.push(issue);
      return { data: issue };
    }
    if (options.method === 'PATCH' && typeof options.body?.body === 'string') {
      const updateError = updateErrors[updateCallCount];
      updateCallCount += 1;
      if (updateError) throw updateError;
      const issueNumber = Number(path.split('/').at(-1));
      const target = openIssues.find((issue) => issue.number === issueNumber);
      if (target) target.body = options.body.body;
      return { data: target ?? { number: issueNumber, body: options.body.body } };
    }
    if (options.method === 'PATCH' && options.body?.state === 'closed') {
      const closeError = closeErrors[closeCallCount];
      closeCallCount += 1;
      if (closeError) throw closeError;
      const issueNumber = Number(path.split('/').at(-1));
      const index = openIssues.findIndex((issue) => issue.number === issueNumber);
      if (index >= 0) openIssues.splice(index, 1);
      return { data: { number: issueNumber, state: 'closed' } };
    }
    return { data: {} };
  };

  const intakeFn = async (args) => {
    calls.push({ kind: 'intake', args });
    const intakeError = intakeErrors[intakeCallCount];
    intakeCallCount += 1;
    if (intakeError) throw intakeError;
    // A real successful intake ends with Copilot assigned on the issue, which is
    // exactly what later `assignees`-based proof checks read back via paginateFn.
    const target = openIssues.find((issue) => issue.number === args.issue.number);
    if (target) target.assignees = [{ login: 'copilot-swe-agent' }];
    return { assignee: 'copilot-swe-agent', comment: 'posted' };
  };

  return { calls, openIssues, paginateFn, requestFn, intakeFn };
}

function runWithHarness(harness, overrides = {}) {
  return runNightlyAgentIssue({
    githubToken,
    intakeToken,
    repository,
    issueTitle: ISSUE_TITLE,
    issueLabels: ISSUE_LABELS,
    buildIssueBodyFn: buildIssueBody,
    paginateFn: harness.paginateFn,
    requestFn: harness.requestFn,
    graphqlFn: async () => ({}),
    intakeFn: harness.intakeFn,
    ...overrides,
  });
}

test('consecutive runs create one issue and invoke Copilot intake once', async () => {
  const harness = createHarness();

  const first = await runWithHarness(harness);
  const second = await runWithHarness(harness);

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'existing');
  assert.equal(harness.openIssues.length, 1);
  const issueCreates = harness.calls.filter(
    (call) =>
      call.kind === 'request' && call.path.endsWith('/issues') && call.options.method === 'POST',
  );
  assert.equal(issueCreates.length, 1);
  assert.deepEqual(issueCreates[0].options.body, {
    title: ISSUE_TITLE,
    body: ISSUE_BODY,
    labels: ISSUE_LABELS,
  });
  const bodyUpdates = harness.calls.filter(
    (call) =>
      call.kind === 'request' &&
      call.path === `/repos/nalfeo/Crawler/issues/${harness.openIssues[0].number}` &&
      call.options.method === 'PATCH' &&
      typeof call.options.body?.body === 'string',
  );
  assert.equal(bodyUpdates.length, 2);
  assert.ok(bodyUpdates.every((call) => call.options.body.body === buildIssueBody(1203)));
  assert.equal(harness.openIssues[0].body, buildIssueBody(1203));
  const intakeCalls = harness.calls.filter((call) => call.kind === 'intake');
  assert.equal(intakeCalls.length, 1);
  assert.equal(intakeCalls[0].args.token, intakeToken);
  assert.equal(intakeCalls[0].args.issue, first.issue);
  assert.equal(intakeCalls[0].args.issue.node_id, 'ISSUE_1203');
});

test('ignores matching pull requests while scanning every open issue', async () => {
  const harness = createHarness({
    initialIssues: [
      {
        number: 88,
        title: ISSUE_TITLE,
        pull_request: { url: 'https://example.test/pulls/88' },
      },
    ],
  });

  const result = await runWithHarness(harness);

  assert.equal(result.status, 'created');
  assert.equal(harness.calls[0].kind, 'paginate');
  assert.equal(harness.calls[0].path, '/repos/nalfeo/Crawler/issues?state=open');
});

test('creates the human approval label when it is missing', async () => {
  const harness = createHarness({ labelExists: false });

  await runWithHarness(harness);

  const labelCreate = harness.calls.find(
    (call) =>
      call.kind === 'request' && call.path.endsWith('/labels') && call.options.method === 'POST',
  );
  assert.deepEqual(labelCreate.options.body, {
    name: HUMAN_APPROVAL_LABEL,
    color: 'b60205',
    description: 'Requires explicit repository-owner approval before merge automation',
  });
});

test('closes a newly created issue and preserves the intake error', async () => {
  const intakeError = new Error('Copilot assignment failed');
  const harness = createHarness({ intakeErrors: [intakeError] });

  await assert.rejects(runWithHarness(harness), (error) => error === intakeError);

  const close = harness.calls.find(
    (call) => call.kind === 'request' && call.options.body?.state === 'closed',
  );
  assert.equal(close.token, githubToken);
  assert.equal(close.path, '/repos/nalfeo/Crawler/issues/1203');
  assert.deepEqual(close.options.body, { state: 'closed', state_reason: 'not_planned' });
  assert.equal(harness.openIssues.length, 0);
});

test('wraps both errors in an AggregateError when the rollback close also fails', async () => {
  const intakeError = new Error('Copilot assignment failed');
  const closeError = new Error('GitHub API unavailable');
  const harness = createHarness({ intakeErrors: [intakeError], closeErrors: [closeError] });

  await assert.rejects(runWithHarness(harness), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [intakeError, closeError]);
    assert.equal(error.cause, intakeError);
    assert.equal(
      error.message,
      'Issue intake failed for #1203: Copilot assignment failed; ' +
        'closing the issue also failed: GitHub API unavailable',
    );
    return true;
  });

  const close = harness.calls.find(
    (call) => call.kind === 'request' && call.options.body?.state === 'closed',
  );
  assert.equal(close.path, '/repos/nalfeo/Crawler/issues/1203');
  assert.equal(harness.openIssues.length, 1);
});

test('closes a newly created issue when patching in the exact issue number fails', async () => {
  const updateError = new Error('issue update failed');
  const harness = createHarness({ updateErrors: [updateError] });

  await assert.rejects(runWithHarness(harness), (error) => error === updateError);

  const close = harness.calls.find(
    (call) => call.kind === 'request' && call.options.body?.state === 'closed',
  );
  assert.equal(close.path, '/repos/nalfeo/Crawler/issues/1203');
  assert.equal(harness.openIssues.length, 0);
});

test('wraps both errors when issue-number patching fails and rollback close also fails', async () => {
  const updateError = new Error('issue update failed');
  const closeError = new Error('GitHub API unavailable');
  const harness = createHarness({ updateErrors: [updateError], closeErrors: [closeError] });

  await assert.rejects(runWithHarness(harness), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [updateError, closeError]);
    assert.equal(error.cause, updateError);
    assert.equal(
      error.message,
      'Issue body update failed for #1203: issue update failed; ' +
        'closing the issue also failed: GitHub API unavailable',
    );
    return true;
  });

  assert.equal(harness.openIssues.length, 1);
});

test('resumed orphan run canonicalizes issue body before intake', async () => {
  const firstUpdateError = new Error('issue update failed');
  const firstCloseError = new Error('GitHub API unavailable');
  const harness = createHarness({
    updateErrors: [firstUpdateError],
    closeErrors: [firstCloseError],
  });

  await assert.rejects(runWithHarness(harness), (error) => error instanceof AggregateError);
  assert.equal(harness.openIssues.length, 1);
  assert.equal(harness.openIssues[0].body, ISSUE_BODY);

  const second = await runWithHarness(harness);

  assert.equal(second.status, 'resumed');
  assert.equal(harness.openIssues[0].body, buildIssueBody(1203));
  assert.equal(harness.calls.filter((call) => call.kind === 'intake').length, 1);

  const secondRunCalls = harness.calls.slice(
    harness.calls.findIndex((call, index) => index > 0 && call.kind === 'paginate'),
  );
  const secondRunUpdateIndex = secondRunCalls.findIndex(
    (call) =>
      call.kind === 'request' &&
      call.path === '/repos/nalfeo/Crawler/issues/1203' &&
      call.options.method === 'PATCH' &&
      typeof call.options.body?.body === 'string',
  );
  const secondRunIntakeIndex = secondRunCalls.findIndex((call) => call.kind === 'intake');
  assert.ok(secondRunUpdateIndex >= 0 && secondRunIntakeIndex >= 0);
  assert.ok(secondRunUpdateIndex < secondRunIntakeIndex);
});

test('resume path retries later when existing automation issue body patch fails', async () => {
  const firstUpdateError = new Error('issue update failed');
  const firstCloseError = new Error('GitHub API unavailable');
  const secondUpdateError = new Error('resume body patch failed');
  const harness = createHarness({
    updateErrors: [firstUpdateError, secondUpdateError],
    closeErrors: [firstCloseError],
  });

  await assert.rejects(runWithHarness(harness), (error) => error instanceof AggregateError);
  await assert.rejects(runWithHarness(harness), (error) => error === secondUpdateError);

  assert.equal(harness.openIssues.length, 1);
  assert.equal(harness.openIssues[0].body, ISSUE_BODY);
  assert.equal(harness.calls.filter((call) => call.kind === 'intake').length, 0);
  assert.equal(
    harness.calls.filter((call) => call.kind === 'request' && call.options.body?.state === 'closed')
      .length,
    1,
  );
});

test('resumes intake on the same automation-created issue after a prior run left it orphaned', async () => {
  const firstIntakeError = new Error('Copilot assignment failed');
  const firstCloseError = new Error('GitHub API unavailable');
  const harness = createHarness({
    intakeErrors: [firstIntakeError],
    closeErrors: [firstCloseError],
  });

  await assert.rejects(runWithHarness(harness), (error) => error instanceof AggregateError);
  assert.equal(harness.openIssues.length, 1);
  assert.deepEqual(harness.openIssues[0].assignees, []);

  const second = await runWithHarness(harness);

  assert.equal(second.status, 'resumed');
  assert.equal(second.issue.number, 1203);
  assert.deepEqual(second.intake, { assignee: 'copilot-swe-agent', comment: 'posted' });
  assert.equal(harness.openIssues.length, 1);
  assert.ok(harness.openIssues[0].assignees.some((a) => a.login === 'copilot-swe-agent'));

  const issueCreates = harness.calls.filter(
    (call) =>
      call.kind === 'request' && call.path.endsWith('/issues') && call.options.method === 'POST',
  );
  assert.equal(issueCreates.length, 1, 'never files a second issue while resuming');

  const intakeCalls = harness.calls.filter((call) => call.kind === 'intake');
  assert.equal(intakeCalls.length, 2);
  assert.equal(intakeCalls[1].args.token, intakeToken);
  assert.equal(intakeCalls[1].args.issue.number, 1203);

  // Once proof of completed intake exists, a third run must deterministically no-op
  // and must not call intake again.
  const third = await runWithHarness(harness);
  assert.equal(third.status, 'existing');
  assert.equal(
    harness.calls.filter((call) => call.kind === 'intake').length,
    2,
    'no further intake call once proof is present',
  );
});

test('never resumes intake or closes a foreign exact-title issue this automation did not create', async () => {
  const harness = createHarness({
    initialIssues: [
      {
        number: 55,
        node_id: 'ISSUE_55',
        title: ISSUE_TITLE,
        user: { login: 'someone-else' },
        labels: [{ name: 'automation' }],
        assignees: [],
      },
    ],
  });

  const result = await runWithHarness(harness);

  assert.equal(result.status, 'existing');
  assert.equal(result.issue.number, 55);
  assert.equal(harness.openIssues.length, 1);
  assert.equal(harness.calls.filter((call) => call.kind === 'intake').length, 0);
  assert.equal(
    harness.calls.filter((call) => call.kind === 'request' && call.options.body?.state === 'closed')
      .length,
    0,
  );
  assert.equal(
    harness.calls.filter(
      (call) =>
        call.kind === 'request' && call.path.endsWith('/issues') && call.options.method === 'POST',
    ).length,
    0,
  );
});

test('never resumes intake for an automation-opened issue missing the automation label', async () => {
  const harness = createHarness({
    initialIssues: [
      {
        number: 77,
        node_id: 'ISSUE_77',
        title: ISSUE_TITLE,
        user: { login: 'github-actions[bot]' },
        labels: [{ name: 'bug' }],
        assignees: [],
      },
    ],
  });

  const result = await runWithHarness(harness);

  assert.equal(result.status, 'existing');
  assert.equal(harness.calls.filter((call) => call.kind === 'intake').length, 0);
});

test('validates every required input before GitHub access', async () => {
  for (const overrides of [
    { githubToken: '' },
    { intakeToken: '' },
    { repository: '' },
    { repository: 'missing-repo' },
    { issueTitle: '' },
    { issueLabels: null },
    { buildIssueBodyFn: null },
  ]) {
    const harness = createHarness();
    await assert.rejects(runWithHarness(harness, overrides));
    assert.deepEqual(harness.calls, []);
  }
});
