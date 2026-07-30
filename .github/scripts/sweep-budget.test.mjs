import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  allocateSweepSlots,
  calculateSweepAdmission,
  computeSweepBudget,
  countLatentBacklog,
  enrichMatrix,
  inspectRunnerDemand,
  runFromEnv,
  SweepProbeError,
} from './sweep-budget.mjs';
import { recoveryBacklogEntries } from './ci-recovery/router.mjs';
import { queueEntries } from './merge-train/state.mjs';

test('budget contracts for live jobs and latent backlog but never below one', () => {
  assert.equal(computeSweepBudget({ nonSweepJobs: 0, latentBacklog: 0 }), 10);
  assert.equal(computeSweepBudget({ nonSweepJobs: 7, latentBacklog: 5 }), 8);
  assert.equal(computeSweepBudget({ nonSweepJobs: 15, latentBacklog: 20 }), 1);
});

test('active sweeps fairly partition available slots in run-id order', () => {
  assert.deepEqual(
    allocateSweepSlots({ budget: 5, activeRunIds: [30, 10], currentRunId: 10 }),
    [0, 2, 4],
  );
  assert.deepEqual(
    allocateSweepSlots({ budget: 5, activeRunIds: [30, 10], currentRunId: 30 }),
    [1, 3],
  );
});

test('more active sweeps than budget share slots instead of losing the one-slot floor', () => {
  const allocations = [10, 20, 30, 40].map((currentRunId) =>
    allocateSweepSlots({
      budget: 2,
      activeRunIds: [10, 20, 30, 40],
      currentRunId,
    }),
  );
  assert.deepEqual(allocations, [[0], [1], [0], [1]]);
});

test('matrix enrichment preserves objects and wraps scalar entries', () => {
  assert.deepEqual(enrichMatrix(['sword', { combo: 'legacy+legacy' }], [2, 4], 'weapon'), [
    { weapon: 'sword', sweepSlot: 2 },
    { combo: 'legacy+legacy', sweepSlot: 4 },
  ]);
});

test('latent backlog unions merge-train, recovery and externally-blocked demand', () => {
  const repository = 'nalfeo/Crawler';
  const base = {
    state: 'open',
    draft: false,
    created_at: '2026-07-21T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: repository } },
  };
  const pullRequests = [
    // Counted once by the merge-train queue (carries the queue label).
    { ...base, number: 1, labels: [{ name: 'merge-train' }] },
    // Counted once by the recovery backlog (unlabelled, so nothing excludes it).
    { ...base, number: 2, labels: [] },
    // Counted once as latent demand: `merge-train-blocked` is excluded from recovery
    // slot consumption, but still contributes to sweep budgeting.
    { ...base, number: 3, labels: [{ name: 'merge-train-blocked' }] },
    // Excluded from both: no queue label, and explicitly opted out of recovery.
    { ...base, number: 4, labels: [{ name: 'ci-recovery-opt-out' }] },
  ];
  // PR #1: merge-train queue entry (counted). PR #2: recovery backlog entry (counted).
  // PR #3: externally blocked (merge-train-blocked) — counted as latent demand for sweep
  // budgeting even though CI Recovery skips dispatching to it.
  // PR #4: ci-recovery-opt-out — excluded from both queues.
  assert.equal(countLatentBacklog({ pullRequests, repository }), 3);
});

// The test above is named for a union, NOT for deduplication, because the three
// demand sources are DISJOINT BY CONSTRUCTION: eligibleTrainRecoveryPulls
// excludes every queue-labelled PR (`hasQueueLabel ||` in ci-recovery/router.mjs)
// and queueEntries selects exactly the queue-labelled PRs. With disjoint inputs
// the Set in countLatentBacklog can never collapse anything, so a fixture of
// singly-classified PRs cannot distinguish `new Set([...])` from a plain array —
// swapping the Set for `[...].length` leaves it green. The two tests below cover
// what that fixture cannot.
test('latent backlog dedup is load-bearing when a PR is reported twice', () => {
  const repository = 'nalfeo/Crawler';
  const base = {
    state: 'open',
    draft: false,
    created_at: '2026-07-21T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: repository } },
  };
  // A paginated listing can hand back the same PR on two pages. Each duplicate
  // is classified into the same bucket, so only the Set keeps the count honest.
  const queued = { ...base, number: 11, labels: [{ name: 'merge-train' }] };
  const recovering = { ...base, number: 12, labels: [] };
  const blocked = { ...base, number: 13, labels: [{ name: 'merge-train-blocked' }] };
  const pullRequests = [queued, recovering, blocked, queued, recovering, blocked];
  assert.equal(countLatentBacklog({ pullRequests, repository }), 3);
});

