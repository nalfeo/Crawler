import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCandidate,
  buildDispatchBindings,
  buildGatedDispatchRecovery,
  deleteCandidateBundle,
  dispatchRecoveryWorkflow,
  dispatchValidationWorkflow,
  EMPTY_TRAIN_LIVENESS_THRESHOLD_MS,
  evaluateStalledQueue,
  evaluateUnadvanceableStrike,
  isDisabledTrainScheduleRun,
  isMergeTrainConflictError,
  isMergeTrainNoopError,
  mainAttributionVerdict,
  mergeTrainGitEnvironment,
  parseStalledQueuePasses,
  parseUnadvanceableStrike,
  promoteValidatedPrefixAfterBuildFailure,
  promotionStaleReason,
  queuePositionAfterRecovery,
  renderStalledQueuePasses,
  renderUnadvanceableStrike,
  resolveMergeTrainTokens,
  runTrainBuildLoop,
  stalledAdmissionEligiblePulls,
  STALLED_QUEUE_PASS_THRESHOLD,
  trainCheckTitle,
  UNADVANCEABLE_ATTEMPT_CEILING,
  UNADVANCEABLE_STRIKE_THRESHOLD,
} from './reconcile-lib.mjs';
import { planAttributedPrefixPromotion, planPrefixPromotion } from './state.mjs';

const baseSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const transportSha = 'c'.repeat(40);
const prSha = '1'.repeat(40);

function makePr(overrides = {}) {
  return {
    number: 42,
    title: 'feat: exact merge train',
    state: 'open',
    draft: false,
    labels: [{ name: 'merge-train' }],
    base: { ref: 'main' },
    head: {
      sha: prSha,
      ref: 'feature/exact-train',
      repo: { full_name: 'nalfeo/Crawler' },
    },
    ...overrides,
  };
}

function createGitStub({
  fetchedSha = prSha,
  parentSha = baseSha,
  failPush = false,
  failMerge = false,
  mergeConflict = false,
  failDirectShaFetch = false,
  noSquashChanges = false,
}) {
  const calls = [];
  const refs = new Map();
  const git = (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'fetch') {
      const spec = args[2];
      if (failDirectShaFetch && spec.startsWith(`${prSha}:`)) {
        throw new Error('direct sha fetch unavailable');
      }
      const [, dest] = spec.split(':');
      if (dest)
        refs.set(
          dest,
          /^[0-9a-f]{40}$/i.test(spec.split(':')[0]) ? spec.split(':')[0] : fetchedSha,
        );
      return '';
    }
    if (args[0] === 'merge' && failMerge) throw new Error('merge failed');
    if (args[0] === 'ls-files' && args[1] === '--unmerged') {
      return mergeConflict ? '100644 abcdef 1\tconflicted.ts' : '';
    }
    if (args[0] === 'push' && failPush) throw new Error('lease rejected');
    if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
      if (noSquashChanges) return '';
      throw new Error('staged diff present');
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return candidateSha;
    if (args[0] === 'rev-parse' && args[1] === `${candidateSha}^`) return parentSha;
    if (args[0] === 'rev-parse') return refs.get(args[1]) || fetchedSha;
    if (args[0] === 'hash-object') return transportSha;
    if (args[0] === 'update-ref') {
      refs.set(args[1], args[2]);
      return '';
    }
    return '';
  };
  return { git, calls };
}

test('buildCandidate fetches the API-observed head SHA instead of refs/pull/<n>/head', () => {
  const entry = makePr();
  const { git, calls } = createGitStub({});
  const sha = buildCandidate({
    baseSha,
    entries: [entry],
    refName: 'merge-train/candidate-1',
    git,
    live: false,
  });
  assert.equal(sha, candidateSha);
  const fetchCall = calls.find(
    (call) => call.args[0] === 'fetch' && call.args[2].includes('refs/remotes/merge-train/pr-42'),
  );
  assert.ok(fetchCall);
  assert.match(fetchCall.args[2], new RegExp(`^${prSha}:refs/remotes/merge-train/pr-42$`));
});

test('buildCandidate treats exact-SHA mismatches as retryable operational failures', () => {
  const entry = makePr();
  const git = (args) => {
    if (args[0] === 'fetch' || args[0] === 'checkout' || args[0] === 'commit') return '';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return candidateSha;
    if (args[0] === 'rev-parse') return '2'.repeat(40);
    return '';
  };
  assert.throws(
    () =>
      buildCandidate({
        baseSha,
        entries: [entry],
        refName: 'merge-train/candidate-1',
        git,
        live: false,
      }),
    (error) => {
      assert.equal(isMergeTrainConflictError(error), false);
      assert.match(error.message, /head changed while building candidate/);
      return true;
    },
  );
});

test('deleteCandidateBundle removes only the exact terminal transport ref', () => {
  const refName = 'refs/merge-train-candidates/candidate-1-deadbeef';
  const transportSha = 'a'.repeat(40);
  const calls = [];
  const deleted = deleteCandidateBundle({
    refName,
    transportSha,
    git: (args) => {
      calls.push(args);
      if (args[0] === 'ls-remote') return `${transportSha}\t${refName}`;
      return '';
    },
  });
  assert.equal(deleted, true);
  assert.deepEqual(calls[1], [
    'push',
    `--force-with-lease=${refName}:${transportSha}`,
    'origin',
    `:${refName}`,
  ]);
});

test('deleteCandidateBundle is idempotent and rejects ref drift', () => {
  const refName = 'refs/merge-train-candidates/candidate-1-deadbeef';
  const transportSha = 'a'.repeat(40);
  assert.equal(
    deleteCandidateBundle({
      refName,
      transportSha,
      git: () => '',
    }),
    false,
  );
  assert.throws(
    () =>
      deleteCandidateBundle({
        refName,
        transportSha,
        git: () => `${'b'.repeat(40)}\t${refName}`,
      }),
    /changed before cleanup/,
  );
});

test('stalledAdmissionEligiblePulls triggers only when admitted PRs are stale past the threshold', () => {
  const now = new Date('2026-07-27T16:00:00Z');
  const pulls = [
    { number: 11, created_at: '2026-07-27T14:30:00Z', updated_at: '2026-07-27T14:30:00Z' }, // stale
    { number: 12, created_at: '2026-07-27T15:40:00Z', updated_at: '2026-07-27T15:40:00Z' }, // fresh
    { number: 13, created_at: '2026-07-27T14:20:00Z', updated_at: '2026-07-27T14:20:00Z' }, // stale but not admitted
  ];
  const admissionByNumber = new Map([
    [11, true],
    [12, true],
    [13, false],
  ]);

  const stalled = stalledAdmissionEligiblePulls({
    pulls,
    admissionByNumber,
    now,
    thresholdMs: EMPTY_TRAIN_LIVENESS_THRESHOLD_MS,
  });

  assert.deepEqual(
    stalled.map((pull) => pull.number),
    [11],
  );
});

test('stalledAdmissionEligiblePulls keys liveness to updated_at when present', () => {
  const now = new Date('2026-07-27T16:00:00Z');
  const pulls = [
    // Old PR, but recently updated when it became admission-eligible.
    { number: 31, created_at: '2026-07-26T09:00:00Z', updated_at: '2026-07-27T15:45:00Z' },
    { number: 32, created_at: '2026-07-26T09:00:00Z', updated_at: '2026-07-27T14:00:00Z' },
  ];
  const admissionByNumber = new Map([
    [31, true],
    [32, true],
  ]);
  const stalled = stalledAdmissionEligiblePulls({
    pulls,
    admissionByNumber,
    now,
    thresholdMs: EMPTY_TRAIN_LIVENESS_THRESHOLD_MS,
  });
  assert.deepEqual(
    stalled.map((pull) => pull.number),
    [32],
  );
});

test('stalledAdmissionEligiblePulls ignores queued entries and keeps deterministic ordering', () => {
  const now = new Date('2026-07-27T16:00:00Z');
  const pulls = [
    { number: 21, created_at: '2026-07-27T13:00:00Z' },
    { number: 19, created_at: '2026-07-27T12:00:00Z' },
    { number: 20, created_at: '2026-07-27T12:00:00Z' },
  ];
  const admissionByNumber = new Map([
    [19, true],
    [20, true],
    [21, true],
  ]);
  const queuedNumbers = new Set([21]);

  const stalled = stalledAdmissionEligiblePulls({
    pulls,
    queuedNumbers,
    admissionByNumber,
    now,
  });

  assert.deepEqual(
    stalled.map((pull) => pull.number),
    [19, 20],
  );
});

test('non-Actions runs fail before mutation when only the non-dispatching App token is present', () => {
  assert.throws(
    () =>
      resolveMergeTrainTokens({
        GITHUB_ACTIONS: 'false',
        MERGE_TRAIN_TOKEN: 'app-token',
      }),
    /requires GITHUB_TOKEN for workflow dispatch/,
  );
});

test('buildCandidate falls back to the branch ref when the direct SHA fetch is unavailable', () => {
  const entry = makePr();
  const { git, calls } = createGitStub({ failDirectShaFetch: true });
  const sha = buildCandidate({
    baseSha,
    entries: [entry],
    refName: 'merge-train/candidate-1',
    git,
    live: false,
  });
  assert.equal(sha, candidateSha);
  assert.ok(
    calls.some(
      (call) =>
        call.args[0] === 'fetch' &&
        call.args[2] === `refs/heads/${entry.head.ref}:refs/remotes/merge-train/pr-${entry.number}`,
    ),
  );
});

