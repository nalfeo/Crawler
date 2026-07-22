import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionsState,
  buildTrainState,
  createDashboardSnapshot,
  parseTrainStatusComments,
} from '../lib/model.mjs';

const repository = 'nalfeo/Crawler';

function pullRequest(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    draft: false,
    created_at: `2026-07-${String(number).padStart(2, '0')}T00:00:00Z`,
    updated_at: `2026-07-${String(number).padStart(2, '0')}T01:00:00Z`,
    html_url: `https://github.com/nalfeo/Crawler/pull/${number}`,
    base: { ref: 'main' },
    head: {
      sha: String(number).repeat(40).slice(0, 40),
      ref: `feature/${number}`,
      repo: { full_name: repository },
    },
    labels: [{ name: 'merge-train' }],
    ...overrides,
  };
}

function statusComment(position, state = 'testing', detail = 'Validation dispatched.') {
  return {
    id: position,
    updated_at: `2026-07-21T00:00:0${position}Z`,
    body: [
      '<!-- crawler-merge-train:v1 -->',
      '## Merge train',
      '',
      `- Position: ${position}`,
      `- Candidate: \`${'a'.repeat(40)}\``,
      `- State: \`${state}\``,
      `- Detail: ${detail}`,
    ].join('\n'),
  };
}

test('parses managed Merge Train comments and exposes missing, malformed, and duplicate states', () => {
  assert.equal(parseTrainStatusComments([]).commentHealth, 'missing');

  const parsed = parseTrainStatusComments([statusComment(2, 'ready', 'Candidate passed.')]);
  assert.deepEqual(parsed, {
    commentHealth: 'ok',
    reportedPosition: 2,
    candidateSha: 'a'.repeat(40),
    state: 'ready',
    detail: 'Candidate passed.',
  });

  assert.equal(
    parseTrainStatusComments([{ body: '<!-- crawler-merge-train:v1 -->\n- Position: nope' }])
      .commentHealth,
    'malformed',
  );
  assert.equal(
    parseTrainStatusComments([{ body: '<!-- crawler-merge-train:v1 -->\n- Position: 2oops' }])
      .commentHealth,
    'malformed',
    'trailing non-digit characters must not be accepted by the position parser',
  );
  assert.equal(
    parseTrainStatusComments([statusComment(1), statusComment(1, 'ready')]).commentHealth,
    'duplicate',
  );
  assert.equal(
    parseTrainStatusComments([], { fetchFailed: true }).commentHealth,
    'unavailable',
    'a failed comment fetch must report unavailable rather than missing',
  );
});

test('uses canonical FIFO eligibility while keeping blocked and recovery PRs visible', () => {
  const openPullRequests = [
    pullRequest(3),
    pullRequest(1),
    pullRequest(2, {
      labels: [{ name: 'merge-train' }, { name: 'merge-train-blocked' }],
    }),
    pullRequest(4, {
      labels: [{ name: 'merge-train' }, { name: 'ci-conflict-order-wait' }],
    }),
    pullRequest(5, { labels: [{ name: 'ci-recovery-waiting' }] }),
    pullRequest(6, {
      labels: [{ name: 'ci-owner-pr-6' }, { name: 'ci-recovery-waiting-transition' }],
    }),
  ];
  const recoveryPullRequests = [
    pullRequest(7, {
      state: 'closed',
      closed_at: '2026-07-21T02:00:00Z',
      labels: [{ name: 'merge-train-recovery-pending' }],
    }),
  ];
  const commentsByPr = new Map([
    [1, [statusComment(1)]],
    [3, [statusComment(2, 'ready')]],
    [2, [statusComment(2, 'blocked')]],
    [4, []],
  ]);

  const train = buildTrainState({
    openPullRequests,
    recoveryPullRequests,
    commentsByPr,
    repository,
  });

  assert.deepEqual(
    train.candidates.map((candidate) => candidate.number),
    [1, 3],
  );
  assert.deepEqual(
    train.blocked.map((candidate) => [candidate.number, candidate.state]),
    [
      [2, 'blocked'],
      [4, 'conflict-order-wait'],
    ],
  );
  assert.deepEqual(
    train.recovery.map((candidate) => [candidate.number, candidate.state]),
    [
      [5, 'recovery-waiting'],
      [6, 'recovery-transition'],
      [7, 'recovery-pending'],
    ],
  );
});

test('counts only repository-visible hosted jobs against the configured cap', () => {
  const actions = buildActionsState(
    {
      runs: [
        {
          id: 10,
          name: 'CI',
          display_title: 'CI for feature',
          status: 'in_progress',
          event: 'pull_request',
          html_url: 'https://github.com/nalfeo/Crawler/actions/runs/10',
          jobs: [
            { id: 1, name: 'build', status: 'in_progress', labels: ['ubuntu-latest'] },
            { id: 2, name: 'test', status: 'queued', labels: ['ubuntu-latest'] },
            { id: 3, name: 'local', status: 'in_progress', labels: ['self-hosted'] },
          ],
        },
      ],
      activeRunsTruncated: 0,
      partialErrors: [],
    },
    1,
  );

  assert.equal(actions.visibleHostedInProgress, 1);
  assert.equal(actions.visibleHostedQueued, 1);
  assert.equal(actions.visibleSelfHostedInProgress, 1);
  assert.match(actions.occupancyScope, /Visible hosted jobs in this repository/);
  assert.match(actions.warnings.join(' '), /configured cap/);
});

test('prioritizes refresh errors and queued runner pressure in the bottleneck summary', () => {
  const rawState = {
    repository,
    openPullRequests: [],
    recoveryPullRequests: [],
    commentsByPr: new Map(),
    runs: [
      {
        id: 10,
        name: 'CI',
        status: 'queued',
        jobs: [{ id: 1, name: 'build', status: 'queued', labels: ['ubuntu-latest'] }],
      },
    ],
    activeRunsTruncated: 0,
    partialErrors: [],
    apiCalls: 4,
    fetchedAt: '2026-07-21T00:00:00Z',
  };

  assert.equal(createDashboardSnapshot(rawState, 20).bottleneck.kind, 'runner-queue');
  assert.equal(
    createDashboardSnapshot(rawState, 20, 'rate limited').bottleneck.kind,
    'refresh-error',
  );
});

test('surfaces queued workflow runs before GitHub exposes their jobs', () => {
  const snapshot = createDashboardSnapshot(
    {
      repository,
      openPullRequests: [],
      recoveryPullRequests: [],
      commentsByPr: new Map(),
      runs: [
        {
          id: 10,
          name: 'CI',
          status: 'queued',
          jobs: [],
        },
      ],
      activeRunsTruncated: 0,
      partialErrors: [],
      apiCalls: 3,
      fetchedAt: '2026-07-21T00:00:00Z',
    },
    20,
  );

  assert.equal(snapshot.actions.queuedRunCount, 1);
  assert.equal(snapshot.actions.visibleHostedQueued, 0);
  assert.equal(snapshot.bottleneck.kind, 'workflow-queue');
});
