import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  admissionFingerprint,
  candidateEvidenceId,
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
  assert.equal(
    candidateRef(6, fingerprint),
    'refs/merge-train-candidates/candidate-6-aaaaaaaaaaaaaaaa',
  );
  assert.throws(() => candidateRef(7, fingerprint), /slot/);
});

test('candidate evidence binds the queue fingerprint to the exact materialized commit', () => {
  const fingerprint = 'a'.repeat(64);
  const candidateSha = 'B'.repeat(40);
  const expected = createHash('sha256')
    .update(`${'a'.repeat(64)}:${'b'.repeat(40)}`)
    .digest('hex');
  assert.equal(candidateEvidenceId(fingerprint, candidateSha), expected);
  // Must fit within GitHub's 100-character external_id limit.
  assert.ok(expected.length <= 100);
  assert.throws(() => candidateEvidenceId('short', candidateSha), /fingerprint/);
  assert.throws(() => candidateEvidenceId(fingerprint, 'short'), /commit SHA/);
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

test('admission fingerprints are stable across benign check-run id churn (regression for PR #1557)', () => {
  // PR #1557 was idle/converged with a matching head, both required checks
  // SUCCESS, and 0 unresolved threads -- yet eligible() rejected it as stale
  // purely because a required check's run id changed (a benign re-run, or a
  // brand-new unrelated check-run appearing in the same commit's check-runs
  // set) between the pass that persisted the state comment and the pass that
  // tried to admit it. The digest must depend only on { name, status,
  // conclusion }, never on the ever-incrementing GitHub check-run id.
  const requiredNames = ['ci', 'Security checks'];
  const stored = admissionFingerprint({
    headSha: 'head-1557',
    title: 'fix: unblock things',
    baseRef: 'main',
    requiredNames,
    reviewThreads: [],
    checkRuns: [
      { id: 100, name: 'ci', status: 'completed', conclusion: 'success' },
      { id: 101, name: 'Security checks', status: 'completed', conclusion: 'success' },
    ],
  });
  const live = admissionFingerprint({
    headSha: 'head-1557',
    title: 'fix: unblock things',
    baseRef: 'main',
    requiredNames,
    reviewThreads: [],
    checkRuns: [
      // Same two required checks, same conclusions, but brand-new run ids
      // (as if both re-ran, or GitHub simply reports a new attempt id) --
      // plus an extra, unrelated check-run that appeared in the meantime.
      { id: 9001, name: 'ci', status: 'completed', conclusion: 'success' },
      { id: 9002, name: 'Security checks', status: 'completed', conclusion: 'success' },
      { id: 9003, name: 'codeql', status: 'completed', conclusion: 'neutral' },
    ],
  });
  assert.equal(
    stored,
    live,
    'benign check-run id churn (re-runs, new unrelated check-runs) must not change the fingerprint',
  );
});

test('admission fingerprints still change when a required check conclusion actually flips', () => {
  // The churn-resilience fix must not become a rubber stamp: a real
  // success -> failure regression on a required check must still be
  // detected as a distinct fingerprint so eligible() keeps rejecting it.
  const requiredNames = ['ci'];
  const passing = admissionFingerprint({
    headSha: 'head-1',
    title: 'fix: one',
    baseRef: 'main',
    requiredNames,
    reviewThreads: [],
    checkRuns: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
  });
  const failing = admissionFingerprint({
    headSha: 'head-1',
    title: 'fix: one',
    baseRef: 'main',
    requiredNames,
    reviewThreads: [],
    checkRuns: [{ id: 2, name: 'ci', status: 'completed', conclusion: 'failure' }],
  });
  assert.notEqual(
    passing,
    failing,
    'a real conclusion flip on a required check must still change the fingerprint',
  );
});

test('admission fingerprints ignore resolved review-thread content churn (new replies, edited bodies, ids)', () => {
  // Both callers of admissionFingerprint (eligible() itself, and ci-recovery
  // before it persists a converged state comment) only ever compute the
  // fingerprint once they have already confirmed zero unresolved threads --
  // any unresolved thread is rejected upstream as its own distinct blocker.
  // So two review-thread snapshots with entirely different ids/bodies/authors
  // but the same (zero) unresolved count must be indistinguishable: a new
  // reply on an already-resolved thread carries no admission-relevant signal.
  const base = {
    headSha: 'head-1',
    title: 'fix: one',
    baseRef: 'main',
    requiredNames: ['ci'],
    checkRuns: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
  };
  const firstPass = admissionFingerprint({
    ...base,
    reviewThreads: [
      {
        id: 'thread-a',
        isResolved: true,
        comments: { nodes: [{ id: 'c1', body: 'looks good', author: { login: 'reviewer-a' } }] },
      },
    ],
  });
  const laterPassWithNewReply = admissionFingerprint({
    ...base,
    reviewThreads: [
      {
        id: 'thread-a',
        isResolved: true,
        comments: {
          nodes: [
            { id: 'c1', body: 'looks good', author: { login: 'reviewer-a' } },
            { id: 'c2', body: 'thanks!', author: { login: 'author-b' } },
          ],
        },
      },
    ],
  });
  assert.equal(
    firstPass,
    laterPassWithNewReply,
    'a new reply on an already-resolved thread must not change the fingerprint',
  );

  // A genuinely different resolved-thread SET (different id, different
  // resolved-thread count is unchanged at zero unresolved) must also be
  // indistinguishable -- only the unresolved COUNT is semantically load
  // bearing, not which specific threads happen to be resolved.
  const differentResolvedThreadSet = admissionFingerprint({
    ...base,
    reviewThreads: [
      { id: 'thread-z', isResolved: true, comments: { nodes: [] } },
      { id: 'thread-y', isResolved: true, comments: { nodes: [] } },
    ],
  });
  assert.equal(
    firstPass,
    differentResolvedThreadSet,
    'the specific set/ids of resolved threads must not change the fingerprint, only the unresolved count',
  );
});

test('the eligible() admission gate now admits a converged, green, thread-clean PR whose check-run set churned (end-to-end mirror of PR #1557)', () => {
  // Mirrors eligible()'s literal final gate
  // (`state.headSha !== pr.head.sha || state.fingerprint !== fingerprint`,
  // merge-train/reconcile.mjs) without needing to refactor or invoke that
  // live, network-calling, process.exit()-ing script directly: build the
  // "stored" fingerprint (as ci-recovery would have persisted it on a prior
  // pass) and the "live" fingerprint (as eligible() computes it on this
  // pass) from the same PR #1557-shaped evidence, differing only in benign
  // check-run id churn, and assert the gate's own comparison now evaluates
  // to "not stale".
  const headSha = 'head-1557-live';
  const requiredNames = ['ci', 'Security checks'];
  const reviewThreads = [{ id: 'thread-1', isResolved: true, comments: { nodes: [] } }];
  const storedFingerprint = admissionFingerprint({
    headSha,
    title: 'fix: unblock things',
    baseRef: 'main',
    requiredNames,
    reviewThreads,
    checkRuns: [
      { id: 100, name: 'ci', status: 'completed', conclusion: 'success' },
      { id: 101, name: 'Security checks', status: 'completed', conclusion: 'success' },
    ],
  });
  const liveFingerprint = admissionFingerprint({
    headSha,
    title: 'fix: unblock things',
    baseRef: 'main',
    requiredNames,
    reviewThreads,
    checkRuns: [
      { id: 9001, name: 'ci', status: 'completed', conclusion: 'success' },
      { id: 9002, name: 'Security checks', status: 'completed', conclusion: 'success' },
    ],
  });
  const state = { headSha, fingerprint: storedFingerprint };
  const pr = { head: { sha: headSha } };
  // This is eligible()'s exact boolean gate, inlined:
  const isStale = state.headSha !== pr.head.sha || state.fingerprint !== liveFingerprint;
  assert.equal(
    isStale,
    false,
    'a converged, green, thread-clean PR must not be rejected as stale merely because its required checks were re-run with new ids',
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
  assert.match(body, new RegExp(`Validated batch candidate: \`${'d'.repeat(40)}\``));
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
  assert.match(body, /Recovery status: durable proof revalidated/);
  assert.match(body, /revalidated the durable proof-complete record/i);
  assert.doesNotMatch(body, /single \(linear\) parent/i);
});

test('planPrefixPromotion validates only the maximal prefix first', () => {
  assert.deepEqual(planPrefixPromotion(['missing', 'missing', 'missing']), {
    action: 'validate',
    prefixes: [2],
    firstFailure: -1,
  });
});

test('planPrefixPromotion waits while maximal validation is pending', () => {
  assert.deepEqual(planPrefixPromotion(['missing', 'missing', 'pending']), {
    action: 'wait',
    firstFailure: -1,
  });
});

test('planPrefixPromotion promotes the whole batch from maximal success alone', () => {
  assert.deepEqual(planPrefixPromotion(['missing', 'missing', 'success']), {
    action: 'promote',
    greenPrefixLength: 3,
    firstFailure: -1,
    validationIndex: 2,
  });
});

test('planPrefixPromotion bisects only after a genuine maximal failure', () => {
  assert.deepEqual(planPrefixPromotion(['missing', 'missing', 'failure']), {
    action: 'validate',
    prefixes: [0],
    firstFailure: 2,
  });
});

test('planPrefixPromotion promotes the oldest green prefix after bisection isolates a failure', () => {
  assert.deepEqual(planPrefixPromotion(['success', 'failure', 'failure']), {
    action: 'promote',
    greenPrefixLength: 1,
    firstFailure: 1,
    validationIndex: 0,
  });
});

test('planPrefixPromotion waits on the selected bisection prefix', () => {
  assert.deepEqual(planPrefixPromotion(['pending', 'missing', 'failure']), {
    action: 'wait',
    firstFailure: 2,
  });
});

test('planPrefixPromotion retries cancelled or infrastructure maximal validation', () => {
  assert.deepEqual(planPrefixPromotion(['success', 'failure', 'missing']), {
    action: 'validate',
    prefixes: [2],
    firstFailure: -1,
  });
});

test('planPrefixPromotion returns noop for an empty batch', () => {
  assert.deepEqual(planPrefixPromotion([]), { action: 'noop' });
});
