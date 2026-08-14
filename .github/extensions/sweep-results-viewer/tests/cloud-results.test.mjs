import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateArtifactWeapon,
  aiSweepWarning,
  baselineSweepWarning,
  cloudResultWarning,
  expectedWeaponsFromJobs,
  floorProvenanceWarning,
  isBaselineArtifact,
  isLeaderboardArtifact,
  isTerminalRun,
  mergeAggregateOutputs,
  normalizeRun,
  parseAiSweepJobPhases,
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
    ...(options.floors === null ? {} : { floors: options.floors ?? [1] }),
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
  assert.deepEqual(merged.floors, [1]);
  assert.deepEqual(merged.weapons, ['sword', 'bow']);
  assert.equal(merged.summaries.length, 2);
  assert.equal(merged.allRecords.length, 4);
});

test('normalizes floor provenance and preserves Unknown for mixed legacy aggregates', () => {
  const normalized = mergeAggregateOutputs([
    { weapon: 'sword', data: aggregate('sword', { floors: [2, 1, 2] }) },
    { weapon: 'bow', data: aggregate('bow', { floors: [3, 2] }) },
  ]);
  assert.deepEqual(normalized.floors, [1, 2, 3]);
  assert.equal(floorProvenanceWarning([{ data: normalized }]), null);

  const legacyEntries = [
    { weapon: 'sword', data: aggregate('sword', { floors: [1] }) },
    { weapon: 'bow', data: aggregate('bow', { floors: null }) },
  ];
  const legacy = mergeAggregateOutputs(legacyEntries);
  assert.equal(Object.hasOwn(legacy, 'floors'), false);
  assert.match(floorProvenanceWarning(legacyEntries), /Floors are Unknown/);
});

