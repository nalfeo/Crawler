import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCandidate,
  dispatchRecoveryWorkflow,
  dispatchValidationWorkflow,
  isDisabledTrainScheduleRun,
  isMergeTrainConflictError,
  isMergeTrainNoopError,
  mainHealthReason,
  promoteExactBatch,
  promotionStaleReason,
  promoteExactCandidate,
  resolveMergeTrainTokens,
  trainCheckTitle,
} from './reconcile-lib.mjs';

const baseSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
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
    fingerprint: 'fingerprint',
    entries: [makePr()],
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.token === 'actions-token'));
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

test('mainHealthReason fails closed when no full-CI evidence exists for current main', () => {
  assert.match(
    mainHealthReason({ mainSha: baseSha, runs: [] }),
    /no full-CI evidence yet for current main/,
  );
  // Evidence exists, but for a different (stale) main SHA -- still fails closed.
  assert.match(
    mainHealthReason({
      mainSha: baseSha,
      runs: [makeCiRun({ head_sha: candidateSha })],
    }),
    /no full-CI evidence yet for current main/,
  );
});

test('mainHealthReason fails closed while the current main SHA is still pending', () => {
  assert.match(
    mainHealthReason({
      mainSha: baseSha,
      runs: [makeCiRun({ status: 'in_progress', conclusion: null })],
    }),
    /still in_progress/,
  );
});

test('mainHealthReason reports a genuine completed failure on the current main SHA', () => {
  assert.match(
    mainHealthReason({
      mainSha: baseSha,
      runs: [makeCiRun({ conclusion: 'failure' })],
    }),
    /concluded failure/,
  );
});

test('mainHealthReason ignores a train fast-path push run and still fails closed', () => {
  // Only evidence for the current SHA is a fast-path push run (docs_only
  // shortcut); that is not authoritative full-CI evidence, so an
  // otherwise-empty run list must still fail closed rather than pass open.
  assert.match(
    mainHealthReason({
      mainSha: baseSha,
      runs: [makeCiRun({ event: 'push', isTrainFastPath: true })],
    }),
    /no full-CI evidence yet for current main/,
  );
});

test('mainHealthReason allows promotion when non-train-fast-path evidence for current main is green', () => {
  assert.equal(
    mainHealthReason({
      mainSha: baseSha,
      runs: [makeCiRun({ event: 'push', isTrainFastPath: true }), makeCiRun({ event: 'schedule' })],
    }),
    null,
  );
});

test('mainHealthReason considers a genuine push-triggered failure on the current main SHA (not just scheduled runs)', () => {
  assert.match(
    mainHealthReason({
      mainSha: baseSha,
      runs: [makeCiRun({ event: 'push', conclusion: 'failure', isTrainFastPath: false })],
    }),
    /concluded failure/,
  );
});

test('mainHealthReason picks the most recently created authoritative run for the current SHA', () => {
  assert.equal(
    mainHealthReason({
      mainSha: baseSha,
      runs: [
        makeCiRun({ created_at: '2024-01-01T00:00:00Z', conclusion: 'failure' }),
        makeCiRun({ created_at: '2024-01-01T01:00:00Z', conclusion: 'success' }),
      ],
    }),
    null,
  );
});

