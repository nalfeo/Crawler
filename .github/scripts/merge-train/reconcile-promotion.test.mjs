import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLandedRecoveryDecision,
  createMergePullRequest,
  isMergeTrainPromotionError,
  landedCommitProofError,
  planLandedRecovery,
  promoteExactBatch,
} from './reconcile-lib.mjs';
import { BLOCKED_LABEL, LANDED_LABEL, QUEUE_LABEL, RECOVERY_PENDING_LABEL } from './state.mjs';

// Deterministic 40-char hex SHAs for the fixtures.
const BASE = 'a'.repeat(40);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const CAND1 = 'c'.repeat(40);
const CAND2 = 'd'.repeat(40);
const LAND1 = 'e'.repeat(40);
const LAND2 = 'f'.repeat(40);
const TREE1 = '1a'.repeat(20);
const TREE2 = '2b'.repeat(20);
const REPO = 'nalfeo/Crawler';

function makePromoPr(number, { merged = false, autoMerge = null, overrides = {} } = {}) {
  return {
    number,
    title: `feat: pr ${number}`,
    state: merged ? 'closed' : 'open',
    draft: false,
    labels: [{ name: QUEUE_LABEL }],
    base: { ref: 'main' },
    head: {
      sha: number === 1 ? HEAD1 : HEAD2,
      ref: `feature/pr-${number}`,
      repo: { full_name: REPO },
    },
    auto_merge: autoMerge,
    merged,
    merged_at: merged ? '2026-07-15T00:00:00Z' : null,
    // When merged, GitHub records the real merge commit; the proof requires it
    // to equal the landed SHA (LAND1/LAND2 for PR 1/2).
    merge_commit_sha: merged ? (number === 1 ? LAND1 : LAND2) : null,
    node_id: `PR_${number}`,
    ...overrides,
  };
}

// A fully-wired 2-PR promotion harness. Overrides let each test inject a
// specific failure while every other dependency stays on the happy path.
function runPromotion(overrides = {}) {
  const records = {
    merges: [],
    landedLabels: [],
    removedLabels: [],
    landedComments: [],
    statuses: [],
    mapping: [],
    postconditions: [],
  };
  let main = overrides.startMain ?? BASE;
  const mergedNumbers = new Set();

  const candParents = { [CAND1]: BASE, [CAND2]: CAND1 };
  const candTrees = { [CAND1]: TREE1, [CAND2]: TREE2 };
  const gitCalls = [];
  const git = (args) => {
    gitCalls.push(args);
    if (args[0] === 'rev-parse') {
      const ref = args[1];
      const tree = ref.match(/^([0-9a-f]{40})\^\{tree\}$/);
      if (tree) return candTrees[tree[1]] ?? `tree-${tree[1]}`;
      const parent = ref.match(/^([0-9a-f]{40})\^$/);
      if (parent) return candParents[parent[1]] ?? BASE;
      return ref;
    }
    return '';
  };

  const landedFor = (number) => (number === 1 ? LAND1 : LAND2);
  const defaultMerge = async (entry) => ({ ok: true, sha: landedFor(entry.number) });
  const mergePullRequest = async (entry, args) => {
    records.merges.push({ number: entry.number, ...args });
    const result = await (overrides.mergePullRequest || defaultMerge)(entry, args);
    if (result.ok) {
      main = result.sha;
      if (!overrides.neverMarkMerged) mergedNumbers.add(entry.number);
    }
    return result;
  };

  const fetchCommitDefault = async (sha) => {
    if (sha === LAND1) return { sha, parents: [{ sha: BASE }], commit: { tree: { sha: TREE1 } } };
    if (sha === LAND2) return { sha, parents: [{ sha: LAND1 }], commit: { tree: { sha: TREE2 } } };
    throw new Error(`unexpected fetchCommit ${sha}`);
  };

  const fetchCurrentPr = async (entry) =>
    makePromoPr(entry.number, {
      merged: mergedNumbers.has(entry.number),
      autoMerge: overrides.autoMergeNumbers?.includes(entry.number) ? {} : null,
    });

  const entries = (overrides.entries || [1, 2]).map((n) => makePromoPr(n));
  const candidateShas = overrides.candidateShas || [CAND1, CAND2].slice(0, entries.length);

  const promise = promoteExactBatch({
    entries,
    candidateShas,
    expectedBase: BASE,
    repository: REPO,
    live: overrides.live ?? true,
    fetchCurrentPr,
    fetchCurrentMain: async () => main,
    fetchCommit: overrides.fetchCommit || fetchCommitDefault,
    eligible: overrides.eligible || (async () => ({ ok: true, fingerprint: 'fp' })),
    git,
    mergePullRequest,
    setLabel: async (number, name) => {
      records.landedLabels.push({ number, name });
    },
    removeLabel: async (number, name) => {
      records.removedLabels.push({ number, name });
    },
    updateStatus: async (number, body) => {
      records.statuses.push({ number, body });
    },
    postLandedComment: async (number, landedSha, candidateSha) => {
      records.landedComments.push({ number, landedSha, candidateSha });
    },
    verifyCandidateEvidence: overrides.verifyCandidateEvidence || (async () => true),
    publishPostconditionCheck: async (sha, fingerprint, provenance) => {
      records.postconditions.push({ sha, fingerprint, provenance });
    },
    recordMapping: (number, sha) => records.mapping.push({ number, sha }),
    reattestHealth: overrides.reattestHealth || (async () => true),
    // ^ Removed from promoteExactBatch by ADR 0077 (main health is no longer on
    // the promotion path). Kept here deliberately so the regression below can
    // prove a legacy caller passing it cannot block a validated merge.
    verifyMergeSlot: overrides.verifyMergeSlot || (async () => null),
    proofSleep: async () => {},
  });

  return { promise, records, gitCalls, getMain: () => main };
}

