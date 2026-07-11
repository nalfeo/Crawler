import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateFingerprint,
  candidateRef,
  commitTimestamp,
  normalizeMode,
  queueEntries,
  renderStatus,
  successfulChecks,
  trainCheckState,
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

test('normalizes supported modes and rejects unknown values', () => {
  assert.equal(normalizeMode('LIVE'), 'live');
  assert.equal(normalizeMode(''), 'off');
  assert.throws(() => normalizeMode('unsafe'), /Unsupported/);
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
  assert.equal(candidateRef(2, fingerprint), 'merge-train/candidate-2-aaaaaaaaaaaaaaaa');
  assert.throws(() => candidateRef(3, fingerprint), /slot/);
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