test('buildCandidate rejects a fallback ref that no longer matches the API head SHA', () => {
  const entry = makePr();
  const { git } = createGitStub({ failDirectShaFetch: true, fetchedSha: '2'.repeat(40) });
  assert.throws(
    () =>
      buildCandidate({
        baseSha,
        entries: [entry],
        refName: 'merge-train/candidate-1',
        git,
        live: false,
      }),
    (error) => {
      assert.equal(isMergeTrainConflictError(error), false);
      assert.match(error.message, /head changed while building candidate/);
      return true;
    },
  );
});

test('buildCandidate classifies squash conflicts separately from retryable failures', () => {
  const entry = makePr();
  const { git } = createGitStub({ failMerge: true, mergeConflict: true });
  assert.throws(
    () =>
      buildCandidate({
        baseSha,
        entries: [entry],
        refName: 'merge-train/candidate-1',
        git,
        live: false,
      }),
    (error) => {
      assert.equal(isMergeTrainConflictError(error), true);
      assert.match(error.message, /conflicts in the cumulative candidate/);
      return true;
    },
  );
});

test('buildCandidate auto-resolves INDEX.md-only conflicts and continues', () => {
  // INDEX.md must never appear on PR branches, but if it does the merge-train
  // should auto-resolve rather than serializing the queue (issue #1856).
  const entry = makePr();
  const calls = [];
  const refs = new Map();
  const git = (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'fetch') {
      const [, dest] = (args[2] || '').split(':');
      if (dest) refs.set(dest, prSha);
      return '';
    }
    if (args[0] === 'merge') throw new Error('merge failed');
    if (args[0] === 'ls-files' && args[1] === '--unmerged') {
      // Return INDEX.md only — three stages but same file path.
      return [
        '100644 aaa 1\tdocs/knowledge/handoffs/INDEX.md',
        '100644 bbb 2\tdocs/knowledge/handoffs/INDEX.md',
        '100644 ccc 3\tdocs/knowledge/handoffs/INDEX.md',
      ].join('\n');
    }
    if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
      throw new Error('staged diff present');
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return candidateSha;
    if (args[0] === 'rev-parse') return refs.get(args[1]) || prSha;
    return '';
  };

  const sha = buildCandidate({
    baseSha,
    entries: [entry],
    refName: 'merge-train/candidate-1',
    git,
    live: false,
  });

  assert.equal(sha, candidateSha);
  // reset --hard must NOT have been called — we resolved in-place.
  assert.ok(
    !calls.some((c) => c.args[0] === 'reset' && c.args[1] === '--hard'),
    'reset --hard should not be called on INDEX.md-only conflict',
  );
  // checkout HEAD -- INDEX.md should have been called to resolve.
  assert.ok(
    calls.some(
      (c) =>
        c.args[0] === 'checkout' &&
        c.args[1] === 'HEAD' &&
        c.args[2] === '--' &&
        c.args[3] === 'docs/knowledge/handoffs/INDEX.md',
    ),
    'expected checkout HEAD -- INDEX.md to resolve the conflict',
  );
  // git add --all must follow to pick up any newly-added files from the PR
  // that a squash-merge leaves untracked rather than staged (critical: without
  // this, added files would be silently dropped from the candidate commit).
  assert.ok(
    calls.some((c) => c.args[0] === 'add' && c.args[1] === '--all'),
    'expected git add --all to stage newly-added files from the PR',
  );
});

test('buildCandidate still throws MergeTrainConflictError when INDEX.md conflicts alongside real files', () => {
  const entry = makePr();
  const refs = new Map();
  const git = (args) => {
    if (args[0] === 'fetch') {
      const spec = args[2] || '';
      const [, dest] = spec.split(':');
      if (dest) refs.set(dest, prSha);
      return '';
    }
    if (args[0] === 'checkout' && args[1] === '--detach') return '';
    if (args[0] === 'rev-parse') return refs.get(args[1]) || prSha;
    if (args[0] === 'merge') throw new Error('merge failed');
    if (args[0] === 'ls-files' && args[1] === '--unmerged') {
      // Both INDEX.md and a real source file conflict.
      return [
        '100644 aaa 1\tdocs/knowledge/handoffs/INDEX.md',
        '100644 bbb 2\tsrc/core/foo.ts',
      ].join('\n');
    }
    if (args[0] === 'reset') return '';
    return '';
  };

  assert.throws(
    () =>
      buildCandidate({
        baseSha,
        entries: [entry],
        refName: 'merge-train/candidate-1',
        git,
        live: false,
      }),
    (error) => {
      assert.equal(isMergeTrainConflictError(error), true);
      assert.match(error.message, /conflicts in the cumulative candidate/);
      return true;
    },
  );
});

test('buildCandidate supplies deterministic Git identity to squash merge', () => {
  const { git, calls } = createGitStub({});
  buildCandidate({
    baseSha,
    entries: [makePr()],
    refName: 'merge-train/candidate-1',
    git,
    live: false,
  });
  const mergeCall = calls.find((call) => call.args[0] === 'merge');
  assert.deepEqual(mergeCall.options.env, {
    GIT_AUTHOR_NAME: 'crawler-merge-train[bot]',
    GIT_AUTHOR_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'crawler-merge-train[bot]',
    GIT_COMMITTER_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
  });
});

test('buildCandidate leaves non-conflict merge failures retryable', () => {
  const { git } = createGitStub({ failMerge: true });
  assert.throws(
    () =>
      buildCandidate({
        baseSha,
        entries: [makePr()],
        refName: 'merge-train/candidate-1',
        git,
        live: false,
      }),
    (error) => {
      assert.equal(isMergeTrainConflictError(error), false);
      assert.match(error.message, /candidate merge failed operationally/);
      return true;
    },
  );
});

test('live candidates use a non-event custom ref with the checkout App credential', () => {
  const { git, calls } = createGitStub({});
  buildCandidate({
    baseSha,
    entries: [makePr()],
    refName: 'refs/merge-train-candidates/candidate-ordinary',
    git,
    live: true,
  });

  const pushCall = calls.find((call) => call.args[0] === 'push');
  assert.deepEqual(pushCall.args, [
    'push',
    '--force',
    'origin',
    'refs/merge-train-candidates/candidate-ordinary:' +
      'refs/merge-train-candidates/candidate-ordinary',
  ]);
  assert.deepEqual(pushCall.options, {});
  assert.ok(calls.some((call) => call.args[0] === 'bundle' && call.args[1] === 'create'));
  assert.ok(calls.some((call) => call.args[0] === 'hash-object'));
});

test('live candidates reject event-emitting refs before Git mutation', () => {
  const { git, calls } = createGitStub({});
  for (const refName of [
    'refs/heads/merge-train/candidate-workflow',
    'refs/tags/merge-train-candidate-workflow',
  ]) {
    assert.throws(
      () =>
        buildCandidate({
          baseSha,
          entries: [makePr()],
          refName,
          git,
          live: true,
        }),
      /non-event ref namespace/,
    );
  }
  assert.equal(calls.length, 0);
});

test('custom-ref push failures remain credential-safe retryable failures', () => {
  const { git, calls } = createGitStub({ failPush: true });
  assert.throws(
    () =>
      buildCandidate({
        baseSha,
        entries: [makePr()],
        refName: 'refs/merge-train-candidates/candidate-workflow',
        git,
        live: true,
      }),
    (error) => {
      assert.equal(isMergeTrainConflictError(error), false);
      assert.equal(isMergeTrainNoopError(error), false);
      return true;
    },
  );
  const pushCall = calls.find((call) => call.args[0] === 'push');
  assert.deepEqual(pushCall.options, {});
});

test('raw workflow credentials are stripped from every Git child environment', () => {
  assert.deepEqual(
    mergeTrainGitEnvironment(
      {
        PATH: '/usr/bin',
        MERGE_TRAIN_WORKFLOW_TOKEN: 'owner-workflow-token',
      },
      {
        GIT_CONFIG_COUNT: '1',
      },
    ),
    {
      PATH: '/usr/bin',
      GIT_CONFIG_COUNT: '1',
    },
  );
});

test('later build failure promotes the highest successful cumulative prefix in order', async () => {
  const train = [1, 2, 3, 4].map((number) => makePr({ number }));
  const candidates = [
    { state: 'missing', entries: train.slice(0, 1) },
    { state: 'success', entries: train.slice(0, 2) },
    { state: 'pending', entries: train.slice(0, 3) },
  ];
  const promotedEntries = [];
  const result = await promoteValidatedPrefixAfterBuildFailure({
    candidates,
    promotePrefix: async (prefixLength, validationIndex) => {
      assert.equal(validationIndex, 1);
      promotedEntries.push(...train.slice(0, prefixLength).map((entry) => entry.number));
      return true;
    },
  });

  assert.deepEqual(promotedEntries, [1, 2]);
  assert.deepEqual(result, {
    greenPrefixLength: 2,
    landedCount: 2,
    validationIndex: 1,
    promotionAttempted: true,
    promoted: true,
  });
  assert.deepEqual(
    train.slice(result.greenPrefixLength).map((entry) => entry.number),
    [3, 4],
  );
});

