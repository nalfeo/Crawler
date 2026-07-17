import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatCloudFailure,
  isCurrentCloudGeneration,
  isCurrentLocalSelection,
  stabilizeTerminalSnapshot,
} from '../lib/state-helpers.mjs';

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
