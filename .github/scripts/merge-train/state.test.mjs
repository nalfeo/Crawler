import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admissionFingerprint,
  candidateFingerprint,
  candidateRef,
  commitTimestamp,
  hasLeadingMarker,
  LANDED_MARKER,
  nextBisectStep,
  parseEnabledFlag,
  parseMergeTrainPrNumber,
  planPrefixPromotion,
  queueEntries,
  renderLandedComment,
  renderStatus,
  resolveAdmissionChecks,
  squashCommitMessage,
  squashCommitTitle,
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

test('rejects whitespace-padded flag values instead of silently trimming them', () => {
  // A value like " true " must not enable the JS reconcilers while YAML
  // (`vars.MERGE_TRAIN_ENABLED == 'true'`) and shell (`[ "$X" = "true" ]`)
  // guards reject it — every layer must agree on the same exact string.
  assert.throws(() => parseEnabledFlag(' true'), /must be true or false/);
  assert.throws(() => parseEnabledFlag('true '), /must be true or false/);
  assert.throws(() => parseEnabledFlag(' true '), /must be true or false/);
  assert.throws(() => parseEnabledFlag('\ttrue\n'), /must be true or false/);
  assert.throws(() => parseEnabledFlag(' false '), /must be true or false/);
});

test('managed state markers must lead the comment instead of appearing in a quote', () => {
  assert.equal(hasLeadingMarker('  <!-- state -->\nbody', '<!-- state -->'), true);
  assert.equal(hasLeadingMarker('> <!-- state -->\nreply', '<!-- state -->'), false);
});

test('parses admission checks and falls back to defaults when empty', () => {
  assert.deepEqual(resolveAdmissionChecks(' ci, extra-check '), ['ci', 'extra-check']);
  assert.deepEqual(resolveAdmissionChecks(''), ['ci', 'Security checks']);
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
  const fingerprint = 'f'.repeat(64);
  const app = { id: 123 };
  assert.equal(trainCheckState([], fingerprint, app.id), 'missing');
  assert.equal(
    trainCheckState(
      [
        {
          id: 1,
          name: 'merge-train-candidate',
          status: 'in_progress',
          external_id: fingerprint,
          app,
        },
      ],
      fingerprint,
      app.id,
    ),
    'pending',
  );
  assert.equal(
    trainCheckState(
      [
        {
          id: 1,
          name: 'merge-train-candidate',
          status: 'completed',
          conclusion: 'failure',
          external_id: fingerprint,
          app,
        },
      ],
      fingerprint,
      app.id,
    ),
    'failure',
  );
  assert.equal(
    trainCheckState(
      [
        {
          id: 1,
          name: 'merge-train-candidate',
          status: 'completed',
          conclusion: 'success',
          external_id: fingerprint,
          app,
        },
      ],
      fingerprint,
      app.id,
    ),
    'success',
  );
  assert.equal(
    trainCheckState(
      [
        {
          id: 2,
          name: 'merge-train-candidate',
          status: 'completed',
          conclusion: 'success',
          external_id: fingerprint,
          app: { id: 999 },
        },
      ],
      fingerprint,
      app.id,
    ),
    'missing',
  );
});

test('train check state treats a stale in_progress candidate check as missing so it is redispatched', () => {
  const fingerprint = 'f'.repeat(64);
  const app = { id: 123 };
  const now = new Date('2024-01-01T01:00:00.000Z');
  const recentlyStarted = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const longStalled = new Date(now.getTime() - 41 * 60 * 1000).toISOString();
  assert.equal(
    trainCheckState(
      [
        {
          id: 1,
          name: 'merge-train-candidate',
          status: 'in_progress',
          external_id: fingerprint,
          started_at: recentlyStarted,
          app,
        },
      ],
      fingerprint,
      app.id,
      now,
    ),
    'pending',
    'a recently-dispatched in_progress check must still be waited on',
  );
  assert.equal(
    trainCheckState(
      [
        {
          id: 1,
          name: 'merge-train-candidate',
          status: 'in_progress',
          external_id: fingerprint,
          started_at: longStalled,
          app,
        },
      ],
      fingerprint,
      app.id,
      now,
    ),
    'missing',
    'an in_progress check stuck past the validation timeout (e.g. the publish job never posted a completed check) must be treated as missing and redispatched',
  );
});