test('build failure before any successful prefix does not attempt promotion', async () => {
  let promotionCalls = 0;
  const result = await promoteValidatedPrefixAfterBuildFailure({
    candidates: [{ state: 'missing' }, { state: 'pending' }],
    promotePrefix: async () => {
      promotionCalls += 1;
      return true;
    },
  });

  assert.equal(promotionCalls, 0);
  assert.deepEqual(result, {
    greenPrefixLength: 0,
    validationIndex: -1,
    promotionAttempted: false,
    promoted: false,
  });
});

test('build failure recovery never promotes later unvalidated candidates', async () => {
  const calls = [];
  const result = await promoteValidatedPrefixAfterBuildFailure({
    candidates: [{ state: 'success' }, { state: 'failure' }, { state: 'pending' }],
    promotePrefix: async (...args) => {
      calls.push(args);
      return true;
    },
  });

  assert.deepEqual(calls, [[1, 0]]);
  assert.equal(result.greenPrefixLength, 1);
});

// Orchestration-level regression: these tests exercise the runTrainBuildLoop
// controller that was changed in the production bug fix. Calling the lib helper
// (promoteValidatedPrefixAfterBuildFailure) in isolation would leave these bugs
// undetected — this seam catches the missing transition.

test('runTrainBuildLoop promotes validated prefix when a later build entry fails with a retryable error', async () => {
  const train = [1, 2, 3].map((number) => makePr({ number }));
  const builtCandidates = [];
  const promotionCalls = [];

  const result = await runTrainBuildLoop({
    train,
    candidates: builtCandidates,
    buildEntry: async (index) => {
      if (index === 0) {
        return { candidateSha: 'sha-0', state: 'success', entries: train.slice(0, 1) };
      }
      // index >= 1: retryable failure (not a conflict, not a noop)
      throw new Error('transient git failure');
    },
    promotePrefix: async (prefixLength, validationIndex) => {
      promotionCalls.push({ prefixLength, validationIndex });
      return true;
    },
  });

  assert.equal(result.action, 'retryable-build-failure');
  assert.equal(result.entry.number, 2); // PR #2 is the failing entry (index 1)
  assert.equal(result.recovery.greenPrefixLength, 1);
  assert.equal(result.recovery.promoted, true);
  assert.deepEqual(promotionCalls, [{ prefixLength: 1, validationIndex: 0 }]);
  // Only the first candidate was accumulated; later entries were never reached.
  assert.equal(builtCandidates.length, 1);
});

test('runTrainBuildLoop does not attempt promotion when no candidate succeeded before the retryable failure', async () => {
  const train = [1, 2].map((number) => makePr({ number }));
  const builtCandidates = [];
  let promotionCalled = false;

  const result = await runTrainBuildLoop({
    train,
    candidates: builtCandidates,
    buildEntry: async (_index) => {
      throw new Error('immediate retryable failure');
    },
    promotePrefix: async () => {
      promotionCalled = true;
      return true;
    },
  });

  assert.equal(result.action, 'retryable-build-failure');
  assert.equal(result.recovery.promotionAttempted, false);
  assert.equal(promotionCalled, false);
  assert.equal(builtCandidates.length, 0);
});

test('candidate custom-ref push rejection remains a retryable build failure', async () => {
  const { git } = createGitStub({ failPush: true });
  const result = await runTrainBuildLoop({
    train: [makePr()],
    candidates: [],
    buildEntry: async () => ({
      candidateSha: buildCandidate({
        baseSha,
        entries: [makePr()],
        refName: 'refs/merge-train-candidates/candidate-workflow',
        git,
        live: true,
      }),
    }),
    promotePrefix: async () => true,
  });

  assert.equal(result.action, 'retryable-build-failure');
  assert.match(result.error.message, /lease rejected/);
  assert.equal(result.recovery.promotionAttempted, false);
});

test('runTrainBuildLoop does not invoke buildEntry for entries beyond the retryable failure', async () => {
  const train = [1, 2, 3].map((number) => makePr({ number }));
  const builtCandidates = [];
  const invoked = [];

  const result = await runTrainBuildLoop({
    train,
    candidates: builtCandidates,
    buildEntry: async (index) => {
      invoked.push(train[index].number);
      if (index === 1) throw new Error('retryable on #2');
      return { candidateSha: `sha-${index}`, state: 'pending', entries: train.slice(0, index + 1) };
    },
    promotePrefix: async () => true,
  });

  assert.equal(result.action, 'retryable-build-failure');
  // Entries 0 (#1) and 1 (#2) were attempted; entry 2 (#3) was never started.
  assert.deepEqual(invoked, [1, 2]);
  assert.equal(builtCandidates.length, 1); // only index 0 succeeded and was accumulated
});

test('runTrainBuildLoop does not reclassify post-build finalization errors as build retries', async () => {
  let promotionCalled = false;
  await assert.rejects(
    runTrainBuildLoop({
      train: [makePr({ number: 1 })],
      candidates: [],
      buildEntry: async () => ({ candidateSha: 'sha-0' }),
      finalizeEntry: async () => {
        throw new Error('validation read failed');
      },
      promotePrefix: async () => {
        promotionCalled = true;
        return true;
      },
    }),
    /validation read failed/,
  );
  assert.equal(promotionCalled, false);
});

test('runTrainBuildLoop promotes prefix even if status reporting rejects', async () => {
  const train = [1, 2].map((number) => makePr({ number }));
  const builtCandidates = [];
  let promotionCalled = false;

  await assert.rejects(
    runTrainBuildLoop({
      train,
      candidates: builtCandidates,
      buildEntry: async (index) => {
        if (index === 0) {
          return { candidateSha: 'sha-0', state: 'success', entries: train.slice(0, 1) };
        }
        throw new Error('transient git failure');
      },
      onRetryableFailure: async () => {
        throw new Error('reporting failure');
      },
      promotePrefix: async () => {
        promotionCalled = true;
        return true;
      },
    }),
    /reporting failure/,
  );

  assert.equal(promotionCalled, true);
});

test('runTrainBuildLoop passes recovery to onRetryableFailure so the failing PR position reflects the post-promotion queue', async () => {
  const train = [1, 2].map((number) => makePr({ number }));
  const builtCandidates = [];
  let capturedPosition;

  await runTrainBuildLoop({
    train,
    candidates: builtCandidates,
    buildEntry: async (index) => {
      if (index === 0) {
        return { candidateSha: 'sha-0', state: 'success', entries: train.slice(0, 1) };
      }
      throw new Error('transient git failure');
    },
    onRetryableFailure: async (_index, _error, recovery) => {
      capturedPosition = queuePositionAfterRecovery(_index, recovery);
    },
    promotePrefix: async () => true,
  });

  // PR #2 was at original index 1 (position 2), but PR #1 was promoted (greenPrefixLength=1).
  // Its new queue position is 2 - 1 = 1.
  assert.equal(capturedPosition, 1);
});

test('runTrainBuildLoop preserves the failing PR position when validated-prefix promotion aborts', async () => {
  const train = [1, 2].map((number) => makePr({ number }));
  const builtCandidates = [];
  let capturedRecovery;
  let capturedPosition;

  await runTrainBuildLoop({
    train,
    candidates: builtCandidates,
    buildEntry: async (index) => {
      if (index === 0) {
        return { candidateSha: 'sha-0', state: 'success', entries: train.slice(0, 1) };
      }
      throw new Error('transient git failure');
    },
    onRetryableFailure: async (index, _error, recovery) => {
      capturedRecovery = recovery;
      capturedPosition = queuePositionAfterRecovery(index, recovery);
    },
    promotePrefix: async () => false,
  });

  assert.equal(capturedRecovery.promotionAttempted, true);
  assert.equal(capturedRecovery.promoted, false);
  assert.equal(capturedRecovery.landedCount, 0);
  assert.equal(capturedPosition, 2);
});

test('runTrainBuildLoop subtracts only the proven landed count after partial promotion', async () => {
  const train = [1, 2, 3].map((number) => makePr({ number }));
  const builtCandidates = [];
  let capturedRecovery;
  let capturedPosition;

  await runTrainBuildLoop({
    train,
    candidates: builtCandidates,
    buildEntry: async (index) => {
      if (index < 2) {
        return {
          candidateSha: `sha-${index}`,
          state: 'success',
          entries: train.slice(0, index + 1),
        };
      }
      throw new Error('transient git failure');
    },
    onRetryableFailure: async (index, _error, recovery) => {
      capturedRecovery = recovery;
      capturedPosition = queuePositionAfterRecovery(index, recovery);
    },
    promotePrefix: async () => ({ promoted: false, landedCount: 1 }),
  });

  assert.equal(capturedRecovery.greenPrefixLength, 2);
  assert.equal(capturedRecovery.promoted, false);
  assert.equal(capturedRecovery.landedCount, 1);
  assert.equal(capturedPosition, 2);
});

