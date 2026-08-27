import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BASELINES_BRANCH,
  RELEASE_SWEEP_MAX_COMPETING_DEMAND,
  RELEASE_SWEEP_MIN_INTERVAL_HOURS,
  decideReleaseSweep,
  fetchLastSweepAt,
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
    jobs: [{ status: 'in_progress' }, { status: 'queued' }],
  });
  responses.set(`/repos/nalfeo/Crawler/commits?sha=${BASELINES_BRANCH}&per_page=1`, [
    { commit: { committer: { date: hoursAgo(1).toISOString() } } },
  ]);
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
  assert.equal(result.warnings.length, 3);
  for (const warning of result.warnings) {
    assert.match(warning, /GitHub API outage/);
  }
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
        latentBacklog: 6,
        warnings: [],
      }),
    );
    const contents = await readFile(output, 'utf8');
    assert.match(contents, /^should_sweep=false$/m);
    assert.match(contents, /^reason=runner pool is constrained$/m);
    assert.match(contents, /^non_sweep_jobs=9$/m);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
