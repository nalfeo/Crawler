import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionsState,
  buildAssetPipelineState,
  buildTrainState,
  createDashboardSnapshot,
  parseAssetRequestComments,
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

test('accepts position 0 as valid syntax for canonical blocked entries', () => {
  // blockEntry() and deAdmitNoop() in reconcile.mjs write position: 0 and
  // candidateSha: '' which renderStatus renders as `not built`.
  const blockedComment = {
    id: 1,
    updated_at: '2026-07-21T00:00:01Z',
    body: [
      '<!-- crawler-merge-train:v1 -->',
      '## Merge train',
      '',
      '- Position: 0',
      '- Candidate: `not built`',
      '- State: `blocked`',
      '- Detail: Validation failed.',
    ].join('\n'),
  };
  const parsed = parseTrainStatusComments([blockedComment]);
  assert.equal(parsed.commentHealth, 'ok', 'position 0 must not be treated as malformed');
  assert.equal(parsed.reportedPosition, 0);
  assert.equal(parsed.state, 'blocked');
  assert.equal(parsed.candidateSha, null, 'not-built candidate must map to null');
});

test('uses canonical FIFO eligibility while keeping blocked and recovery PRs visible', () => {
  const openPullRequests = [
    pullRequest(3),
    pullRequest(1),
    // Canonical blockEntry() removes merge-train and adds merge-train-blocked.
    pullRequest(2, {
      labels: [{ name: 'merge-train-blocked' }],
    }),
    // ci-conflict-order-wait can appear with or without merge-train.
    pullRequest(4, {
      labels: [{ name: 'ci-conflict-order-wait' }],
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

test('includes a warning when job-list fetches fail for one or more runs', () => {
  const actions = buildActionsState(
    {
      runs: [
        {
          id: 10,
          name: 'CI',
          status: 'in_progress',
          jobs: [],
          jobsError: 'API rate limited',
        },
      ],
      activeRunsTruncated: 0,
      partialErrors: [],
    },
    20,
  );

  assert.ok(
    actions.warnings.some((w) => /job.*load|load.*job/i.test(w)),
    `expected a job-load warning in: ${JSON.stringify(actions.warnings)}`,
  );
});

function assetComment(id, body, createdAt, login = 'github-actions[bot]') {
  return {
    id,
    body,
    createdAt,
    updatedAt: createdAt,
    url: `https://github.com/nalfeo/Crawler/issues/1313#issuecomment-${id}`,
    author: { login },
  };
}

test('resolves asset status within the newest queue attempt and marks unlinked terminal results inferred', () => {
  const parsed = parseAssetRequestComments(
    [
      assetComment('1', '🎬 Queued for processing', '2026-07-25T00:00:00Z'),
      assetComment(
        '2',
        '⚠️ Asset-request pipeline failed.\n\nError: old attempt failed',
        '2026-07-25T00:01:00Z',
      ),
      assetComment(
        '3',
        '🔁 Re-queued (previous run appeared stale)\n\n- Workflow run: https://github.com/nalfeo/Crawler/actions/runs/30',
        '2026-07-25T01:00:00Z',
      ),
      assetComment(
        '4',
        '✅ Asset-request pipeline complete.\n\n- summary: https://example.test/summary.json\n- selected for publication: variant 2',
        '2026-07-25T01:03:00Z',
      ),
    ],
    { now: '2026-07-25T01:04:00Z' },
  );

  assert.equal(parsed.state, 'complete');
  assert.equal(parsed.stage, 'generated + selected');
  assert.equal(parsed.attribution, 'inferred');
  assert.equal(parsed.workflowUrl, null, 'a workflow URL is not copied across comment markers');
  assert.equal(parsed.summaryUrl, 'https://example.test/summary.json');
  assert.match(parsed.detail, /variant 2/);
});

test('surfaces failed, stale, and truncated-history asset states without inventing checkpoints', () => {
  const failed = parseAssetRequestComments(
    [
      assetComment('1', '🎬 Queued for processing', '2026-07-25T00:00:00Z'),
      assetComment(
        '2',
        '⚠️ Asset-request pipeline failed.\n\nError: provider refused the request',
        '2026-07-25T00:01:00Z',
      ),
    ],
    { now: '2026-07-25T00:02:00Z' },
  );
  assert.equal(failed.state, 'failed');
  assert.match(failed.detail, /provider refused/);

  const stale = parseAssetRequestComments(
    [assetComment('3', '🎬 Queued for processing', '2026-07-25T00:00:00Z')],
    { now: '2026-07-25T02:00:01Z' },
  );
  assert.equal(stale.state, 'stale');

  const partial = parseAssetRequestComments([], {
    historyTruncated: true,
    now: '2026-07-25T02:00:01Z',
  });
  assert.equal(partial.state, 'truncated');
  assert.equal(partial.attribution, 'partial');
});

test('builds distinct asset workflow and downstream promotion lanes with actionable failures', () => {
  const pipeline = buildAssetPipelineState({
    repository,
    fetchedAt: '2026-07-25T06:03:00Z',
    assetRequests: {
      issues: [
        {
          number: 1313,
          title: 'Asset request: war-pick',
          url: 'https://github.com/nalfeo/Crawler/issues/1313',
          comments: {
            pageInfo: { hasPreviousPage: false },
            nodes: [
              assetComment(
                '1',
                '✅ Asset-request pipeline complete.\n\n- selected for publication: variant 2',
                '2026-07-25T05:21:00Z',
              ),
            ],
          },
        },
      ],
      assetWorkflow: {
        latestRun: {
          id: 301,
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/nalfeo/Crawler/actions/runs/301',
          jobs: [
            {
              name: 'Ingest issues + drain queue',
              html_url: 'https://github.com/nalfeo/Crawler/actions/runs/301/job/1',
              steps: [
                {
                  name: 'Ingest asset-request issues',
                  status: 'completed',
                  conclusion: 'success',
                  started_at: '2026-07-25T05:47:00Z',
                  completed_at: '2026-07-25T05:48:00Z',
                },
                {
                  name: 'Drain worker',
                  status: 'completed',
                  conclusion: 'success',
                  started_at: '2026-07-25T05:48:00Z',
                  completed_at: '2026-07-25T05:52:00Z',
                },
                {
                  name: 'Publish selected variants',
                  status: 'completed',
                  conclusion: 'failure',
                  started_at: '2026-07-25T05:52:00Z',
                  completed_at: '2026-07-25T06:02:00Z',
                },
              ],
            },
          ],
        },
      },
      reconcilerWorkflow: { latestRun: null },
      refs: [{ ref: 'refs/heads/assets/queue', sha: 'a'.repeat(40) }],
      pullRequests: [],
      errors: [],
    },
  });

  assert.equal(pipeline.stages[0].state, 'success');
  assert.equal(pipeline.stages[1].state, 'success');
  assert.equal(pipeline.stages[2].state, 'failure');
  assert.equal(pipeline.stages[3].lane, 'downstream reconciler');
  assert.equal(pipeline.stages[3].state, 'queue-without-pr');
  assert.equal(pipeline.severity, 'danger');
  assert.equal(pipeline.defaultExpanded, true);
  assert.equal(pipeline.counts.complete, 1);
});

test('collapses the asset section by default only when the pipeline is idle and healthy', () => {
  const pipeline = buildAssetPipelineState({
    repository,
    fetchedAt: '2026-07-25T06:03:00Z',
    assetRequests: {
      issues: [],
      assetWorkflow: {
        latestRun: {
          id: 301,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/nalfeo/Crawler/actions/runs/301',
          jobs: [
            {
              name: 'Ingest issues + drain queue',
              steps: [
                { name: 'Ingest asset-request issues', status: 'completed', conclusion: 'success' },
                { name: 'Drain worker', status: 'completed', conclusion: 'success' },
                { name: 'Publish selected variants', status: 'completed', conclusion: 'success' },
              ],
            },
          ],
        },
      },
      reconcilerWorkflow: {
        latestRun: {
          id: 302,
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-07-25T06:00:00Z',
          updated_at: '2026-07-25T06:01:00Z',
        },
      },
      refs: [],
      pullRequests: [],
      errors: [],
    },
  });

  assert.equal(pipeline.severity, 'success');
  assert.equal(pipeline.defaultExpanded, false);
  assert.equal(pipeline.active, false);
});

test('marks an in-progress workflow step stale after the workflow window', () => {
  const pipeline = buildAssetPipelineState({
    repository,
    fetchedAt: '2026-07-25T02:00:01Z',
    assetRequests: {
      issues: [],
      assetWorkflow: {
        latestRun: {
          id: 301,
          status: 'in_progress',
          html_url: 'https://github.com/nalfeo/Crawler/actions/runs/301',
          jobs: [
            {
              name: 'Ingest issues + drain queue',
              steps: [
                {
                  name: 'Ingest asset-request issues',
                  status: 'in_progress',
                  started_at: '2026-07-25T01:00:00Z',
                },
              ],
            },
          ],
        },
      },
      reconcilerWorkflow: { latestRun: null },
      refs: [],
      pullRequests: [],
      errors: [],
    },
  });

  assert.equal(pipeline.stages[0].state, 'stale');
  assert.equal(pipeline.severity, 'danger');
  assert.equal(pipeline.defaultExpanded, true);
});

test('rejects asset pipeline markers from untrusted comment authors', () => {
  const parsed = parseAssetRequestComments(
    [
      assetComment('1', '🎬 Queued for processing', '2026-07-25T00:00:00Z', 'github-actions[bot]'),
      assetComment(
        '2',
        '✅ Asset-request pipeline complete.\n\n- selected for publication: spoofed-variant',
        '2026-07-25T00:01:00Z',
        'random-fork-user',
      ),
    ],
    { now: '2026-07-25T00:02:00Z' },
  );
  assert.equal(
    parsed.state,
    'queued',
    'spoofed completion from untrusted author must not advance state',
  );
  assert.equal(parsed.stage, 'queued');
});

test('classifies quality-stopped completion as failed requiring human intervention', () => {
  const parsed = parseAssetRequestComments(
    [
      assetComment('1', '🎬 Queued for processing', '2026-07-25T00:00:00Z'),
      assetComment(
        '2',
        '✅ Asset-request pipeline complete.\n\n- brief: `war-pick-brief`\n- run: `run-1`\n- summary: `path/summary.json`\n- selection: no acceptable variants; human intervention required (the sheet will not be regenerated)',
        '2026-07-25T00:01:00Z',
      ),
    ],
    { now: '2026-07-25T00:02:00Z' },
  );
  assert.equal(parsed.state, 'failed');
  assert.equal(parsed.stage, 'quality-stopped');
  assert.match(parsed.detail, /human intervention/);
});

test('does not flag assets/queue-without-pr as danger when reconciler last ran successfully', () => {
  const pipeline = buildAssetPipelineState({
    repository,
    fetchedAt: '2026-07-25T06:03:00Z',
    assetRequests: {
      issues: [],
      assetWorkflow: { latestRun: null },
      reconcilerWorkflow: {
        latestRun: {
          id: 302,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/nalfeo/Crawler/actions/runs/302',
          created_at: '2026-07-25T06:00:00Z',
          updated_at: '2026-07-25T06:01:00Z',
        },
      },
      refs: [{ ref: 'refs/heads/assets/queue', sha: 'a'.repeat(40) }],
      pullRequests: [],
      errors: [],
    },
  });
  assert.equal(
    pipeline.stages[3].state,
    'idle',
    'bare queue branch after a successful reconciler run is a healthy no-op',
  );
  assert.equal(pipeline.severity, 'success');
});

test('flags assets/queue-without-pr when no successful reconciler run is on record', () => {
  const pipeline = buildAssetPipelineState({
    repository,
    fetchedAt: '2026-07-25T06:03:00Z',
    assetRequests: {
      issues: [],
      assetWorkflow: { latestRun: null },
      reconcilerWorkflow: { latestRun: null },
      refs: [{ ref: 'refs/heads/assets/queue', sha: 'a'.repeat(40) }],
      pullRequests: [],
      errors: [],
    },
  });
  assert.equal(pipeline.stages[3].state, 'queue-without-pr');
  assert.equal(pipeline.severity, 'danger');
});

test('overlays reconciler failure before queue topology so failures are not hidden by a queue PR', () => {
  const pipeline = buildAssetPipelineState({
    repository,
    fetchedAt: '2026-07-25T06:03:00Z',
    assetRequests: {
      issues: [],
      assetWorkflow: { latestRun: null },
      reconcilerWorkflow: {
        latestRun: {
          id: 302,
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/nalfeo/Crawler/actions/runs/302',
          created_at: '2026-07-25T06:00:00Z',
          updated_at: '2026-07-25T06:01:00Z',
        },
      },
      refs: [{ ref: 'refs/heads/assets/queue', sha: 'a'.repeat(40) }],
      pullRequests: [],
      errors: [],
    },
  });
  assert.equal(
    pipeline.stages[3].state,
    'failure',
    'reconciler failure must surface even when queue branch exists',
  );
  assert.equal(pipeline.severity, 'danger');
});

test('surfaces a warning when no executable asset pipeline run was found in the bounded search', () => {
  const pipeline = buildAssetPipelineState({
    repository,
    fetchedAt: '2026-07-25T06:03:00Z',
    assetRequests: {
      issues: [],
      assetWorkflow: {
        latestRun: null,
        executableRunNotFound: true,
      },
      reconcilerWorkflow: { latestRun: null },
      refs: [],
      pullRequests: [],
      errors: [],
    },
  });
  assert.ok(
    pipeline.warnings.some((w) => /executable.*run|run.*found/i.test(w)),
    `expected executableRunNotFound warning in: ${JSON.stringify(pipeline.warnings)}`,
  );
  assert.equal(
    pipeline.partial,
    false,
    'executableRunNotFound affects warnings but not partial flag',
  );
});
