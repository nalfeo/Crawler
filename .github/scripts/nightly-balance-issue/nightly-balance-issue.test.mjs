import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';
import {
  buildIssueBody,
  buildReleaseBaselineClause,
  ISSUE_BODY,
  ISSUE_LABELS,
  ISSUE_TITLE,
  runNightlyBalanceIssue,
} from './nightly-balance-issue.mjs';

const repository = 'nalfeo/Crawler';
const githubToken = 'github-token';
const intakeToken = 'intake-token';

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
  return runNightlyBalanceIssue({
    githubToken,
    intakeToken,
    repository,
    paginateFn: harness.paginateFn,
    requestFn: harness.requestFn,
    graphqlFn: async () => ({}),
    intakeFn: harness.intakeFn,
    ...overrides,
  });
}

test('hardened prompt encodes every evidence and approval gate', () => {
  const required = [
    /exact head SHA/,
    /Shipped\/default runtime configuration only/,
    /telemetry-backed causal attribution/,
    /real production reachability on a floor the baseline actually covers/,
    /Propose UP TO 3, including zero; never fill quota/,
    /Never use individual\/selected shards/,
    /dormant definitions, unreachable code are ineligible/,
    /never bundle unmeasured ideas or infer marginal contribution from combined treatment/,
    />10 runs via GitHub workflow dispatch/,
    /local smoke never accepts\/rejects/,
    /never substitute 10-seed indicative results/,
    /inability to run independent canonical sweep => no implementation\/PR/,
    /Gameplay PR contains `Closes nalfeo\/Crawler#<this issue number>`/,
    /labels `human-approval-required` \+ `merge-train-blocked`/,
    /Only an approving GitHub review from owner `nalfeo`, or their exact standalone trimmed comment `APPROVED FOR CHECK-IN`, unlocks/,
    /Every terminal outcome that produces no implementation PR .* is not complete until you post a final rationale\/ledger comment .* then close this issue/,
    /closure is mandatory, not optional, for every no-PR path/,
    /@copilot Please execute this issue end-to-end/,
  ];
  assert.equal(ISSUE_BODY.includes(buildReleaseBaselineClause()), true);
  assert.match(ISSUE_BODY, /Never assume a fixed sweep formulation/);
  // The sweep formulation is not part of the contract: a fixed weapon list,
  // seed count, or floor scope would go stale the next time the release sweep
  // is rebalanced.
  assert.doesNotMatch(ISSUE_BODY, /100 seeds\/weapon/);
  assert.doesNotMatch(ISSUE_BODY, /all six FINAL aggregate artifacts/);
  assert.doesNotMatch(ISSUE_BODY, /weapon-sweep-(?:sword|fireball)/);
  for (const invariant of required) assert.match(ISSUE_BODY, invariant);

  assert.doesNotMatch(ISSUE_BODY, /(?:exactly|at least) 3 (?:ideas|candidates)/i);
  assert.doesNotMatch(ISSUE_BODY, /10-seed (?:results|sweep).*(?:sufficient|acceptable)/i);
  // No release baseline was provided to ISSUE_BODY, so the win-rate
  // investigation ask must not fire — a healthy/unknown win rate never nags.
  assert.doesNotMatch(ISSUE_BODY, /Win-rate investigation/);
  assert.deepEqual(ISSUE_LABELS, [
    'bug',
    'automation',
    'telemetry',
    'simulation',
    'ai',
    HUMAN_APPROVAL_LABEL,
  ]);
});

test('issue body builder injects the exact issue number for the live approval gate', () => {
  const body = buildIssueBody(1253);
  assert.match(body, /Gameplay PR contains `Closes nalfeo\/Crawler#1253`/);
  assert.doesNotMatch(body, /Gameplay PR contains `Closes #1253`/);
  assert.equal(body.includes('weapon-sweep-<weapon>'), false);
});

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

test('validates every required environment value before GitHub access', async () => {
  for (const overrides of [
    { githubToken: '' },
    { intakeToken: '' },
    { repository: '' },
    { repository: 'missing-repo' },
  ]) {
    const harness = createHarness();
    await assert.rejects(runWithHarness(harness, overrides));
    assert.deepEqual(harness.calls, []);
  }
});

test('workflow is scheduled, serialized, least-privilege, and scopes secrets to execution', async () => {
  const workflow = (
    await readFile(new URL('../../workflows/nightly-balance-issue.yml', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');

  assert.match(workflow, /- cron: '0 8 \* \* \*'/);
  assert.match(workflow, /\n  workflow_dispatch:\s*\n/);
  assert.match(
    workflow,
    /concurrency:\n  group: nightly-balance-issue-filer\n  cancel-in-progress: false/,
  );
  assert.match(workflow, /permissions:\n  contents: read\n  issues: write/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);

  const executionStep = workflow.indexOf('- name: File nightly balance issue');
  assert.ok(executionStep > 0);
  assert.equal(workflow.slice(0, executionStep).includes('CRAWLER_CI_PAT'), false);
  assert.equal(workflow.match(/^\s+CRAWLER_CI_PAT:/gm)?.length, 1);
  assert.equal(workflow.match(/\$\{\{ secrets\.CRAWLER_CI_PAT \}\}/g)?.length, 1);
  assert.equal(workflow.match(/^\s+GITHUB_TOKEN:/gm)?.length, 1);
  assert.equal(workflow.match(/\$\{\{ secrets\.GITHUB_TOKEN \}\}/g)?.length, 1);
});

test('issue body stamps the resolved release baseline when one is available', () => {
  const baseline = {
    commit: 'c'.repeat(40),
    commitDate: '2026-08-20T07:29:59Z',
    capturedAt: '2026-08-20T08:45:32.263Z',
    totalRuns: 300,
    legs: { floor1: { totalWins: 300, totalRuns: 300 }, floor2: { totalWins: 41, totalRuns: 150 } },
    runUrl: 'https://github.com/nalfeo/Crawler/actions/runs/32345869317',
    payloadUrl: `https://github.com/nalfeo/Crawler/blob/baselines/by-sha/${'c'.repeat(40)}.json`,
    funReportUrl: null,
  };
  const body = buildIssueBody(77, baseline);
  assert.match(body, new RegExp(`commit \`${'c'.repeat(40)}\``));
  assert.match(body, /legs: floor1 300\/300, floor2 41\/150/);
  assert.match(body, /Re-resolve it before analysis/);
  // The Floor 2 / chain win-rate investigation ask moved to the release
  // workflow (issue #3293); the nightly body must no longer carry it.
  assert.doesNotMatch(body, /Win-rate investigation/);
  // Without a resolved baseline the body still explains how to find it.
  assert.match(buildIssueBody(77), /Resolve it yourself from the `baselines` branch/);
});