test('merge-train queue and recovery backlog never claim the same PR', () => {
  const repository = 'nalfeo/Crawler';
  const base = {
    state: 'open',
    draft: false,
    created_at: '2026-07-21T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: repository } },
  };
  const pullRequests = [
    { ...base, number: 21, labels: [{ name: 'merge-train' }] },
    { ...base, number: 22, labels: [] },
    { ...base, number: 23, labels: [{ name: 'merge-train' }] },
  ];
  const queued = new Set(queueEntries(pullRequests, repository).map((pull) => pull.number));
  const recovering = recoveryBacklogEntries(pullRequests, repository).map((pull) => pull.number);
  assert.ok(queued.size > 0, 'fixture must exercise the queue selector');
  assert.ok(recovering.length > 0, 'fixture must exercise the recovery selector');
  // Pins the disjointness the union accounting relies on. If a future change
  // drops `hasQueueLabel` from the recovery exclusions, dedup becomes genuinely
  // load-bearing for real inputs and this fails instead of silently double-counting.
  assert.deepEqual(
    recovering.filter((number) => queued.has(number)),
    [],
  );
});

// Pins externally-blocked latent-demand accounting so future changes to
// EXTERNALLY_BLOCKED_LABEL_NAMES fail with an unambiguous message.
test('latent backlog counts externally-blocked PRs once as latent demand', () => {
  const repository = 'nalfeo/Crawler';
  const base = {
    state: 'open',
    draft: false,
    created_at: '2026-07-21T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: repository } },
  };
  const blocked = [{ ...base, number: 10, labels: [{ name: 'merge-train-blocked' }] }];
  assert.equal(countLatentBacklog({ pullRequests: blocked, repository }), 1);

  const unblocked = [{ ...base, number: 10, labels: [] }];
  assert.equal(countLatentBacklog({ pullRequests: unblocked, repository }), 1);
});

// Pins behavior (b): an externally-blocked PR that also carries ci-recovery-opt-out
// still counts as latent demand. ci-recovery-opt-out only opts the PR out of CI
// Recovery slot consumption; the PR still occupies a runner when its own CI
// eventually runs, so it must be counted toward the sweep budget.
test('latent backlog counts externally-blocked PR even when ci-recovery-opt-out is present', () => {
  const repository = 'nalfeo/Crawler';
  const base = {
    state: 'open',
    draft: false,
    created_at: '2026-07-21T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: repository } },
  };
  // Both labels together: externally blocked and opted out of recovery.
  const bothLabels = [
    {
      ...base,
      number: 30,
      labels: [{ name: 'merge-train-blocked' }, { name: 'ci-recovery-opt-out' }],
    },
  ];
  assert.equal(countLatentBacklog({ pullRequests: bothLabels, repository }), 1);

  // Just ci-recovery-opt-out (not externally blocked): excluded from the latent count.
  const optOutOnly = [{ ...base, number: 31, labels: [{ name: 'ci-recovery-opt-out' }] }];
  assert.equal(countLatentBacklog({ pullRequests: optOutOnly, repository }), 0);
});