test('live Actions runs require separate promotion and workflow-dispatch tokens', () => {
  assert.deepEqual(
    resolveMergeTrainTokens({
      GITHUB_ACTIONS: 'true',
      MERGE_TRAIN_TOKEN: 'app-token',
      GITHUB_TOKEN: 'actions-token',
    }),
    {
      promotionToken: 'app-token',
      workflowDispatchToken: 'actions-token',
      updateBranchToken: 'actions-token',
    },
  );
  assert.throws(
    () =>
      resolveMergeTrainTokens({
        GITHUB_ACTIONS: 'true',
        MERGE_TRAIN_TOKEN: 'app-token',
      }),
    /requires GITHUB_TOKEN for workflow dispatch/,
  );
  assert.throws(
    () =>
      resolveMergeTrainTokens({
        GITHUB_ACTIONS: 'true',
        GITHUB_TOKEN: 'actions-token',
      }),
    /requires MERGE_TRAIN_TOKEN for promotion/,
  );
});

test('workflow dispatch helpers use the Actions token for recovery and validation', async () => {
  const calls = [];
  const request = async (token, path, options) => {
    calls.push({ token, path, options });
  };
  await dispatchRecoveryWorkflow({
    request,
    token: 'actions-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    prNumber: 42,
    trigger: 'merge-train-validation-failure',
  });
  await dispatchValidationWorkflow({
    request,
    token: 'actions-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    sha: candidateSha,
    refName: 'refs/merge-train-candidates/candidate-1',
    attestationSha: baseSha,
    fingerprint: 'fingerprint',
    entries: [makePr()],
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.token === 'actions-token'));
  assert.match(calls[0].path, /ci-recovery\.yml\/dispatches$/);
  assert.match(calls[1].path, /merge-train-validate\.yml\/dispatches$/);
  assert.deepEqual(calls[1].options.body.inputs, {
    candidate_sha: candidateSha,
    candidate_ref: 'refs/merge-train-candidates/candidate-1',
    attestation_sha: baseSha,
    fingerprint: 'fingerprint',
    pr_numbers: '42',
  });
});

test('buildDispatchBindings routes both dispatch calls to workflowDispatchToken not promotionToken', async () => {
  // This wiring test ensures that when reconcile.mjs creates dispatch
  // functions via buildDispatchBindings, both calls use workflowDispatchToken
  // (GITHUB_TOKEN) rather than the App promotion token (MERGE_TRAIN_TOKEN).
  // If the binding were accidentally changed to forward the promotion token,
  // this test would fail while the helpers-only test above would remain green.
  const calls = [];
  const request = async (token, path, options) => {
    calls.push({ token, path, options });
  };
  const { dispatchRecovery, dispatchValidation } = buildDispatchBindings({
    request,
    workflowDispatchToken: 'actions-token',
    owner: 'nalfeo',
    repo: 'Crawler',
  });
  await dispatchRecovery(42, 'merge-train-validation-failure');
  await dispatchValidation(
    candidateSha,
    'refs/merge-train-candidates/candidate-1',
    baseSha,
    'fingerprint',
    [makePr()],
  );
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((call) => call.token === 'actions-token'),
    'both dispatch calls must forward workflowDispatchToken',
  );
  assert.match(calls[0].path, /ci-recovery\.yml\/dispatches$/);
  assert.match(calls[1].path, /merge-train-validate\.yml\/dispatches$/);
});

test('buildCandidate classifies already-applied squash diffs as no-op candidates', () => {
  const entry = makePr();
  const { git } = createGitStub({ noSquashChanges: true });
  assert.throws(
    () =>
      buildCandidate({
        baseSha,
        entries: [entry],
        refName: 'merge-train/candidate-1',
        git,
        live: false,
      }),
    (error) => {
      assert.equal(isMergeTrainConflictError(error), false);
      assert.equal(isMergeTrainNoopError(error), true);
      assert.match(error.message, /no longer changes main/);
      return true;
    },
  );
});

test('promotion stale-state guard mirrors queue admission boundaries', () => {
  const original = makePr();
  assert.match(
    promotionStaleReason({
      currentMain: baseSha,
      currentPr: makePr({ labels: [] }),
      expectedBase: baseSha,
      pr: original,
      repository: 'nalfeo/Crawler',
    }),
    /no longer has the merge-train label/,
  );
  assert.match(
    promotionStaleReason({
      currentMain: baseSha,
      currentPr: makePr({ draft: true }),
      expectedBase: baseSha,
      pr: original,
      repository: 'nalfeo/Crawler',
    }),
    /now a draft/,
  );
  assert.match(
    promotionStaleReason({
      currentMain: baseSha,
      currentPr: makePr({ base: { ref: 'release' } }),
      expectedBase: baseSha,
      pr: original,
      repository: 'nalfeo/Crawler',
    }),
    /retargeted to release/,
  );
  assert.match(
    promotionStaleReason({
      currentMain: baseSha,
      currentPr: makePr({ labels: [{ name: 'merge-train' }, { name: 'merge-train-blocked' }] }),
      expectedBase: baseSha,
      pr: original,
      repository: 'nalfeo/Crawler',
    }),
    /marked merge-train-blocked/,
  );
  assert.match(
    promotionStaleReason({
      currentMain: baseSha,
      currentPr: makePr({ labels: [{ name: 'merge-train' }, { name: 'ci-conflict-order-wait' }] }),
      expectedBase: baseSha,
      pr: original,
      repository: 'nalfeo/Crawler',
    }),
    /ci-conflict-order-wait/,
  );
});

function makeCiRun(overrides = {}) {
  return {
    name: 'CI',
    event: 'schedule',
    head_sha: baseSha,
    status: 'completed',
    conclusion: 'success',
    created_at: '2024-01-01T00:00:00Z',
    isTrainFastPath: false,
    ...overrides,
  };
}

test('mainAttributionVerdict is unknown (fails OPEN) when no full-CI evidence exists for current main', () => {
  // ADR 0077: absence of evidence attributes nothing. Unlike the promotion gate
  // this replaced, `unknown` must NOT pause the attribution breaker.
  const empty = mainAttributionVerdict({ mainSha: baseSha, runs: [] });
  assert.equal(empty.verdict, 'unknown');
  assert.match(empty.reason, /no full-CI evidence yet for current main/);
  // Evidence exists, but for a different (stale) main SHA -- still unknown.
  const stale = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ head_sha: candidateSha })],
  });
  assert.equal(stale.verdict, 'unknown');
  assert.match(stale.reason, /no full-CI evidence yet for current main/);
});

test('mainAttributionVerdict is unknown while the current main SHA is still pending', () => {
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ status: 'in_progress', conclusion: null })],
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.reason, /still in_progress/);
});

test('mainAttributionVerdict preserves completed green evidence across a newer pending duplicate', () => {
  assert.equal(
    mainAttributionVerdict({
      mainSha: baseSha,
      runs: [
        makeCiRun({ created_at: '2024-01-01T00:00:00Z' }),
        makeCiRun({
          created_at: '2024-01-01T01:00:00Z',
          status: 'in_progress',
          conclusion: null,
        }),
      ],
    }).verdict,
    'green',
  );
});

test('mainAttributionVerdict is red on a later completed failure despite older green evidence', () => {
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [
      makeCiRun({ created_at: '2024-01-01T00:00:00Z' }),
      makeCiRun({ created_at: '2024-01-01T01:00:00Z', conclusion: 'failure' }),
      makeCiRun({
        created_at: '2024-01-01T02:00:00Z',
        status: 'in_progress',
        conclusion: null,
      }),
    ],
  });
  assert.equal(verdict.verdict, 'red');
  assert.match(verdict.reason, /concluded failure/);
});

test('mainAttributionVerdict reports a genuine completed failure on the current main SHA', () => {
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ conclusion: 'failure' })],
  });
  assert.equal(verdict.verdict, 'red');
  assert.match(verdict.reason, /concluded failure/);
});

test('mainAttributionVerdict treats timed_out as red (genuine failure evidence)', () => {
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ conclusion: 'timed_out' })],
  });
  assert.equal(verdict.verdict, 'red');
  assert.match(verdict.reason, /concluded timed_out/);
});

test('mainAttributionVerdict treats cancelled as unknown, not red', () => {
  // A manually cancelled run proves nothing about main. Classifying it as red
  // would suppress bisection/ejection until the next daily backstop, exactly
  // like the old promotion gate deadlock (ADR 0077).
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ conclusion: 'cancelled' })],
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.reason, /non-authoritative conclusion cancelled/);
});

test('mainAttributionVerdict falls through to an authoritative run when the newest is cancelled', () => {
  // If there is an older completed authoritative run but the newest is cancelled,
  // the newest takes the slot (find() picks first match of the sorted list);
  // that one is unknown, not red. The caller re-runs when the next schedule run arrives.
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [
      makeCiRun({ created_at: '2024-01-01T01:00:00Z', conclusion: 'cancelled' }),
      makeCiRun({ created_at: '2024-01-01T00:00:00Z', conclusion: 'failure' }),
    ],
  });
  // The most recently created authoritative run is the cancelled one → unknown
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.reason, /non-authoritative conclusion cancelled/);
});

test('mainAttributionVerdict ignores a train fast-path push run and stays unknown', () => {
  // Only evidence for the current SHA is a fast-path push run (docs_only
  // shortcut); that is not authoritative full-CI evidence, so the verdict must
  // stay `unknown` rather than being read as green OR red.
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ event: 'push', isTrainFastPath: true })],
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.reason, /no full-CI evidence yet for current main/);
});

