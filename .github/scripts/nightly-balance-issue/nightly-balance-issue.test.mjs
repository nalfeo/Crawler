import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';
import {
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
  intakeError = null,
  closeError = null,
  initialIssues = [],
} = {}) {
  const calls = [];
  const openIssues = [...initialIssues];
  let nextIssueNumber = 1203;

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
      const issue = {
        number: nextIssueNumber,
        node_id: `ISSUE_${nextIssueNumber}`,
        title: options.body.title,
      };
      nextIssueNumber += 1;
      openIssues.push(issue);
      return { data: issue };
    }
    if (options.method === 'PATCH' && options.body?.state === 'closed') {
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
    if (intakeError) throw intakeError;
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
    /all six FINAL `weapon-sweep-<weapon>` aggregate artifacts and 100 seeds\/weapon only/,
    /exact head SHA/,
    /Shipped\/default runtime configuration only/,
    /telemetry-backed causal attribution/,
    /real Floor-1 production reachability/,
    /Propose UP TO 3, including zero; never fill quota/,
    /Never use individual\/selected shards/,
    /dormant definitions, unreachable code are ineligible/,
    /never bundle unmeasured ideas or infer marginal contribution from combined treatment/,
    />10 runs via GitHub workflow dispatch/,
    /local smoke never accepts\/rejects/,
    /never substitute 10-seed indicative results/,
    /inability to run independent canonical sweep => no implementation\/PR/,
    /Gameplay PR contains `Closes #<this issue number>`/,
    /labels `human-approval-required` \+ `merge-train-blocked`/,
    /Only exact standalone trimmed owner `nalfeo` comment `APPROVED FOR CHECK-IN` unlocks/,
    /Every terminal outcome that produces no implementation PR .* is not complete until you post a final rationale\/ledger comment .* then close this issue/,
    /closure is mandatory, not optional, for every no-PR path/,
    /@copilot Please execute this issue end-to-end/,
  ];
  for (const invariant of required) assert.match(ISSUE_BODY, invariant);

  assert.doesNotMatch(ISSUE_BODY, /(?:exactly|at least) 3 (?:ideas|candidates)/i);
  assert.doesNotMatch(ISSUE_BODY, /10-seed (?:results|sweep).*(?:sufficient|acceptable)/i);
  assert.deepEqual(ISSUE_LABELS, [
    'bug',
    'automation',
    'telemetry',
    'simulation',
    'ai',
    HUMAN_APPROVAL_LABEL,
  ]);
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
  const harness = createHarness({ intakeError });

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
  const harness = createHarness({ intakeError, closeError });

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
