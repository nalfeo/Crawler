import assert from 'node:assert/strict';
import test from 'node:test';

import { whoMustLandFirst } from '../ci-conflict-coordinator/state.mjs';
import { isAdmissible } from '../merge-train/state.mjs';
import {
  PHASE,
  applyLifecycleDecision,
  applyRawLabelDecision,
  evaluatePhase,
  formatLifecycleOutcome,
  formatRawLabelOutcome,
  isNonBlocking,
  makeLifecycleRecord,
  parseLifecycleComment,
  renderLifecycleComment,
} from './pr-lifecycle.mjs';
import { evaluateAdmission } from './state.mjs';

const HEAD = 'a'.repeat(40);

function greenChecks() {
  return [
    { id: 1, name: 'ci', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'Security checks', status: 'completed', conclusion: 'success' },
  ];
}

function substantiveCopilotReviews() {
  return [
    {
      author: { login: 'copilot-pull-request-reviewer[bot]' },
      state: 'COMMENTED',
      body: 'Reviewed the diff; one nit about naming.',
    },
  ];
}

function greenPrFacts(overrides = {}) {
  return {
    prNumber: 1883,
    headSha: HEAD,
    baseRef: 'main',
    state: 'open',
    draft: false,
    mergeable: true,
    hasMergeConflict: false,
    checkRuns: greenChecks(),
    reviewThreads: [],
    reviews: substantiveCopilotReviews(),
    ...overrides,
  };
}

function clusterPull(number, overrides = {}) {
  return {
    number,
    green: true,
    ciFiles: ['.github/workflows/ci.yml'],
    changedFiles: 1,
    additions: 1,
    deletions: 0,
    createdAt: '2026-07-01T00:00:00Z',
    headSha: HEAD,
    ...overrides,
  };
}

test('D11: a quarantined PR is never the cluster leader and is never admissible', () => {
  // The quarantined PR outranks the others on every ordering key (green,
  // most CI files, oldest), so a phase-blind ranker would elect it leader.
  const quarantined = clusterPull(1900, {
    lifecyclePhase: 'quarantined',
    ciFiles: ['.github/workflows/ci.yml', '.github/scripts/a.mjs', '.github/scripts/b.mjs'],
    changedFiles: 9,
    additions: 90,
    createdAt: '2025-01-01T00:00:00Z',
  });
  const cluster = [quarantined, clusterPull(1901), clusterPull(1902)];

  const { leader, order, nonBlocking } = whoMustLandFirst(
    cluster,
    [],
    ['quarantined', 'abandoned'],
  );

  assert.ok(leader, 'a blocking leader must still be selected');
  assert.notEqual(leader.number, 1900, 'a quarantined PR must never be the leader');
  assert.equal(
    order.some((pull) => pull.number === 1900),
    false,
    'a quarantined PR must never appear as an ordering predecessor',
  );
  assert.deepEqual(
    nonBlocking.map((pull) => pull.number),
    [1900],
  );

  const admission = isAdmissible(greenPrFacts({ prNumber: 1900, lifecyclePhase: 'quarantined' }));
  assert.deepEqual(admission, {
    eligible: false,
    reasons: ['lifecycle-phase:quarantined'],
  });
});

test('D11: an abandoned PR is also structurally non-blocking', () => {
  const abandoned = clusterPull(1910, { lifecyclePhase: 'abandoned' });
  const { leader, order } = whoMustLandFirst(
    [abandoned, clusterPull(1911)],
    [],
    ['quarantined', 'abandoned'],
  );
  assert.equal(leader.number, 1911);
  assert.equal(
    order.some((pull) => pull.number === 1910),
    false,
  );
  assert.equal(isNonBlocking(PHASE.ABANDONED), true);
  assert.equal(isNonBlocking(PHASE.QUEUED), false);
});

