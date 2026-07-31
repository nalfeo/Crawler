import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectUnarmedMergeablePrs,
  isUnarmedWatchdogCandidate,
  UNARMED_WATCHDOG_BLOCKED_LABELS,
} from './unarmed-pr-watchdog.mjs';

function pr(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    draft: false,
    mergeable_state: 'clean',
    auto_merge: null,
    labels: [],
    ...overrides,
  };
}

// ── detectUnarmedMergeablePrs ──────────────────────────────────────────────

test('returns a clean PR with null auto_merge', () => {
  const result = detectUnarmedMergeablePrs([pr()]);
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 42);
});

test('excludes a closed PR', () => {
  const result = detectUnarmedMergeablePrs([pr({ state: 'closed' })]);
  assert.equal(result.length, 0);
});

test('excludes a draft PR', () => {
  const result = detectUnarmedMergeablePrs([pr({ draft: true })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with mergeable_state behind', () => {
  const result = detectUnarmedMergeablePrs([pr({ mergeable_state: 'behind' })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with mergeable_state blocked', () => {
  const result = detectUnarmedMergeablePrs([pr({ mergeable_state: 'blocked' })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with mergeable_state dirty', () => {
  const result = detectUnarmedMergeablePrs([pr({ mergeable_state: 'dirty' })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with mergeable_state unknown', () => {
  const result = detectUnarmedMergeablePrs([pr({ mergeable_state: 'unknown' })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with auto_merge already armed', () => {
  const result = detectUnarmedMergeablePrs([
    pr({ auto_merge: { merge_method: 'squash', commit_title: 'feat: something' } }),
  ]);
  assert.equal(result.length, 0);
});

test('treats auto_merge === undefined as unarmed', () => {
  const { auto_merge: _ignored, ...rest } = pr();
  const result = detectUnarmedMergeablePrs([rest]);
  assert.equal(result.length, 1);
});

test('excludes a PR with merge-train label', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'merge-train' }] })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with human-approval-required label', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'human-approval-required' }] })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with ci-conflict-order-wait label', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'ci-conflict-order-wait' }] })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with ci-conflict-escalation label', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'ci-conflict-escalation' }] })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with ci-lifecycle-quarantined label', () => {
  const result = detectUnarmedMergeablePrs([
    pr({ labels: [{ name: 'ci-lifecycle-quarantined' }] }),
  ]);
  assert.equal(result.length, 0);
});

test('excludes a PR with ci-lifecycle-abandoned label', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'ci-lifecycle-abandoned' }] })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with ci-recovery-opt-out label', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'ci-recovery-opt-out' }] })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with merge-train-blocked label', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'merge-train-blocked' }] })]);
  assert.equal(result.length, 0);
});

test('excludes a PR with merge-train-validation-failed label', () => {
  const result = detectUnarmedMergeablePrs([
    pr({ labels: [{ name: 'merge-train-validation-failed' }] }),
  ]);
  assert.equal(result.length, 0);
});

test('includes a PR whose only label is a non-blocking one', () => {
  const result = detectUnarmedMergeablePrs([pr({ labels: [{ name: 'ci-infra' }] })]);
  assert.equal(result.length, 1);
});

test('filters a mixed list returning only dormant unarmed PRs', () => {
  const pulls = [
    pr({ number: 1 }), // dormant — should be returned
    pr({ number: 2, auto_merge: { merge_method: 'squash' } }), // already armed
    pr({ number: 3, mergeable_state: 'behind' }), // not yet clean
    pr({ number: 4, draft: true }), // draft
    pr({ number: 5, labels: [{ name: 'merge-train' }] }), // in queue
    pr({ number: 6, state: 'closed' }), // closed
    pr({ number: 7 }), // dormant — should be returned
  ];
  const result = detectUnarmedMergeablePrs(pulls);
  assert.deepEqual(
    result.map((p) => p.number),
    [1, 7],
  );
});

