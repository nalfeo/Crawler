import { execFileSync } from 'node:child_process';

import { listReviewThreads, paginate, request, graphql } from '../ci-recovery/github.mjs';
import {
  isTrainFastPathPushRun,
  parseStateComment,
  STATE_MARKER as RECOVERY_STATE_MARKER,
} from '../ci-recovery/state.mjs';
import {
  buildCandidate,
  buildDispatchBindings,
  createMergePullRequest,
  isDisabledTrainScheduleRun,
  isMergeTrainConflictError,
  isMergeTrainNoopError,
  mainHealthReason,
  planLandedRecovery,
  promoteExactBatch,
  promotionStaleReason,
  resolveMergeTrainTokens,
  trainCheckTitle,
} from './reconcile-lib.mjs';
import {
  BLOCKED_LABEL,
  CANDIDATE_CHECK_NAME,
  admissionFingerprint,
  candidateFingerprint,
  candidateRef,
  hasLeadingMarker,
  LANDED_LABEL,
  LANDED_MARKER,
  MAX_TRAIN_SIZE,
  NOOP_LABEL,
  parseEnabledFlag,
  parseMergeTrainPrNumber,
  planPrefixPromotion,
  PROMOTION_POSTCONDITION_CHECK_NAME,
  QUEUE_LABEL,
  queueEntries,
  resolveAdmissionChecks,
  renderLandedComment,
  renderStatus,
  STATUS_MARKER,
  successfulChecks,
  trainCheckState,
  VALIDATION_FAILED_LABEL,
} from './state.mjs';

const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const { promotionToken: token, workflowDispatchToken } = resolveMergeTrainTokens(process.env);
const enabled = parseEnabledFlag(process.env.MERGE_TRAIN_ENABLED);
const requiredAdmissionChecks = resolveAdmissionChecks(process.env.MERGE_TRAIN_ADMISSION_CHECKS);
const trustedAppId = Number.parseInt(process.env.MERGE_TRAIN_APP_ID || '', 10);

if (!owner || !repo || !token || !Number.isInteger(trustedAppId)) {
  throw new Error('Merge train requires GITHUB_REPOSITORY, a GitHub token, and MERGE_TRAIN_APP_ID');
}
if (!enabled) {
  process.stdout.write('Merge train is disabled\n');
  process.exit(0);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) },
  }).trim();
}

async function checkRuns(sha) {
  const response = await request(
    token,
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  return response.data.check_runs || [];
}

async function workflowRunJobs(runId) {
  const response = await request(
    token,
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return response.data.jobs || [];
}

async function ensureLabel(name, color, description) {
  try {
    await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: { name, color, description },
    });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
}

async function setLabel(prNumber, name) {
  await request(token, `/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
    method: 'POST',
    body: { labels: [name] },
  });
}

async function removeLabel(prNumber, name) {
  try {
    await request(
      token,
      `/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function updateStatus(prNumber, status) {
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`);
  const stateComments = comments.filter((comment) => hasLeadingMarker(comment.body, STATUS_MARKER));
  if (stateComments.length > 1) {
    throw new Error(`PR #${prNumber} has duplicate merge-train state comments`);
  }
  if (stateComments[0]) {
    await request(token, `/repos/${owner}/${repo}/issues/comments/${stateComments[0].id}`, {
      method: 'PATCH',
      body: { body: status },
    });
  } else {
    await request(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: { body: status },
    });
  }
}

async function eligible(pr) {
  const runs = await checkRuns(pr.head.sha);
  if (!successfulChecks(runs, requiredAdmissionChecks)) {
    return { ok: false, reason: `waiting for ${requiredAdmissionChecks.join(', ')}` };
  }
  const review = await listReviewThreads(token, owner, repo, pr.number);
  if (review.threads.some((thread) => !thread.isResolved)) {
    return { ok: false, reason: 'unresolved review threads' };
  }
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${pr.number}/comments`);
  const stateComments = comments.filter((comment) =>
    hasLeadingMarker(comment.body, RECOVERY_STATE_MARKER),
  );
  if (stateComments.length !== 1) {
    return {
      ok: false,
      reason: `expected one CI recovery state comment, found ${stateComments.length}`,
    };
  }
  const state = parseStateComment(stateComments[0].body);
  const fingerprint = admissionFingerprint({
    headSha: pr.head.sha,
    title: pr.title,
    baseRef: pr.base?.ref,
    checkRuns: runs,
    requiredNames: requiredAdmissionChecks,
    reviewThreads: review.threads,
  });
  if (state.headSha !== pr.head.sha || state.fingerprint !== fingerprint) {
    return { ok: false, reason: 'CI recovery admission evidence is stale' };
  }
  return { ok: true, fingerprint };
}

async function createTrainCheck(
  sha,
  fingerprint,
  status,
  conclusion = undefined,
  name = CANDIDATE_CHECK_NAME,
  entries = [],
) {
  await request(token, `/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    body: {
      name,
      head_sha: sha,
      status,
      external_id: fingerprint,
      ...(conclusion ? { conclusion } : {}),
      output: {
        title: trainCheckTitle(status, conclusion),
        summary: [
          `Fingerprint: ${fingerprint}`,
          `PR order: ${entries.map((entry) => `#${entry.number}`).join(', ') || 'none'}`,
        ].join('\n'),
      },
    },
  });
}

