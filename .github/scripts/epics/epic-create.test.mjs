import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EPIC_LABEL,
  EPIC_ISSUE_ASSIGNEES,
  EPIC_REVIEW_LABEL,
  assertUniqueEpicIds,
  ensureLabelsExist,
  epicContentHash,
  epicLabel,
  nodeMarker,
  planAndCreateEpic,
  reviewMarker,
  topoSortNodes,
  validateEpicFile,
} from './epic-create.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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

function findEpicFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return findEpicFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.epic.json') ? [path] : [];
  });
}

function reviewIssueFor(
  epic,
  { number = 1, state = 'open', stateReason = null, closedBy = undefined } = {},
) {
  return {
    number,
    node_id: `ISSUE_${number}`,
    state,
    state_reason: stateReason,
    closed_by:
      closedBy === undefined && state === 'closed' ? { login: 'nalfeo', type: 'User' } : closedBy,
    body: reviewMarker(epic.epic_id, epicContentHash(epic)),
  };
}

function harness(existingIssues = [], existingLabels = []) {
  const calls = [];
  let nextIssueNumber = 100;
  const labels = [...existingLabels];
  const paginateFn = async (token, url) => {
    calls.push(['paginate', token, url]);
    if (url.endsWith('/labels')) {
      return labels;
    }
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
    if (options.method === 'POST' && url.endsWith('/labels')) {
      if (labels.some((label) => label.name === options.body.name)) {
        const error = new Error('label already exists');
        error.status = 422;
        throw error;
      }
      labels.push({ name: options.body.name });
      return { data: { name: options.body.name } };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { calls, paginateFn, requestFn, labels };
}

test('validateEpicFile accepts a well-formed epic', () => {
  assert.deepEqual(validateEpicFile(exampleEpic()), []);
});

test('committed epic json files are valid and use unique epic ids', () => {
  const epicFiles = findEpicFiles(join(REPO_ROOT, 'docs/knowledge/epics')).sort();
  assert.ok(epicFiles.length > 0, 'expected at least one committed *.epic.json file');

  const epics = epicFiles.map((path) => ({
    path,
    epic: JSON.parse(readFileSync(path, 'utf8')),
  }));
  for (const { path, epic } of epics) {
    assert.deepEqual(validateEpicFile(epic), [], path);
  }
  assert.doesNotThrow(() => assertUniqueEpicIds(epics));
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

test('validateEpicFile rejects dependency cycles before GitHub mutations can happen', () => {
  const epic = exampleEpic({
    nodes: [
      { id: 'a', title: 'A', depends_on: ['b'] },
      { id: 'b', title: 'B', depends_on: ['a'] },
    ],
  });
  assert.ok(validateEpicFile(epic).some((e) => e.includes('cycle')));
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
  const posts = h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues'));
  assert.equal(posts.length, 1);
  const [, , , options] = posts[0];
  assert.match(options.body.title, /^\[Epic Review\] Example Epic$/);
  assert.ok(
    options.body.body.includes(reviewMarker('example-epic', epicContentHash(exampleEpic()))),
  );
  assert.deepEqual(options.body.labels, [EPIC_LABEL, epicLabel('example-epic'), EPIC_REVIEW_LABEL]);
  assert.deepEqual(options.body.assignees, EPIC_ISSUE_ASSIGNEES);
  assert.match(options.body.body, /## Global labels/);
  assert.match(options.body.body, /`epic:example-epic`/);
  assert.match(options.body.body, /### `slice-1`: Slice 1/);
  assert.match(options.body.body, /Do the first thing\./);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].action, 'created');
});

test('epicContentHash includes global labels that are applied to materialized nodes', () => {
  const base = exampleEpic();
  const labeled = exampleEpic({ labels: ['needs-triage'] });
  assert.notEqual(epicContentHash(base), epicContentHash(labeled));
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
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 0);
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
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 0);
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
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 0);
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
  const posts = h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues'));
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
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 1);
});