test('promoteExactBatch squash-merges each PR through GitHub and records real landed commits', async () => {
  const { promise, records, gitCalls, getMain } = runPromotion();
  const result = await promise;

  assert.equal(result, true);
  // Both PRs merged in order via GitHub's merge machinery.
  assert.deepEqual(
    records.merges.map((m) => m.number),
    [1, 2],
  );
  // Real landed SHAs recorded as the PR<->commit mapping.
  assert.deepEqual(records.mapping, [
    { number: 1, sha: LAND1 },
    { number: 2, sha: LAND2 },
  ]);
  // Durable landed label applied to each original PR (never removed).
  assert.deepEqual(records.landedLabels, [
    { number: 1, name: LANDED_LABEL },
    { number: 2, name: LANDED_LABEL },
  ]);
  // Queue/blocked labels cleared on each original PR.
  assert.ok(records.removedLabels.some((l) => l.number === 1 && l.name === QUEUE_LABEL));
  assert.ok(records.removedLabels.some((l) => l.number === 2 && l.name === BLOCKED_LABEL));
  // Completion comment posted on each original PR with the landed commit and
  // the one batch candidate whose validation authorized the FIFO promotion.
  assert.deepEqual(records.landedComments, [
    { number: 1, landedSha: LAND1, candidateSha: CAND2 },
    { number: 2, landedSha: LAND2, candidateSha: CAND2 },
  ]);
  // No postcondition failure and main ends at the last landed commit.
  assert.equal(records.postconditions.length, 0);
  assert.equal(getMain(), LAND2);
  // Promotion never force-pushes: git is used only for local rev-parse reads.
  assert.ok(gitCalls.every((args) => args[0] === 'rev-parse'));
});

test('promoteExactBatch forwards the durable trailer and pins the head SHA on each merge', async () => {
  const { promise, records } = runPromotion();
  await promise;
  assert.equal(records.merges[0].expectedHeadSha, HEAD1);
  assert.equal(records.merges[0].commitTitle, 'feat: pr 1 (#1)');
  assert.match(records.merges[0].commitMessage, /^Merge-Train-PR: 1$/m);
  assert.match(records.merges[0].commitMessage, /Merge-Train-Original-Head: /);
});

test('promoteExactBatch fails closed (throws + postcondition) when a landed tree diverges', async () => {
  // GitHub's squash produced a different tree than the validated candidate.
  const { promise, records } = runPromotion({
    fetchCommit: async (sha) => {
      if (sha === LAND1) {
        return { sha, parents: [{ sha: BASE }], commit: { tree: { sha: 'bad' + '0'.repeat(37) } } };
      }
      return { sha, parents: [{ sha: LAND1 }], commit: { tree: { sha: TREE2 } } };
    },
  });
  await assert.rejects(promise, (error) => {
    assert.ok(isMergeTrainPromotionError(error));
    assert.match(error.message, /tree .* != validated candidate prefix tree/);
    return true;
  });
  // Postcondition failure published on the ACTUAL landed commit.
  assert.equal(records.postconditions.length, 1);
  assert.equal(records.postconditions[0].sha, LAND1);
  // The divergent PR is NOT marked landed.
  assert.equal(records.landedLabels.length, 0);
});

test('promoteExactBatch fails closed when a landed commit has more than one parent', async () => {
  const { promise, records } = runPromotion({
    entries: [1],
    candidateShas: [CAND1],
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }, { sha: HEAD1 }],
      commit: { tree: { sha: TREE1 } },
    }),
  });
  await assert.rejects(promise, /has 2 parents/);
  assert.equal(records.postconditions[0].sha, LAND1);
  assert.equal(records.landedLabels.length, 0);
});

