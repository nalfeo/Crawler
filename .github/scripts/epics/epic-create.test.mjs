import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EPIC_LABEL,
  EPIC_REVIEW_LABEL,
  assertUniqueEpicIds,
  epicContentHash,
  epicLabel,
  nodeMarker,
  planAndCreateEpic,
  reviewMarker,
  topoSortNodes,
  validateEpicFile,
} from './epic-create.mjs';

function exampleEpic(overrides = {}) {
  return {
    epic_id: 'example-epic',
    title: 'Example Epic',
    description: 'A small epic used for tests.',
    nodes: [
      { id: 'slice-1', title: 'Slice 1', body: 'Do the first thing.', depends_on: [] },
      { id: 'slice-2', title: 'Slice 2', body: 'Do the second thing.', depends_on: ['slice-1'] },
    ],
    ...overrides,
  };
}

function reviewIssueFor(epic, { number = 1, state = 'open', stateReason = null } = {}) {
  return {
    number,
    node_id: `ISSUE_${number}`,
    state,
    state_reason: stateReason,
    body: reviewMarker(epic.epic_id, epicContentHash(epic)),
  };
}

function harness(existingIssues = []) {
  const calls = [];
  let nextIssueNumber = 100;
  const paginateFn = async (token, url) => {
    calls.push(['paginate', token, url]);
    return existingIssues;
  };
  const requestFn = async (token, url, options) => {
    calls.push(['request', token, url, options]);
    if (options.method === 'POST' && url.endsWith('/issues')) {
      const number = nextIssueNumber++;
      const issue = {
        number,
        node_id: `ISSUE_${number}`,
        state: 'open',
        state_reason: null,
        body: options.body.body,
      };
      existingIssues.push(issue);
      return { data: issue };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { calls, paginateFn, requestFn };
}

test('validateEpicFile accepts a well-formed epic', () => {
  assert.deepEqual(validateEpicFile(exampleEpic()), []);
});

test('validateEpicFile rejects missing epic_id, empty nodes, and unknown deps', () => {
  assert.ok(validateEpicFile({ title: 'x', nodes: [] }).length > 0);
  assert.ok(
    validateEpicFile(exampleEpic({ nodes: [{ id: 'a', title: 'A', depends_on: ['ghost'] }] })).some(
      (e) => e.includes('unknown node'),
    ),
  );
});

test('validateEpicFile rejects duplicate node ids', () => {
  const epic = exampleEpic({
    nodes: [
      { id: 'a', title: 'A' },
      { id: 'a', title: 'A again' },
    ],
  });
  assert.ok(validateEpicFile(epic).some((e) => e.includes('duplicate node id')));
});

test('validateEpicFile rejects a node id that is not lowercase kebab-case', () => {
  const epic = exampleEpic({ nodes: [{ id: 'Slice_1', title: 'Bad id' }] });
  assert.ok(validateEpicFile(epic).some((e) => e.includes('kebab-case')));
});

test('validateEpicFile rejects non-string description/review fields', () => {
  assert.ok(
    validateEpicFile(exampleEpic({ description: 42 })).some((e) => e.includes('description')),
  );
  assert.ok(
    validateEpicFile(exampleEpic({ review: { title_prefix: 42 } })).some((e) =>
      e.includes('review.title_prefix'),
    ),
  );
});

test('topoSortNodes orders dependencies before dependents', () => {
  const nodes = [
    { id: 'b', title: 'B', depends_on: ['a'] },
    { id: 'a', title: 'A', depends_on: [] },
    { id: 'c', title: 'C', depends_on: ['b'] },
  ];
  const order = topoSortNodes(nodes).map((n) => n.id);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('topoSortNodes throws on a dependency cycle', () => {
  const nodes = [
    { id: 'a', title: 'A', depends_on: ['b'] },
    { id: 'b', title: 'B', depends_on: ['a'] },
  ];
  assert.throws(() => topoSortNodes(nodes), /cycle/);
});

test('first run creates only the human-review issue, no node issues', async () => {
  const h = harness();
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic: exampleEpic(),
  });

  assert.equal(result.reviewApproved, false);
  const posts = h.calls.filter((c) => c[0] === 'request');
  assert.equal(posts.length, 1);
  const [, , , options] = posts[0];
  assert.match(options.body.title, /^\[Epic Review\] Example Epic$/);
  assert.ok(
    options.body.body.includes(reviewMarker('example-epic', epicContentHash(exampleEpic()))),
  );
  assert.deepEqual(options.body.labels, [EPIC_LABEL, epicLabel('example-epic'), EPIC_REVIEW_LABEL]);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].action, 'created');
});

test('re-running while the review issue is still open creates nothing new', async () => {
  const epic = exampleEpic();
  const h = harness([reviewIssueFor(epic, { state: 'open' })]);
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic,
  });

  assert.equal(result.reviewApproved, false);
  assert.equal(result.reviewIssueNumber, 1);
  assert.equal(h.calls.filter((c) => c[0] === 'request').length, 0);
});

test('a review issue closed with no state_reason (e.g. auto-closed via "Closes #N") is not treated as approval', async () => {
  const epic = exampleEpic();
  const h = harness([reviewIssueFor(epic, { state: 'closed', stateReason: null })]);
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic,
  });

  assert.equal(result.reviewApproved, false);
  assert.equal(result.reviewRejected, undefined);
  assert.equal(h.calls.filter((c) => c[0] === 'request').length, 0);
});