test('mainAttributionVerdict is green when non-train-fast-path evidence for current main is green', () => {
  assert.equal(
    mainAttributionVerdict({
      mainSha: baseSha,
      runs: [makeCiRun({ event: 'push', isTrainFastPath: true }), makeCiRun({ event: 'schedule' })],
    }).verdict,
    'green',
  );
});

test('mainAttributionVerdict considers a genuine push-triggered failure on the current main SHA (not just scheduled runs)', () => {
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ event: 'push', conclusion: 'failure', isTrainFastPath: false })],
  });
  assert.equal(verdict.verdict, 'red');
  assert.match(verdict.reason, /concluded failure/);
});

test('mainAttributionVerdict picks the most recently created authoritative run for the current SHA', () => {
  assert.equal(
    mainAttributionVerdict({
      mainSha: baseSha,
      runs: [
        makeCiRun({ created_at: '2024-01-01T00:00:00Z', conclusion: 'failure' }),
        makeCiRun({ created_at: '2024-01-01T01:00:00Z', conclusion: 'success' }),
      ],
    }).verdict,
    'green',
  );
});

// --- planAttributedPrefixPromotion: main health as an ATTRIBUTION signal only ---
// ADR 0077. BEFORE: promotion was gated a second time on `main` alone being
// green, so a PR whose composite was green could not land while `main` was red
// -- a PR that FIXED `main` could never merge. AFTER: the verdict is consulted
// ONLY when the maximal composite failed, and only to suppress ejection.

const RED = async () => ({ verdict: 'red', reason: 'latest completed full-CI run ... failure' });

test('planAttributedPrefixPromotion never consults main health when the maximal composite is green', async () => {
  let probes = 0;
  const plan = await planAttributedPrefixPromotion({
    prefixStates: ['success', 'success'],
    mainVerdict: async () => {
      probes += 1;
      return { verdict: 'red', reason: 'main is red' };
    },
  });
  // The deadlock fix: green composite promotes even though the probe would have
  // said `main` is red -- and the probe is not even called.
  assert.equal(probes, 0);
  assert.equal(plan.action, 'promote');
  assert.equal(plan.greenPrefixLength, 2);
  assert.deepEqual(plan, planPrefixPromotion(['success', 'success']));
});

test('planAttributedPrefixPromotion ejects nothing while main is red', async () => {
  // Bisection has isolated prefix 2 as the first failing addition. On a red
  // `main` that attribution is unsound, so `firstFailure` must be suppressed.
  const states = ['success', 'failure', 'failure'];
  const unattributed = planPrefixPromotion(states);
  assert.equal(unattributed.firstFailure, 1, 'precondition: today this ejects entry index 1');

  const plan = await planAttributedPrefixPromotion({ prefixStates: states, mainVerdict: RED });
  assert.equal(plan.firstFailure, -1);
  // The already-proven green prefix still promotes, so a queued repair PR lands.
  assert.equal(plan.action, 'promote');
  assert.equal(plan.greenPrefixLength, 1);
  assert.match(plan.attribution, /full-CI run/);
});

test('planAttributedPrefixPromotion promotes a proven-green prefix mid-bisection while main is red', async () => {
  // Regression: bisection has proven prefix 1 green but has not yet resolved
  // prefixes 2-3, so planPrefixPromotion asks for another `validate` round.
  // Pausing there would strand a repair PR sitting at prefix 1 -- and `main`
  // cannot go green until that repair lands, so the train would deadlock
  // permanently, reinstating the very bug this change removes.
  const states = ['success', 'missing', 'missing', 'failure'];
  assert.equal(planPrefixPromotion(states).action, 'validate', 'precondition: mid-bisection');

  const plan = await planAttributedPrefixPromotion({ prefixStates: states, mainVerdict: RED });
  assert.equal(plan.action, 'promote');
  assert.equal(plan.greenPrefixLength, 1);
  assert.equal(plan.validationIndex, 0);
  assert.equal(plan.firstFailure, -1);
});

test('planAttributedPrefixPromotion skips further bisection rounds entirely while main is red', async () => {
  for (const [states, todayAction] of [
    [['missing', 'missing', 'missing', 'failure'], 'validate'],
    [['pending', 'pending', 'pending', 'failure'], 'wait'],
    // Bisection has converged on green=0/red=1: today this ejects entry 0.
    [['failure', 'failure'], 'promote'],
  ]) {
    assert.equal(
      planPrefixPromotion(states).action,
      todayAction,
      `precondition: today this spends a ${todayAction} round`,
    );
    const plan = await planAttributedPrefixPromotion({ prefixStates: states, mainVerdict: RED });
    assert.equal(plan.action, 'pause');
    assert.equal(plan.firstFailure, -1);
    assert.equal(plan.greenPrefixLength, 0);
  }
});

test('planAttributedPrefixPromotion preserves bisection and ejection when main is green', async () => {
  const states = ['success', 'failure', 'failure'];
  const plan = await planAttributedPrefixPromotion({
    prefixStates: states,
    mainVerdict: async () => ({ verdict: 'green', reason: null }),
  });
  assert.deepEqual(plan, planPrefixPromotion(states));
});

test('planAttributedPrefixPromotion fails OPEN on an unknown verdict', async () => {
  // Absence of evidence attributes nothing. After every train promotion the only
  // run on the new `main` is the excluded fast-path attestation, so `unknown` is
  // the steady state; pausing on it would stall ejection until the daily backstop.
  const states = ['success', 'failure', 'failure'];
  for (const verdict of ['unknown', undefined]) {
    const plan = await planAttributedPrefixPromotion({
      prefixStates: states,
      mainVerdict: async () => ({ verdict, reason: 'no full-CI evidence yet' }),
    });
    assert.deepEqual(plan, planPrefixPromotion(states), `verdict=${verdict}`);
  }
});

test('planAttributedPrefixPromotion is a noop on an empty queue without probing main', async () => {
  let probes = 0;
  const plan = await planAttributedPrefixPromotion({
    prefixStates: [],
    mainVerdict: async () => {
      probes += 1;
      return { verdict: 'red' };
    },
  });
  assert.deepEqual(plan, { action: 'noop' });
  assert.equal(probes, 0);
});

test('planAttributedPrefixPromotion fails open when the probe throws', async () => {
  // A transient GitHub API error must NOT abort reconciliation. The design treats
  // unavailable evidence as `unknown`, so a thrown probe falls through to the
  // original bisection plan (ADR 0077).
  const states = ['success', 'failure', 'failure'];
  const plan = await planAttributedPrefixPromotion({
    prefixStates: states,
    mainVerdict: async () => {
      throw new Error('GitHub API 503 Service Unavailable');
    },
  });
  // Falls back to the normal plan — still ejects and bisects
  assert.deepEqual(plan, planPrefixPromotion(states));
});

test('trainCheckTitle distinguishes queued, failed, and successful completed checks', () => {
  assert.equal(trainCheckTitle('in_progress'), 'Merge-train validation queued');
  assert.equal(trainCheckTitle('completed', 'failure'), 'Merge-train validation could not start');
  assert.equal(trainCheckTitle('completed', 'success'), 'Candidate promoted to main');
});

test('isDisabledTrainScheduleRun returns false when Detect change scope ran successfully', () => {
  const jobs = [
    { name: 'Detect change scope', conclusion: 'success' },
    { name: 'build', conclusion: 'success' },
  ];
  assert.equal(isDisabledTrainScheduleRun(jobs), false);
});

test('isDisabledTrainScheduleRun returns true when Detect change scope was skipped (disabled-train run)', () => {
  const jobs = [
    { name: 'Detect change scope', conclusion: 'skipped' },
    { name: 'build', conclusion: 'skipped' },
  ];
  assert.equal(isDisabledTrainScheduleRun(jobs), true);
});

test('isDisabledTrainScheduleRun fails closed when jobs list is empty', () => {
  assert.equal(isDisabledTrainScheduleRun([]), true);
  assert.equal(isDisabledTrainScheduleRun(null), true);
  assert.equal(isDisabledTrainScheduleRun(undefined), true);
});

test('isDisabledTrainScheduleRun fails closed when Detect change scope job is absent', () => {
  // Jobs were returned but the expected changes-scope job is missing;
  // cannot confirm full CI ran, so treat as not authoritative.
  const jobs = [{ name: 'build', conclusion: 'success' }];
  assert.equal(isDisabledTrainScheduleRun(jobs), true);
});

test('mainAttributionVerdict stays unknown when latest schedule run is a disabled-train no-op', () => {
  // A schedule run with isTrainFastPath:true (disabled-train no-op) must not
  // count as authoritative evidence in either direction.
  const verdict = mainAttributionVerdict({
    mainSha: baseSha,
    runs: [makeCiRun({ event: 'schedule', isTrainFastPath: true })],
  });
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.reason, /no full-CI evidence yet for current main/);
});

test('mainAttributionVerdict is green when a non-no-op schedule run is green', () => {
  // A disabled-train no-op schedule run (isTrainFastPath:true) alongside a real
  // enabled-train schedule run (isTrainFastPath:false, green) → green.
  assert.equal(
    mainAttributionVerdict({
      mainSha: baseSha,
      runs: [
        makeCiRun({ event: 'schedule', isTrainFastPath: true }),
        makeCiRun({ event: 'schedule', isTrainFastPath: false }),
      ],
    }).verdict,
    'green',
  );
});

