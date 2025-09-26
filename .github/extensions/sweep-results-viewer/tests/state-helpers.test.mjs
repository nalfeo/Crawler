import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatCloudFailure,
  isCurrentCloudGeneration,
  isCurrentLocalSelection,
  stabilizeTerminalSnapshot,
} from '../lib/state-helpers.mjs';
import { transitionToLocalSource } from '../lib/local-source-transition.mjs';
import { stateSnapshot } from '../lib/state-snapshot.mjs';

test('formats non-auth cloud failures without auth login guidance', () => {
  const message = formatCloudFailure(
    'Cloud refresh failed: ',
    'No weapon-sweep workflow runs were found for this repository.',
  );
  assert.doesNotMatch(message, /gh auth login/);
  assert.match(message, /No weapon-sweep workflow runs/);
});

test('formats auth cloud failures with auth login guidance', () => {
  const message = formatCloudFailure(
    'Cloud initialization failed: ',
    'gh command failed: HTTP 401 authentication failed',
  );
  assert.match(message, /gh auth login/);
});

test('local selection guard rejects stale out-of-order completions', () => {
  const staleSelection = { generation: 1, path: '/tmp/weapon-a.json' };
  const state = {
    closed: false,
    generation: 2,
    source: 'cloud',
    path: null,
  };
  assert.equal(isCurrentLocalSelection(state, staleSelection), false);
});

test('cloud generation guard accepts only active cloud state', () => {
  assert.equal(
    isCurrentCloudGeneration({ closed: false, generation: 3, source: 'cloud' }, 3),
    true,
  );
  assert.equal(
    isCurrentCloudGeneration({ closed: false, generation: 4, source: 'local' }, 4),
    false,
  );
  assert.equal(
    isCurrentCloudGeneration({ closed: false, generation: 5, source: 'cloud' }, 4),
    false,
  );
  assert.equal(
    isCurrentCloudGeneration({ closed: true, generation: 3, source: 'cloud' }, 3),
    false,
  );
});

test('terminal stabilization exhausts retry budget while still incomplete', async () => {
  const snapshots = [
    {
      run: { status: 'completed' },
      expectedWeapons: ['sword', 'bow', 'bat'],
      aggregateOutputs: [{ weapon: 'sword' }],
      expiredArtifactCount: 0,
    },
    {
      run: { status: 'completed' },
      expectedWeapons: ['sword', 'bow', 'bat'],
      aggregateOutputs: [{ weapon: 'sword' }],
      expiredArtifactCount: 0,
    },
    {
      run: { status: 'completed' },
      expectedWeapons: ['sword', 'bow', 'bat'],
      aggregateOutputs: [{ weapon: 'sword' }, { weapon: 'bow' }],
      expiredArtifactCount: 0,
    },
  ];
  let loads = 0;
  const stabilized = await stabilizeTerminalSnapshot(snapshots[0], {
    attempts: 3,
    delayMs: 0,
    signal: new AbortController().signal,
    isTerminalRun: (run) => run.status === 'completed',
    loadSnapshot: async () => {
      loads += 1;
      return snapshots[loads];
    },
    sleep: async () => {},
  });
  assert.equal(loads, 2);
  assert.deepEqual(
    stabilized.aggregateOutputs.map((entry) => entry.weapon),
    ['sword', 'bow'],
  );
});

test('terminal stabilization with custom isComplete callback stops early for AI sweep leaderboard', async () => {
  const snapshots = [
    // Terminal run with no leaderboard yet.
    { run: { status: 'completed' }, leaderboardData: null, expiredArtifactCount: 0 },
    // After first reload: leaderboard arrived.
    { run: { status: 'completed' }, leaderboardData: { byComposite: [] }, expiredArtifactCount: 0 },
    // Should NOT be loaded; we should stop after snapshot[1].
    {
      run: { status: 'completed' },
      leaderboardData: { byComposite: [{ combo: 'x' }] },
      expiredArtifactCount: 0,
    },
  ];
  let loads = 0;
  const stabilized = await stabilizeTerminalSnapshot(snapshots[0], {
    attempts: 5,
    delayMs: 0,
    signal: new AbortController().signal,
    isTerminalRun: (run) => run.status === 'completed',
    isComplete: (snapshot) =>
      Boolean(snapshot.leaderboardData) || snapshot.expiredArtifactCount > 0,
    loadSnapshot: async () => {
      loads += 1;
      return snapshots[loads];
    },
    sleep: async () => {},
  });
  // Should stop after 1 reload once leaderboard arrives.
  assert.equal(loads, 1);
  assert.ok(stabilized.leaderboardData !== null);
});

function baseCloudAiState() {
  return {
    source: 'cloud',
    path: null,
    selectedLocalPath: null,
    localDirectory: '/workspace/artifacts/weapon-sweeps',
    localRuns: [],
    localErrors: [],
    context: { repository: 'nalfeo/Crawler', branch: 'nalfeo-local-sweep-discovery' },
    sessionId: 'session-1',
    runs: [],
    selectedRun: {
      id: 123,
      workflowType: 'ai-sweep',
      status: 'completed',
      conclusion: 'success',
      headBranch: 'nalfeo-local-sweep-discovery',
      headSha: 'abc',
      createdAt: '2026-07-19T00:00:00Z',
      updatedAt: '2026-07-19T00:00:00Z',
      url: 'https://example.test/run/123',
      event: 'workflow_dispatch',
      attempt: 1,
    },
    selectionReason: 'explicit-run',
    expectedWeapons: [],
    availableWeapons: [],
    expiredArtifactCount: 0,
    jobPhases: { total: 4, completed: 4, failed: 0, inProgress: 0, queued: 0 },
    pollTimer: null,
    refreshing: false,
    error: null,
    warning: null,
    loadedAt: null,
    lastRefreshedAt: null,
    data: null,
  };
}

test('cloud(AI) → local explicit-file transition clears cloud-only state and snapshot is non-AI', () => {
  const state = baseCloudAiState();
  state.localRuns = [{ path: '/workspace/artifacts/weapon-sweeps/run.json' }];
  state.path = '/workspace/artifacts/weapon-sweeps/run.json';

  transitionToLocalSource(state);

  const snapshot = stateSnapshot(state, 30_000);
  const renderedWorkflowType = snapshot.workflowType || snapshot.selectedRun?.workflowType;

  assert.equal(state.source, 'local');
  assert.equal(state.selectedRun, null);
  assert.equal(state.jobPhases, null);
  assert.equal(snapshot.source, 'local');
  assert.equal(renderedWorkflowType, undefined);
  assert.notEqual(renderedWorkflowType, 'ai-sweep');
});

test('cloud(AI) → local empty-catalog transition clears cloud-only state and snapshot is non-AI', () => {
  const state = baseCloudAiState();
  state.localRuns = [];
  state.path = null;
  state.selectionReason = 'no-local-runs';

  transitionToLocalSource(state);

  const snapshot = stateSnapshot(state, 30_000);
  const renderedWorkflowType = snapshot.workflowType || snapshot.selectedRun?.workflowType;

  assert.equal(state.source, 'local');
  assert.equal(state.selectedRun, null);
  assert.equal(state.jobPhases, null);
  assert.equal(snapshot.source, 'local');
  assert.equal(renderedWorkflowType, undefined);
  assert.notEqual(renderedWorkflowType, 'ai-sweep');
});
