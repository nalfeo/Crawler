import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildCanonicalRunName,
  CANONICAL_SWEEP_INPUTS,
  CANONICAL_SWEEP_WORKFLOW,
  ensureCanonicalBaselineSweep,
  ensureCanonicalBaselineSweepSafely,
  isCanonicalSweepRun,
} from './canonical-baseline.mjs';
import { FINAL_AGGREGATE_ARTIFACTS } from './nightly-balance-issue.mjs';

const token = 'intake-token';
const owner = 'nalfeo';
const repo = 'Crawler';
const headSha = 'a'.repeat(40);

function createRequestFn({ runs = [], artifactsByRun = {}, defaultBranch = 'main' } = {}) {
  const calls = [];
  const requestFn = async (usedToken, path, options = {}) => {
    calls.push({ token: usedToken, path, options });
    if (path === `/repos/${owner}/${repo}`) {
      return { data: { default_branch: defaultBranch } };
    }
    if (path.startsWith(`/repos/${owner}/${repo}/commits/`)) {
      return { data: { sha: headSha } };
    }
    if (path.includes(`/actions/workflows/${CANONICAL_SWEEP_WORKFLOW}/runs`)) {
      return { data: { workflow_runs: runs } };
    }
    const artifactsMatch = path.match(/\/actions\/runs\/(\d+)\/artifacts/);
    if (artifactsMatch) {
      return { data: { artifacts: artifactsByRun[artifactsMatch[1]] ?? [] } };
    }
    if (path.endsWith(`/actions/workflows/${CANONICAL_SWEEP_WORKFLOW}/dispatches`)) {
      return { data: null };
    }
    throw new Error(`unexpected request: ${path}`);
  };
  return { requestFn, calls };
}

function canonicalRun(overrides = {}) {
  return {
    id: 555,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    display_title: buildCanonicalRunName(),
    ...overrides,
  };
}

function allFinalAggregates() {
  return FINAL_AGGREGATE_ARTIFACTS.map((name) => ({ name, expired: false }));
}

test('canonical inputs describe a 100-seed six-weapon persona sweep', () => {
  assert.equal(CANONICAL_SWEEP_INPUTS.seed_count, '100');
  assert.deepEqual(CANONICAL_SWEEP_INPUTS.weapons.split(','), [
    'sword',
    'bow',
    'baseball-bat',
    'pistol',
    'throwing-knife',
    'fireball',
  ]);
  assert.equal(CANONICAL_SWEEP_INPUTS.weapon_personas, 'true');
  assert.equal(CANONICAL_SWEEP_INPUTS.max_frames, '19800');
});