test('golden fixture #1782/#1861: green leader without merge-train status is admissible and QUEUED', () => {
  const facts = greenPrFacts({ prNumber: 1782 });

  assert.deepEqual(evaluateAdmission(facts), { eligible: true, reasons: [] });

  // No synthetic merge-train status exists yet, and no live cluster names a
  // different leader — so the PR must reach QUEUED rather than being pinned in
  // ORDERING waiting for a status that only a queued PR can ever receive.
  const decision = evaluatePhase(facts, { queued: false }, {});
  assert.equal(decision.phase, PHASE.QUEUED);
  assert.equal(decision.blockReason, null);
});

test('golden fixture #1883: recovered checks with no merge-train label re-admit instead of "train empty"', () => {
  const facts = greenPrFacts();

  assert.equal(evaluateAdmission(facts).eligible, true);

  const decision = evaluatePhase(facts, { queued: false }, {});
  assert.equal(decision.phase, PHASE.QUEUED);
  assert.equal(
    decision.readmit,
    true,
    'an admissible PR that is not enrolled must be re-admitted, not reported as an empty train',
  );
  assert.notEqual(decision.phase, PHASE.REPAIRING);
});

test('golden fixture #1883: waiting with zero blockers and green CI is not a stable phase', () => {
  // status=waiting, owner=none, blockers=[], current head, green required CI.
  const facts = greenPrFacts({ recoveryStatus: 'waiting', recoveryOwner: 'none', blockers: [] });

  assert.deepEqual(evaluateAdmission(facts), { eligible: true, reasons: [] });

  const decision = evaluatePhase(facts, { queued: false }, {});
  assert.equal(decision.phase, PHASE.QUEUED, 'waiting-with-zero-blockers must advance to queued');
});

test('evaluateAdmission reports every blocking reason from current facts only', () => {
  const result = evaluateAdmission({
    state: 'open',
    draft: true,
    mergeable: false,
    checkRuns: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'failure' }],
    reviewThreads: [{ isResolved: false }, { isResolved: true }],
    reviews: [],
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [
    'pr-is-draft',
    'not-mergeable',
    'ci',
    'Security checks',
    'substantive-copilot-review',
    'unresolved-threads:1',
  ]);
});

test('a not-yet-admissible PR evaluates to REPAIRING with the blocking reason', () => {
  const decision = evaluatePhase(
    greenPrFacts({ reviewThreads: [{ isResolved: false }] }),
    { queued: true },
    {},
  );
  assert.equal(decision.phase, PHASE.REPAIRING);
  assert.equal(decision.blockReason, 'unresolved-threads:1');
});

test('an admissible PR behind a cluster leader evaluates to ORDERING', () => {
  const decision = evaluatePhase(
    greenPrFacts({ prNumber: 1902 }),
    { queued: true },
    { members: [clusterPull(1901), clusterPull(1902)] },
  );
  assert.equal(decision.phase, PHASE.ORDERING);
  assert.equal(decision.blockReason, 'ordering-behind:1901');
});

test('acted-vs-no-op: an already-in-phase decision is an explicit no-op', async () => {
  const outcome = await applyLifecycleDecision({
    prNumber: 1883,
    currentPhase: PHASE.QUEUED,
    targetPhase: PHASE.QUEUED,
    headSha: HEAD,
    mode: 'live',
    writeComment: () => assert.fail('a no-op must not write'),
    addLabel: () => assert.fail('a no-op must not write'),
    removeLabel: () => assert.fail('a no-op must not write'),
  });

  assert.deepEqual(outcome, {
    acted: false,
    noOp: true,
    phase: PHASE.QUEUED,
    reason: 'already-in-phase',
  });
  assert.equal(
    formatLifecycleOutcome(1883, outcome),
    'lifecycle no-op: pr=#1883 reason=already-in-phase',
  );
});

