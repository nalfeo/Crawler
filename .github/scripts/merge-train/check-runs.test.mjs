import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listTrustedAppCheckRunsForRef,
  mergeCheckRunSnapshots,
  resolveCandidateCheckState,
} from './check-runs.mjs';
import { trainCheckState } from './state.mjs';

const sha = 'a'.repeat(40);
const evidenceId = 'b'.repeat(64);
const trustedAppId = 4106541;
const app = { id: trustedAppId };

function candidateRun(overrides = {}) {
  return {
    id: 1,
    name: 'merge-train-candidate',
    status: 'completed',
    conclusion: 'success',
    external_id: evidenceId,
    app,
    ...overrides,
  };
}

async function resolve({ commitCheckRuns = [], trustedCheckRuns = [] }) {
  return resolveCandidateCheckState({
    sha,
    evidenceId,
    trustedAppId,
    now: new Date('2026-07-21T05:30:00.000Z'),
    loadCommitCheckRuns: async () => commitCheckRuns,
    loadTrustedAppCheckRuns: async () => ({
      checkRuns: trustedCheckRuns,
      suiteCount: 1,
      suitePages: 1,
      checkRunPages: 1,
    }),
    classify: trainCheckState,
  });
}

test('candidate state falls back to trusted App suites when commit enumeration omits success', async () => {
  const result = await resolve({ trustedCheckRuns: [candidateRun()] });
  assert.equal(result.state, 'success');
  assert.equal(result.usedSuiteFallback, true);
});

test('suite-only active and cancelled candidate checks preserve pending and retryable states', async () => {
  const pending = await resolve({
    trustedCheckRuns: [
      candidateRun({
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-07-21T05:25:00.000Z',
      }),
    ],
  });
  assert.equal(pending.state, 'pending');

  const cancelled = await resolve({
    trustedCheckRuns: [candidateRun({ conclusion: 'cancelled' })],
  });
  assert.equal(cancelled.state, 'missing');
});

test('same-id suite snapshot replaces stale commit snapshot with terminal evidence', async () => {
  const result = await resolve({
    commitCheckRuns: [
      candidateRun({
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-07-21T04:00:00.000Z',
      }),
    ],
    trustedCheckRuns: [
      candidateRun({
        completed_at: '2026-07-21T05:00:00.000Z',
      }),
    ],
  });
  assert.equal(result.state, 'success');
});

test('same-id snapshot merging prefers terminal state, then the freshest representation', () => {
  const stale = candidateRun({
    status: 'in_progress',
    conclusion: null,
    updated_at: '2026-07-21T04:00:00.000Z',
  });
  const terminal = candidateRun({
    updated_at: '2026-07-21T03:00:00.000Z',
  });
  assert.deepEqual(mergeCheckRunSnapshots([stale], [terminal]), [terminal]);

  const fresher = candidateRun({
    conclusion: 'failure',
    updated_at: '2026-07-21T05:00:00.000Z',
  });
  assert.deepEqual(mergeCheckRunSnapshots([terminal], [fresher]), [fresher]);
});

test('trusted App suite lookup paginates every suite and check-run page with id deduplication', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    candidateRun({ id: index + 1, name: `check-${index + 1}` }),
  );
  const terminal = candidateRun({
    id: 100,
    completed_at: '2026-07-21T05:00:00.000Z',
  });
  const calls = [];
  const request = async (_token, path) => {
    calls.push(path);
    const page = Number(new URL(path, 'https://api.github.test').searchParams.get('page'));
    if (path.includes('/check-suites?')) {
      return {
        data: {
          check_suites: page === 1 ? [{ id: 11 }, { id: 12 }] : [],
        },
      };
    }
    if (path.includes('/check-suites/11/check-runs')) {
      return {
        data: {
          check_runs: page === 1 ? firstPage : [terminal],
        },
      };
    }
    if (path.includes('/check-suites/12/check-runs')) {
      return { data: { check_runs: [candidateRun({ id: 101 })] } };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const result = await listTrustedAppCheckRunsForRef({
    request,
    token: 'token',
    owner: 'nalfeo',
    repo: 'Crawler',
    sha,
    trustedAppId,
  });

  assert.equal(result.suiteCount, 2);
  assert.equal(result.suitePages, 1);
  assert.equal(result.checkRunPages, 3);
  assert.equal(result.checkRuns.length, 101);
  assert.equal(result.checkRuns.find((run) => run.id === 100)?.status, 'completed');
  assert.ok(calls.every((path) => path.includes('per_page=100')));
  assert.ok(calls.some((path) => path.includes(`app_id=${trustedAppId}`)));
  assert.ok(calls.some((path) => path.includes('page=2')));
});
