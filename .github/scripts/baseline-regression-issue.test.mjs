import assert from 'node:assert/strict';
import test from 'node:test';

import { BASELINE_RECURRENCE_MARKER } from './ci-recovery/markers.mjs';
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

function signatureDecision(signatures, marker = 'abc123') {
  const markerText = `<!-- release-baseline-regression:${marker} -->`;
  return {
    regression: true,
    issue: {
      marker: markerText,
      title: `bug: release sweep regression at ${marker}`,
      failureSignatures: signatures,
      body: `${markerText}\n### Failure signatures\n\n${signatures.map((signature) => `- \`${signature}\``).join('\n')}`,
    },
  };
}

function copilotAssignees() {
  return [{ login: 'copilot-swe-agent' }];
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
    if (options.method === 'POST' && url.endsWith('/comments')) {
      return { data: { id: 99 } };
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

  assert.deepEqual(result, [{ action: 'created', issueNumber: 42, assignee: 'copilot-swe-agent' }]);
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

  assert.equal(result[0].action, 'updated');
  const patch = h.calls.find((call) => call[0] === 'request');
  assert.equal(patch[2], '/repos/nalfeo/Crawler/issues/7');
  assert.equal(patch[3].body.state, undefined);
  assert.equal(h.calls.filter((call) => call[2] === '/repos/nalfeo/Crawler/issues').length, 0);
});

test('collapses duplicate stable-marker issues onto the oldest and closes the rest', async () => {
  // A stable (non-commit) marker is long-lived and the release workflow is only
  // serialized per head SHA, so two overlapping releases can each create one.
  // Converging on the oldest and closing the duplicates makes that self-heal.
  const h = harness([
    {
      number: 9,
      node_id: 'ISSUE_9',
      state: 'open',
      body: decision().issue.body,
    },
    {
      number: 5,
      node_id: 'ISSUE_5',
      state: 'open',
      body: decision().issue.body,
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

  assert.equal(result[0].action, 'updated');
  assert.equal(result[0].issueNumber, 5);
  const patches = h.calls.filter((call) => call[0] === 'request');
  assert.equal(patches[0][2], '/repos/nalfeo/Crawler/issues/5');
  assert.equal(patches[0][3].body.state, undefined);
  assert.equal(patches[1][2], '/repos/nalfeo/Crawler/issues/9');
  assert.equal(patches[1][3].body.state, 'closed');
  assert.match(patches[1][3].body.body, /Superseded by #5/);
  // Intake still runs exactly once, on the surviving canonical issue.
  assert.deepEqual(
    h.calls.filter((call) => call[0] === 'intake'),
    [['intake', 'pat-token', 5]],
  );
});

test('comments on an existing issue when the same sweep configuration repeats', async () => {
  const signature =
    'floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=7|weapon=sword';
  const h = harness([
    {
      number: 12,
      node_id: 'ISSUE_12',
      state: 'open',
      assignees: copilotAssignees(),
      body: signatureDecision([signature]).issue.body,
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
    decision: signatureDecision([signature], 'newer'),
  });
  assert.deepEqual(result, [{ action: 'commented', issueNumber: 12 }]);
  const update = h.calls.find((call) => call[0] === 'request');
  assert.equal(update[2], '/repos/nalfeo/Crawler/issues/12/comments');
  assert.ok(update[3].body.body.startsWith(`${BASELINE_RECURRENCE_MARKER}\n`));
  assert.match(update[3].body.body, /occurred again/);
  assert.match(update[3].body.body, new RegExp(signature.replaceAll('|', '\\\\|')));
});

test('comments on the existing issue when only the failed seed changes', async () => {
  const oldSignature =
    'floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=7|weapon=sword';
  const newSignature =
    'floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=8|weapon=sword';
  const h = harness([
    {
      number: 15,
      node_id: 'ISSUE_15',
      state: 'open',
      assignees: copilotAssignees(),
      body: signatureDecision([oldSignature]).issue.body,
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
    decision: signatureDecision([newSignature], 'newer'),
  });

  assert.deepEqual(result, [{ action: 'commented', issueNumber: 15 }]);
  assert.equal(
    h.calls.filter((call) => call[0] === 'request' && call[2].endsWith('/issues')).length,
    0,
  );
  assert.equal(h.calls.filter((call) => call[0] === 'intake').length, 0);
});

test('keeps the oldest issue when historical duplicates share a configuration', async () => {
  const signature = (seed) =>
    `floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=${seed}|weapon=sword`;
  const h = harness([
    {
      number: 18,
      node_id: 'ISSUE_18',
      state: 'open',
      body: signatureDecision([signature(7)]).issue.body,
    },
    {
      number: 11,
      node_id: 'ISSUE_11',
      state: 'open',
      assignees: copilotAssignees(),
      body: signatureDecision([signature(8)]).issue.body,
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
    decision: signatureDecision([signature(9)], 'newer'),
  });

  assert.deepEqual(result, [{ action: 'commented', issueNumber: 11 }]);
  const duplicateClose = h.calls.find(
    (call) => call[0] === 'request' && call[2].endsWith('/issues/18'),
  );
  assert.equal(duplicateClose[3].body.state, 'closed');
  assert.match(duplicateClose[3].body.body, /Superseded by #11/);
});

test('retries intake for existing matching issue when prior create succeeded but intake failed', async () => {
  const signature =
    'floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=7|weapon=sword';
  const first = harness();
  first.intakeFn = async () => {
    throw new Error('intake failed');
  };
  await assert.rejects(
    fileBaselineRegressionIssue({
      requestFn: first.requestFn,
      paginateFn: first.paginateFn,
      intakeFn: first.intakeFn,
      graphqlFn: async () => ({}),
      mutationToken: 'github-token',
      intakeToken: 'pat-token',
      owner: 'nalfeo',
      repo: 'Crawler',
      decision: signatureDecision([signature], 'newer'),
    }),
    /intake failed/,
  );

  const retry = harness([
    {
      number: 42,
      node_id: 'ISSUE_42',
      state: 'open',
      assignees: [],
      body: signatureDecision([signature]).issue.body,
    },
  ]);
  const result = await fileBaselineRegressionIssue({
    requestFn: retry.requestFn,
    paginateFn: retry.paginateFn,
    intakeFn: retry.intakeFn,
    graphqlFn: async () => ({}),
    mutationToken: 'github-token',
    intakeToken: 'pat-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    decision: signatureDecision([signature], 'newer'),
  });

  assert.deepEqual(result, [
    { action: 'commented', issueNumber: 42, assignee: 'copilot-swe-agent' },
  ]);
  assert.deepEqual(
    retry.calls.filter((call) => call[0] === 'intake'),
    [['intake', 'pat-token', 42]],
  );
});

test('creates an issue only for a new failure signature', async () => {
  const oldSignature =
    'floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=7|weapon=sword';
  const newSignature =
    'floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=8|weapon=bow';
  const h = harness([
    {
      number: 13,
      node_id: 'ISSUE_13',
      state: 'open',
      body: signatureDecision([oldSignature]).issue.body,
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
    decision: signatureDecision([newSignature], 'newer'),
  });
  assert.deepEqual(result, [{ action: 'created', issueNumber: 42, assignee: 'copilot-swe-agent' }]);
  const create = h.calls.find((call) => call[0] === 'request' && call[2].endsWith('/issues'));
  assert.match(create[3].body.body, new RegExp(newSignature.replaceAll('|', '\\\\|')));
});

test('does not update an unrelated automation issue with a copied signature', async () => {
  const signature =
    'floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=7|weapon=sword';
  const h = harness([
    {
      number: 14,
      node_id: 'ISSUE_14',
      state: 'open',
      body: `Unrelated automation issue\n\n- \`${signature}\``,
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
    decision: signatureDecision([signature], 'newer'),
  });

  assert.deepEqual(result, [{ action: 'created', issueNumber: 42, assignee: 'copilot-swe-agent' }]);
  const create = h.calls.find((call) => call[0] === 'request' && call[2].endsWith('/issues'));
  assert.equal(create[2], '/repos/nalfeo/Crawler/issues');
});

test('does not treat a closed issue as an open duplicate', async () => {
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
  assert.equal(result[0].action, 'created');
  const create = h.calls.find((call) => call[0] === 'request');
  assert.equal(create[2], '/repos/nalfeo/Crawler/issues');
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
