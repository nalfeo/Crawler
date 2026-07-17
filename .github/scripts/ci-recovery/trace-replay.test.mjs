import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { replayProductionHourTrace } from './trace-replay.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/production-hour-trace.json', import.meta.url), 'utf8'),
);

test('production-hour replay preserves efficacy while cutting runner jobs by at least half', () => {
  const replay = replayProductionHourTrace(fixture);

  assert.equal(replay.baseline.routerRecords, 149);
  assert.equal(replay.baseline.recoveryJobs, 196);
  assert.equal(replay.baseline.recoverySuccess, 191);
  assert.equal(replay.baseline.recoveryFailure, 5);
  assert.equal(replay.baseline.p50Seconds, 15);
  assert.equal(replay.baseline.p95Seconds, 39);

  assert.equal(replay.baseline.effectiveActions.length, 77);
  assert.equal(replay.proposed.effectiveActions.length, 77);
  assert.deepEqual(replay.proposed.effectiveActions, replay.baseline.effectiveActions);
  assert.equal(replay.proposed.cleanupRaceFailures, 0);
  assert.equal(replay.proposed.staleOwnerFailures, 0);
  assert.equal(replay.proposed.staleHeartbeatFailures, 2);
  assert.equal(replay.proposed.recoveryFailure, 2);
  assert.ok(replay.reduction >= 0.5, `expected >=50% reduction, got ${replay.reduction}`);
  assert.ok(
    replay.proposed.p95Seconds <= 60,
    `expected p95 <=60s, got ${replay.proposed.p95Seconds}s`,
  );
});

test('proposed latency follows retained jobs when suppression is interleaved', () => {
  const replay = replayProductionHourTrace({
    routerSeries: [],
    recoverySeries: [
      {
        count: 1,
        kind: 'action',
        effectiveAction: true,
        effectiveActionPrefix: 'first',
        baselineOutcome: 'success',
        latencySeconds: 1,
      },
      {
        count: 1,
        kind: 'recursive',
        effectiveAction: true,
        effectiveActionPrefix: 'suppressed',
        baselineOutcome: 'success',
        suppressedByQueuedAdmission: true,
        alreadyQueued: true,
        latencySeconds: 100,
      },
      {
        count: 1,
        kind: 'action',
        effectiveAction: true,
        effectiveActionPrefix: 'last',
        baselineOutcome: 'success',
        latencySeconds: 2,
      },
    ],
    observed: { recoveryP50Seconds: 0, recoveryP95Seconds: 0 },
    staleOwnerModel: {
      headSha: 'trace-head',
      fingerprint: 'trace-fingerprint',
      attempt: 1,
      progressAt: '2026-07-17T00:00:00.000Z',
      replayedAt: '2026-07-17T00:31:00.000Z',
    },
  });

  assert.equal(replay.proposed.recoveryJobs, 2);
  assert.equal(replay.proposed.p95Seconds, 2);
});