const { dispatchRecovery, dispatchValidation: baseDispatchValidation } = buildDispatchBindings({
  request,
  workflowDispatchToken,
  owner,
  repo,
});

// Bound on how many recent push-triggered CI runs we inspect (and fetch
// check-runs for) when looking for evidence on the current main SHA. Main
// only advances via merge-train promotions or rare direct pushes, so the
// exact-SHA match will normally be found within the first entry; this cap
// keeps the check-run fan-out small and predictable either way.
const MAIN_HEALTH_PUSH_RUN_LOOKBACK = 5;

async function mainHealthAllowsPromotion() {
  const currentMainSha = (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data
    .object.sha;
  const [scheduleResponse, pushResponse] = await Promise.all([
    request(
      token,
      `/repos/${owner}/${repo}/actions/workflows/ci.yml/runs?event=schedule&branch=main&per_page=20`,
    ),
    request(
      token,
      `/repos/${owner}/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=${MAIN_HEALTH_PUSH_RUN_LOOKBACK}`,
    ),
  ]);
  const scheduleRuns = [];
  for (const run of scheduleResponse.data.workflow_runs || []) {
    if (run.head_sha !== currentMainSha) {
      // Runs for other SHAs are filtered by mainHealthReason; no need to
      // fetch jobs for them.
      scheduleRuns.push({ ...run, isTrainFastPath: false });
      continue;
    }
    // For schedule runs on the current main SHA, verify they ran the full CI
    // gate. When MERGE_TRAIN_ENABLED=false, ci.yml skips the `changes` job on
    // schedule events, so the run completes as success without real CI work.
    // Such a no-op run must not be treated as authoritative health evidence.
    const jobs = await workflowRunJobs(run.id);
    scheduleRuns.push({ ...run, isTrainFastPath: isDisabledTrainScheduleRun(jobs) });
  }
  const candidatePushRuns = (pushResponse.data.workflow_runs || []).filter(
    (run) => run.head_sha === currentMainSha,
  );
  const pushRuns = [];
  for (const run of candidatePushRuns) {
    const runs = await checkRuns(run.head_sha);
    pushRuns.push({ ...run, isTrainFastPath: isTrainFastPathPushRun(run, trustedAppId, runs) });
  }
  const reason = mainHealthReason({
    mainSha: currentMainSha,
    runs: [...scheduleRuns, ...pushRuns],
  });
  if (reason) {
    process.stdout.write(`paused merge train; ${reason}\n`);
    return false;
  }
  return true;
}

// Real GitHub squash-merge promotion. `mergePullRequest` merges each admitted
// PR through GitHub's own Merge API (the App bypasses the required-check
// ruleset), producing genuine `merged: true` + a real merge commit SHA -- the
// completion semantics the old atomic force-push could never produce. The
// bounded mergeability poll absorbs GitHub's async `mergeable` computation.
const mergePullRequest = createMergePullRequest({ request, token, owner, repo });

// Fetch a landed commit's REST object (tree + parents) for the post-merge
// proof in promoteExactBatch.
async function fetchCommit(sha) {
  return (await request(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`)).data;
}

// Publish the fail-closed promotion-postcondition check on the ACTUAL landed
// commit (or the candidate, if nothing landed). Deliberately named
// PROMOTION_POSTCONDITION_CHECK_NAME, never `merge-train`: a `merge-train`
// check on a real landed main commit would masquerade as the fast-path
// attestation ci.yml/mainHealthReason key on.
async function publishPostconditionCheck(sha, fingerprint, entries) {
  await createTrainCheck(
    sha,
    fingerprint,
    'completed',
    'failure',
    PROMOTION_POSTCONDITION_CHECK_NAME,
    entries,
  );
}

// Post the durable landed-completion comment, idempotently (never duplicates
// across reconciles or recovery). `recovered` selects the truthful recovery
// variant (no candidate-tree claim) for interrupted-landing cleanup.
async function postLandedComment(prNumber, landedSha, candidateSha, recovered = false) {
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`);
  if (comments.some((comment) => hasLeadingMarker(comment.body, LANDED_MARKER))) {
    return;
  }
  await request(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: { body: renderLandedComment({ landedSha, candidateSha, recovered }) },
  });
}

// Fence the sequential promotion against the legacy auto-merge path: a PR with
// an armed auto-merge could land out of order underneath the loop (see #1131's
// real merge-then-force-push-2s-later race). Disable it on admission; the lib
// also fails closed if it is still/again armed at final reattestation.
async function disableAutoMerge(pr) {
  if (!pr.auto_merge || !pr.node_id) return;
  try {
    await graphql(
      token,
      `
        mutation ($id: ID!) {
          disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
            clientMutationId
          }
        }
      `,
      { id: pr.node_id },
    );
    process.stdout.write(`disabled armed auto-merge pr=#${pr.number}\n`);
  } catch (error) {
    process.stdout.write(
      `could not disable auto-merge pr=#${pr.number}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

// Whether a promotion-postcondition FAILURE check is recorded on a landed
// commit. That check is published precisely for the rare base-race that would
// have produced a divergent tree, so its presence means recovery must NOT treat
// the landing as clean.
async function landedCommitHasPostconditionFailure(landedSha) {
  const runs = await checkRuns(landedSha);
  return runs.some(
    (run) =>
      run.name === PROMOTION_POSTCONDITION_CHECK_NAME &&
      run.status === 'completed' &&
      run.conclusion === 'failure',
  );
}

// Crash-recovery for an INTERRUPTED landing. A PR still carrying QUEUE_LABEL
// after being merged is an interrupted landing (promotion removes QUEUE last).
// Because the validated candidate is not reconstructable after main advances,
// recovery cannot re-run the per-commit tree proof; instead planLandedRecovery
// (in reconcile-lib) re-establishes the strongest post-hoc evidence -- genuinely
// merged INTO main, this PR's Merge-Train-PR provenance trailer on the merge
// commit, a single (linear) parent, and NO promotion-postcondition failure on
// it -- and refuses anything weaker. This does NOT depend on the LANDED marker
// (whose own write could have failed), so it recovers marker-less merges too,
// and never asserts an unproven or known-divergent landing. Finishing posts the
// truthful RECOVERED comment (no candidate-tree claim) and removes the transient
// labels (BLOCKED first, QUEUE last).
async function reconcileLandedSignals() {
  const staleClosed = await paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=closed&labels=${encodeURIComponent(QUEUE_LABEL)}`,
  );
  for (const item of staleClosed) {
    if (!item.pull_request) continue;
    const pr = (await request(token, `/repos/${owner}/${repo}/pulls/${item.number}`)).data;
    const landedSha = String(pr.merge_commit_sha || '');
    let trailerPrNumber = null;
    let parentCount = 0;
    let hasPostconditionFailure = false;
    let factsComplete = false;
    if (/^[0-9a-f]{40}$/i.test(landedSha)) {
      try {
        const commit = await fetchCommit(landedSha);
        const recoveredTrailerPrNumber = parseMergeTrainPrNumber(commit?.commit?.message || '');
        const recoveredParentCount = (commit?.parents || []).length;
        const recoveredHasPostconditionFailure =
          await landedCommitHasPostconditionFailure(landedSha);
        trailerPrNumber = recoveredTrailerPrNumber;
        parentCount = recoveredParentCount;
        hasPostconditionFailure = recoveredHasPostconditionFailure;
        factsComplete = true;
      } catch {
        // Keep factsComplete false: an unavailable check-runs read is NOT evidence
        // that the postcondition failure check is absent. planLandedRecovery will
        // therefore skip instead of asserting a possibly divergent landing.
      }
    }
    const decision = planLandedRecovery({
      merged: pr.merged,
      baseRef: pr.base?.ref,
      landedSha,
      trailerPrNumber,
      prNumber: pr.number,
      parentCount,
      hasPostconditionFailure,
      factsComplete,
    });
    if (decision.action !== 'finish') {
      process.stdout.write(
        `WARN: pr=#${pr.number} still queued after close but not a provable train landing (${decision.reason}); leaving ${QUEUE_LABEL} for review\n`,
      );
      continue;
    }
    if (!(pr.labels || []).some((label) => label.name === LANDED_LABEL)) {
      await setLabel(pr.number, LANDED_LABEL);
    }
    await postLandedComment(pr.number, landedSha, '', true);
    await removeLabel(pr.number, BLOCKED_LABEL);
    await removeLabel(pr.number, QUEUE_LABEL);
    process.stdout.write(`recovered interrupted landing for pr=#${pr.number} sha=${landedSha}\n`);
  }
}

async function blockEntry(entry, { detail, validationFailure = false }) {
  await setLabel(entry.number, BLOCKED_LABEL);
  if (validationFailure) {
    await setLabel(entry.number, VALIDATION_FAILED_LABEL);
  }
  await removeLabel(entry.number, QUEUE_LABEL);
  await updateStatus(
    entry.number,
    renderStatus({
      position: 0,
      candidateSha: '',
      state: 'blocked',
      detail,
    }),
  );
}

async function deAdmitNoop(entry, detail) {
  await setLabel(entry.number, BLOCKED_LABEL);
  await setLabel(entry.number, NOOP_LABEL);
  await removeLabel(entry.number, QUEUE_LABEL);
  await updateStatus(
    entry.number,
    renderStatus({
      position: 0,
      candidateSha: '',
      state: 'blocked',
      detail,
    }),
  );
  await dispatchRecovery(entry.number, 'merge-train-noop');
}

async function dispatchValidation(sha, fingerprint, entries) {
  await createTrainCheck(sha, fingerprint, 'in_progress', undefined, CANDIDATE_CHECK_NAME, entries);
  try {
    await baseDispatchValidation(sha, fingerprint, entries);
  } catch (error) {
    // Model a dispatch/API failure (workflow_dispatch rejected, token
    // issue, transient network error) as an infrastructure problem, not a
    // candidate code failure: use `cancelled` so trainCheckState() treats
    // it as retryable ("missing") on the next reconciliation instead of
    // being bisected as if the candidate's code actually failed CI.
    await createTrainCheck(sha, fingerprint, 'completed', 'cancelled');
    throw error;
  }
}

await ensureLabel(QUEUE_LABEL, '1f6feb', 'Ready for the repository-managed merge train');
await ensureLabel(BLOCKED_LABEL, 'd1242f', 'Merge-train candidate needs intervention');
await ensureLabel(NOOP_LABEL, 'bf8700', 'PR squash diff is already present in the train base');
await ensureLabel(
  VALIDATION_FAILED_LABEL,
  'd1242f',
  'First failing addition isolated by merge-train validation',
);
await ensureLabel(LANDED_LABEL, '0e8a16', "This PR's change landed on main via the merge train");

// Crash-after-merge recovery runs first, every reconcile: it backfills the
// durable landed signal for any PR that was really merged but whose
// label/comment update did not complete. Cheap in the normal case (successful
// landings remove QUEUE_LABEL, so this query is usually empty).
await reconcileLandedSignals();

const pulls = await paginate(token, `/repos/${owner}/${repo}/pulls?state=open&base=main`);
const queued = queueEntries(pulls, repository);
if (queued.length === 0) {
  process.stdout.write('Merge train is empty\n');
  process.exit(0);
}

const admitted = [];
for (const pr of queued) {
  const admission = await eligible(pr);
  if (admission.ok) {
    // Fence the legacy auto-merge path before this PR can be sequentially
    // squash-merged, so it cannot land out of order underneath the promotion.
    await disableAutoMerge(pr);
    admitted.push(pr);
  } else {
    await removeLabel(pr.number, QUEUE_LABEL);
    await updateStatus(
      pr.number,
      renderStatus({
        position: queued.indexOf(pr) + 1,
        candidateSha: '',
        state: 'waiting',
        detail: admission.reason,
      }),
    );
    await dispatchRecovery(pr.number, 'merge-train-admission-stale');
  }
}

const train = admitted.slice(0, MAX_TRAIN_SIZE);
if (train.length === 0) {
  process.stdout.write('No admitted PR is ready for candidate construction\n');
  process.exit(0);
}

const mainSha = (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data.object
  .sha;
const candidates = [];
for (let index = 0; index < train.length; index += 1) {
  const entries = train.slice(0, index + 1);
  const fingerprint = candidateFingerprint(mainSha, entries);
  const refName = candidateRef(index + 1, fingerprint);
  let candidateSha;
  try {
    candidateSha = buildCandidate({ baseSha: mainSha, entries, refName, git, live: true });
    await removeLabel(train[index].number, BLOCKED_LABEL);
    await removeLabel(train[index].number, VALIDATION_FAILED_LABEL);
  } catch (error) {
    if (isMergeTrainConflictError(error)) {
      await blockEntry(train[index], { detail: error.message });
      const predecessor = train[index - 1]?.number || 0;
      await dispatchRecovery(train[index].number, `merge-train-cumulative-conflict:${predecessor}`);
      process.stdout.write(`returned conflict pr=#${train[index].number} to reconciliation\n`);
      process.exit(0);
    }
    if (isMergeTrainNoopError(error)) {
      await deAdmitNoop(train[index], error.message);
      process.stdout.write(`returned no-op pr=#${train[index].number} to reconciliation\n`);
      process.exit(0);
    }
    await updateStatus(
      train[index].number,
      renderStatus({
        position: index + 1,
        candidateSha: '',
        state: 'waiting',
        detail: error.message,
      }),
    );
    process.stdout.write(
      `retryable candidate build failure pr=#${train[index].number} error=${error.message}\n`,
    );
    process.exit(0);
  }
  git(['fetch', 'origin', `${refName}:refs/remotes/origin/${refName}`, '--force']);
  const state = trainCheckState(
    await checkRuns(candidateSha),
    fingerprint,
    trustedAppId,
    new Date(),
  );
  candidates.push({ candidateSha, entries, fingerprint, refName, state });
  await updateStatus(
    train[index].number,
    renderStatus({
      position: index + 1,
      candidateSha,
      state,
      detail:
        state === 'failure'
          ? 'Candidate validation failed; the merge train will localize the first failing PR and return it to recovery, promoting the validated green prefix before it.'
          : 'Candidate is immutable and bound to the listed PR revisions.',
    }),
  );
}

async function promotePrefix(prefixLength) {
  if (!(await mainHealthAllowsPromotion())) return false;
  const provenanceEntries = train.slice(0, prefixLength);
  return promoteExactBatch({
    entries: provenanceEntries,
    candidateShas: candidates.slice(0, prefixLength).map((candidate) => candidate.candidateSha),
    expectedBase: mainSha,
    repository,
    live: true,
    fetchCurrentPr: async (entry) =>
      (await request(token, `/repos/${owner}/${repo}/pulls/${entry.number}`)).data,
    fetchCurrentMain: async () =>
      (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data.object.sha,
    fetchCommit,
    eligible,
    git,
    mergePullRequest,
    setLabel,
    removeLabel,
    updateStatus,
    postLandedComment,
    publishPostconditionCheck,
    // Re-confirm, immediately before merging each PR, that its cumulative
    // prefix still has terminal SUCCESS validation evidence bound to that
    // prefix's exact candidate SHA + fingerprint.
    verifyPrefixEvidence: async (index) => {
      const candidate = candidates[index];
      const state = trainCheckState(
        await checkRuns(candidate.candidateSha),
        candidate.fingerprint,
        trustedAppId,
        new Date(),
      );
      return state === 'success';
    },
    provenanceEntries,
    reattestHealth: mainHealthAllowsPromotion,
  });
}

// Promotion gate (ADR 0063): every cumulative prefix that will be exposed on
// main must have terminal SUCCESS validation evidence BEFORE any merge, so the
// sequential squash-merges never land an unvalidated tree. `planPrefixPromotion`
// decides the next action from the per-prefix candidate states.
const plan = planPrefixPromotion(candidates.map((candidate) => candidate.state));

if (plan.action === 'validate') {
  // Validate every still-missing prefix in the target range in parallel, so a
  // full batch's validation wall-time is one candidate run, not N serial runs.
  await Promise.all(
    plan.prefixes.map((index) =>
      dispatchValidation(
        candidates[index].candidateSha,
        candidates[index].fingerprint,
        candidates[index].entries,
      ),
    ),
  );
  process.stdout.write(
    `dispatched ${plan.prefixes.length} prefix validation(s) in parallel prefixes=${plan.prefixes
      .map((index) => index + 1)
      .join(',')} total=${train.length}\n`,
  );
  process.exit(0);
}

if (plan.action === 'wait') {
  process.stdout.write(`waiting on prefix validation(s); total=${train.length}\n`);
  process.exit(0);
}

// plan.action === 'promote': the whole [0, greenPrefixLength) is proven green.
// Localize the earliest failing PR FIRST (before promoting the green prefix, so
// promoting does not move main and make the failing-PR reattestation falsely
// stale). No bisection is needed: every promotable prefix was validated, so the
// first failing prefix's last-added PR is the culprit. Reattest against live
// state before mutating so a stale result can't block a PR for a problem that no
// longer applies.
if (plan.firstFailure !== -1) {
  const failingEntry = train[plan.firstFailure];
  const [liveMainSha, liveFailingPr] = await Promise.all([
    request(token, `/repos/${owner}/${repo}/git/ref/heads/main`).then((r) => r.data.object.sha),
    request(token, `/repos/${owner}/${repo}/pulls/${failingEntry.number}`).then((r) => r.data),
  ]);
  const staleReason = promotionStaleReason({
    currentMain: liveMainSha,
    currentPr: liveFailingPr,
    expectedBase: mainSha,
    pr: failingEntry,
    repository,
  });
  if (staleReason) {
    process.stdout.write(
      `failing pr=#${failingEntry.number} stale reason=${staleReason}; skipping mutation, will rebuild next run\n`,
    );
    process.exit(0);
  }
  await blockEntry(failingEntry, {
    validationFailure: true,
    detail: `PR #${failingEntry.number} is the first failing addition in the validated prefix.`,
  });
  await dispatchRecovery(failingEntry.number, 'merge-train-validation-failure');
  process.stdout.write(
    `isolated first failing pr=#${failingEntry.number} green_prefix=${plan.greenPrefixLength}\n`,
  );
}

if (plan.greenPrefixLength > 0) {
  await promotePrefix(plan.greenPrefixLength);
}
process.exit(0);