test('train check state treats a cancelled conclusion as missing/retryable instead of a candidate failure', () => {
  const fingerprint = 'f'.repeat(64);
  const app = { id: 123 };
  assert.equal(
    trainCheckState(
      [
        {
          id: 1,
          name: 'merge-train-candidate',
          status: 'completed',
          conclusion: 'cancelled',
          external_id: fingerprint,
          app,
        },
      ],
      fingerprint,
      app.id,
    ),
    'missing',
    'a cancelled conclusion records a dispatch/publish infrastructure failure, not a real candidate validation failure, and must be retried rather than bisected',
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

test('squashCommitTitle collapses newlines and keeps the PR autolink suffix', () => {
  assert.equal(
    squashCommitTitle({ number: 42, title: 'feat: add\r\nthing' }),
    'feat: add thing (#42)',
  );
});

test('squashCommitMessage emits the durable Merge-Train-PR trailer', () => {
  const message = squashCommitMessage({ number: 42, head: { sha: 'a'.repeat(40) } });
  assert.match(message, /^Merge-Train-PR: 42$/m);
  assert.match(message, new RegExp(`^Merge-Train-Original-Head: ${'a'.repeat(40)}$`, 'm'));
});

test('parseMergeTrainPrNumber round-trips the squash trailer', () => {
  const message = squashCommitMessage({ number: 1149, head: { sha: 'b'.repeat(40) } });
  assert.equal(parseMergeTrainPrNumber(message), 1149);
});

test('parseMergeTrainPrNumber returns null when the trailer is absent or malformed', () => {
  assert.equal(parseMergeTrainPrNumber('just a normal commit body'), null);
  assert.equal(parseMergeTrainPrNumber('Merge-Train-PR: not-a-number'), null);
  assert.equal(parseMergeTrainPrNumber(''), null);
  assert.equal(parseMergeTrainPrNumber(null), null);
  // A mid-line mention must not be misread as the mapping.
  assert.equal(parseMergeTrainPrNumber('see Merge-Train-PR: 7 inline'), null);
});

test('renderLandedComment records the real landed commit and validated candidate under the landed marker', () => {
  const body = renderLandedComment({ landedSha: 'c'.repeat(40), candidateSha: 'd'.repeat(40) });
  assert.ok(hasLeadingMarker(body, LANDED_MARKER));
  assert.match(body, new RegExp(`Landed commit: \`${'c'.repeat(40)}\``));
  assert.match(body, new RegExp(`Validated candidate: \`${'d'.repeat(40)}\``));
  assert.match(body, /recorded this PR as \*\*merged\*\*/);
});

test('renderLandedComment recovered variant omits the candidate/tree-proof claim', () => {
  const body = renderLandedComment({
    landedSha: 'c'.repeat(40),
    candidateSha: '',
    recovered: true,
  });
  assert.ok(hasLeadingMarker(body, LANDED_MARKER));
  assert.match(body, new RegExp(`Landed commit: \`${'c'.repeat(40)}\``));
  assert.match(body, /recovered/i);
  // Must NOT claim a validated candidate or a tree proof it did not re-run.
  assert.doesNotMatch(body, /Validated candidate/);
  assert.doesNotMatch(body, /tree was proven/);
  // Must be truthful: cite the durable proof-complete marker as the basis for
  // the merge-time proof claim, and state recovery does not re-run the proof.
  assert.match(body, /proof-complete\s+marker/i);
  assert.match(body, /does not \(and cannot\) re-run/i);
});

test('planPrefixPromotion dispatches every missing prefix in the target range in parallel', () => {
  assert.deepEqual(planPrefixPromotion(['missing', 'missing', 'missing']), {
    action: 'validate',
    prefixes: [0, 1, 2],
    firstFailure: -1,
  });
});

test('planPrefixPromotion waits when a target-range prefix is still pending', () => {
  assert.deepEqual(planPrefixPromotion(['success', 'pending', 'success']), {
    action: 'wait',
    firstFailure: -1,
  });
});

test('planPrefixPromotion promotes the whole batch when every prefix is green', () => {
  assert.deepEqual(planPrefixPromotion(['success', 'success', 'success']), {
    action: 'promote',
    greenPrefixLength: 3,
    firstFailure: -1,
  });
});

test('planPrefixPromotion promotes the green prefix and localizes the earliest failure', () => {
  assert.deepEqual(planPrefixPromotion(['success', 'success', 'failure']), {
    action: 'promote',
    greenPrefixLength: 2,
    firstFailure: 2,
  });
});

test('planPrefixPromotion ignores prefixes at/after the earliest failure (does not validate them)', () => {
  // Prefix 3 is missing but irrelevant because prefix 2 already failed; only the
  // green [0,1) range matters, and it is fully validated -> promote 1, block PR2.
  assert.deepEqual(planPrefixPromotion(['success', 'failure', 'missing']), {
    action: 'promote',
    greenPrefixLength: 1,
    firstFailure: 1,
  });
});

test('planPrefixPromotion validates only the target-range missing prefix before a later failure', () => {
  // firstFailure=2, target=[0,2); prefix index 1 still missing -> validate just it.
  assert.deepEqual(planPrefixPromotion(['success', 'missing', 'failure']), {
    action: 'validate',
    prefixes: [1],
    firstFailure: 2,
  });
});

test('planPrefixPromotion returns noop for an empty batch', () => {
  assert.deepEqual(planPrefixPromotion([]), { action: 'noop' });
});