test('promoteExactCandidate publishes the required check only after state and ref validation', async () => {
  const pr = makePr();
  const currentPr = makePr();
  const { git, calls } = createGitStub({});
  const checkCalls = [];
  const statusCalls = [];
  const removedLabels = [];
  const promoted = await promoteExactCandidate({
    pr,
    candidateSha,
    expectedBase: baseSha,
    position: 1,
    repository: 'nalfeo/Crawler',
    live: true,
    fetchCurrentPr: async () => currentPr,
    fetchCurrentMain: async () => baseSha,
    eligible: async () => ({ ok: true }),
    git,
    createTrainCheck: async (...args) => checkCalls.push(args),
    removeLabel: async (...args) => removedLabels.push(args),
    updateStatus: async (...args) => statusCalls.push(args),
    requiredCheckName: 'merge-train',
  });
  assert.equal(promoted, true);
  assert.equal(checkCalls.length, 1);
  assert.deepEqual(checkCalls[0].slice(2, 5), ['completed', 'success', 'merge-train']);
  assert.deepEqual(
    checkCalls[0][5].map((entry) => entry.number),
    [pr.number],
  );
  const pushCall = calls.find((call) => call.args[0] === 'push');
  assert.ok(pushCall);
  assert.ok(pushCall.args.includes('--atomic'));
  assert.ok(pushCall.args.includes(`--force-with-lease=refs/heads/${pr.head.ref}:${pr.head.sha}`));
  assert.ok(pushCall.args.includes(`--force-with-lease=refs/heads/main:${baseSha}`));
  assert.deepEqual(removedLabels, [
    [pr.number, 'merge-train'],
    [pr.number, 'merge-train-blocked'],
  ]);
  assert.equal(statusCalls.length, 1);
});

test('promoteExactBatch advances all PR heads and main in one atomic push', async () => {
  const first = makePr();
  const second = makePr({
    number: 43,
    title: 'fix: second train entry',
    head: {
      sha: '2'.repeat(40),
      ref: 'feature/second-train',
      repo: { full_name: 'nalfeo/Crawler' },
    },
  });
  const firstCandidate = 'b'.repeat(40);
  const finalCandidate = 'c'.repeat(40);
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === `${firstCandidate}^`) return baseSha;
    if (args[0] === 'rev-parse' && args[1] === `${finalCandidate}^`) return firstCandidate;
    return '';
  };
  const checkCalls = [];
  const promoted = await promoteExactBatch({
    entries: [first, second],
    candidateShas: [firstCandidate, finalCandidate],
    expectedBase: baseSha,
    repository: 'nalfeo/Crawler',
    live: true,
    fetchCurrentPr: async (entry) => entry,
    fetchCurrentMain: async () => baseSha,
    eligible: async () => ({ ok: true }),
    git,
    createTrainCheck: async (...args) => checkCalls.push(args),
    removeLabel: async () => {},
    updateStatus: async () => {},
    requiredCheckName: 'merge-train',
  });

  assert.equal(promoted, true);
  assert.equal(checkCalls.length, 1);
  assert.deepEqual([checkCalls[0][0], checkCalls[0][4]], [finalCandidate, 'merge-train']);
  const push = calls.find((args) => args[0] === 'push');
  assert.ok(push.includes('--atomic'));
  assert.ok(push.includes(`${finalCandidate}:refs/heads/${first.head.ref}`));
  assert.ok(push.includes(`${finalCandidate}:refs/heads/${second.head.ref}`));
  assert.ok(push.includes(`${finalCandidate}:refs/heads/main`));
  assert.ok(push.includes(`--force-with-lease=refs/heads/${first.head.ref}:${first.head.sha}`));
  assert.ok(push.includes(`--force-with-lease=refs/heads/${second.head.ref}:${second.head.sha}`));
  assert.ok(push.includes(`--force-with-lease=refs/heads/main:${baseSha}`));
});

test('promoteExactCandidate refuses stale queue state before publishing the required check', async () => {
  const pr = makePr();
  const { git } = createGitStub({});
  const checkCalls = [];
  const promoted = await promoteExactCandidate({
    pr,
    candidateSha,
    expectedBase: baseSha,
    position: 1,
    repository: 'nalfeo/Crawler',
    live: true,
    fetchCurrentPr: async () => makePr({ labels: [] }),
    fetchCurrentMain: async () => baseSha,
    eligible: async () => ({ ok: true }),
    git,
    createTrainCheck: async (...args) => checkCalls.push(args),
    removeLabel: async () => {},
    updateStatus: async () => {},
    requiredCheckName: 'merge-train',
  });
  assert.equal(promoted, false);
  assert.equal(checkCalls.length, 0);
});