test('rejects malformed present cloud floor metadata', () => {
  assert.throws(
    () => mergeAggregateOutputs([{ weapon: 'sword', data: aggregate('sword', { floors: ['1'] }) }]),
    /floors must be a non-empty array of positive integers/,
  );
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

test('partial warnings are keyed by missing membership, not only array length', () => {
  const warning = cloudResultWarning({
    run: { status: 'completed', conclusion: 'success' },
    expectedWeapons: ['sword'],
    availableWeapons: ['bow'],
    expiredCount: 0,
  });
  assert.match(warning, /Missing/);
  assert.match(warning, /sword/);
});

// ── AI sweep helpers ──────────────────────────────────────────────────────────

test('parseAiSweepJobPhases classifies Preflight, Search, Validate, and Aggregate jobs', () => {
  const jobs = [
    { name: 'Preflight (derive + cap combo matrix)', status: 'completed', conclusion: 'success' },
    { name: 'Search legacy+legacy', status: 'completed', conclusion: 'success' },
    { name: 'Search navmeshFused+slackAware', status: 'in_progress', conclusion: null },
    { name: 'Validate legacy+legacy', status: 'queued', conclusion: null },
    { name: 'Aggregate → leaderboard', status: 'queued', conclusion: null },
  ];
  const phases = parseAiSweepJobPhases(jobs);
  assert.equal(phases.preflight.total, 1);
  assert.equal(phases.preflight.done, 1);
  assert.equal(phases.search.total, 2);
  assert.equal(phases.search.done, 1);
  assert.equal(phases.search.running, 1);
  assert.equal(phases.validate.total, 1);
  assert.equal(phases.validate.pending, 1);
  assert.equal(phases.aggregate.total, 1);
  assert.equal(phases.aggregate.pending, 1);
});

test('parseAiSweepJobPhases counts failed jobs and ignores unrecognized names', () => {
  const jobs = [
    { name: 'Search legacy+legacy', status: 'completed', conclusion: 'failure' },
    { name: 'Some unrelated setup job', status: 'completed', conclusion: 'success' },
  ];
  const phases = parseAiSweepJobPhases(jobs);
  assert.equal(phases.search.total, 1);
  assert.equal(phases.search.failed, 1);
  // Unrecognized job must not appear in any phase.
  for (const phase of Object.values(phases)) {
    assert.ok(phase.total <= 1, 'unexpected total in phase');
  }
});

test('parseAiSweepJobPhases counts skipped jobs as done', () => {
  const jobs = [
    { name: 'Validate navmeshFused+slackAware', status: 'completed', conclusion: 'skipped' },
  ];
  const phases = parseAiSweepJobPhases(jobs);
  assert.equal(phases.validate.done, 1);
  assert.equal(phases.validate.failed, 0);
});

test('parseAiSweepJobPhases classifies the bounded round-DAG job names under "search"', () => {
  // The round-DAG (Baseline / Checkpoint init / Round N — plan candidates /
  // Round N eval / Round N select) replaced the old monolithic "Search"
  // job — all of it must still classify as the "search" phase so progress
  // reporting keeps working for the new workflow shape.
  const jobs = [
    { name: 'Baseline legacy+legacy', status: 'completed', conclusion: 'success' },
    { name: 'Checkpoint init legacy+legacy', status: 'completed', conclusion: 'success' },
    { name: 'Round 1 — plan candidates', status: 'completed', conclusion: 'success' },
    { name: 'Round 1 eval riskRewardFused+legacy', status: 'in_progress', conclusion: null },
    { name: 'Round 1 select legacy+legacy', status: 'queued', conclusion: null },
    { name: 'Round 2 eval navmeshFused+slackAware', status: 'queued', conclusion: null },
  ];
  const phases = parseAiSweepJobPhases(jobs);
  assert.equal(phases.search.total, 6);
  assert.equal(phases.search.done, 3);
  assert.equal(phases.search.running, 1);
  assert.equal(phases.search.pending, 2);
});

test('isLeaderboardArtifact accepts only a non-expired artifact named "leaderboard"', () => {
  assert.equal(isLeaderboardArtifact({ name: 'leaderboard', expired: false }), true);
  assert.equal(isLeaderboardArtifact({ name: 'leaderboard', expired: true }), false);
  assert.equal(isLeaderboardArtifact({ name: 'leaderboard-old', expired: false }), false);
  assert.equal(isLeaderboardArtifact({ name: 'weapon-sweep-sword', expired: false }), false);
  assert.equal(isLeaderboardArtifact(null), false);
});

test('aiSweepWarning returns null for a successful terminal run with a leaderboard', () => {
  const result = aiSweepWarning({
    run: { status: 'completed', conclusion: 'success' },
    jobPhases: null,
    hasLeaderboard: true,
  });
  assert.equal(result, null);
});

test('aiSweepWarning describes search phase progress', () => {
  const result = aiSweepWarning({
    run: { status: 'in_progress' },
    jobPhases: {
      preflight: { total: 1, done: 1, failed: 0, running: 0, pending: 0 },
      search: { total: 8, done: 3, failed: 0, running: 2, pending: 3 },
      validate: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
      aggregate: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
    },
    hasLeaderboard: false,
  });
  assert.match(result, /Search/i);
  assert.match(result, /Refreshing automatically/i);
});

test('aiSweepWarning describes validation phase progress', () => {
  const result = aiSweepWarning({
    run: { status: 'in_progress' },
    jobPhases: {
      preflight: { total: 1, done: 1, failed: 0, running: 0, pending: 0 },
      search: { total: 8, done: 8, failed: 0, running: 0, pending: 0 },
      validate: { total: 8, done: 5, failed: 0, running: 3, pending: 0 },
      aggregate: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
    },
    hasLeaderboard: false,
  });
  assert.match(result, /Validation/i);
  assert.match(result, /Refreshing automatically/i);
});

test('aiSweepWarning reports missing leaderboard on a failed terminal run', () => {
  const result = aiSweepWarning({
    run: { status: 'completed', conclusion: 'failure' },
    jobPhases: null,
    hasLeaderboard: false,
  });
  assert.match(result, /failure/i);
  assert.match(result, /leaderboard/i);
});

test('aiSweepWarning reports expired artifact when leaderboard is missing and expiredArtifactCount > 0', () => {
  const result = aiSweepWarning({
    run: { status: 'completed', conclusion: 'success' },
    jobPhases: null,
    hasLeaderboard: false,
    expiredArtifactCount: 1,
  });
  assert.match(result, /expired/i);
  assert.match(result, /leaderboard/i);
});

// ── Baseline-sweep (post-release deploy.yml) helpers ──────────────────────────

test('isBaselineArtifact accepts only a non-expired "baseline-<sha>" artifact', () => {
  assert.equal(isBaselineArtifact({ name: 'baseline-abc1234def56', expired: false }), true);
  assert.equal(isBaselineArtifact({ name: 'baseline-abc1234def56', expired: true }), false);
  assert.equal(isBaselineArtifact({ name: 'baseline-shard-abc123', expired: false }), false);
  assert.equal(isBaselineArtifact({ name: 'weapon-sweep-sword', expired: false }), false);
  assert.equal(isBaselineArtifact({ name: 'leaderboard', expired: false }), false);
  assert.equal(isBaselineArtifact(null), false);
});

test('baselineSweepWarning reports an active run as still running', () => {
  const result = baselineSweepWarning({
    run: { status: 'in_progress' },
    hasArtifact: false,
    hasFunReport: false,
  });
  assert.match(result, /still running/i);
});

test('baselineSweepWarning reports a terminal run with no artifact (baseline-sweep skipped)', () => {
  const result = baselineSweepWarning({
    run: { status: 'completed', conclusion: 'success' },
    hasArtifact: false,
    hasFunReport: false,
  });
  assert.match(result, /no baseline-sweep artifact/i);
});

test('baselineSweepWarning reports expired artifact distinctly from a never-produced one', () => {
  const result = baselineSweepWarning({
    run: { status: 'completed', conclusion: 'success' },
    hasArtifact: false,
    hasFunReport: false,
    expiredArtifactCount: 1,
  });
  assert.match(result, /expired/i);
});

test('baselineSweepWarning reports a failed run missing its artifact with the conclusion', () => {
  const result = baselineSweepWarning({
    run: { status: 'completed', conclusion: 'failure' },
    hasArtifact: false,
    hasFunReport: false,
  });
  assert.match(result, /failure/i);
});

test('baselineSweepWarning flags a missing fun-eval report as non-fatal (legacy or scoring failure)', () => {
  const result = baselineSweepWarning({
    run: { status: 'completed', conclusion: 'success' },
    hasArtifact: true,
    hasFunReport: false,
  });
  assert.match(result, /fun evaluation report is not available/i);
});

test('baselineSweepWarning returns null for a successful terminal run with both baseline and fun report', () => {
  const result = baselineSweepWarning({
    run: { status: 'completed', conclusion: 'success' },
    hasArtifact: true,
    hasFunReport: true,
  });
  assert.equal(result, null);
});
