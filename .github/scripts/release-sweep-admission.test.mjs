import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BASELINES_BRANCH,
  RELEASE_SWEEP_MAX_COMPETING_DEMAND,
  RELEASE_SWEEP_MAX_QUEUED_JOBS,
  RELEASE_SWEEP_MIN_INTERVAL_HOURS,
  RELEASE_WORKFLOW_FILE,
  decideReleaseSweep,
  fetchLastSweepAt,
  inspectSweepInFlight,
  resolveReleaseSweepAdmission,
  runFromEnv,
} from './release-sweep-admission.mjs';

const NOW = new Date('2026-08-27T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

test('an unconstrained runner pool always sweeps', () => {
  const decision = decideReleaseSweep({
    nonSweepJobs: 2,
    latentBacklog: 1,
    lastSweepAt: hoursAgo(0.5),
    now: NOW,
  });
  assert.equal(decision.shouldSweep, true);
  assert.equal(decision.constrained, false);
  assert.match(decision.reason, /headroom/);
});

test('a constrained pool skips the sweep when a fresh baseline already exists', () => {
  const decision = decideReleaseSweep({
    nonSweepJobs: 8,
    latentBacklog: 4,
    lastSweepAt: hoursAgo(3),
    now: NOW,
  });
  assert.equal(decision.shouldSweep, false);
  assert.equal(decision.constrained, true);
  assert.match(decision.reason, /skipping/);
});

test('the 24h staleness override sweeps even while the pool is constrained', () => {
  const stale = decideReleaseSweep({
    nonSweepJobs: 30,
    latentBacklog: 30,
    lastSweepAt: hoursAgo(RELEASE_SWEEP_MIN_INTERVAL_HOURS),
    now: NOW,
  });
  assert.equal(stale.shouldSweep, true);
  assert.equal(stale.constrained, true);
  assert.match(stale.reason, /sweeping anyway/);

  // One minute short of the interval still skips, so the boundary is pinned.
  const almostStale = decideReleaseSweep({
    nonSweepJobs: 30,
    latentBacklog: 30,
    lastSweepAt: hoursAgo(RELEASE_SWEEP_MIN_INTERVAL_HOURS - 1 / 60),
    now: NOW,
  });
  assert.equal(almostStale.shouldSweep, false);
});

test('the pressure threshold counts live jobs and latent backlog together', () => {
  // Exactly at the threshold is still admitted; one unit past it is not.
  assert.equal(
    decideReleaseSweep({
      nonSweepJobs: RELEASE_SWEEP_MAX_COMPETING_DEMAND,
      latentBacklog: 0,
      lastSweepAt: NOW,
      now: NOW,
    }).shouldSweep,
    true,
  );
  assert.equal(
    decideReleaseSweep({
      nonSweepJobs: RELEASE_SWEEP_MAX_COMPETING_DEMAND,
      latentBacklog: 1,
      lastSweepAt: NOW,
      now: NOW,
    }).shouldSweep,
    false,
  );
});

test('any job already waiting for a runner constrains the pool on its own', () => {
  // The pool is nearly idle by total claim, but one job is queued — that job is
  // work someone is waiting on that the pool has no capacity for right now, so
  // the sweep must not be piled on top of it.
  const decision = decideReleaseSweep({
    nonSweepJobs: 1,
    queuedJobs: RELEASE_SWEEP_MAX_QUEUED_JOBS + 1,
    latentBacklog: 0,
    lastSweepAt: hoursAgo(1),
    now: NOW,
  });
  assert.equal(decision.shouldSweep, false);
  assert.equal(decision.constrained, true);
  assert.match(decision.reason, /waiting for a runner/);

  // Busy but keeping up (nothing queued) is still admitted.
  const running = decideReleaseSweep({
    nonSweepJobs: RELEASE_SWEEP_MAX_COMPETING_DEMAND,
    queuedJobs: RELEASE_SWEEP_MAX_QUEUED_JOBS,
    latentBacklog: 0,
    lastSweepAt: hoursAgo(1),
    now: NOW,
  });
  assert.equal(running.shouldSweep, true);
  assert.equal(running.constrained, false);
});

test('a queue-constrained pool still honors the staleness override', () => {
  const decision = decideReleaseSweep({
    nonSweepJobs: 1,
    queuedJobs: 25,
    latentBacklog: 0,
    lastSweepAt: hoursAgo(RELEASE_SWEEP_MIN_INTERVAL_HOURS),
    now: NOW,
  });
  assert.equal(decision.shouldSweep, true);
  assert.match(decision.reason, /sweeping anyway/);
});

test('the staleness override does not stack on a sweep that is still in flight', () => {
  const decision = decideReleaseSweep({
    nonSweepJobs: 30,
    latentBacklog: 30,
    sweepInFlight: true,
    lastSweepAt: hoursAgo(RELEASE_SWEEP_MIN_INTERVAL_HOURS * 2),
    now: NOW,
  });
  assert.equal(decision.shouldSweep, false);
  assert.match(decision.reason, /still in flight/);

  // Same for the "no baseline has ever been published" catch-up path.
  const firstEver = decideReleaseSweep({
    nonSweepJobs: 30,
    latentBacklog: 30,
    sweepInFlight: true,
    lastSweepAt: null,
    now: NOW,
  });
  assert.equal(firstEver.shouldSweep, false);
  assert.match(firstEver.reason, /still in flight/);
});

test('an in-flight sweep is detected from the release workflow’s active jobs', async () => {
  const responses = new Map();
  for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
    responses.set(
      `/repos/nalfeo/Crawler/actions/workflows/${RELEASE_WORKFLOW_FILE}/runs?status=${status}&per_page=100`,
      { workflow_runs: status === 'in_progress' ? [{ id: 41 }, { id: 42 }] : [] },
    );
  }
  responses.set('/repos/nalfeo/Crawler/actions/runs/41/jobs?filter=latest&per_page=100', {
    jobs: [{ name: 'Baseline multi-floor sweep (600 runs)', status: 'in_progress' }],
  });
  const requestFn = async (_token, requestPath) => {
    assert.ok(responses.has(requestPath), `unexpected request ${requestPath}`);
    return { data: responses.get(requestPath) };
  };
  // Run 42 is the current run and must not be probed as its own predecessor.
  assert.equal(
    await inspectSweepInFlight({
      token: 'token',
      owner: 'nalfeo',
      repo: 'Crawler',
      currentRunId: 42,
      requestFn,
    }),
    true,
  );

  responses.set('/repos/nalfeo/Crawler/actions/runs/41/jobs?filter=latest&per_page=100', {
    jobs: [
      { name: 'Baseline multi-floor sweep (600 runs)', status: 'completed' },
      { name: 'Deploy', status: 'in_progress' },
    ],
  });
  assert.equal(
    await inspectSweepInFlight({
      token: 'token',
      owner: 'nalfeo',
      repo: 'Crawler',
      currentRunId: 42,
      requestFn,
    }),
    false,
  );
});