test('closing the review issue as "not planned" rejects that exact revision', async () => {
  const epic = exampleEpic();
  const h = harness([reviewIssueFor(epic, { state: 'closed', stateReason: 'not_planned' })]);
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic,
  });

  assert.equal(result.reviewApproved, false);
  assert.equal(result.reviewRejected, true);
  assert.equal(h.calls.filter((c) => c[0] === 'request').length, 0);
});

test('a revised epic (different content hash) after a rejection gets a brand-new review issue, not stuck forever', async () => {
  const originalEpic = exampleEpic();
  const h = harness([
    reviewIssueFor(originalEpic, { number: 1, state: 'closed', stateReason: 'not_planned' }),
  ]);
  const revisedEpic = exampleEpic({ title: 'Example Epic (revised)' });
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic: revisedEpic,
  });

  assert.equal(result.reviewApproved, false);
  assert.equal(result.reviewRejected, undefined);
  assert.notEqual(result.reviewIssueNumber, 1);
  const posts = h.calls.filter((c) => c[0] === 'request');
  assert.equal(posts.length, 1);
  assert.ok(
    posts[0][3].body.body.includes(reviewMarker('example-epic', epicContentHash(revisedEpic))),
  );
});

test('a revised epic (different content hash) after approval also gets a brand-new review issue, not silently approved', async () => {
  const originalEpic = exampleEpic();
  const h = harness([
    reviewIssueFor(originalEpic, { number: 1, state: 'closed', stateReason: 'completed' }),
  ]);
  const revisedEpic = exampleEpic({ title: 'Example Epic (revised)' });
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic: revisedEpic,
  });

  assert.equal(result.reviewApproved, false);
  assert.notEqual(result.reviewIssueNumber, 1);
  assert.equal(h.calls.filter((c) => c[0] === 'request').length, 1);
});

test('once the review issue is closed as completed, node issues are created in dependency order with Blocked-by text', async () => {
  const epic = exampleEpic();
  const h = harness([reviewIssueFor(epic, { state: 'closed', stateReason: 'completed' })]);
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic,
  });

  assert.equal(result.reviewApproved, true);
  const posts = h.calls.filter((c) => c[0] === 'request');
  assert.equal(posts.length, 2);

  const [, , , slice1Options] = posts[0];
  assert.equal(slice1Options.body.title, 'Slice 1');
  assert.ok(slice1Options.body.body.includes(nodeMarker('example-epic', 'slice-1')));
  assert.ok(slice1Options.body.body.includes('Blocked by #1'));

  const [, , , slice2Options] = posts[1];
  assert.equal(slice2Options.body.title, 'Slice 2');
  assert.ok(slice2Options.body.body.includes(nodeMarker('example-epic', 'slice-2')));
  // slice-2 depends on the review issue AND on slice-1's freshly created number.
  const slice1IssueNumber = result.outcomes.find((o) => o.nodeId === 'slice-1').issueNumber;
  assert.ok(slice2Options.body.body.includes(`Blocked by #1, #${slice1IssueNumber}`));
});

test('is idempotent: re-running after all issues exist creates nothing new', async () => {
  const epic = exampleEpic();
  const reviewIssue = reviewIssueFor(epic, { state: 'closed', stateReason: 'completed' });
  const slice1Issue = {
    number: 2,
    node_id: 'ISSUE_2',
    state: 'open',
    body: `${nodeMarker('example-epic', 'slice-1')}\nBlocked by #1`,
  };
  const slice2Issue = {
    number: 3,
    node_id: 'ISSUE_3',
    state: 'open',
    body: `${nodeMarker('example-epic', 'slice-2')}\nBlocked by #1, #2`,
  };
  const h = harness([reviewIssue, slice1Issue, slice2Issue]);
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic,
  });

  assert.equal(result.reviewApproved, true);
  assert.equal(h.calls.filter((c) => c[0] === 'request').length, 0);
  assert.ok(result.outcomes.every((o) => o.action === 'exists'));
});

test('assertUniqueEpicIds rejects two files claiming the same epic_id', () => {
  const epics = [
    { path: 'a/x.epic.json', epic: { epic_id: 'dup' } },
    { path: 'b/x.epic.json', epic: { epic_id: 'dup' } },
  ];
  assert.throws(() => assertUniqueEpicIds(epics), /claimed by both/);
});

test('assertUniqueEpicIds accepts distinct epic_ids', () => {
  const epics = [
    { path: 'a/x.epic.json', epic: { epic_id: 'one' } },
    { path: 'b/x.epic.json', epic: { epic_id: 'two' } },
  ];
  assert.doesNotThrow(() => assertUniqueEpicIds(epics));
});

test('planAndCreateEpic throws for an invalid epic file instead of writing anything', async () => {
  const h = harness();
  await assert.rejects(
    planAndCreateEpic({
      requestFn: h.requestFn,
      paginateFn: h.paginateFn,
      token: 'tok',
      owner: 'nalfeo',
      repo: 'Crawler',
      epic: { title: 'no id', nodes: [] },
    }),
    /invalid epic file/,
  );
  assert.equal(h.calls.length, 0);
});