test('the weapon sweep workflow stamps the canonical fields into its run name', async () => {
  const workflow = await readFile(
    new URL(`../../workflows/${CANONICAL_SWEEP_WORKFLOW}`, import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /run-name: Weapon Sweep · seeds=\$\{\{ inputs\.seed_count \}\} · weapons=\$\{\{ inputs\.weapons \}\} · personas=\$\{\{ inputs\.weapon_personas \}\} · frames=\$\{\{ inputs\.max_frames \}\}/,
  );
  const rendered = buildCanonicalRunName();
  assert.equal(
    rendered,
    'Weapon Sweep · seeds=100 · weapons=sword,bow,baseball-bat,pistol,throwing-knife,fireball · personas=true · frames=19800',
  );
});

test('non-canonical run titles are not accepted as canonical runs', () => {
  assert.equal(isCanonicalSweepRun(canonicalRun()), true);
  assert.equal(isCanonicalSweepRun({ display_title: 'Weapon Sweep' }), false);
  assert.equal(
    isCanonicalSweepRun({
      display_title: buildCanonicalRunName({ ...CANONICAL_SWEEP_INPUTS, seed_count: '30' }),
    }),
    false,
  );
  assert.equal(isCanonicalSweepRun({}), false);
});

test('dispatches a canonical sweep when current head has no eligible run', async () => {
  const { requestFn, calls } = createRequestFn({
    runs: [canonicalRun({ id: 1, head_sha: 'b'.repeat(40) })],
  });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.equal(result.status, 'dispatched');
  assert.equal(result.branch, 'main');
  assert.equal(result.headSha, headSha);
  const dispatch = calls.find((call) => call.options?.method === 'POST');
  assert.ok(dispatch, 'expected a workflow dispatch');
  assert.equal(dispatch.token, token);
  assert.deepEqual(dispatch.options.body, { ref: 'main', inputs: { ...CANONICAL_SWEEP_INPUTS } });
});

test('dispatches when a same-head run used non-canonical inputs', async () => {
  const { requestFn, calls } = createRequestFn({
    runs: [canonicalRun({ id: 2, display_title: 'Weapon Sweep' })],
    artifactsByRun: { 2: allFinalAggregates() },
  });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.equal(result.status, 'dispatched');
  assert.ok(calls.some((call) => call.options?.method === 'POST'));
});

test('dispatches when a canonical run is missing a FINAL aggregate artifact', async () => {
  const partial = allFinalAggregates().slice(1);
  const { requestFn, calls } = createRequestFn({
    runs: [canonicalRun({ id: 3 })],
    artifactsByRun: { 3: partial },
  });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.equal(result.status, 'dispatched');
  assert.ok(calls.some((call) => call.options?.method === 'POST'));
});

test('treats expired aggregate artifacts as unavailable', async () => {
  const expired = allFinalAggregates().map((artifact, index) =>
    index === 0 ? { ...artifact, expired: true } : artifact,
  );
  const { requestFn, calls } = createRequestFn({
    runs: [canonicalRun({ id: 4 })],
    artifactsByRun: { 4: expired },
  });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.equal(result.status, 'dispatched');
  assert.ok(calls.some((call) => call.options?.method === 'POST'));
});

test('dispatches when every canonical run at head fails the artifact check', async () => {
  const { requestFn, calls } = createRequestFn({
    runs: [canonicalRun({ id: 5 }), canonicalRun({ id: 6 })],
    artifactsByRun: { 5: [], 6: allFinalAggregates().slice(2) },
  });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.equal(result.status, 'dispatched');
  assert.ok(calls.some((call) => call.options?.method === 'POST'));
});

test('scopes the runs query to the exact head SHA instead of paging branch history', async () => {
  const { requestFn, calls } = createRequestFn();

  await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  const runsQuery = calls.find((call) => call.path.includes('/runs?'));
  assert.ok(runsQuery.path.includes(`head_sha=${headSha}`));
  assert.ok(runsQuery.path.includes('branch=main'));
});

test('reuses an eligible canonical run at the current head instead of dispatching', async () => {
  const { requestFn, calls } = createRequestFn({
    runs: [canonicalRun({ id: 7 })],
    artifactsByRun: { 7: allFinalAggregates() },
  });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.deepEqual(result, { status: 'fresh', branch: 'main', headSha, runId: 7 });
  assert.equal(
    calls.some((call) => call.options?.method === 'POST'),
    false,
  );
});

test('never dispatches a duplicate while a canonical run is still in flight', async () => {
  const { requestFn, calls } = createRequestFn({
    runs: [canonicalRun({ id: 8, status: 'in_progress', conclusion: null })],
  });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.deepEqual(result, { status: 'pending', branch: 'main', headSha, runId: 8 });
  assert.equal(
    calls.some((call) => call.options?.method === 'POST'),
    false,
  );
});

test('queries the resolved default branch rather than assuming main', async () => {
  const { requestFn, calls } = createRequestFn({ defaultBranch: 'trunk' });

  const result = await ensureCanonicalBaselineSweep({ token, owner, repo, requestFn });

  assert.equal(result.branch, 'trunk');
  assert.ok(calls.some((call) => call.path.includes('/runs?branch=trunk')));
  const dispatch = calls.find((call) => call.options?.method === 'POST');
  assert.equal(dispatch.options.body.ref, 'trunk');
});

test('a baseline failure never blocks the nightly issue from being filed', async () => {
  const requestFn = async () => {
    throw new Error('boom');
  };

  const result = await ensureCanonicalBaselineSweepSafely({
    token,
    repository: `${owner}/${repo}`,
    requestFn,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /boom/);
});

test('a missing token or malformed repository is skipped, not thrown', async () => {
  const { requestFn } = createRequestFn();

  assert.equal(
    (await ensureCanonicalBaselineSweepSafely({ token: '', repository: 'a/b', requestFn })).status,
    'skipped',
  );
  assert.equal(
    (await ensureCanonicalBaselineSweepSafely({ token, repository: 'nope', requestFn })).status,
    'skipped',
  );
});

test('the safe wrapper dispatches for a well-formed repository', async () => {
  const { requestFn, calls } = createRequestFn();

  const result = await ensureCanonicalBaselineSweepSafely({
    token,
    repository: `${owner}/${repo}`,
    requestFn,
  });

  assert.equal(result.status, 'dispatched');
  assert.ok(
    calls.some(
      (call) =>
        call.options?.method === 'POST' &&
        call.path ===
          `/repos/${owner}/${repo}/actions/workflows/${CANONICAL_SWEEP_WORKFLOW}/dispatches`,
    ),
  );
});

test('the entrypoint only dispatches the baseline after the issue decision', async () => {
  const entrypoint = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  const issueCallIndex = entrypoint.indexOf('runNightlyBalanceIssue({');
  const baselineCallIndex = entrypoint.indexOf('ensureCanonicalBaselineSweepSafely({');
  assert.ok(issueCallIndex > 0, 'entrypoint must call runNightlyBalanceIssue');
  assert.ok(baselineCallIndex > 0, 'entrypoint must call ensureCanonicalBaselineSweepSafely');
  // An already-open issue means the prior night's work is still active, so that
  // nightly must no-op instead of re-dispatching a 100-seed six-weapon sweep.
  assert.ok(
    issueCallIndex < baselineCallIndex,
    'the baseline sweep must be dispatched after the open-issue check',
  );
  assert.match(entrypoint, /canonical baseline sweep: skipped reason=issue-already-open/);
});
