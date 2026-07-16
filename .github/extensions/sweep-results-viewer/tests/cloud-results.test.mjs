import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateArtifactWeapon,
  cloudResultWarning,
  expectedWeaponsFromJobs,
  isTerminalRun,
  mergeAggregateOutputs,
  normalizeRun,
  selectDefaultRun,
  shouldPollRun,
  sortRunsNewestFirst,
} from '../lib/cloud-results.mjs';

function run(id, branch, status, createdAt) {
  return normalizeRun({
    id,
    head_branch: branch,
    status,
    conclusion: status === 'completed' ? 'success' : null,
    created_at: createdAt,
  });
}

function aggregate(weapon, options = {}) {
  const seeds = options.seeds ?? [1, 2];
  const records = seeds.map((seed) => ({
    weapon,
    seed,
    outcome: 'victory',
    gameTimeSec: 10,
    finalLevel: 2,
    totalKills: 3,
    totalXp: 4,
    totalGold: 5,
    score: 6,
    minHealthPct: 0.5,
    closeCallCount: 0,
    questsCompleted: 1,
  }));
  return {
    runAt: '2026-07-16T00:00:00Z',
    seeds,
    weapons: [weapon],
    maxFrames: options.maxFrames ?? 19_800,
    weaponPersonas: options.weaponPersonas ?? true,
    budgetSec: 330,
    summaries: [
      {
        weapon,
        runs: records.length,
        victories: records.length,
        winRate: 1,
        meanGameTimeSec: 10,
        meanLevel: 2,
        meanKills: 3,
        meanXp: 4,
        meanScore: 6,
        meanMinHealthPct: 0.5,
        meanCloseCallCount: 0,
        meanQuestsCompleted: 1,
        records,
      },
    ],
    allRecords: records,
  };
}

test('orders runs newest first with run id as a deterministic tie-breaker', () => {
  const runs = [
    run(1, 'main', 'completed', '2026-07-15T00:00:00Z'),
    run(3, 'main', 'completed', '2026-07-16T00:00:00Z'),
    run(2, 'main', 'completed', '2026-07-16T00:00:00Z'),
  ];
  assert.deepEqual(
    sortRunsNewestFirst(runs).map(({ id }) => id),
    [3, 2, 1],
  );
});

test('defaults to active attached branch, then latest attached branch, then repository', () => {
  const runs = [
    run(30, 'main', 'in_progress', '2026-07-16T03:00:00Z'),
    run(20, 'feature', 'completed', '2026-07-16T02:00:00Z'),
    run(10, 'feature', 'queued', '2026-07-16T01:00:00Z'),
  ];
  assert.deepEqual(selectDefaultRun(runs, 'feature'), {
    run: runs[2],
    reason: 'active-session-branch',
  });
  assert.equal(
    selectDefaultRun(
      runs.filter(({ id }) => id !== 10),
      'feature',
    ).run.id,
    20,
  );
  assert.equal(selectDefaultRun(runs, 'missing').run.id, 30);
});

test('recognizes terminal completion and aggregate artifacts only', () => {
  assert.equal(isTerminalRun({ status: 'completed' }), true);
  assert.equal(isTerminalRun({ status: 'in_progress' }), false);
  assert.equal(shouldPollRun({ status: 'queued' }), true);
  assert.equal(shouldPollRun({ status: 'completed' }), false);
  assert.equal(shouldPollRun(null), false);
  assert.equal(aggregateArtifactWeapon({ name: 'weapon-sweep-sword', expired: false }), 'sword');
  assert.equal(
    aggregateArtifactWeapon({ name: 'weapon-sweep-shard-sword-0', expired: false }),
    null,
  );
  assert.equal(aggregateArtifactWeapon({ name: 'weapon-sweep-bow', expired: true }), null);
});

test('derives expected weapons from aggregate and shard job names without duplicates', () => {
  assert.deepEqual(
    expectedWeaponsFromJobs([
      { name: 'setup' },
      { name: 'weapon-sweep (sword, 0, 1,5,9)' },
      { name: 'weapon-sweep (bow, 0, 1,5,9)' },
      { name: 'aggregate (sword)' },
    ]),
    ['sword', 'bow'],
  );
});

test('merges per-weapon aggregates in expected order using workflow timing', () => {
  const merged = mergeAggregateOutputs(
    [
      { weapon: 'bow', data: aggregate('bow') },
      { weapon: 'sword', data: aggregate('sword') },
    ],
    {
      expectedWeapons: ['sword', 'bow'],
      runCreatedAt: '2026-07-16T06:36:35Z',
    },
  );
  assert.equal(merged.runAt, '2026-07-16T06:36:35Z');
  assert.deepEqual(merged.weapons, ['sword', 'bow']);
  assert.equal(merged.summaries.length, 2);
  assert.equal(merged.allRecords.length, 4);
});

test('rejects inconsistent aggregate payloads', () => {
  assert.throws(
    () =>
      mergeAggregateOutputs([
        { weapon: 'sword', data: aggregate('sword') },
        { weapon: 'bow', data: aggregate('bow', { seeds: [1, 3] }) },
      ]),
    /Seed-set mismatch/,
  );
});

test('describes active, partial, failed, and expired result states explicitly', () => {
  assert.match(
    cloudResultWarning({
      run: { status: 'in_progress' },
      expectedWeapons: ['sword'],
      availableWeapons: [],
      expiredCount: 0,
    }),
    /refresh automatically/,
  );
  assert.match(
    cloudResultWarning({
      run: { status: 'completed', conclusion: 'failure' },
      expectedWeapons: ['sword', 'bow'],
      availableWeapons: ['sword'],
      expiredCount: 0,
    }),
    /partial results/,
  );
  assert.match(
    cloudResultWarning({
      run: { status: 'completed', conclusion: 'success' },
      expectedWeapons: [],
      availableWeapons: [],
      expiredCount: 2,
    }),
    /no longer has downloadable/,
  );
});

test('terminal partial warning says Missing not Waiting; active partial says Waiting', () => {
  const terminal = cloudResultWarning({
    run: { status: 'completed', conclusion: 'failure' },
    expectedWeapons: ['sword', 'bow'],
    availableWeapons: ['sword'],
    expiredCount: 0,
  });
  assert.doesNotMatch(terminal, /Waiting/);
  assert.match(terminal, /Missing/);
  assert.match(terminal, /bow/);

  const active = cloudResultWarning({
    run: { status: 'in_progress' },
    expectedWeapons: ['sword', 'bow'],
    availableWeapons: ['sword'],
    expiredCount: 0,
  });
  assert.match(active, /Waiting/);
  assert.match(active, /bow/);
});
