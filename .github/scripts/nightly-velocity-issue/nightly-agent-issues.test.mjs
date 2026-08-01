import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ISSUE_LABELS as PERF_LABELS,
  ISSUE_TITLE as PERF_TITLE,
  buildIssueBody as buildPerfIssueBody,
  runNightlyPerfIssue,
} from '../nightly-perf-issue/nightly-perf-issue.mjs';
import {
  ISSUE_LABELS as VELOCITY_LABELS,
  ISSUE_TITLE as VELOCITY_TITLE,
  buildIssueBody as buildVelocityIssueBody,
  runNightlyVelocityIssue,
} from './nightly-velocity-issue.mjs';

const repository = 'nalfeo/Crawler';
const githubToken = 'github-token';
const intakeToken = 'intake-token';

function createHarness() {
  const calls = [];
  const openIssues = [];
  let nextIssueNumber = 3001;

  const paginateFn = async (token, path) => {
    calls.push({ kind: 'paginate', token, path });
    return [...openIssues];
  };

  const requestFn = async (token, path, options = {}) => {
    calls.push({ kind: 'request', token, path, options });
    if (path.endsWith('/labels/human-approval-required')) return { data: {} };
    if (path.endsWith('/issues') && options.method === 'POST') {
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
      const issueNumber = Number(path.split('/').at(-1));
      const issue = openIssues.find((candidate) => candidate.number === issueNumber);
      if (issue) issue.body = options.body.body;
      return { data: issue };
    }
    return { data: {} };
  };

  const intakeFn = async (args) => {
    calls.push({ kind: 'intake', args });
    const issue = openIssues.find((candidate) => candidate.number === args.issue.number);
    if (issue) issue.assignees = [{ login: 'copilot-swe-agent' }];
    return { assignee: 'copilot-swe-agent', comment: 'posted' };
  };

  return { calls, openIssues, paginateFn, requestFn, intakeFn };
}

async function runWithHarness(runFn, harness) {
  return runFn({
    githubToken,
    intakeToken,
    repository,
    paginateFn: harness.paginateFn,
    requestFn: harness.requestFn,
    graphqlFn: async () => ({}),
    intakeFn: harness.intakeFn,
  });
}

function expectCreatedIssue(harness, { expectedTitle, expectedLabels, expectedBody }) {
  assert.equal(harness.openIssues.length, 1);
  const createdIssue = harness.openIssues[0];
  assert.equal(createdIssue.title, expectedTitle);
  assert.deepEqual(
    createdIssue.labels.map((label) => label.name),
    expectedLabels,
  );
  assert.equal(createdIssue.body, expectedBody(createdIssue.number));
}

test('nightly velocity filer creates and then reuses one durable issue', async () => {
  const harness = createHarness();
  const first = await runWithHarness(runNightlyVelocityIssue, harness);
  const second = await runWithHarness(runNightlyVelocityIssue, harness);

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'existing');
  expectCreatedIssue(harness, {
    expectedTitle: VELOCITY_TITLE,
    expectedLabels: VELOCITY_LABELS,
    expectedBody: buildVelocityIssueBody,
  });
});

test('nightly perf filer creates and then reuses one durable issue', async () => {
  const harness = createHarness();
  const first = await runWithHarness(runNightlyPerfIssue, harness);
  const second = await runWithHarness(runNightlyPerfIssue, harness);

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'existing');
  expectCreatedIssue(harness, {
    expectedTitle: PERF_TITLE,
    expectedLabels: PERF_LABELS,
    expectedBody: buildPerfIssueBody,
  });
});

test('nightly velocity issue body uses fully qualified closes reference', () => {
  const issueNumber = 2612;
  assert.match(
    buildVelocityIssueBody(issueNumber),
    new RegExp(`Closes nalfeo/Crawler#${issueNumber}`),
  );
});