test('resolveMergeTrainTokens ignores the legacy workflow PAT environment variable', () => {
  const result = resolveMergeTrainTokens({
    GITHUB_ACTIONS: 'true',
    MERGE_TRAIN_TOKEN: 'app-token',
    GITHUB_TOKEN: 'github-token',
    MERGE_TRAIN_WORKFLOW_TOKEN: 'a-pat-that-must-not-be-used',
  });
  assert.deepEqual(result, {
    promotionToken: 'app-token',
    workflowDispatchToken: 'github-token',
    updateBranchToken: 'github-token',
  });
});

// buildGatedDispatchRecovery — admission gate for reconcile.mjs dispatch sites

test('buildGatedDispatchRecovery dispatches when outstanding count is below cap', async () => {
  const dispatched = [];
  const countRuns = async () => 0;
  const dispatchRecovery = async (prNumber, trigger) => dispatched.push({ prNumber, trigger });
  const gated = buildGatedDispatchRecovery({
    dispatchRecovery,
    countRuns,
    cap: 1,
    token: 'tok',
    owner: 'owner',
    repo: 'repo',
  });
  await gated(42, 'merge-train-noop');
  assert.deepEqual(dispatched, [{ prNumber: 42, trigger: 'merge-train-noop' }]);
});

test('buildGatedDispatchRecovery skips dispatch when outstanding count equals cap', async () => {
  const dispatched = [];
  const countRuns = async () => 1; // at cap
  const dispatchRecovery = async (prNumber, trigger) => dispatched.push({ prNumber, trigger });
  const gated = buildGatedDispatchRecovery({
    dispatchRecovery,
    countRuns,
    cap: 1,
    token: 'tok',
    owner: 'owner',
    repo: 'repo',
  });
  await gated(42, 'merge-train-noop');
  assert.deepEqual(dispatched, [], 'expected no dispatch when at cap');
});

test('buildGatedDispatchRecovery skips dispatch when outstanding count exceeds cap', async () => {
  const dispatched = [];
  const countRuns = async () => 3; // above cap
  const dispatchRecovery = async (prNumber, trigger) => dispatched.push({ prNumber, trigger });
  const gated = buildGatedDispatchRecovery({
    dispatchRecovery,
    countRuns,
    cap: 1,
    token: 'tok',
    owner: 'owner',
    repo: 'repo',
  });
  await gated(99, 'merge-train-validation-failure');
  assert.deepEqual(dispatched, [], 'expected no dispatch when above cap');
});

test('buildGatedDispatchRecovery passes token/owner/repo to countRuns', async () => {
  const countCallArgs = [];
  const countRuns = async (token, owner, repo) => {
    countCallArgs.push({ token, owner, repo });
    return 0;
  };
  const dispatchRecovery = async () => {};
  const gated = buildGatedDispatchRecovery({
    dispatchRecovery,
    countRuns,
    cap: 1,
    token: 'mytoken',
    owner: 'myowner',
    repo: 'myrepo',
  });
  await gated(1, 'merge-train-admission-stale');
  assert.deepEqual(countCallArgs, [{ token: 'mytoken', owner: 'myowner', repo: 'myrepo' }]);
});

test('buildGatedDispatchRecovery blocks second sequential call via in-process reservation when API is stale', async () => {
  // Simulates the admission-loop thundering-herd: countRuns always returns 0
  // because the Actions API has not yet reflected the first dispatch.  Without
  // an in-process reservation both sequential calls would see 0 < cap=1 and
  // dispatch independently, exceeding the cap.
  const dispatched = [];
  const countRuns = async () => 0; // stale API — never updated between calls
  const dispatchRecovery = async (prNumber, trigger) => dispatched.push({ prNumber, trigger });
  const gated = buildGatedDispatchRecovery({
    dispatchRecovery,
    countRuns,
    cap: 1,
    token: 'tok',
    owner: 'owner',
    repo: 'repo',
  });
  await gated(42, 'merge-train-admission-stale');
  await gated(43, 'merge-train-admission-stale');
  assert.deepEqual(
    dispatched,
    [{ prNumber: 42, trigger: 'merge-train-admission-stale' }],
    'second sequential call must be blocked by in-process reservation despite stale API count',
  );
});

test('buildGatedDispatchRecovery allows a second call once cap is raised (stale API, cap=2)', async () => {
  // With cap=2 and a stale API (always 0), the first call reserves one slot
  // (pendingDispatches=1) and the second call sees 0+1=1 < 2, so it is still
  // allowed.  A third call is blocked by 0+2=2 >= 2.
  const dispatched = [];
  const countRuns = async () => 0;
  const dispatchRecovery = async (prNumber, trigger) => dispatched.push({ prNumber, trigger });
  const gated = buildGatedDispatchRecovery({
    dispatchRecovery,
    countRuns,
    cap: 2,
    token: 'tok',
    owner: 'owner',
    repo: 'repo',
  });
  await gated(10, 'merge-train-admission-stale');
  await gated(11, 'merge-train-admission-stale');
  await gated(12, 'merge-train-admission-stale');
  assert.deepEqual(
    dispatched,
    [
      { prNumber: 10, trigger: 'merge-train-admission-stale' },
      { prNumber: 11, trigger: 'merge-train-admission-stale' },
    ],
    'third sequential call must be blocked once pendingDispatches reaches cap',
  );
});

// ---------------------------------------------------------------------------
// Coordination kill-switch wiring (source topology).
//
// reconcile.mjs is a top-level script that performs live GitHub I/O on import,
// so the gate cannot be exercised by importing it. These assertions pin the
// two regressions that would silently restore the delivery-blocking behaviour
// while every behavioural test still passed:
//   (a) the coordinator callback being supplied unconditionally, and
//   (b) the environment gate being inverted.
// ---------------------------------------------------------------------------
const RECONCILE_SOURCE = readFileSync(new URL('./reconcile.mjs', import.meta.url), 'utf8');

test('verifyMergeSlot is gated on the coordination kill switch', () => {
  assert.match(
    RECONCILE_SOURCE,
    /verifyMergeSlot:\s*coordinationEnforcementEnabled\(process\.env\)\s*\?/,
    'verifyMergeSlot must be supplied ONLY when coordination enforcement is enabled; ' +
      'supplying it unconditionally re-enables live filename-ordering enforcement at promotion',
  );
});

test('the disabled branch of the merge-slot gate is a no-op, not an enforcer', () => {
  // `undefined` falls through to promoteExactBatch's `verifyMergeSlot = async () => null`
  // default, i.e. "no coordinator ordering objection".
  const gate = RECONCILE_SOURCE.slice(
    RECONCILE_SOURCE.indexOf('verifyMergeSlot: coordinationEnforcementEnabled'),
  );
  const enabledBranch = gate.indexOf('ciConflictOrderReasonForPromotion');
  const disabledBranch = gate.indexOf(': undefined');
  assert.ok(enabledBranch > -1, 'enabled branch must call ciConflictOrderReasonForPromotion');
  assert.ok(disabledBranch > -1, 'disabled branch must pass undefined');
  assert.ok(
    enabledBranch < disabledBranch,
    'gate is INVERTED: the truthy branch must enforce and the falsy branch must be undefined',
  );
});

test('promoteExactBatch defaults verifyMergeSlot to a permissive no-op', () => {
  // This is what makes passing `undefined` safe rather than a crash.
  const libSource = readFileSync(new URL('./reconcile-lib.mjs', import.meta.url), 'utf8');
  assert.match(
    libSource,
    /verifyMergeSlot = async \(\) => null/,
    'promoteExactBatch must default verifyMergeSlot to a null-returning no-op',
  );
});

// ---------------------------------------------------------------------------
// update-branch 403 must not be misclassified as "PR is a fork" for a
// same-repo PR (e.g. a `copilot/*` coding-agent branch, which GitHub
// restricts to the Copilot App / branch owner and 403s every other token).
//
// PR #3027 was same-repo (isCrossRepository: false) but got dequeued as
// "fork/no-permission" on every reconcile pass for 3+ days: CI Recovery kept
// re-labeling it `merge-train`, the reconciler kept treating the 403 as fork
// evidence and removing the label again, producing an unbounded livelock
// (label added/removed every 1-2 minutes). These assertions pin the fix:
// a same-repo 403 must take a distinct, non-dequeuing path.
// ---------------------------------------------------------------------------
test('a same-repo update-branch 403 is not treated as a fork dequeue', () => {
  assert.match(
    RECONCILE_SOURCE,
    /if \(err\.status === 403 && !sameRepository\(livePr, repository\)\)/,
    'the fork/dequeue branch must be gated on !sameRepository(...) so a same-repo ' +
      '403 (e.g. a restricted copilot/* branch) cannot be misclassified as a fork',
  );
});