test('an unknown last-sweep time fails open', () => {
  const decision = decideReleaseSweep({
    nonSweepJobs: 40,
    latentBacklog: 40,
    lastSweepAt: null,
    now: NOW,
  });
  assert.equal(decision.shouldSweep, true);
  assert.match(decision.reason, /no previous baseline/);
});

test('malformed demand inputs are rejected instead of silently skipping the sweep', () => {
  assert.throws(
    () => decideReleaseSweep({ nonSweepJobs: -1, latentBacklog: 0, lastSweepAt: NOW, now: NOW }),
    /nonSweepJobs/,
  );
  assert.throws(
    () => decideReleaseSweep({ nonSweepJobs: 0, latentBacklog: 1.5, lastSweepAt: NOW, now: NOW }),
    /latentBacklog/,
  );
  assert.throws(
    () =>
      decideReleaseSweep({
        nonSweepJobs: 0,
        queuedJobs: -1,
        latentBacklog: 0,
        lastSweepAt: NOW,
        now: NOW,
      }),
    /queuedJobs/,
  );
});

test('the last sweep time comes from the baselines branch tip', async () => {
  const requestFn = async (_token, requestPath) => {
    assert.equal(
      requestPath,
      `/repos/nalfeo/Crawler/commits?sha=${BASELINES_BRANCH}&per_page=1`,
      'must read the baselines branch, not main',
    );
    return {
      data: [{ commit: { committer: { date: '2026-08-26T12:00:00Z' } } }],
    };
  };
  const lastSweepAt = await fetchLastSweepAt({
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    requestFn,
  });
  assert.equal(lastSweepAt.toISOString(), '2026-08-26T12:00:00.000Z');
});