test('acted-vs-no-op: a live transition writes and reports acted', async () => {
  const added = [];
  const removed = [];
  const comments = [];
  const outcome = await applyLifecycleDecision({
    prNumber: 1883,
    currentPhase: PHASE.REPAIRING,
    targetPhase: PHASE.QUEUED,
    headSha: HEAD,
    mode: 'live',
    writeComment: (prNumber, body) => comments.push([prNumber, body]),
    addLabel: (prNumber, label) => added.push(label),
    removeLabel: (prNumber, label) => removed.push(label),
    now: new Date('2026-07-24T00:00:00Z'),
  });

  assert.equal(outcome.acted, true);
  assert.equal(outcome.noOp, false);
  assert.deepEqual(added, ['merge-train']);
  assert.deepEqual(removed, ['ci-recovery-waiting']);
  assert.equal(comments.length, 1);
  assert.equal(formatLifecycleOutcome(1883, outcome), 'lifecycle acted: pr=#1883 phase=queued');
});

test('acted-vs-no-op: dry-run never writes and is distinguishable from acted', async () => {
  const outcome = await applyLifecycleDecision({
    prNumber: 1883,
    currentPhase: PHASE.REPAIRING,
    targetPhase: PHASE.QUEUED,
    headSha: HEAD,
    mode: 'dry-run',
    writeComment: () => assert.fail('dry-run must not write'),
    addLabel: () => assert.fail('dry-run must not write'),
    removeLabel: () => assert.fail('dry-run must not write'),
  });

  assert.equal(outcome.acted, false);
  assert.equal(outcome.noOp, false);
  assert.equal(outcome.dryRun, true);
  assert.equal(
    formatLifecycleOutcome(1883, outcome),
    'lifecycle dry-run: pr=#1883 would-transition-to=queued',
  );
});

test('lifecycle comment round-trips through render/parse', () => {
  const record = makeLifecycleRecord({
    prNumber: 1883,
    phase: PHASE.ORDERING,
    blockReason: 'ordering-behind:1901',
    headSha: HEAD,
    updatedAt: '2026-07-24T00:00:00.000Z',
  });
  assert.deepEqual(parseLifecycleComment(renderLifecycleComment(record)), record);
  assert.equal(parseLifecycleComment('no marker here'), null);
});

test('terminal phases: merged PRs are DONE, closed PRs are ABANDONED', () => {
  assert.equal(evaluatePhase(greenPrFacts({ state: 'merged' })).phase, PHASE.DONE);
  assert.equal(evaluatePhase(greenPrFacts({ state: 'closed' })).phase, PHASE.ABANDONED);
});

test('isAdmissible ignores stale enrollment state and answers from live facts (D1)', () => {
  assert.deepEqual(isAdmissible(greenPrFacts()), { eligible: true, reasons: [] });
  assert.deepEqual(isAdmissible(greenPrFacts({ hasMergeConflict: true })), {
    eligible: false,
    reasons: ['merge-conflict'],
  });
});

test('applyRawLabelDecision: no-op when label already in desired state', async () => {
  const calls = [];
  const outcome = await applyRawLabelDecision({
    prNumber: 42,
    label: 'ci-conflict-order-wait',
    desired: true,
    currentlyPresent: true,
    addLabel: () => calls.push('add'),
    removeLabel: () => calls.push('remove'),
  });
  assert.equal(outcome.acted, false);
  assert.equal(outcome.noOp, true);
  assert.equal(outcome.reason, 'already-present');
  assert.deepEqual(calls, []);
});

test('applyRawLabelDecision: adds label when desired=true and not present', async () => {
  const calls = [];
  const outcome = await applyRawLabelDecision({
    prNumber: 42,
    label: 'ci-conflict-order-wait',
    desired: true,
    currentlyPresent: false,
    addLabel: () => calls.push('add'),
    removeLabel: () => calls.push('remove'),
  });
  assert.equal(outcome.acted, true);
  assert.equal(outcome.noOp, false);
  assert.deepEqual(calls, ['add']);
});