test('the same-repo 403 branch dequeues only under sticky quarantine', () => {
  const forkBranchStart = RECONCILE_SOURCE.indexOf(
    'if (err.status === 403 && !sameRepository(livePr, repository))',
  );
  const sameRepoBranchStart = RECONCILE_SOURCE.indexOf(
    'same-repo-restricted-branch (403)',
    forkBranchStart,
  );
  const branch422Start = RECONCILE_SOURCE.indexOf('err.status === 422', sameRepoBranchStart);
  assert.ok(forkBranchStart > -1, 'fork branch must exist');
  assert.ok(sameRepoBranchStart > forkBranchStart, 'same-repo branch must follow the fork branch');
  assert.ok(branch422Start > sameRepoBranchStart, '422 branch must follow the same-repo branch');
  const sameRepoBranchSource = RECONCILE_SOURCE.slice(sameRepoBranchStart, branch422Start);

  // #3027 livelock guard, narrowed by safeguard (3): the ordinary same-repo 403
  // path must still leave the PR queued, or CI Recovery re-labels it straight
  // back into the same 403 forever. Dequeuing is permitted in exactly one
  // place -- the quarantine branch -- because that path also applies the sticky
  // BLOCKED_LABEL, which router.mjs treats as dispatch-blocked, so the re-label
  // loop cannot restart.
  const quarantineStart = sameRepoBranchSource.indexOf('if (strike.quarantine)');
  assert.ok(quarantineStart > -1, 'the same-repo 403 branch must evaluate quarantine');
  const beforeQuarantine = sameRepoBranchSource.slice(0, quarantineStart);
  assert.doesNotMatch(
    beforeQuarantine,
    /removeLabel\(pr\.number,\s*QUEUE_LABEL\)/,
    'a same-repo 403 must leave the PR queued (no removeLabel) unless it is being quarantined, ' +
      'or CI Recovery will just re-label it into the same 403 forever',
  );
  const quarantineBranch = sameRepoBranchSource.slice(quarantineStart);
  const elseStart = quarantineBranch.indexOf('} else {');
  const quarantineBody = quarantineBranch.slice(0, elseStart);
  assert.match(
    quarantineBody,
    /setLabel\(pr\.number,\s*BLOCKED_LABEL\)/,
    'any dequeue on this path MUST be paired with the sticky BLOCKED_LABEL, otherwise it ' +
      'reintroduces the #3027 label-churn livelock',
  );
  const afterQuarantineBody = quarantineBranch.slice(elseStart);
  assert.doesNotMatch(
    afterQuarantineBody,
    /removeLabel\(pr\.number,\s*QUEUE_LABEL\)/,
    'the non-quarantine branch must never dequeue',
  );
  assert.match(
    sameRepoBranchSource,
    /dispatchRecoveryGated\(pr\.number, 'merge-train-restricted-branch-update'\)/,
    'a same-repo 403 must dispatch recovery so the stall is visible instead of silently repeating',
  );
});

// ---------------------------------------------------------------------------
// A same-repo restricted-branch 403 must also YIELD THE FIFO LINE.
//
// Regression: 2026-08-21. #3208 (`nalfeo-repair-asset-queue`) sat at the head
// of the queue in `behind` state and 403'd on update-branch every pass. The
// same-repo branch correctly left it queued, but still fell through to the
// unconditional `break`, so reconcile admitted nothing and exited with
// "No admitted PR is ready for candidate construction" on every 30-minute
// cycle -- while #3216 and #3218 sat behind it fully green, mergeable, and
// starved. The workflow reported `success` throughout, so the deadlock was
// invisible in run status.
//
// FIFO ordering exists to stop newer PRs leapfrogging a PR the train is
// actively advancing. A PR the train provably cannot advance on any pass is
// not being advanced, so it must not pin the line.
// ---------------------------------------------------------------------------
test('a same-repo restricted-branch 403 yields the FIFO line so later PRs are not starved', () => {
  const forkBranchStart = RECONCILE_SOURCE.indexOf(
    'if (err.status === 403 && !sameRepository(livePr, repository))',
  );
  const sameRepoBranchStart = RECONCILE_SOURCE.indexOf(
    'same-repo-restricted-branch (403)',
    forkBranchStart,
  );
  const branch422Start = RECONCILE_SOURCE.indexOf('err.status === 422', sameRepoBranchStart);
  assert.ok(sameRepoBranchStart > -1, 'same-repo 403 branch must exist');
  const sameRepoBranchSource = RECONCILE_SOURCE.slice(sameRepoBranchStart, branch422Start);
  assert.match(
    sameRepoBranchSource,
    /yieldFifoLine = true/,
    'a same-repo restricted-branch 403 must set yieldFifoLine so the loop keeps admitting ' +
      'later queued PRs instead of deadlocking the entire train behind an entry the ' +
      'train can never advance',
  );
});

test('the FIFO break is conditional on yieldFifoLine, not on fork-dequeue alone', () => {
  assert.match(
    RECONCILE_SOURCE,
    /if \(!yieldFifoLine\) break;/,
    'the FIFO break must be gated on yieldFifoLine so every un-advanceable BEHIND entry ' +
      '(fork dequeue AND same-repo restricted branch) releases the line',
  );
  assert.doesNotMatch(
    RECONCILE_SOURCE,
    /dequeuedFork/,
    'the old dequeuedFork-only gate must be gone: it released the line for forks only, ' +
      'leaving same-repo restricted branches to starve the queue indefinitely',
  );
});

// --- Safeguard (2): stalled non-empty queue detection (2026-08-21 deadlock) ---

test('evaluateStalledQueue ignores a healthy pass that admitted work', () => {
  const result = evaluateStalledQueue({ queuedCount: 3, admittedCount: 1, passes: 9 });
  assert.equal(result.stalled, false);
  assert.equal(result.alarm, false);
  assert.equal(result.passes, 0, 'a healthy pass must reset the consecutive stall counter');
});

test('evaluateStalledQueue ignores an empty queue (owned by the empty-train detector)', () => {
  const result = evaluateStalledQueue({ queuedCount: 0, admittedCount: 0, passes: 5 });
  assert.equal(result.stalled, false);
  assert.equal(result.alarm, false);
});

test('evaluateStalledQueue detects the deadlock signature but waits out the threshold', () => {
  const first = evaluateStalledQueue({ queuedCount: 3, admittedCount: 0, passes: 1 });
  assert.equal(first.stalled, true);
  assert.equal(first.alarm, false, 'a single stalled pass is not yet an incident');

  const third = evaluateStalledQueue({ queuedCount: 3, admittedCount: 0, passes: 3 });
  assert.equal(third.stalled, true);
  assert.equal(third.alarm, true, 'a sustained non-empty/zero-admitted stall must alarm');
  assert.equal(third.passes, 3);
});

test('stalled-queue pass counter round-trips through the incident body', () => {
  assert.equal(parseStalledQueuePasses(renderStalledQueuePasses(4)), 4);
  assert.equal(parseStalledQueuePasses('no marker here'), 0);
  assert.equal(parseStalledQueuePasses(renderStalledQueuePasses(0)), 0);
});

// --- Safeguard (3): eject + quarantine an un-advanceable head entry ---

test('evaluateUnadvanceableStrike accumulates strikes on an unchanged head sha', () => {
  const sha = 'd'.repeat(40);
  const first = evaluateUnadvanceableStrike({ headSha: sha, recordedSha: '', recordedStrikes: 0 });
  assert.equal(first.strikes, 1);
  assert.equal(first.quarantine, false);

  const second = evaluateUnadvanceableStrike({
    headSha: sha,
    recordedSha: sha,
    recordedStrikes: first.strikes,
  });
  assert.equal(second.strikes, 2);
  assert.equal(second.quarantine, false, 'quarantine must not fire before the threshold');

  const third = evaluateUnadvanceableStrike({
    headSha: sha,
    recordedSha: sha,
    recordedStrikes: second.strikes,
  });
  assert.equal(third.strikes, UNADVANCEABLE_STRIKE_THRESHOLD);
  assert.equal(third.quarantine, true, 'the train must eject an entry it can never advance');
});

test('evaluateUnadvanceableStrike resets strikes when the branch is rebased out-of-band', () => {
  const oldSha = 'd'.repeat(40);
  const newSha = 'e'.repeat(40);
  const result = evaluateUnadvanceableStrike({
    headSha: newSha,
    recordedSha: oldSha,
    recordedStrikes: 2,
  });
  assert.equal(result.strikes, 1, 'a new head sha is a fresh attempt, not a continuing strike');
  assert.equal(result.quarantine, false);
});

test('unadvanceable strike record round-trips through the status comment', () => {
  const sha = 'f'.repeat(40);
  const encoded = renderUnadvanceableStrike({ headSha: sha, strikes: 2, attempts: 5 });
  assert.deepEqual(parseUnadvanceableStrike(encoded), { headSha: sha, strikes: 2, attempts: 5 });
  assert.deepEqual(parseUnadvanceableStrike('## Merge train\n\n- State: `waiting`'), {
    headSha: '',
    strikes: 0,
    attempts: 0,
  });
});

test('a legacy two-field strike marker still parses, crediting strikes as attempts', () => {
  // Markers written before the cumulative-attempt field existed must not read
  // back as zero attempts, or an in-flight PR would silently lose its history.
  const sha = 'a'.repeat(40);
  assert.deepEqual(
    parseUnadvanceableStrike(`<!-- crawler-merge-train-unadvanceable:${sha}:2 -->`),
    {
      headSha: sha,
      strikes: 2,
      attempts: 2,
    },
  );
});

