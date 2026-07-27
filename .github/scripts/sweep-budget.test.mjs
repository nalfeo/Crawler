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

const LATENT_BACKLOG_REPOSITORY = 'nalfeo/Crawler';
const LATENT_BACKLOG_BASE_PR = {
  state: 'open',
  draft: false,
  created_at: '2026-07-21T00:00:00Z',
  base: { ref: 'main' },
  head: { repo: { full_name: LATENT_BACKLOG_REPOSITORY } },
};
// Fixed so the assertions never depend on wall-clock drift against the fixture's
// created_at (hasHealthyOwnerForSweep takes `now`).
const LATENT_BACKLOG_NOW = new Date('2026-07-21T06:00:00Z');

function latentBacklogOf(labels, number = 1) {
  return countLatentBacklog({
    pullRequests: [{ ...LATENT_BACKLOG_BASE_PR, number, labels }],
    repository: LATENT_BACKLOG_REPOSITORY,
    now: LATENT_BACKLOG_NOW,
  });
}

// Asserts each label class's contribution individually rather than only the
// union size: a bare total lets a behaviour change move which PRs qualify while
// the number coincidentally holds, which is how this test previously rotted.
test('latent backlog counts train-queued and unowned recovery demand only', () => {
  // Reserved: these will genuinely consume runners.
  assert.equal(latentBacklogOf([{ name: 'merge-train' }]), 1, 'merge-train is queued demand');
  assert.equal(latentBacklogOf([]), 1, 'unlabelled PRs are recovery-sweep demand');

  // Not reserved: reconcile skips these unconditionally, so no dispatch and no
  // runners. `merge-train-blocked` stopped counting in 492bb4be8 (2026-07-27),
  // which applied isExternallyBlocked() to the train-enabled recovery path.
  assert.equal(
    latentBacklogOf([{ name: 'merge-train-blocked' }]),
    0,
    'externally blocked PRs cannot be dispatched, so they reserve no budget',
  );
  assert.equal(latentBacklogOf([{ name: 'ci-recovery-opt-out' }]), 0, 'opted-out PRs are excluded');
});

test('latent backlog unions merge-train and recovery demand', () => {
  const pullRequests = [
    { ...LATENT_BACKLOG_BASE_PR, number: 1, labels: [{ name: 'merge-train' }] },
    { ...LATENT_BACKLOG_BASE_PR, number: 2, labels: [] },
    { ...LATENT_BACKLOG_BASE_PR, number: 3, labels: [{ name: 'merge-train-blocked' }] },
    { ...LATENT_BACKLOG_BASE_PR, number: 4, labels: [{ name: 'ci-recovery-opt-out' }] },
  ];
  assert.equal(
    countLatentBacklog({
      pullRequests,
      repository: LATENT_BACKLOG_REPOSITORY,
      now: LATENT_BACKLOG_NOW,
    }),
    2,
  );
});

// The two selectors are provably disjoint -- eligibleTrainRecoveryPulls()
// excludes the merge-train label unconditionally, and queueEntries() requires
// it -- so no label fixture can make one PR appear in both. Repeating a PR in
// the input is therefore the only way to exercise the Set, and without this the
// dedup in countLatentBacklog() is untested.
test('latent backlog deduplicates a repeated PR number', () => {
  const pullRequest = { ...LATENT_BACKLOG_BASE_PR, number: 7, labels: [] };
  assert.equal(
    countLatentBacklog({
      pullRequests: [pullRequest, pullRequest],
      repository: LATENT_BACKLOG_REPOSITORY,
      now: LATENT_BACKLOG_NOW,
    }),
    1,
  );
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
