import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admissionFingerprint,
  candidateFingerprint,
  candidateRef,
  commitTimestamp,
  hasLeadingMarker,
  nextBisectStep,
  parseEnabledFlag,
  queueEntries,
  renderStatus,
  resolveAdmissionChecks,
  successfulChecks,
  trainCheckState,
  unsatisfiedChecks,
} from './state.mjs';

const pr = (number, overrides = {}) => ({
  number,
  state: 'open',
  draft: false,
  title: `fix: pr ${number}`,
  created_at: `2026-07-${String(number).padStart(2, '0')}T00:00:00Z`,
  base: { ref: 'main' },
  head: { sha: `head-${number}`, repo: { full_name: 'nalfeo/Crawler' } },
  labels: [{ name: 'merge-train' }],
  ...overrides,
});

test('parses the single merge-train flag and rejects ambiguous values', () => {
  assert.equal(parseEnabledFlag('true'), true);
  assert.equal(parseEnabledFlag('false'), false);
  assert.equal(parseEnabledFlag(''), false);
  assert.throws(() => parseEnabledFlag('TRUE'), /must be true or false/);
  assert.throws(() => parseEnabledFlag('dry-run'), /must be true or false/);
});

test('managed state markers must lead the comment instead of appearing in a quote', () => {
  assert.equal(hasLeadingMarker('  <!-- state -->\nbody', '<!-- state -->'), true);
  assert.equal(hasLeadingMarker('> <!-- state -->\nreply', '<!-- state -->'), false);
});

test('parses admission checks and falls back to defaults when empty', () => {
  assert.deepEqual(resolveAdmissionChecks(' ci, commit-lint '), ['ci', 'commit-lint']);
  assert.deepEqual(resolveAdmissionChecks(''), ['ci', 'commit-lint', 'Security checks']);
});

test('orders eligible same-repository PRs by creation time', () => {
  const fork = pr(3, { head: { sha: 'fork', repo: { full_name: 'fork/Crawler' } } });
  const draft = pr(4, { draft: true });
  const blocked = pr(5, { labels: [{ name: 'merge-train' }, { name: 'merge-train-blocked' }] });
  assert.deepEqual(
    queueEntries([pr(2), fork, draft, blocked, pr(1)], 'nalfeo/Crawler').map(
      (entry) => entry.number,
    ),
    [1, 2],
  );
});

test('candidate fingerprints bind base, head, title, and order', () => {
  const original = candidateFingerprint('base', [pr(1), pr(2)]);
  assert.equal(original, candidateFingerprint('base', [pr(1), pr(2)]));
  assert.notEqual(original, candidateFingerprint('other', [pr(1), pr(2)]));
  assert.notEqual(original, candidateFingerprint('base', [pr(2), pr(1)]));
  assert.notEqual(original, candidateFingerprint('base', [pr(1, { title: 'fix: edited' }), pr(2)]));
});

test('candidate refs are bounded and immutable by fingerprint', () => {
  const fingerprint = 'a'.repeat(64);
  assert.equal(candidateRef(6, fingerprint), 'merge-train/candidate-6-aaaaaaaaaaaaaaaa');
  assert.throws(() => candidateRef(7, fingerprint), /slot/);
});

test('admission fingerprints bind immutable head evidence without binding main', () => {
  const evidence = {
    headSha: 'head-1',
    title: 'fix: one',
    baseRef: 'main',
    checkRuns: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
    requiredNames: ['ci'],
    reviewThreads: [{ id: 'thread-1', isResolved: true, comments: { nodes: [] } }],
  };
  assert.equal(admissionFingerprint(evidence), admissionFingerprint(evidence));
  assert.notEqual(
    admissionFingerprint(evidence),
    admissionFingerprint({
      ...evidence,
      reviewThreads: [{ id: 'thread-1', isResolved: false, comments: { nodes: [] } }],
    }),
  );
});

test('bisection validates the midpoint then isolates the first failing addition', () => {
  assert.deepEqual(
    nextBisectStep(['missing', 'missing', 'missing', 'missing', 'missing', 'failure']),
    {
      type: 'validate',
      prefixLength: 3,
    },
  );
  assert.deepEqual(
    nextBisectStep(['success', 'success', 'success', 'missing', 'missing', 'failure']),
    {
      type: 'validate',
      prefixLength: 4,
    },
  );
  assert.deepEqual(
    nextBisectStep(['success', 'success', 'success', 'failure', 'missing', 'failure']),
    {
      type: 'isolate',
      greenPrefixLength: 3,
      failingPrefixLength: 4,
    },
  );
});

test('bisection advances from the longest successful prefix when results are non-monotonic', () => {
  assert.deepEqual(nextBisectStep(['failure', 'success', 'missing', 'failure']), {
    type: 'validate',
    prefixLength: 3,
  });
  assert.deepEqual(nextBisectStep(['success', 'failure', 'success', 'failure']), {
    type: 'isolate',
    greenPrefixLength: 3,
    failingPrefixLength: 4,
  });
});

test('commit timestamps are deterministic per PR revision', () => {
  assert.equal(commitTimestamp(pr(1)), commitTimestamp(pr(1)));
  assert.notEqual(commitTimestamp(pr(1)), commitTimestamp(pr(1, { title: 'fix: edited' })));
});

test('required checks use the latest attempt and require success', () => {
  const runs = [
    { id: 1, name: 'ci', status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'ci', status: 'completed', conclusion: 'success' },
    { id: 3, name: 'commit-lint', status: 'completed', conclusion: 'success' },
  ];
  assert.equal(successfulChecks(runs, ['ci', 'commit-lint']), true);
  assert.equal(successfulChecks(runs, ['ci', 'missing']), false);
});

test('unsatisfied checks keep completed non-successful admissions waiting', () => {
  const runs = [
    { id: 1, name: 'ci', status: 'completed', conclusion: 'skipped' },
    { id: 2, name: 'commit-lint', status: 'completed', conclusion: 'success' },
  ];
  assert.deepEqual(unsatisfiedChecks(runs, ['ci', 'commit-lint']), ['ci']);
});

test('train check state distinguishes missing, pending, failed, and successful checks', () => {
  assert.equal(trainCheckState([]), 'missing');
  assert.equal(
    trainCheckState([{ id: 1, name: 'merge-train-candidate', status: 'in_progress' }]),
    'pending',
  );
  assert.equal(
    trainCheckState([
      { id: 1, name: 'merge-train-candidate', status: 'completed', conclusion: 'failure' },
    ]),
    'failure',
  );
  assert.equal(
    trainCheckState([
      { id: 1, name: 'merge-train-candidate', status: 'completed', conclusion: 'success' },
    ]),
    'success',
  );
});

test('status comments carry the stable marker and candidate state', () => {
  const body = renderStatus({
    position: 1,
    candidateSha: 'abc',
    state: 'testing',
    detail: 'validation dispatched',
  });
  assert.match(body, /crawler-merge-train:v1/);
  assert.match(body, /Candidate: `abc`/);
});