test('cumulative attempts quarantine a PR that resets its head sha every pass', () => {
  // A bot pushing ineffective commits changes the head SHA each pass, which
  // resets per-SHA strikes forever. Without a cumulative ceiling that PR could
  // fail update-branch indefinitely and never be quarantined.
  let attempts = 0;
  let result;
  for (let pass = 0; pass < UNADVANCEABLE_ATTEMPT_CEILING; pass += 1) {
    result = evaluateUnadvanceableStrike({
      headSha: String(pass).padStart(40, '0'),
      recordedSha: String(pass - 1).padStart(40, '0'),
      recordedStrikes: 1,
      recordedAttempts: attempts,
    });
    assert.equal(result.strikes, 1, 'each new head sha is a fresh per-sha strike');
    attempts = result.attempts;
  }
  assert.equal(attempts, UNADVANCEABLE_ATTEMPT_CEILING);
  assert.equal(
    result.quarantine,
    true,
    'the cumulative ceiling must eventually fire even though per-sha strikes always reset',
  );
});

test('quarantine uses the sticky BLOCKED_LABEL and removes the queue label', () => {
  const branch = RECONCILE_SOURCE.slice(RECONCILE_SOURCE.indexOf('if (strike.quarantine)'));
  const body = branch.slice(0, branch.indexOf('} else {'));
  assert.match(
    body,
    /removeLabel\(pr\.number,\s*QUEUE_LABEL\)/,
    'an un-advanceable PR must be ejected from the queue so it stops starving the FIFO line',
  );
  assert.match(
    body,
    /setLabel\(pr\.number,\s*BLOCKED_LABEL\)/,
    'quarantine must use merge-train-blocked, which router.mjs treats as dispatch-blocked, ' +
      'so CI Recovery cannot immediately re-queue it into the same 403 loop (the #3027 livelock)',
  );
  const setBlockedIdx = body.indexOf('setLabel(pr.number, BLOCKED_LABEL)');
  const removeQueueIdx = body.indexOf('removeLabel(pr.number, QUEUE_LABEL)');
  assert.ok(
    setBlockedIdx > -1 && removeQueueIdx > -1 && setBlockedIdx < removeQueueIdx,
    'BLOCKED_LABEL must be applied BEFORE QUEUE_LABEL is removed: a transient setLabel ' +
      'failure must never leave the PR dequeued but unblocked, which would let CI Recovery ' +
      're-queue it and recreate the label-churn livelock (matches the fail-safe order already ' +
      'used by blockEntry/deAdmitNoop)',
  );
});

test('STALLED_TRAIN_TRACKING_LABEL is provisioned by the startup ensureLabel sequence', () => {
  const ensureLabelCalls = RECONCILE_SOURCE.slice(
    RECONCILE_SOURCE.indexOf('await ensureLabel(QUEUE_LABEL'),
    RECONCILE_SOURCE.indexOf('// Crash-after-merge recovery runs first'),
  );
  assert.match(
    ensureLabelCalls,
    /ensureLabel\(\s*STALLED_TRAIN_TRACKING_LABEL/,
    'the stall-watch tracking label must exist before the first watch issue is created, or ' +
      'GitHub silently drops the nonexistent label, leaving the record unlabeled and ' +
      'undiscoverable by findStalledTrainIncident() on the next pass',
  );
});

test('the zero-admitted exit path evaluates the stalled-queue safeguard before exiting', () => {
  const tail = RECONCILE_SOURCE.slice(RECONCILE_SOURCE.indexOf('if (train.length === 0)'));
  const block = tail.slice(0, tail.indexOf('process.exit(0)'));
  assert.match(
    block,
    /evaluateStalledQueue\(/,
    'reconcile exits 0 here, so the stall must be evaluated before exit or it stays invisible',
  );
});

test('the stalled-pass counter is persisted from the first pass, not only at the alarm', () => {
  // Regression: the counter lives in the incident issue body, but the issue was
  // only created when `stall.alarm` was true -- and alarm requires passes>=3.
  // So passes could never read back above 0, pinned at 1 forever, and the alarm
  // was structurally unreachable. Persistence must be gated on `stalled`, not
  // on `alarm`, or the whole safeguard is dead code.
  const tail = RECONCILE_SOURCE.slice(RECONCILE_SOURCE.indexOf('if (train.length === 0)'));
  const block = tail.slice(0, tail.indexOf('process.exit(0)'));
  assert.match(
    block,
    /if \(stall\.stalled\)\s*\{\s*await upsertStalledTrainIncident\(/,
    'the counter must be written on every stalled pass, otherwise it can never reach its threshold',
  );
  assert.doesNotMatch(
    block,
    /if \(stall\.alarm\)\s*\{\s*await upsertStalledTrainIncident\(/,
    'gating persistence on the alarm makes the alarm unreachable',
  );
});

test('a stalled pass below the threshold escalates only after the threshold', () => {
  const first = evaluateStalledQueue({ queuedCount: 2, admittedCount: 0, passes: 1 });
  assert.deepEqual(
    { stalled: first.stalled, alarm: first.alarm },
    { stalled: true, alarm: false },
    'pass 1 is tracked but must not raise an incident label yet',
  );
  const third = evaluateStalledQueue({
    queuedCount: 2,
    admittedCount: 0,
    passes: STALLED_QUEUE_PASS_THRESHOLD,
  });
  assert.equal(third.alarm, true, 'the alarm must fire exactly at the threshold');
});

test('every non-advancing update-branch outcome yields the FIFO line', () => {
  // The 2026-08-21 deadlock was one un-advanceable head-of-line PR holding FIFO
  // forever. Any branch that leaves the PR queued WITHOUT advancing it must
  // release the line, or it can reproduce the same starvation.
  const region = RECONCILE_SOURCE.slice(
    RECONCILE_SOURCE.indexOf('same-repo-restricted-branch'),
    RECONCILE_SOURCE.indexOf('if (!yieldFifoLine) break;'),
  );
  const branch422 = region.slice(region.indexOf('err.status === 422'));
  assert.match(
    branch422.slice(0, branch422.indexOf('} else {')),
    /yieldFifoLine = true/,
    'a 422 means no update landed, so the line must not stay held',
  );
  assert.match(
    region.slice(region.indexOf('unexpected-status')),
    /yieldFifoLine = true/,
    'an unknown update-branch failure advanced nothing and must not pin the queue',
  );
});

test('recovery dispatch is skipped once a PR is quarantined', () => {
  // Dispatching recovery before quarantine raced it: the recovery run could
  // converge, strip BLOCKED_LABEL, and re-admit the PR into the same 403 loop.
  // router.mjs exclusion blocks new dispatch selection but cannot cancel an
  // in-flight one, so the dispatch must live on the non-quarantine branch only.
  const branch = RECONCILE_SOURCE.slice(RECONCILE_SOURCE.indexOf('if (strike.quarantine)'));
  const quarantined = branch.slice(0, branch.indexOf('} else {'));
  assert.doesNotMatch(
    quarantined,
    /dispatchRecoveryGated\(/,
    'a quarantined PR must not also get a recovery dispatch that could un-quarantine it',
  );
});

test('the queue-empty exit path closes a lingering stalled-train incident', () => {
  const region = RECONCILE_SOURCE.slice(
    RECONCILE_SOURCE.indexOf("process.stdout.write('Merge train is empty\\n')"),
  );
  assert.match(
    region.slice(0, region.indexOf('process.exit(0)')),
    /closeStalledTrainIncidentIfAny\(/,
    'a queue that drained to empty has recovered, so the stall record must not linger open',
  );
});

test('the stalled-train record is discoverable before the alarm labels it', () => {
  // The record is created below the alarm threshold, when it deliberately does
  // not carry the `ci-incident` label. Looking it up through that label made
  // the pass counter unreadable (always 0) and leaked a new unlabeled issue on
  // every stalled pass, so the alarm could never fire.
  const finder = RECONCILE_SOURCE.slice(
    RECONCILE_SOURCE.indexOf('async function findStalledTrainIncident()'),
  );
  const body = finder.slice(0, finder.indexOf('\n}\n'));
  assert.match(
    body,
    /STALLED_TRAIN_TRACKING_LABEL/,
    'the stall record must be looked up by its always-applied tracking label',
  );
  assert.doesNotMatch(
    body,
    /EMPTY_TRAIN_INCIDENT_LABEL/,
    'the alarm-only incident label cannot be the lookup key for a pre-alarm record',
  );
  for (const fn of [
    'async function upsertStalledTrainIncident',
    'async function readStalledTrainPasses',
    'async function closeStalledTrainIncidentIfAny',
  ]) {
    const region = RECONCILE_SOURCE.slice(RECONCILE_SOURCE.indexOf(fn));
    assert.match(
      region.slice(0, region.indexOf('\n}\n')),
      /findStalledTrainIncident\(\)/,
      `${fn} must share the tracking-label lookup so the counter round-trips`,
    );
  }
});

test('the stalled-train record always carries the tracking label', () => {
  const region = RECONCILE_SOURCE.slice(
    RECONCILE_SOURCE.indexOf('async function upsertStalledTrainIncident'),
  );
  const upsert = region.slice(0, region.indexOf('\n}\n'));
  assert.doesNotMatch(
    upsert,
    /labels: alarm \? \[[^\]]*\] : \[\]/,
    'an unlabeled record cannot be found again, so it must never be created without a label',
  );
  assert.match(upsert, /\[STALLED_TRAIN_TRACKING_LABEL\]/);
});