test('once the review issue is closed as completed, node issues are created in dependency order with Blocked-by text', async () => {
  const epic = exampleEpic();
  const hash = epicContentHash(epic);
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
  const posts = h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues'));
  assert.equal(posts.length, 2);

  const [, , , slice1Options] = posts[0];
  assert.equal(slice1Options.body.title, 'Slice 1');
  assert.ok(slice1Options.body.body.includes(nodeMarker('example-epic', hash, 'slice-1')));
  assert.ok(slice1Options.body.body.includes('Blocked by #1'));
  assert.deepEqual(slice1Options.body.assignees, EPIC_ISSUE_ASSIGNEES);

  const [, , , slice2Options] = posts[1];
  assert.equal(slice2Options.body.title, 'Slice 2');
  assert.ok(slice2Options.body.body.includes(nodeMarker('example-epic', hash, 'slice-2')));
  assert.deepEqual(slice2Options.body.assignees, EPIC_ISSUE_ASSIGNEES);
  // slice-2 depends on the review issue AND on slice-1's freshly created number.
  const slice1IssueNumber = result.outcomes.find((o) => o.nodeId === 'slice-1').issueNumber;
  assert.ok(slice2Options.body.body.includes(`Blocked by #1, #${slice1IssueNumber}`));
});

test('is idempotent: re-running after all issues exist creates nothing new', async () => {
  const epic = exampleEpic();
  const hash = epicContentHash(epic);
  const reviewIssue = reviewIssueFor(epic, { state: 'closed', stateReason: 'completed' });
  const slice1Issue = {
    number: 2,
    node_id: 'ISSUE_2',
    state: 'open',
    body: `${nodeMarker('example-epic', hash, 'slice-1')}\nBlocked by #1`,
  };
  const slice2Issue = {
    number: 3,
    node_id: 'ISSUE_3',
    state: 'open',
    body: `${nodeMarker('example-epic', hash, 'slice-2')}\nBlocked by #1, #2`,
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
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 0);
  assert.ok(result.outcomes.every((o) => o.action === 'exists'));
});

test('post-materialization revisions are rejected instead of reusing stale node issues', async () => {
  const originalEpic = exampleEpic();
  const originalHash = epicContentHash(originalEpic);
  const revisedEpic = exampleEpic({ labels: ['new-global-label'] });
  const h = harness([
    reviewIssueFor(originalEpic, { state: 'closed', stateReason: 'completed' }),
    {
      number: 2,
      node_id: 'ISSUE_2',
      state: 'open',
      body: `${nodeMarker('example-epic', originalHash, 'slice-1')}\nBlocked by #1`,
    },
  ]);
  await assert.rejects(
    planAndCreateEpic({
      requestFn: h.requestFn,
      paginateFn: h.paginateFn,
      token: 'tok',
      owner: 'nalfeo',
      repo: 'Crawler',
      epic: revisedEpic,
    }),
    /post-materialization revisions are not supported/,
  );
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 0);
});

test('approved revised review cannot materialize over stale node issues from an older revision', async () => {
  const originalEpic = exampleEpic();
  const originalHash = epicContentHash(originalEpic);
  const revisedEpic = exampleEpic({ labels: ['new-global-label'] });
  const h = harness([
    reviewIssueFor(revisedEpic, { state: 'closed', stateReason: 'completed' }),
    {
      number: 2,
      node_id: 'ISSUE_2',
      state: 'open',
      body: `${nodeMarker('example-epic', originalHash, 'slice-1')}\nBlocked by #1`,
    },
  ]);
  await assert.rejects(
    planAndCreateEpic({
      requestFn: h.requestFn,
      paginateFn: h.paginateFn,
      token: 'tok',
      owner: 'nalfeo',
      repo: 'Crawler',
      epic: revisedEpic,
    }),
    /post-materialization revisions are not supported/,
  );
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 0);
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

test('planAndCreateEpic throws for cyclic dependencies before writing labels or issues', async () => {
  const h = harness();
  await assert.rejects(
    planAndCreateEpic({
      requestFn: h.requestFn,
      paginateFn: h.paginateFn,
      token: 'tok',
      owner: 'nalfeo',
      repo: 'Crawler',
      epic: exampleEpic({
        nodes: [
          { id: 'a', title: 'A', depends_on: ['b'] },
          { id: 'b', title: 'B', depends_on: ['a'] },
        ],
      }),
    }),
    /cycle/,
  );
  assert.equal(h.calls.length, 0);
});

test('ensureLabelsExist creates only labels that do not already exist', async () => {
  const h = harness([], [{ name: 'epic' }]);
  await ensureLabelsExist({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    labelNames: ['epic', 'epic:example-epic', 'epic-review'],
  });

  const labelPosts = h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/labels'));
  assert.deepEqual(labelPosts.map((c) => c[3].body.name).sort(), [
    'epic-review',
    'epic:example-epic',
  ]);
  assert.deepEqual(h.labels.map((l) => l.name).sort(), [
    'epic',
    'epic-review',
    'epic:example-epic',
  ]);
});

test('ensureLabelsExist tolerates a 422 from a label created concurrently between list and create', async () => {
  const h = harness();
  h.requestFn = async (token, url, options) => {
    h.calls.push(['request', token, url, options]);
    if (options.method === 'POST' && url.endsWith('/labels')) {
      const error = new Error('already exists');
      error.status = 422;
      error.data = {
        errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }],
      };
      throw error;
    }
    throw new Error(`unexpected request: ${url}`);
  };
  await assert.doesNotReject(
    ensureLabelsExist({
      requestFn: h.requestFn,
      paginateFn: h.paginateFn,
      token: 'tok',
      owner: 'nalfeo',
      repo: 'Crawler',
      labelNames: ['epic'],
    }),
  );
});