test('an empty baselines branch reports no previous sweep', async () => {
  const lastSweepAt = await fetchLastSweepAt({
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    requestFn: async () => ({ data: [] }),
  });
  assert.equal(lastSweepAt, null);
});

/** Canned active-run listing responses for the runner-demand probe. */
function runListingResponses(runs) {
  const statuses = ['queued', 'pending', 'in_progress', 'waiting', 'requested'];
  const responses = new Map();
  for (const status of statuses) {
    responses.set(`/repos/nalfeo/Crawler/actions/runs?status=${status}&per_page=100&page=1`, {
      workflow_runs: runs.filter((run) => run.status === status),
    });
  }
  return responses;
}

test('the probe excludes the deploy run’s own jobs from measured pressure', async () => {
  const responses = runListingResponses([
    { id: 42, name: 'Deploy to GitHub Pages', status: 'in_progress' },
    { id: 7, name: 'CI', status: 'in_progress' },
  ]);
  responses.set('/repos/nalfeo/Crawler/actions/runs/7/jobs?filter=latest&per_page=100&page=1', {
    jobs: [{ status: 'in_progress' }, { status: 'in_progress' }],
  });
  responses.set(`/repos/nalfeo/Crawler/commits?sha=${BASELINES_BRANCH}&per_page=1`, [
    { commit: { committer: { date: hoursAgo(1).toISOString() } } },
  ]);
  for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
    responses.set(
      `/repos/nalfeo/Crawler/actions/workflows/${RELEASE_WORKFLOW_FILE}/runs?status=${status}&per_page=100`,
      { workflow_runs: [] },
    );
  }
  const requestFn = async (_token, requestPath) => {
    assert.ok(
      responses.has(requestPath),
      `unexpected request ${requestPath} (the deploy run's own jobs must not be probed)`,
    );
    return { data: responses.get(requestPath) };
  };
  const result = await resolveReleaseSweepAdmission({
    token: 'token',
    repository: 'nalfeo/Crawler',
    currentRunId: 42,
    now: NOW,
    requestFn,
    paginateFn: async () => [],
  });
  assert.equal(result.nonSweepJobs, 2);
  assert.equal(result.queuedJobs, 0);
  assert.equal(result.latentBacklog, 0);
  assert.equal(result.shouldSweep, true);
  assert.deepEqual(result.warnings, []);
});

test('a failed probe degrades to sweeping and records a warning', async () => {
  const result = await resolveReleaseSweepAdmission({
    token: 'token',
    repository: 'nalfeo/Crawler',
    currentRunId: 42,
    now: NOW,
    requestFn: async () => {
      throw new Error('GitHub API outage');
    },
    paginateFn: async () => {
      throw new Error('GitHub API outage');
    },
  });
  assert.equal(result.shouldSweep, true);
  assert.equal(result.warnings.length, 4);
  for (const warning of result.warnings) {
    assert.match(warning, /GitHub API outage/);
  }
});