test('promoteExactCandidate refuses unsafe head refs before publishing the required check', async () => {
  const pr = makePr();
  const { git } = createGitStub({});
  const checkCalls = [];
  await assert.rejects(
    () =>
      promoteExactCandidate({
        pr,
        candidateSha,
        expectedBase: baseSha,
        position: 1,
        repository: 'nalfeo/Crawler',
        live: true,
        fetchCurrentPr: async () => makePr({ head: { ...makePr().head, ref: 'bad ref' } }),
        fetchCurrentMain: async () => baseSha,
        eligible: async () => ({ ok: true }),
        git,
        createTrainCheck: async (...args) => checkCalls.push(args),
        removeLabel: async () => {},
        updateStatus: async () => {},
        requiredCheckName: 'merge-train',
      }),
    /Unsafe PR head ref/,
  );
  assert.equal(checkCalls.length, 0);
});

test('promoteExactCandidate marks the required check failed when the atomic push loses its lease', async () => {
  const pr = makePr();
  const { git } = createGitStub({ failPush: true });
  const checkCalls = [];
  await assert.rejects(
    () =>
      promoteExactCandidate({
        pr,
        candidateSha,
        expectedBase: baseSha,
        position: 1,
        repository: 'nalfeo/Crawler',
        live: true,
        fetchCurrentPr: async () => makePr(),
        fetchCurrentMain: async () => baseSha,
        eligible: async () => ({ ok: true }),
        git,
        createTrainCheck: async (...args) => checkCalls.push(args),
        removeLabel: async () => {},
        updateStatus: async () => {},
        requiredCheckName: 'merge-train',
      }),
    /lease rejected/,
  );
  assert.equal(checkCalls.length, 2);
  assert.deepEqual(checkCalls[0].slice(2, 5), ['completed', 'success', 'merge-train']);
  assert.deepEqual(checkCalls[1].slice(2, 5), ['completed', 'failure', 'merge-train']);
});

test('promoteExactCandidate publishes a separate failure when GitHub does not record the PR as merged', async () => {
  const pr = makePr();
  const { git } = createGitStub({});
  const checkCalls = [];
  await assert.rejects(
    () =>
      promoteExactCandidate({
        pr,
        candidateSha,
        expectedBase: baseSha,
        position: 1,
        repository: 'nalfeo/Crawler',
        live: true,
        fetchCurrentPr: async () => makePr(),
        fetchCurrentMain: async () => baseSha,
        eligible: async () => ({ ok: true }),
        git,
        createTrainCheck: async (...args) => checkCalls.push(args),
        removeLabel: async () => {},
        updateStatus: async () => {},
        requiredCheckName: 'merge-train',
        waitForMergedPr: async () => false,
      }),
    /was not recorded as merged/,
  );
  assert.deepEqual(checkCalls[0].slice(2, 5), ['completed', 'success', 'merge-train']);
  assert.deepEqual(checkCalls[1].slice(2, 5), [
    'completed',
    'failure',
    'merge-train-promotion-postcondition',
  ]);
});

// Regression coverage for a TOCTOU review finding: `mainHealthAllowsPromotion()`
// was only checked once, before the sequential per-PR reads
// (`fetchCurrentPr`/`eligible`) that follow it. A scheduled or push-triggered
// CI run for `main` can start and go pending/red while those reads are in
// flight, so the initial guard alone cannot prove `main` is still healthy at
// the moment the required check is published and the atomic push happens.
// `promoteExactBatch` now accepts a `reattestHealth` callback and re-runs it
// as part of the final pre-push reattestation -- after the last PR read, and
// immediately before publishing the required check / updating refs -- so a
// health transition in that window blocks promotion instead of racing past it.
test('promoteExactBatch re-checks main health immediately before publishing the required check', async () => {
  const pr = makePr();
  const { git, calls } = createGitStub({});
  const checkCalls = [];
  const callOrder = [];
  let fetchCurrentPrCalls = 0;
  const promoted = await promoteExactCandidate({
    pr,
    candidateSha,
    expectedBase: baseSha,
    position: 1,
    repository: 'nalfeo/Crawler',
    live: true,
    fetchCurrentPr: async () => {
      fetchCurrentPrCalls += 1;
      callOrder.push(`fetchCurrentPr:${fetchCurrentPrCalls}`);
      return makePr();
    },
    fetchCurrentMain: async () => baseSha,
    eligible: async () => ({ ok: true }),
    git,
    createTrainCheck: async (...args) => {
      callOrder.push('createTrainCheck');
      checkCalls.push(args);
    },
    removeLabel: async () => {},
    updateStatus: async () => {},
    requiredCheckName: 'merge-train',
    // Model main flipping unhealthy between candidate validation and the
    // final pre-push reattestation.
    reattestHealth: async () => {
      callOrder.push('reattestHealth');
      return false;
    },
  });
  assert.equal(promoted, false);
  assert.equal(checkCalls.length, 0, 'must not publish the required check when health regressed');
  assert.equal(
    calls.some((call) => call.args[0] === 'push'),
    false,
    'must not push when health regressed',
  );
  // reattestHealth must run after the final per-PR read (2nd fetchCurrentPr
  // call, from the final reattestation loop) and before any check
  // publish/push -- not merely once, up front, before those reads.
  assert.equal(fetchCurrentPrCalls, 2);
  assert.deepEqual(callOrder, ['fetchCurrentPr:1', 'fetchCurrentPr:2', 'reattestHealth']);
});