test('applyRawLabelDecision: removes label when desired=false and present', async () => {
  const calls = [];
  const outcome = await applyRawLabelDecision({
    prNumber: 42,
    label: 'ci-conflict-order-wait',
    desired: false,
    currentlyPresent: true,
    addLabel: () => calls.push('add'),
    removeLabel: () => calls.push('remove'),
  });
  assert.equal(outcome.acted, true);
  assert.equal(outcome.noOp, false);
  assert.deepEqual(calls, ['remove']);
});

test('formatRawLabelOutcome: no-op and acted variants', () => {
  assert.equal(
    formatRawLabelOutcome(42, { noOp: true, label: 'ci-conflict-order-wait', reason: 'already-present' }),
    'coordinator no-op: pr=#42 label=ci-conflict-order-wait reason=already-present',
  );
  assert.equal(
    formatRawLabelOutcome(42, { noOp: false, label: 'ci-conflict-order-wait' }),
    'coordinator acted: pr=#42 label=ci-conflict-order-wait',
  );
});

test('D11 integration: isAdmissible rejects quarantined phase parsed from lifecycle comment', () => {
  // This validates the full D11 path: a lifecycle comment written by
  // applyLifecycleDecision can be parsed and fed into isAdmissible() to
  // structurally reject a quarantined PR — no label combination needed.
  const record = {
    phase: PHASE.QUARANTINED,
    prNumber: 9000,
    headSha: HEAD,
    baseRef: 'main',
    reason: 'manual-quarantine',
    updatedAt: '2026-07-24T00:00:00Z',
  };
  const commentBody = renderLifecycleComment(record);
  const parsed = parseLifecycleComment(commentBody);
  assert.equal(parsed?.phase, PHASE.QUARANTINED);

  // Now feed the parsed phase into isAdmissible — even a fully green PR must fail.
  const admission = isAdmissible(
    greenPrFacts({ prNumber: 9000, lifecyclePhase: parsed.phase }),
  );
  assert.deepEqual(admission, {
    eligible: false,
    reasons: ['lifecycle-phase:quarantined'],
  });
});

test('D11 integration: isAdmissible passes when no lifecycle comment exists (backwards compat)', () => {
  // Pre-Issue-8 PRs have no lifecycle comment. lifecyclePhase=null must not block.
  const admission = isAdmissible(greenPrFacts({ lifecyclePhase: null }));
  assert.deepEqual(admission, { eligible: true, reasons: [] });
});

test('applyLifecycleDecision: force-push in same phase updates lifecycle comment (issue #5 fix)', async () => {
  // A force-push that stays in the same phase (e.g., QUEUED → QUEUED after rebase)
  // must still update the lifecycle comment so the comment's headSha stays current.
  const comments = [];
  const outcome = await applyLifecycleDecision({
    prNumber: 42,
    currentPhase: PHASE.QUEUED,
    currentHeadSha: 'old-head',
    targetPhase: PHASE.QUEUED,
    headSha: 'new-head-after-force-push',
    mode: 'live',
    writeComment: (_, body) => comments.push(body),
    addLabel: () => {},
    removeLabel: () => {},
  });
  assert.equal(outcome.acted, true);
  assert.equal(outcome.noOp, false);
  assert.equal(comments.length, 1, 'lifecycle comment must be written on force-push');
  assert.ok(String(comments[0]).includes('new-head-after-force-push'), 'comment must contain new headSha');
});

test('applyLifecycleDecision: same phase + same headSha is still a no-op', async () => {
  const outcome = await applyLifecycleDecision({
    prNumber: 42,
    currentPhase: PHASE.QUEUED,
    currentHeadSha: HEAD,
    targetPhase: PHASE.QUEUED,
    headSha: HEAD,
    mode: 'live',
    writeComment: () => assert.fail('must not write'),
    addLabel: () => assert.fail('must not write'),
    removeLabel: () => assert.fail('must not write'),
  });
  assert.equal(outcome.acted, false);
  assert.equal(outcome.noOp, true);
});