test('ensureLabelsExist re-throws a 422 label validation failure', async () => {
  const h = harness();
  h.requestFn = async (token, url, options) => {
    h.calls.push(['request', token, url, options]);
    if (options.method === 'POST' && url.endsWith('/labels')) {
      const error = new Error('Validation Failed');
      error.status = 422;
      error.data = {
        errors: [{ resource: 'Label', field: 'name', code: 'invalid' }],
      };
      throw error;
    }
    throw new Error(`unexpected request: ${url}`);
  };
  await assert.rejects(
    ensureLabelsExist({
      requestFn: h.requestFn,
      paginateFn: h.paginateFn,
      token: 'tok',
      owner: 'nalfeo',
      repo: 'Crawler',
      labelNames: ['bad label'],
    }),
    /Validation Failed/,
  );
});

test('a completed review issue closed by a bot is not treated as human approval', async () => {
  const epic = exampleEpic();
  const h = harness([
    reviewIssueFor(epic, {
      state: 'closed',
      stateReason: 'completed',
      closedBy: { login: 'github-actions[bot]', type: 'Bot' },
    }),
  ]);
  const result = await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic,
  });

  assert.equal(result.reviewApproved, false);
  assert.equal(h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/issues')).length, 0);
});

test('ensureLabelsExist re-throws a non-422 failure from label creation', async () => {
  const h = harness();
  h.requestFn = async (token, url, options) => {
    h.calls.push(['request', token, url, options]);
    if (options.method === 'POST' && url.endsWith('/labels')) {
      const error = new Error('server error');
      error.status = 500;
      throw error;
    }
    throw new Error(`unexpected request: ${url}`);
  };
  await assert.rejects(
    ensureLabelsExist({
      requestFn: h.requestFn,
      paginateFn: h.paginateFn,
      token: 'tok',
      owner: 'nalfeo',
      repo: 'Crawler',
      labelNames: ['epic'],
    }),
    /server error/,
  );
});

test('planAndCreateEpic creates the epic and epic-review labels before filing the first review issue', async () => {
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
  assert.deepEqual(h.labels.map((l) => l.name).sort(), [
    'epic',
    'epic-review',
    'epic:example-epic',
  ]);
  // Every label the review issue is created with must already exist by the
  // time the POST /issues call happens, or GitHub silently drops it.
  const issuePost = h.calls.find((c) => c[0] === 'request' && c[2].endsWith('/issues'));
  const labelPostIndexes = h.calls
    .map((c, i) => (c[0] === 'request' && c[2].endsWith('/labels') ? i : -1))
    .filter((i) => i >= 0);
  const issuePostIndex = h.calls.indexOf(issuePost);
  assert.ok(labelPostIndexes.every((i) => i < issuePostIndex));
});

test('planAndCreateEpic does not try to recreate labels that already exist', async () => {
  const epic = exampleEpic();
  const h = harness(
    [reviewIssueFor(epic, { state: 'closed', stateReason: 'completed' })],
    [{ name: 'epic' }, { name: 'epic:example-epic' }, { name: 'epic-review' }],
  );
  await planAndCreateEpic({
    requestFn: h.requestFn,
    paginateFn: h.paginateFn,
    token: 'tok',
    owner: 'nalfeo',
    repo: 'Crawler',
    epic,
  });

  const labelPosts = h.calls.filter((c) => c[0] === 'request' && c[2].endsWith('/labels'));
  assert.equal(labelPosts.length, 0);
});