test('a single failed probe still fails open even when the others say constrained', async () => {
  // Only the in-flight probe fails; measured demand alone reads as constrained
  // against a fresh baseline, so degrading the failed probe to a default would
  // produce a *skip* built on a signal we could not actually measure.
  const responses = runListingResponses([{ id: 7, name: 'CI', status: 'in_progress' }]);
  responses.set('/repos/nalfeo/Crawler/actions/runs/7/jobs?filter=latest&per_page=100&page=1', {
    jobs: Array.from({ length: 12 }, () => ({ status: 'in_progress' })),
  });
  responses.set(`/repos/nalfeo/Crawler/commits?sha=${BASELINES_BRANCH}&per_page=1`, [
    { commit: { committer: { date: hoursAgo(1).toISOString() } } },
  ]);
  const result = await resolveReleaseSweepAdmission({
    token: 'token',
    repository: 'nalfeo/Crawler',
    currentRunId: 42,
    now: NOW,
    requestFn: async (_token, requestPath) => {
      if (responses.has(requestPath)) return { data: responses.get(requestPath) };
      throw new Error('workflow runs API 403');
    },
    paginateFn: async () => [],
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /in-flight sweep probe failed/);
  assert.equal(result.nonSweepJobs, 12);
  assert.equal(result.shouldSweep, true);
  assert.match(result.reason, /not trustworthy/);
});

test('CLI writes the verdict to GITHUB_OUTPUT', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawler-release-sweep-'));
  const output = path.join(directory, 'output.txt');
  try {
    await runFromEnv(
      {
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '42',
        GITHUB_OUTPUT: output,
      },
      async () => ({
        shouldSweep: false,
        reason: 'runner pool is constrained',
        nonSweepJobs: 9,
        queuedJobs: 4,
        latentBacklog: 6,
        warnings: [],
      }),
    );
    const contents = await readFile(output, 'utf8');
    assert.match(contents, /^should_sweep=false$/m);
    assert.match(contents, /^reason=runner pool is constrained$/m);
    assert.match(contents, /^non_sweep_jobs=9$/m);
    assert.match(contents, /^queued_jobs=4$/m);
    assert.match(contents, /^latent_backlog=6$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI fails open when the admission check itself throws', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawler-release-sweep-'));
  const output = path.join(directory, 'output.txt');
  try {
    const result = await runFromEnv(
      {
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '42',
        GITHUB_OUTPUT: output,
      },
      async () => {
        throw new Error('unexpected\nmulti-line failure');
      },
    );
    assert.equal(result.shouldSweep, true);
    const contents = await readFile(output, 'utf8');
    assert.match(contents, /^should_sweep=true$/m);
    // A multi-line reason would corrupt every later key in GITHUB_OUTPUT.
    assert.match(contents, /^reason=admission check failed \(unexpected multi-line failure\)/m);
    assert.match(contents, /^non_sweep_jobs=0$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI honors operator-tuned interval and demand knobs, ignoring malformed values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawler-release-sweep-'));
  const output = path.join(directory, 'output.txt');
  const seen = [];
  try {
    await runFromEnv(
      {
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '42',
        GITHUB_OUTPUT: output,
        RELEASE_SWEEP_MIN_INTERVAL_HOURS: '6',
        RELEASE_SWEEP_MAX_COMPETING_DEMAND: '12oops',
        RELEASE_SWEEP_MAX_QUEUED_JOBS: '3',
      },
      async (input) => {
        seen.push(input);
        return {
          shouldSweep: true,
          reason: 'ok',
          nonSweepJobs: 0,
          latentBacklog: 0,
          warnings: [],
        };
      },
    );
    assert.equal(seen[0].minIntervalHours, 6);
    assert.equal(seen[0].maxCompetingDemand, RELEASE_SWEEP_MAX_COMPETING_DEMAND);
    // Zero is a meaningful value for this knob, so it must parse as
    // non-negative rather than falling back like a positive-only knob.
    assert.equal(seen[0].maxQueuedJobs, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