test('promoteExactBatch fails closed when GitHub does not record the PR merged', async () => {
  // The merge API returns a SHA and main advances, but the PR never flips
  // merged:true (the forbidden closed-not-merged outcome). The post-merge
  // proof must catch it and fail closed.
  const { promise, records } = runPromotion({
    entries: [1],
    candidateShas: [CAND1],
    neverMarkMerged: true,
  });
  await assert.rejects(promise, /did not record PR #1 as merged/);
  assert.equal(records.landedLabels.length, 0);
  assert.equal(records.postconditions.length, 1);
});

test('promoteExactBatch returns false (stale, no landed signal) when a merge is retryable', async () => {
  const { promise, records } = runPromotion({
    entries: [1],
    candidateShas: [CAND1],
    mergePullRequest: async () => ({ ok: false, retryable: true, reason: 'not mergeable' }),
  });
  assert.equal(await promise, false);
  assert.equal(records.landedLabels.length, 0);
  assert.equal(records.postconditions.length, 0);
});

test('promoteExactBatch idempotently lands a partial batch and stops on the first retryable failure', async () => {
  // PR1 merges for real; PR2 is transiently not mergeable. PR1 keeps its
  // landed signal; PR2 gets none; no hard failure (rebuild next reconcile).
  const { promise, records, getMain } = runPromotion({
    mergePullRequest: async (entry) => {
      if (entry.number === 1) return { ok: true, sha: LAND1 };
      return { ok: false, retryable: true, reason: 'behind main; recompute' };
    },
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
  });
  assert.equal(await promise, false);
  assert.deepEqual(records.landedLabels, [{ number: 1, name: LANDED_LABEL }]);
  assert.deepEqual(records.mapping, [{ number: 1, sha: LAND1 }]);
  assert.ok(!records.landedComments.some((c) => c.number === 2));
  assert.equal(records.postconditions.length, 0);
  assert.equal(getMain(), LAND1);
});

test('promoteExactBatch throws + publishes postcondition on a non-retryable merge failure', async () => {
  const { promise, records } = runPromotion({
    entries: [1],
    candidateShas: [CAND1],
    mergePullRequest: async () => ({ ok: false, retryable: false, reason: 'policy rejected' }),
  });
  await assert.rejects(promise, /promotion aborted at pr=#1/);
  assert.equal(records.postconditions.length, 1);
  // Nothing landed (the merge API call itself failed), so there is no landed
  // commit to blame. The postcondition must attach to the confirmed-current
  // real main commit, never a candidate SHA -- candidates are transported as
  // opaque git blobs and are not real commit objects on GitHub, so a
  // check-run posted against one would not resolve.
  assert.equal(records.postconditions[0].sha, BASE);
  assert.equal(records.landedLabels.length, 0);
});

test('promoteExactBatch publishes postcondition on the just-landed prior commit when a later entry hits a non-retryable merge failure', async () => {
  // PR1 lands for real (main advances to LAND1); PR2's merge API call then
  // fails non-retryably. Nothing landed for PR2, so the postcondition must
  // attach to LAND1 -- the confirmed-current real main at that point -- never
  // to CAND2 (PR2's candidate SHA, which is a local-only opaque bundle, not a
  // real GitHub commit) and never to a stale BASE.
  const { promise, records } = runPromotion({
    mergePullRequest: async (entry) => {
      if (entry.number === 1) return { ok: true, sha: LAND1 };
      return { ok: false, retryable: false, reason: 'policy rejected' };
    },
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
  });
  await assert.rejects(promise, /promotion aborted at pr=#2/);
  assert.equal(records.postconditions.length, 1);
  assert.equal(records.postconditions[0].sha, LAND1);
  assert.deepEqual(records.landedLabels, [{ number: 1, name: LANDED_LABEL }]);
});

test('promoteExactBatch fails closed (returns false) when main moved before a merge (base-CAS)', async () => {
  const { promise, records } = runPromotion({ startMain: 'b'.repeat(40) });
  assert.equal(await promise, false);
  assert.equal(records.merges.length, 0);
  assert.equal(records.landedLabels.length, 0);
});

test('promoteExactBatch refuses to promote a PR with an armed auto-merge', async () => {
  const { promise, records } = runPromotion({ autoMergeNumbers: [2] });
  assert.equal(await promise, false);
  assert.equal(records.merges.length, 0);
});

test('promoteExactBatch fails closed when batch validation evidence is lost between merges', async () => {
  let checks = 0;
  const { promise, records } = runPromotion({
    verifyCandidateEvidence: async () => {
      checks += 1;
      return checks === 1;
    },
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
  });
  assert.equal(await promise, false);
  assert.deepEqual(
    records.merges.map((m) => m.number),
    [1],
  );
  assert.deepEqual(records.landedLabels, [{ number: 1, name: LANDED_LABEL }]);
  assert.ok(!records.landedComments.some((c) => c.number === 2));
});

test('promoteExactBatch never merges when batch validation evidence is absent', async () => {
  const { promise, records } = runPromotion({
    entries: [1],
    candidateShas: [CAND1],
    verifyCandidateEvidence: async () => false,
  });
  assert.equal(await promise, false);
  assert.equal(records.merges.length, 0);
  assert.equal(records.landedLabels.length, 0);
});

test('promoteExactBatch does nothing in dry-run mode', async () => {
  const { promise, records } = runPromotion({ live: false });
  assert.equal(await promise, false);
  assert.equal(records.merges.length, 0);
  assert.equal(records.landedLabels.length, 0);
});

test('promoteExactBatch promotes a validated candidate regardless of main-alone health (ADR 0077)', async () => {
  // BEFORE: `reattestHealth` was a final main-health re-check immediately before
  // the merge API call, so a green composite on a red `main` was refused --
  // deadlocking any PR that FIXES `main`. AFTER: main health is not consulted on
  // the promotion path at all. A legacy caller still passing the removed option
  // must not be able to block the merge.
  const { promise, records } = runPromotion({ reattestHealth: async () => false });
  assert.equal(await promise, true);
  assert.equal(records.merges.length, 2);
});

test('promoteExactBatch blocks a merge when the final merge-slot recheck fails', async () => {
  const { promise, records } = runPromotion({
    entries: [1],
    candidateShas: [CAND1],
    verifyMergeSlot: async () => 'ci-conflict coordinator currently selects #2',
  });
  assert.equal(await promise, false);
  assert.deepEqual(records.merges, []);
});

test('promoteExactBatch fails closed when main moves during the coordinator slot verification', async () => {
  // The base-CAS check passes (main === BASE), then verifyMergeSlot runs the
  // coordinator scan (fetches files, comments, checks, git proofs for all
  // group members). During that scan an external writer advances main. The
  // post-verifyMergeSlot re-read must catch the drift and return false before
  // issuing the merge PUT.
  const EXTERNAL_SHA = '9'.repeat(40);
  let main = BASE;
  const merges = [];
  const result = await promoteExactBatch({
    entries: [makePromoPr(1)],
    candidateShas: [CAND1],
    expectedBase: BASE,
    repository: REPO,
    live: true,
    fetchCurrentPr: async () => makePromoPr(1),
    fetchCurrentMain: async () => main,
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
    eligible: async () => ({ ok: true }),
    git: (args) =>
      args[0] === 'rev-parse'
        ? args[1]?.endsWith('^{tree}')
          ? TREE1
          : args[1]?.endsWith('^')
            ? BASE
            : args[1]
        : '',
    mergePullRequest: async (entry, args) => {
      merges.push({ number: entry.number, ...args });
      main = LAND1;
      return { ok: true, sha: LAND1 };
    },
    setLabel: async () => {},
    removeLabel: async () => {},
    updateStatus: async () => {},
    postLandedComment: async () => {},
    publishPostconditionCheck: async () => {},
    recordMapping: () => {},
    verifyCandidateEvidence: async () => true,
    verifyMergeSlot: async () => {
      // Simulate main advancing while the coordinator scan was running.
      main = EXTERNAL_SHA;
      return null; // the verifier itself found no blocking reason
    },
    proofSleep: async () => {},
  });
  // The post-verifyMergeSlot re-read detects EXTERNAL_SHA !== BASE and must
  // rebuild without issuing the merge PUT.
  assert.equal(result, false);
  assert.deepEqual(merges, []);
});

test('promoteExactBatch fails closed when admission policy changes during the coordinator slot verification', async () => {
  // The per-PR admission check passes before verifyMergeSlot, then verifyMergeSlot
  // returns null (no blocking reason). During the scan a review thread is opened,
  // making the PR no longer admission-eligible. The post-slot admission re-check
  // must catch this and return false before the merge PUT.
  const merges = [];
  let slotVerified = false;
  const result = await promoteExactBatch({
    entries: [makePromoPr(1)],
    candidateShas: [CAND1],
    expectedBase: BASE,
    repository: REPO,
    live: true,
    fetchCurrentPr: async () => makePromoPr(1),
    fetchCurrentMain: async () => BASE,
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
    eligible: async () => {
      // Pass on all pre-slot calls; only fail after the coordinator scan runs.
      if (slotVerified) return { ok: false, reason: 'unresolved review thread' };
      return { ok: true };
    },
    git: (args) =>
      args[0] === 'rev-parse'
        ? args[1]?.endsWith('^{tree}')
          ? TREE1
          : args[1]?.endsWith('^')
            ? BASE
            : args[1]
        : '',
    mergePullRequest: async (entry, args) => {
      merges.push({ number: entry.number, ...args });
      return { ok: true, sha: LAND1 };
    },
    setLabel: async () => {},
    removeLabel: async () => {},
    updateStatus: async () => {},
    postLandedComment: async () => {},
    publishPostconditionCheck: async () => {},
    recordMapping: () => {},
    verifyCandidateEvidence: async () => true,
    verifyMergeSlot: async () => {
      // Simulate admission state changing while the coordinator scan ran.
      slotVerified = true;
      return null; // the verifier itself found no blocking reason
    },
    proofSleep: async () => {},
  });
  // The post-slot admission re-check detects the changed policy and must rebuild
  // without issuing the merge PUT.
  assert.equal(result, false);
  assert.deepEqual(merges, []);
});

test('promoteExactBatch fails closed when auto_merge is re-armed during the coordinator slot verification', async () => {
  // The per-PR auto_merge check passes (auto_merge === null) before verifyMergeSlot.
  // A competing actor re-arms auto_merge during the coordinator scan. The post-slot
  // admission re-check must catch this and return false before the merge PUT.
  const merges = [];
  let slotVerified = false;
  const result = await promoteExactBatch({
    entries: [makePromoPr(1)],
    candidateShas: [CAND1],
    expectedBase: BASE,
    repository: REPO,
    live: true,
    fetchCurrentPr: async () => makePromoPr(1, { autoMerge: slotVerified ? {} : null }),
    fetchCurrentMain: async () => BASE,
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
    eligible: async () => ({ ok: true }),
    git: (args) =>
      args[0] === 'rev-parse'
        ? args[1]?.endsWith('^{tree}')
          ? TREE1
          : args[1]?.endsWith('^')
            ? BASE
            : args[1]
        : '',
    mergePullRequest: async (entry, args) => {
      merges.push({ number: entry.number, ...args });
      return { ok: true, sha: LAND1 };
    },
    setLabel: async () => {},
    removeLabel: async () => {},
    updateStatus: async () => {},
    postLandedComment: async () => {},
    publishPostconditionCheck: async () => {},
    recordMapping: () => {},
    verifyCandidateEvidence: async () => true,
    verifyMergeSlot: async () => {
      // Simulate auto_merge being re-armed during the coordinator scan.
      slotVerified = true;
      return null; // the verifier itself found no blocking reason
    },
    proofSleep: async () => {},
  });
  // The post-slot auto_merge re-check detects the re-arming and must rebuild
  // without issuing the merge PUT.
  assert.equal(result, false);
  assert.deepEqual(merges, []);
});

test('promoteExactBatch fails closed and publishes postcondition when final main guard sees main moved after promotion', async () => {
  // After both PRs are merged and their per-PR proofs pass, an external writer
  // advances main. The final guard must detect this (after exhausting its zero-
  // delay poll budget) and publish the postcondition on the last landed commit.
  // We advance main inside the last removeLabel call — after the per-PR proof
  // already passed — so the proof sees LAND1 and the final guard sees the
  // unexpected SHA.
  let main = BASE;
  const postconditions = [];
  let removeLabelCalled = false;
  const EXTERNAL_SHA = '9'.repeat(40);

  const result = promoteExactBatch({
    entries: [makePromoPr(1)],
    candidateShas: [CAND1],
    expectedBase: BASE,
    repository: REPO,
    live: true,
    fetchCurrentPr: async () => makePromoPr(1, { merged: main === LAND1 }),
    fetchCurrentMain: async () => main,
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
    eligible: async () => ({ ok: true }),
    git: (args) => (args[1] === `${CAND1}^{tree}` ? TREE1 : args[1] === `${CAND1}^` ? BASE : ''),
    mergePullRequest: async () => {
      main = LAND1;
      return { ok: true, sha: LAND1 };
    },
    setLabel: async () => {},
    removeLabel: async () => {
      if (!removeLabelCalled) {
        // Move main to an unexpected SHA after proof succeeded but before the
        // final guard reads it. The final guard must catch this and fail closed.
        removeLabelCalled = true;
        main = EXTERNAL_SHA;
      }
    },
    updateStatus: async () => {},
    postLandedComment: async () => {},
    publishPostconditionCheck: async (sha) => {
      postconditions.push(sha);
    },
    recordMapping: () => {},
    // Zero-delay poll: one attempt in both the per-PR proof and the final guard.
    proofPollDelaysMs: [],
    proofSleep: async () => {},
  });
  await assert.rejects(result, (error) => {
    assert.ok(isMergeTrainPromotionError(error));
    assert.match(error.message, /main moved.*after promotion/);
    return true;
  });
  // Postcondition published on the last landed commit, not the external SHA.
  assert.deepEqual(postconditions, [LAND1]);
});

test('promoteExactBatch final main guard tolerates a transient fetchCurrentMain error and succeeds on retry', async () => {
  // The first call to fetchCurrentMain in the final guard throws; the second
  // returns the correct landed SHA. The guard must NOT fail closed on a transient
  // network error during the final check.
  let main = BASE;
  let finalGuardCallCount = 0;
  // Track which calls are "in the final guard" by counting all fetchCurrentMain
  // calls in the harness: initial (1) + final-reattest (1) + base-CAS (1) +
  // per-PR proof (1) = 4 calls before the final guard. The 5th+ are the guard.
  let totalCalls = 0;

  const result = await promoteExactBatch({
    entries: [makePromoPr(1)],
    candidateShas: [CAND1],
    expectedBase: BASE,
    repository: REPO,
    live: true,
    fetchCurrentPr: async () => makePromoPr(1, { merged: main === LAND1 }),
    fetchCurrentMain: async () => {
      totalCalls += 1;
      if (totalCalls > 4 && finalGuardCallCount === 0) {
        finalGuardCallCount += 1;
        throw new Error('transient network error');
      }
      return main;
    },
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
    eligible: async () => ({ ok: true }),
    git: (args) => (args[1] === `${CAND1}^{tree}` ? TREE1 : args[1] === `${CAND1}^` ? BASE : ''),
    mergePullRequest: async () => {
      main = LAND1;
      return { ok: true, sha: LAND1 };
    },
    setLabel: async () => {},
    removeLabel: async () => {},
    updateStatus: async () => {},
    postLandedComment: async () => {},
    publishPostconditionCheck: async () => {},
    recordMapping: () => {},
    // One retry delay so the guard retries after the transient error.
    proofPollDelaysMs: [0],
    proofSleep: async () => {},
  });
  assert.equal(result, true);
  assert.ok(finalGuardCallCount >= 1, 'final guard retried after transient error');
});

test('promoteExactBatch still returns true when a post-merge label/comment update hiccups', async () => {
  // A landed PR is genuinely merged; a labeling error must not abort the batch
  // or re-close anything (startup reconciliation backfills next run).
  const records = { merges: [] };
  let main = BASE;
  const result = await promoteExactBatch({
    entries: [makePromoPr(1)],
    candidateShas: [CAND1],
    expectedBase: BASE,
    repository: REPO,
    live: true,
    fetchCurrentPr: async () => makePromoPr(1, { merged: main === LAND1 }),
    fetchCurrentMain: async () => main,
    fetchCommit: async (sha) => ({
      sha,
      parents: [{ sha: BASE }],
      commit: { tree: { sha: TREE1 } },
    }),
    eligible: async () => ({ ok: true }),
    git: (args) => (args[1] === `${CAND1}^{tree}` ? TREE1 : args[1] === `${CAND1}^` ? BASE : ''),
    mergePullRequest: async () => {
      main = LAND1;
      return { ok: true, sha: LAND1 };
    },
    setLabel: async () => {
      throw new Error('label API flaked');
    },
    removeLabel: async () => {},
    updateStatus: async () => {},
    postLandedComment: async () => {},
    publishPostconditionCheck: async () => {},
    recordMapping: () => {},
  });
  assert.equal(result, true);
  void records;
});

// ---- createMergePullRequest ----

function mergeRequestStub(responders) {
  const calls = [];
  const request = async (token, path, options = {}) => {
    calls.push({ path, options });
    const responder = responders(path, options, calls.length);
    if (responder instanceof Error) throw responder;
    return { data: responder };
  };
  return { request, calls };
}

const mergeableOpen = { head: { sha: HEAD1 }, mergeable: true, mergeable_state: 'clean' };

test('createMergePullRequest squash-merges once mergeable and returns the real merge SHA', async () => {
  const { request, calls } = mergeRequestStub((path, options) => {
    if (options.method === 'PUT') return { merged: true, sha: LAND1 };
    return mergeableOpen;
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 'feat (#1)', commitMessage: 'Merge-Train-PR: 1' },
  );
  assert.deepEqual(result, { ok: true, sha: LAND1 });
  const put = calls.find((c) => c.options.method === 'PUT');
  assert.equal(put.options.body.sha, HEAD1);
  assert.equal(put.options.body.merge_method, 'squash');
  assert.equal(put.options.body.commit_title, 'feat (#1)');
});

test('createMergePullRequest waits for GitHub to finish computing mergeability', async () => {
  let poll = 0;
  const { request } = mergeRequestStub((path, options) => {
    if (options.method === 'PUT') return { merged: true, sha: LAND1 };
    poll += 1;
    return { head: { sha: HEAD1 }, mergeable: poll >= 2 ? true : null };
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.equal(result.ok, true);
  assert.ok(poll >= 2);
});

test('createMergePullRequest treats a moved head as retryable and never merges', async () => {
  const { request, calls } = mergeRequestStub(() => ({ head: { sha: HEAD2 }, mergeable: true }));
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.ok(!calls.some((c) => c.options.method === 'PUT'));
});

test('createMergePullRequest treats mergeable:false as retryable', async () => {
  const { request } = mergeRequestStub(() => ({
    head: { sha: HEAD1 },
    mergeable: false,
    mergeable_state: 'dirty',
  }));
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

for (const status of [405, 409]) {
  test(`createMergePullRequest treats a ${status} merge rejection as retryable`, async () => {
    const { request } = mergeRequestStub((path, options) => {
      if (options.method === 'PUT') {
        const error = new Error(`merge blocked (${status})`);
        error.status = status;
        return error;
      }
      return mergeableOpen;
    });
    const mergePullRequest = createMergePullRequest({
      request,
      token: 't',
      owner: 'o',
      repo: 'r',
      sleep: async () => {},
    });
    const result = await mergePullRequest(
      { number: 1 },
      { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
  });
}

test('createMergePullRequest returns a non-retryable result on a policy/configuration failure (403)', async () => {
  const { request } = mergeRequestStub((path, options) => {
    if (options.method === 'PUT') {
      const error = new Error('bypass not configured');
      error.status = 403;
      return error;
    }
    return mergeableOpen;
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason, /\(403\)/);
});

test('createMergePullRequest returns a non-retryable result when the merge is not recorded merged', async () => {
  const { request } = mergeRequestStub((path, options) => {
    if (options.method === 'PUT') return { merged: false, sha: null };
    return mergeableOpen;
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason, /did not record PR #1 as merged/);
});

test('createMergePullRequest treats a mergeability-poll GET failure as retryable (never throws)', async () => {
  const { request } = mergeRequestStub(() => {
    const error = new Error('service unavailable');
    error.status = 503;
    return error;
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.reason, /mergeability poll failed \(503\)/);
});

test('createMergePullRequest disambiguates an ambiguous PUT failure that actually merged', async () => {
  // The PUT 5xx-fails after GitHub merged the PR; a re-read shows it merged with
  // a real commit, so we return that SHA (ok:true) for the caller to prove.
  let putAttempted = false;
  const { request } = mergeRequestStub((path, options) => {
    if (options.method === 'PUT') {
      putAttempted = true;
      const error = new Error('gateway timeout');
      error.status = 504;
      return error;
    }
    // The mergeability GET before PUT; the disambiguation GET after PUT.
    return putAttempted
      ? { head: { sha: HEAD1 }, merged: true, merge_commit_sha: LAND1 }
      : mergeableOpen;
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.deepEqual(result, { ok: true, sha: LAND1 });
});

test('createMergePullRequest polls disambiguation when first read is stale (merged:false) then resolves', async () => {
  // Merged-state can lag ~20s on read replicas. The disambiguation loop must not
  // conclude the PUT failed on the first stale read -- it should keep polling
  // until a consistent replica returns merged:true.
  let putAttempted = false;
  let disambigReads = 0;
  const { request } = mergeRequestStub((path, options) => {
    if (options.method === 'PUT') {
      putAttempted = true;
      const error = new Error('gateway timeout');
      error.status = 504;
      return error;
    }
    if (!putAttempted) return mergeableOpen;
    disambigReads += 1;
    // First disambiguation read returns stale merged:false; second returns truth.
    return disambigReads < 2
      ? { head: { sha: HEAD1 }, merged: false, merge_commit_sha: null }
      : { head: { sha: HEAD1 }, merged: true, merge_commit_sha: LAND1 };
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.deepEqual(result, { ok: true, sha: LAND1 });
  assert.ok(disambigReads >= 2, 'should have polled at least twice for merged state');
});

test('createMergePullRequest returns non-retryable when an ambiguous PUT failure did not merge', async () => {
  let putAttempted = false;
  const { request } = mergeRequestStub((path, options) => {
    if (options.method === 'PUT') {
      putAttempted = true;
      const error = new Error('gateway timeout');
      error.status = 504;
      return error;
    }
    return putAttempted
      ? { head: { sha: HEAD1 }, merged: false, merge_commit_sha: null }
      : mergeableOpen;
  });
  const mergePullRequest = createMergePullRequest({
    request,
    token: 't',
    owner: 'o',
    repo: 'r',
    sleep: async () => {},
  });
  const result = await mergePullRequest(
    { number: 1 },
    { expectedHeadSha: HEAD1, commitTitle: 't', commitMessage: 'm' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason, /merge API failed \(504\)/);
});

// ---- landedCommitProofError ----

const proofDefaults = {
  entry: { number: 1 },
  index: 0,
  landedSha: LAND1,
  expectedParent: BASE,
  expectedTree: TREE1,
  fetchCurrentMain: async () => LAND1,
  fetchCurrentPr: async () => ({
    merged: true,
    merged_at: '2026-07-15T00:00:00Z',
    merge_commit_sha: LAND1,
  }),
  fetchCommit: async () => ({ parents: [{ sha: BASE }], commit: { tree: { sha: TREE1 } } }),
  sleep: async () => {},
};

test('landedCommitProofError returns null when every invariant holds', async () => {
  assert.equal(await landedCommitProofError({ ...proofDefaults }), null);
});

test('landedCommitProofError rejects a merged PR whose recorded merge commit is not the landed sha', async () => {
  assert.match(
    await landedCommitProofError({
      ...proofDefaults,
      fetchCurrentPr: async () => ({
        merged: true,
        merged_at: '2026-07-15T00:00:00Z',
        merge_commit_sha: HEAD2,
      }),
    }),
    /recorded merge commit for PR #1 is .* \(expected the landed/,
  );
});

test('landedCommitProofError polls through read-replica lag before succeeding', async () => {
  // main ref and PR merged-state are stale for the first two reads (replica
  // lag), then catch up. The proof must NOT fail closed on the transient lag.
  let mainReads = 0;
  let prReads = 0;
  const error = await landedCommitProofError({
    ...proofDefaults,
    fetchCurrentMain: async () => {
      mainReads += 1;
      return mainReads >= 3 ? LAND1 : BASE;
    },
    fetchCurrentPr: async () => {
      prReads += 1;
      return prReads >= 3
        ? { merged: true, merged_at: '2026-07-15T00:00:00Z', merge_commit_sha: LAND1 }
        : { merged: false, merged_at: null };
    },
  });
  assert.equal(error, null);
  assert.ok(mainReads >= 3 && prReads >= 3);
});

test('landedCommitProofError retries a transient read failure instead of failing closed', async () => {
  // A transient 5xx on the main/PR read must be retried within the budget, not
  // rejected immediately (which would bypass the caller's postcondition publish).
  let mainReads = 0;
  const error = await landedCommitProofError({
    ...proofDefaults,
    fetchCurrentMain: async () => {
      mainReads += 1;
      if (mainReads < 2) throw new Error('503 transient');
      return LAND1;
    },
  });
  assert.equal(error, null);
  assert.ok(mainReads >= 2);
});

test('landedCommitProofError retries a transient fetchCurrentPr failure instead of failing closed', async () => {
  // The same per-attempt retry budget applies to fetchCurrentPr as to fetchCurrentMain.
  let prReads = 0;
  const error = await landedCommitProofError({
    ...proofDefaults,
    fetchCurrentPr: async () => {
      prReads += 1;
      if (prReads < 2) throw new Error('503 transient');
      return { merged: true, merged_at: '2026-07-15T00:00:00Z', merge_commit_sha: LAND1 };
    },
  });
  assert.equal(error, null);
  assert.ok(prReads >= 2);
});

test('landedCommitProofError rejects an invalid landed SHA', async () => {
  assert.match(
    await landedCommitProofError({ ...proofDefaults, landedSha: 'nope' }),
    /invalid landed sha/,
  );
});

test('landedCommitProofError rejects when main is not the landed commit', async () => {
  assert.match(
    await landedCommitProofError({ ...proofDefaults, fetchCurrentMain: async () => BASE }),
    /main is .*, not the landed commit/,
  );
});

test('landedCommitProofError rejects a non-linear (multi-parent) landed commit', async () => {
  assert.match(
    await landedCommitProofError({
      ...proofDefaults,
      fetchCommit: async () => ({
        parents: [{ sha: BASE }, { sha: HEAD1 }],
        commit: { tree: { sha: TREE1 } },
      }),
    }),
    /has 2 parents/,
  );
});

test('landedCommitProofError rejects a wrong parent (base moved under the merge)', async () => {
  assert.match(
    await landedCommitProofError({
      ...proofDefaults,
      fetchCommit: async () => ({ parents: [{ sha: HEAD2 }], commit: { tree: { sha: TREE1 } } }),
    }),
    /parent is .* \(expected/,
  );
});

test('landedCommitProofError rejects a divergent tree', async () => {
  assert.match(
    await landedCommitProofError({
      ...proofDefaults,
      fetchCommit: async () => ({ parents: [{ sha: BASE }], commit: { tree: { sha: TREE2 } } }),
    }),
    /tree .* != validated candidate prefix tree/,
  );
});

test('landedCommitProofError rejects a PR GitHub did not record as merged (closed-not-merged is forbidden)', async () => {
  assert.match(
    await landedCommitProofError({
      ...proofDefaults,
      fetchCurrentPr: async () => ({ merged: false, state: 'closed', merged_at: null }),
    }),
    /did not record PR #1 as merged/,
  );
});

test('landedCommitProofError rejects a merged PR with no merged_at timestamp', async () => {
  assert.match(
    await landedCommitProofError({
      ...proofDefaults,
      fetchCurrentPr: async () => ({ merged: true, merged_at: null }),
    }),
    /no merged_at timestamp/,
  );
});

// ---- planLandedRecovery (crash-recovery decision for an interrupted landing) ----

const recoveryDefaults = {
  merged: true,
  baseRef: 'main',
  landedSha: LAND1,
  trailerPrNumber: 42,
  prNumber: 42,
  parentCount: 1,
  hasPostconditionFailure: false,
  hasLandedLabel: true,
  factsComplete: true,
};

test('planLandedRecovery finishes a fully-proven interrupted landing', () => {
  assert.deepEqual(planLandedRecovery({ ...recoveryDefaults }), {
    action: 'finish',
    reason: 'proven interrupted landing',
  });
});

test('planLandedRecovery skips a closed-but-unmerged PR', () => {
  assert.equal(planLandedRecovery({ ...recoveryDefaults, merged: false }).action, 'skip');
});

test('planLandedRecovery skips a PR merged into another branch', () => {
  assert.equal(planLandedRecovery({ ...recoveryDefaults, baseRef: 'release' }).action, 'skip');
});

test('planLandedRecovery skips when the merge commit sha is invalid', () => {
  assert.equal(planLandedRecovery({ ...recoveryDefaults, landedSha: '' }).action, 'skip');
});

test('planLandedRecovery skips a merge lacking this PR provenance trailer', () => {
  const decision = planLandedRecovery({ ...recoveryDefaults, trailerPrNumber: null });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /provenance trailer/);
});

test('planLandedRecovery skips a merge attributed to a different PR', () => {
  assert.equal(planLandedRecovery({ ...recoveryDefaults, trailerPrNumber: 99 }).action, 'skip');
});

test('planLandedRecovery skips a non-linear landed commit', () => {
  const decision = planLandedRecovery({ ...recoveryDefaults, parentCount: 2 });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /linear/);
});

test('planLandedRecovery skips a landing with a promotion-postcondition failure (possible divergence)', () => {
  const decision = planLandedRecovery({ ...recoveryDefaults, hasPostconditionFailure: true });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /postcondition failure/);
});

test('planLandedRecovery skips a markerless landing (crash may have occurred before tree proof)', () => {
  const decision = planLandedRecovery({ ...recoveryDefaults, hasLandedLabel: false });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /LANDED_LABEL proof-complete marker is absent/);
});

test('planLandedRecovery retries when recovery proof facts could not all be read', () => {
  const decision = planLandedRecovery({ ...recoveryDefaults, factsComplete: false });
  assert.equal(decision.action, 'retry');
  assert.match(decision.reason, /could not reconstruct all landed-commit proof facts/);
});

test('applyLandedRecoveryDecision finishes proof-complete recovery before secondary cleanup', async () => {
  const calls = [];
  await applyLandedRecoveryDecision({
    prNumber: 42,
    landedSha: LAND1,
    decision: { action: 'finish', reason: 'proven interrupted landing' },
    postLandedComment: async (...args) => calls.push(['comment', ...args]),
    setLabel: async (...args) => calls.push(['set', ...args]),
    removeLabel: async (...args) => calls.push(['remove', ...args]),
  });

  assert.deepEqual(calls, [
    ['comment', 42, LAND1, '', true],
    ['remove', 42, QUEUE_LABEL],
    ['remove', 42, BLOCKED_LABEL],
    ['remove', 42, RECOVERY_PENDING_LABEL],
  ]);
});

test('applyLandedRecoveryDecision moves indeterminate recovery off the queue label', async () => {
  const calls = [];
  await applyLandedRecoveryDecision({
    prNumber: 42,
    landedSha: LAND1,
    decision: { action: 'retry', reason: 'transient evidence read' },
    postLandedComment: async (...args) => calls.push(['comment', ...args]),
    setLabel: async (...args) => calls.push(['set', ...args]),
    removeLabel: async (...args) => calls.push(['remove', ...args]),
  });

  assert.deepEqual(calls, [
    ['set', 42, RECOVERY_PENDING_LABEL],
    ['remove', 42, QUEUE_LABEL],
  ]);
});

test('applyLandedRecoveryDecision clears only transient labels for an unprovable closure', async () => {
  const calls = [];
  await applyLandedRecoveryDecision({
    prNumber: 42,
    landedSha: LAND1,
    decision: { action: 'skip', reason: 'not a train landing' },
    postLandedComment: async (...args) => calls.push(['comment', ...args]),
    setLabel: async (...args) => calls.push(['set', ...args]),
    removeLabel: async (...args) => calls.push(['remove', ...args]),
  });

  assert.deepEqual(calls, [
    ['remove', 42, QUEUE_LABEL],
    ['remove', 42, RECOVERY_PENDING_LABEL],
  ]);
});