test('runner inspection excludes all broad sweeps and counts queued non-sweep runs', async () => {
  const responses = new Map([
    [
      '/repos/nalfeo/Crawler/actions/runs?status=in_progress&per_page=100&page=1',
      {
        workflow_runs: [
          { id: 1, name: 'AI Sweep Eval', status: 'in_progress' },
          { id: 2, name: 'CI', status: 'in_progress' },
        ],
      },
    ],
    [
      '/repos/nalfeo/Crawler/actions/runs?status=queued&per_page=100&page=1',
      { workflow_runs: [{ id: 3, name: 'CI Recovery', status: 'queued' }] },
    ],
    [
      '/repos/nalfeo/Crawler/actions/runs?status=pending&per_page=100&page=1',
      { workflow_runs: [] },
    ],
    [
      '/repos/nalfeo/Crawler/actions/runs?status=waiting&per_page=100&page=1',
      { workflow_runs: [] },
    ],
    [
      '/repos/nalfeo/Crawler/actions/runs?status=requested&per_page=100&page=1',
      { workflow_runs: [] },
    ],
    [
      '/repos/nalfeo/Crawler/actions/runs/2/jobs?filter=latest&per_page=100&page=1',
      { jobs: [{ status: 'in_progress' }, { status: 'queued' }, { status: 'completed' }] },
    ],
    ['/repos/nalfeo/Crawler/actions/runs/3/jobs?filter=latest&per_page=100&page=1', { jobs: [] }],
  ]);
  const requestFn = async (_token, requestPath) => {
    assert.ok(responses.has(requestPath), `unexpected request ${requestPath}`);
    return { data: responses.get(requestPath) };
  };
  const result = await inspectRunnerDemand({
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    currentRunId: 1,
    requestFn,
  });
  assert.equal(result.nonSweepJobs, 3);
  assert.deepEqual(result.activeSweepRunIds, [1]);
});

test('CLI fails closed to slot zero when GitHub probing fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawler-sweep-budget-'));
  const output = path.join(directory, 'output.txt');
  try {
    const result = await runFromEnv(
      {
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '42',
        GITHUB_OUTPUT: output,
        MATRIX_JSON: '["sword","bow"]',
      },
      async () => {
        throw new SweepProbeError('simulated API outage');
      },
    );
    assert.equal(result.budget, 1);
    assert.deepEqual(result.matrix, [
      { value: 'sword', sweepSlot: 0 },
      { value: 'bow', sweepSlot: 0 },
    ]);
    const contents = await readFile(output, 'utf8');
    assert.match(contents, /^budget=1$/m);
    assert.match(contents, /^max_parallel=1$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unreadable recovery ownership turns sweep admission into a fail-closed probe error', async () => {
  const requestFn = async (_token, requestPath) => {
    if (
      requestPath === '/repos/nalfeo/Crawler/actions/runs?status=in_progress&per_page=100&page=1' ||
      requestPath === '/repos/nalfeo/Crawler/actions/runs?status=queued&per_page=100&page=1' ||
      requestPath === '/repos/nalfeo/Crawler/actions/runs?status=pending&per_page=100&page=1' ||
      requestPath === '/repos/nalfeo/Crawler/actions/runs?status=waiting&per_page=100&page=1' ||
      requestPath === '/repos/nalfeo/Crawler/actions/runs?status=requested&per_page=100&page=1'
    ) {
      return { data: { workflow_runs: [] } };
    }
    assert.fail(`unexpected request ${requestPath}`);
  };
  const paginateFn = async (_token, requestPath) => {
    if (
      requestPath === '/repos/nalfeo/Crawler/pulls?state=open&base=main&sort=updated&direction=desc'
    ) {
      return [
        {
          number: 17,
          state: 'open',
          draft: false,
          created_at: '2026-07-21T00:00:00Z',
          base: { ref: 'main' },
          head: { repo: { full_name: 'nalfeo/Crawler' }, sha: 'abc123' },
          labels: [{ name: 'ci-owner-pr-17' }],
        },
      ];
    }
    if (requestPath === '/repos/nalfeo/Crawler/issues/17/comments') {
      throw new Error('comments API unavailable');
    }
    assert.fail(`unexpected pagination request ${requestPath}`);
  };

  await assert.rejects(
    calculateSweepAdmission({
      token: 'token',
      repository: 'nalfeo/Crawler',
      currentRunId: 42,
      matrixEntries: ['sword'],
      requestFn,
      paginateFn,
    }),
    (error) => {
      assert.equal(error instanceof SweepProbeError, true);
      assert.match(error.message, /CI recovery ownership unreadable for PR #17/);
      return true;
    },
  );
});

test('CLI surfaces invalid inputs instead of disguising them as probe failures', async () => {
  await assert.rejects(
    runFromEnv(
      {
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '42',
        GITHUB_OUTPUT: 'unused',
        MATRIX_JSON: '[]',
      },
      async () => {
        throw new TypeError('invalid matrix contract');
      },
    ),
    /invalid matrix contract/,
  );
});