test('returns empty array when given an empty list', () => {
  const result = detectUnarmedMergeablePrs([]);
  assert.deepEqual(result, []);
});

// ── UNARMED_WATCHDOG_BLOCKED_LABELS sanity checks ─────────────────────────

test('UNARMED_WATCHDOG_BLOCKED_LABELS contains the expected labels', () => {
  const expected = [
    'merge-train',
    'merge-train-blocked',
    'merge-train-validation-failed',
    'human-approval-required',
    'ci-conflict-order-wait',
    'ci-conflict-escalation',
    'ci-lifecycle-quarantined',
    'ci-lifecycle-abandoned',
    'ci-recovery-opt-out',
  ];
  for (const label of expected) {
    assert.ok(
      UNARMED_WATCHDOG_BLOCKED_LABELS.has(label),
      `Expected ${label} in UNARMED_WATCHDOG_BLOCKED_LABELS`,
    );
  }
});

// ── isUnarmedWatchdogCandidate (list-representation pre-filter) ────────────

test('candidate pre-filter accepts a list-representation PR without mergeable_state', () => {
  // GET /pulls returns the SIMPLE representation: no mergeable_state field.
  const listed = { number: 7, state: 'open', draft: false, auto_merge: null, labels: [] };
  assert.equal(isUnarmedWatchdogCandidate(listed), true);
  // ...and the detector must reject it until it is hydrated via pulls.get.
  assert.deepEqual(detectUnarmedMergeablePrs([listed]), []);
  assert.equal(detectUnarmedMergeablePrs([{ ...listed, mergeable_state: 'clean' }]).length, 1);
});

test('candidate pre-filter excludes draft, closed, armed and blocked-label PRs', () => {
  assert.equal(isUnarmedWatchdogCandidate({ state: 'open', draft: true }), false);
  assert.equal(isUnarmedWatchdogCandidate({ state: 'closed', draft: false }), false);
  assert.equal(
    isUnarmedWatchdogCandidate({ state: 'open', auto_merge: { merge_method: 'squash' } }),
    false,
  );
  assert.equal(
    isUnarmedWatchdogCandidate({
      state: 'open',
      auto_merge: null,
      labels: [{ name: 'merge-train' }],
    }),
    false,
  );
  assert.equal(isUnarmedWatchdogCandidate(null), false);
});

// ── ci-recovery-waiting design decision ───────────────────────────────────
// PRs in WAIT_ADMISSION carry the `ci-recovery-waiting` label.  The label is
// intentionally NOT in UNARMED_WATCHDOG_BLOCKED_LABELS: a PR may become stale
// in WAIT_ADMISSION (e.g. the push/check event that should have re-armed
// auto-merge was dropped).  The watchdog dispatching for such a PR provides the
// durable backstop that the post-update-branch one-shot dispatch cannot
// guarantee.

test('ci-recovery-waiting is NOT in UNARMED_WATCHDOG_BLOCKED_LABELS', () => {
  assert.equal(
    UNARMED_WATCHDOG_BLOCKED_LABELS.has('ci-recovery-waiting'),
    false,
    'ci-recovery-waiting must stay visible to the watchdog so stale WAIT_ADMISSION PRs are rescued',
  );
});

test('detectUnarmedMergeablePrs includes a PR labelled ci-recovery-waiting', () => {
  const result = detectUnarmedMergeablePrs([
    pr({ labels: [{ name: 'ci-recovery-waiting' }] }),
  ]);
  assert.equal(result.length, 1, 'stale WAIT_ADMISSION PR must be detected as dormant-unarmed');
});

test('candidate pre-filter accepts a PR labelled ci-recovery-waiting', () => {
  assert.equal(
    isUnarmedWatchdogCandidate({ state: 'open', draft: false, auto_merge: null, labels: [{ name: 'ci-recovery-waiting' }] }),
    true,
    'ci-recovery-waiting must not prevent pre-filter pass-through',
  );
});
