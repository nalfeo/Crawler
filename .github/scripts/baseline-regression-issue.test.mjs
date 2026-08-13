import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASELINE_REGRESSION_LABELS,
  fileBaselineRegressionIssue,
} from './baseline-regression-issue.mjs';

function decision() {
  const marker = '<!-- release-baseline-regression:abc123 -->';
  return {
    regression: true,
    issue: {
      marker,
      title: 'bug: release sweep regression at abc123',
      body: `${marker}\nRegression evidence`,
    },
  };
}

function harness(existingIssues = []) {
  const calls = [];
  const paginateFn = async (token, url) => {
    calls.push(['paginate', token, url]);
    if (url.includes('/comments')) return [];
    return existingIssues;
  };
  const requestFn = async (token, url, options) => {
    calls.push(['request', token, url, options]);
    if (options.method === 'POST' && url.endsWith('/issues')) {
      return { data: { number: 42, node_id: 'ISSUE_42', state: 'open' } };
    }
    const number = Number(url.split('/').at(-1));
    return { data: { number, node_id: `ISSUE_${number}`, state: 'open' } };
  };
  const intakeFn = async (args) => {
    calls.push(['intake', args.token, args.issue.number]);
    return { assignee: 'copilot-swe-agent' };
  };
  return { calls, paginateFn, requestFn, intakeFn };
}

test('creates one labeled issue with GITHUB_TOKEN then assigns through shared PAT intake', async () => {
  const h = harness();
  const result = await fileBaselineRegressionIssue({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    intakeFn: h.intakeFn,
    graphqlFn: async () => ({}),
    mutationToken: 'github-token',
    intakeToken: 'pat-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    decision: decision(),
  });

  assert.deepEqual(result, {
    action: 'created',
    issueNumber: 42,
    assignee: 'copilot-swe-agent',
  });
  const create = h.calls.find(
    (call) => call[0] === 'request' && call[2] === '/repos/nalfeo/Crawler/issues',
  );
  assert.equal(create[1], 'github-token');
  assert.deepEqual(create[3].body.labels, BASELINE_REGRESSION_LABELS);
  assert.deepEqual(h.calls.at(-1), ['intake', 'pat-token', 42]);
});

test('updates an open marker match instead of creating a duplicate', async () => {
  const h = harness([
    {
      number: 7,
      node_id: 'ISSUE_7',
      state: 'open',
      body: decision().issue.body,
      updated_at: '2026-08-12T00:00:00Z',
    },
  ]);
  const result = await fileBaselineRegressionIssue({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    intakeFn: h.intakeFn,
    graphqlFn: async () => ({}),
    mutationToken: 'github-token',
    intakeToken: 'pat-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    decision: decision(),
  });
  assert.equal(result.action, 'updated');
  const patch = h.calls.find((call) => call[0] === 'request');
  assert.equal(patch[2], '/repos/nalfeo/Crawler/issues/7');
  assert.equal(patch[3].body.state, undefined);
  assert.equal(h.calls.filter((call) => call[2] === '/repos/nalfeo/Crawler/issues').length, 0);
});

test('reopens the newest closed marker match and re-runs assignment', async () => {
  const h = harness([
    {
      number: 8,
      node_id: 'ISSUE_8',
      state: 'closed',
      body: decision().issue.body,
      updated_at: '2026-08-11T00:00:00Z',
    },
    {
      number: 9,
      node_id: 'ISSUE_9',
      state: 'closed',
      body: decision().issue.body,
      updated_at: '2026-08-12T00:00:00Z',
    },
  ]);
  const result = await fileBaselineRegressionIssue({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    intakeFn: h.intakeFn,
    graphqlFn: async () => ({}),
    mutationToken: 'github-token',
    intakeToken: 'pat-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    decision: decision(),
  });
  assert.equal(result.action, 'reopened');
  const patch = h.calls.find((call) => call[0] === 'request');
  assert.equal(patch[2], '/repos/nalfeo/Crawler/issues/9');
  assert.equal(patch[3].body.state, 'open');
  assert.deepEqual(h.calls.at(-1), ['intake', 'pat-token', 9]);
});

test('propagates create and assignment failures so regression filing cannot pass silently', async () => {
  const createFailure = harness();
  createFailure.requestFn = async () => {
    throw new Error('create failed');
  };
  await assert.rejects(
    fileBaselineRegressionIssue({
      requestFn: createFailure.requestFn,
      paginateFn: createFailure.paginateFn,
      intakeFn: createFailure.intakeFn,
      graphqlFn: async () => ({}),
      mutationToken: 'github-token',
      intakeToken: 'pat-token',
      owner: 'nalfeo',
      repo: 'Crawler',
      decision: decision(),
    }),
    /create failed/,
  );

  const assignmentFailure = harness();
  assignmentFailure.intakeFn = async () => {
    throw new Error('assignment failed');
  };
  await assert.rejects(
    fileBaselineRegressionIssue({
      requestFn: assignmentFailure.requestFn,
      paginateFn: assignmentFailure.paginateFn,
      intakeFn: assignmentFailure.intakeFn,
      graphqlFn: async () => ({}),
      mutationToken: 'github-token',
      intakeToken: 'pat-token',
      owner: 'nalfeo',
      repo: 'Crawler',
      decision: decision(),
    }),
    /assignment failed/,
  );
});

test('rejects non-regression and incomplete decisions before making API calls', async () => {
  for (const invalidDecision of [
    { regression: false },
    { regression: true, issue: { title: 'missing marker', body: 'no marker' } },
  ]) {
    const h = harness();
    await assert.rejects(
      fileBaselineRegressionIssue({
        requestFn: h.requestFn,
        paginateFn: h.paginateFn,
        intakeFn: h.intakeFn,
        graphqlFn: async () => ({}),
        mutationToken: 'github-token',
        intakeToken: 'pat-token',
        owner: 'nalfeo',
        repo: 'Crawler',
        decision: invalidDecision,
      }),
      /does not contain a fileable issue/,
    );
    assert.equal(h.calls.length, 0);
  }
});