test('promoteExactBatch proceeds to publish and push when reattestHealth stays healthy', async () => {
  const pr = makePr();
  const { git, calls } = createGitStub({});
  const checkCalls = [];
  let reattestCalls = 0;
  const promoted = await promoteExactCandidate({
    pr,
    candidateSha,
    expectedBase: baseSha,
    position: 1,
    repository: 'nalfeo/Crawler',
    live: true,
    fetchCurrentPr: async () => makePr(),
    fetchCurrentMain: async () => baseSha,
    eligible: async () => ({ ok: true }),
    git,
    createTrainCheck: async (...args) => checkCalls.push(args),
    removeLabel: async () => {},
    updateStatus: async () => {},
    requiredCheckName: 'merge-train',
    reattestHealth: async () => {
      reattestCalls += 1;
      return true;
    },
  });
  assert.equal(promoted, true);
  assert.equal(reattestCalls, 1);
  assert.equal(checkCalls.length, 1);
  const pushCall = calls.find((call) => call.args[0] === 'push');
  assert.ok(pushCall);
});

test('promoteExactBatch defaults reattestHealth to healthy when the caller omits it', async () => {
  const pr = makePr();
  const { git } = createGitStub({});
  const checkCalls = [];
  const promoted = await promoteExactCandidate({
    pr,
    candidateSha,
    expectedBase: baseSha,
    position: 1,
    repository: 'nalfeo/Crawler',
    live: true,
    fetchCurrentPr: async () => makePr(),
    fetchCurrentMain: async () => baseSha,
    eligible: async () => ({ ok: true }),
    git,
    createTrainCheck: async (...args) => checkCalls.push(args),
    removeLabel: async () => {},
    updateStatus: async () => {},
    requiredCheckName: 'merge-train',
  });
  assert.equal(promoted, true);
  assert.equal(checkCalls.length, 1);
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

test('mainHealthReason fails closed when latest schedule run is a disabled-train no-op', () => {
  // A schedule run with isTrainFastPath:true (disabled-train no-op) must not
  // count as authoritative evidence; the circuit breaker must still fail closed.
  assert.match(
    mainHealthReason({
      mainSha: baseSha,
      runs: [makeCiRun({ event: 'schedule', isTrainFastPath: true })],
    }),
    /no full-CI evidence yet for current main/,
  );
});

test('mainHealthReason allows promotion when a non-no-op schedule run is green', () => {
  // A disabled-train no-op schedule run (isTrainFastPath:true) alongside a real
  // enabled-train schedule run (isTrainFastPath:false, green) → allows promotion.
  assert.equal(
    mainHealthReason({
      mainSha: baseSha,
      runs: [
        makeCiRun({ event: 'schedule', isTrainFastPath: true }),
        makeCiRun({ event: 'schedule', isTrainFastPath: false }),
      ],
    }),
    null,
  );
});
