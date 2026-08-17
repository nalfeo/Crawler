import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBlockers, normalizePullRequest, summarizeChecks } from '../lib/model.mjs';

test('normalizes PR labels into CI recovery and merge-train state', () => {
  const pr = normalizePullRequest({
    number: 42,
    title: 'Test',
    isDraft: true,
    headRefName: 'feature',
    labels: [{ name: 'ci-recovery-owner:abc' }, { name: 'ci-conflict-order-wait' }],
  });
  assert.equal(pr.number, 42);
  assert.equal(pr.ciRecoveryOwner, 'ci-recovery-owner:abc');
  assert.deepEqual(pr.mergeTrainState, ['ci-conflict-order-wait']);
});

test('summarizes required failing and pending checks', () => {
  const summary = summarizeChecks([
    { name: 'ci', status: 'completed', conclusion: 'failure' },
    { name: 'merge-train', status: 'queued', conclusion: null },
    { name: 'non-required', status: 'completed', conclusion: 'failure' },
  ]);
  assert.equal(summary.failing.length, 2);
  assert.deepEqual(
    summary.requiredFailing.map((check) => check.name),
    ['ci'],
  );
  assert.deepEqual(
    summary.requiredPending.map((check) => check.name),
    ['merge-train'],
  );
});

test('builds deterministic blockers without inventing human review requirements', () => {
  const cockpit = buildBlockers({
    pullRequest: { number: 7, isDraft: true, mergeStateStatus: 'DIRTY', labels: [] },
    checks: [{ name: 'ci', status: 'completed', conclusion: 'action_required' }],
    unresolvedThreads: 2,
  });
  assert.equal(cockpit.mergeReady, false);
  assert.deepEqual(
    cockpit.blockers.map((blocker) => blocker.type),
    ['draft', 'mergeability', 'review-threads', 'required-check'],
  );
  assert.match(cockpit.notes.join('\n'), /No human review is required/);
});
