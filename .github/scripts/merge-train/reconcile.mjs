import { execFileSync } from 'node:child_process';

import { listReviewThreads, paginate, request } from '../ci-recovery/github.mjs';
import {
  isTrainFastPathPushRun,
  parseStateComment,
  STATE_MARKER as RECOVERY_STATE_MARKER,
} from '../ci-recovery/state.mjs';
import {
  buildCandidate,
  buildDispatchBindings,
  createWaitForMergedPr,
  isDisabledTrainScheduleRun,
  isMergeTrainConflictError,
  isMergeTrainNoopError,
  mainHealthReason,
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
  MAX_TRAIN_SIZE,
  nextBisectStep,
  NOOP_LABEL,
  parseEnabledFlag,
  QUEUE_LABEL,
  queueEntries,
  REQUIRED_CHECK_NAME,
  resolveAdmissionChecks,
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

// GitHub's PR `merged` / `merged_at` fields are asynchronous UI signals, not
// the authoritative proof for this train's atomic multi-ref push path; live
// promotions on 2026-07-15 showed they can remain unset even when GitHub has
// already auto-closed the promoted PR (ADR 0062 DEC-025). Confirmation accepts
// `merged === true` OR `state === 'closed'`, and this retry budget gives
// GitHub enough headroom to close entries under load while staying inside the
// reconcile job timeout.
const MERGED_PR_POLL_DELAYS_MS = [2000, 4000, 8000, 8000, 15000, 15000, 25000];

const waitForMergedPr = createWaitForMergedPr({
  request,
  token,
  owner,
  repo,
  pollDelaysMs: MERGED_PR_POLL_DELAYS_MS,
});

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
          ? 'Candidate validation failed; the merge train will bisect the failing prefix and return the first failing PR to recovery.'
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
    eligible,
    git,
    createTrainCheck,
    removeLabel,
    updateStatus,
    requiredCheckName: REQUIRED_CHECK_NAME,
    provenanceEntries,
    waitForMergedPr,
    reattestHealth: mainHealthAllowsPromotion,
  });
}

const fullCandidate = candidates[candidates.length - 1];
if (fullCandidate.state === 'missing') {
  await dispatchValidation(
    fullCandidate.candidateSha,
    fullCandidate.fingerprint,
    fullCandidate.entries,
  );
  process.stdout.write(`validating combined candidate size=${train.length}\n`);
  process.exit(0);
}
if (fullCandidate.state === 'pending') {
  process.stdout.write(`waiting combined candidate size=${train.length}\n`);
  process.exit(0);
}
if (fullCandidate.state === 'success') {
  await promotePrefix(train.length);
  process.exit(0);
}

const step = nextBisectStep(candidates.map((candidate) => candidate.state));
if (step.type === 'validate') {
  const candidate = candidates[step.prefixLength - 1];
  if (candidate.state === 'missing') {
    await dispatchValidation(candidate.candidateSha, candidate.fingerprint, candidate.entries);
  }
  process.stdout.write(`bisect validating prefix=${step.prefixLength} total=${train.length}\n`);
  process.exit(0);
}

const failingEntry = train[step.failingPrefixLength - 1];

// The candidates/train above were built from `mainSha` captured earlier in
// this run; by the time bisection isolates a failing PR, main may have
// moved or the PR's queued state may have changed (rebased, retargeted,
// unlabeled, etc.). Reattest both immediately before mutating anything so a
// stale bisection result can't block/label a PR for a problem that no
// longer applies. This check runs unconditionally -- including when
// step.greenPrefixLength === 0, the case where nothing else in this script
// (mainHealthAllowsPromotion/promoteExactBatch) re-validates before mutation.
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
    `bisect stale pr=#${failingEntry.number} reason=${staleReason}; skipping mutation, will rebuild next run\n`,
  );
  process.exit(0);
}

await blockEntry(failingEntry, {
  validationFailure: true,
  detail: `PR #${failingEntry.number} is the first failing addition in the validated prefix.`,
});
if (step.greenPrefixLength > 0) {
  await promotePrefix(step.greenPrefixLength);
}
await dispatchRecovery(failingEntry.number, 'merge-train-validation-failure');
process.stdout.write(
  `bisect isolated pr=#${failingEntry.number} green_prefix=${step.greenPrefixLength}\n`,
);
