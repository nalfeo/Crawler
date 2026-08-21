import { execFileSync } from 'node:child_process';

import {
  listClosingIssues,
  listReviewThreads,
  paginate,
  request,
  graphql,
} from '../ci-recovery/github.mjs';
import { listTrustedAppCheckRunsForRef, resolveCandidateCheckState } from './check-runs.mjs';
import {
  isTrainFastPathPushRun,
  parseStateComment,
  shouldSkipSubstantiveReview,
  STATE_MARKER as RECOVERY_STATE_MARKER,
  TRUSTED_ASSOCIATIONS,
  TRUSTED_BOT_LOGINS,
} from '../ci-recovery/state.mjs';
import { MERGE_TRAIN_EMPTY_INCIDENT_MARKER as EMPTY_TRAIN_INCIDENT_MARKER } from '../ci-recovery/markers.mjs';
import { coordinationEnforcementEnabled } from '../ci-conflict-coordinator/state.mjs';
import { ciConflictOrderReasonForPromotion } from './ci-conflict-order.mjs';
import {
  applyLandedRecoveryDecision,
  buildCandidate,
  buildDispatchBindings,
  buildGatedDispatchRecovery,
  createMergeBottomOfStackPr,
  createMergePullRequest,
  deleteCandidateBundle,
  isDisabledTrainScheduleRun,
  isMergeTrainConflictError,
  isMergeTrainNoopError,
  mainAttributionVerdict,
  mergeTrainGitEnvironment,
  planLandedRecovery,
  promoteExactBatch,
  promotionStaleReason,
  queuePositionAfterRecovery,
  resolveMergeTrainTokens,
  runTrainBuildLoop,
  sameRepository,
  EMPTY_TRAIN_LIVENESS_THRESHOLD_MS,
  evaluateStalledQueue,
  evaluateUnadvanceableStrike,
  parseStalledQueuePasses,
  parseUnadvanceableStrike,
  renderStalledQueuePasses,
  renderUnadvanceableStrike,
  stalledAdmissionEligiblePulls,
  UNADVANCEABLE_STRIKE_THRESHOLD,
  trainCheckTitle,
} from './reconcile-lib.mjs';
import {
  BLOCKED_LABEL,
  CANDIDATE_CHECK_NAME,
  admissionFingerprint,
  candidateEvidenceId,
  candidateFingerprint,
  candidateRef,
  hasLeadingMarker,
  isAdmissible,
  LANDED_LABEL,
  LANDED_MARKER,
  MAX_TRAIN_SIZE,
  NOOP_LABEL,
  parseEnabledFlag,
  parseMergeTrainPrNumber,
  planAttributedPrefixPromotion,
  PROMOTION_POSTCONDITION_CHECK_NAME,
  QUEUE_LABEL,
  RECOVERY_PENDING_LABEL,
  queueEntries,
  resolveAdmissionChecks,
  renderLandedComment,
  renderStatus,
  squashCommitMessage,
  squashCommitTitle,
  STATUS_MARKER,
  successfulChecks,
  trainCheckState,
  VALIDATION_FAILED_LABEL,
} from './state.mjs';
import { resolveHumanApprovalRejection } from './human-approval.mjs';
import { countOutstandingRecoveryRuns, resolveGlobalDispatchCaps } from '../ci-recovery/router.mjs';
import { LIFECYCLE_MARKER, parseLifecycleComment } from '../ci-recovery/pr-lifecycle.mjs';

const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const {
  promotionToken: token,
  workflowDispatchToken,
  updateBranchToken,
} = resolveMergeTrainTokens(process.env);
const enabled = parseEnabledFlag(process.env.MERGE_TRAIN_ENABLED);
const requiredAdmissionChecks = resolveAdmissionChecks(process.env.MERGE_TRAIN_ADMISSION_CHECKS);
const trustedAppId = Number.parseInt(process.env.MERGE_TRAIN_APP_ID || '', 10);
const { trainCap: resolvedTrainCap } = resolveGlobalDispatchCaps(process.env);
const EMPTY_TRAIN_INCIDENT_LABEL = 'ci-incident';
const EMPTY_TRAIN_INCIDENT_TITLE = 'CI incident: Merge train empty with admission-eligible backlog';

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
    env: mergeTrainGitEnvironment(process.env, options.env),
  }).trim();
}

// GitHub's default `filter=latest` collapses same-named check runs on a ref
// down to just the newest one. The merge train posts a NEW check run named
// CANDIDATE_CHECK_NAME (distinct external_id = fingerprint:candidateSha) for
// every candidate validated against the same mainSha during bisection, so the
// default filter would hide an earlier candidate's still-relevant evidence
// behind a later one and break bisection convergence (trainCheckState would
// see 'missing' for a candidate that actually completed). filter=all keeps
// every check run; the check-runs envelope (`{ check_runs: [...] }`) isn't a
// bare array, so it can't reuse the shared `paginate` helper -- page through
// it explicitly instead of trusting a single 100-item page.
async function checkRuns(sha) {
  const encodedSha = encodeURIComponent(sha);
  const results = [];
  let page = 1;
  while (true) {
    const response = await request(
      token,
      `/repos/${owner}/${repo}/commits/${encodedSha}/check-runs?filter=all&per_page=100&page=${page}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    const runs = response.data.check_runs || [];
    results.push(...runs);
    if (runs.length < 100) return results;
    page += 1;
  }
}

async function candidateCheckState(sha, evidenceId, now = new Date()) {
  const result = await resolveCandidateCheckState({
    sha,
    evidenceId,
    trustedAppId,
    now,
    loadCommitCheckRuns: checkRuns,
    loadTrustedAppCheckRuns: (ref) =>
      listTrustedAppCheckRunsForRef({
        request,
        token,
        owner,
        repo,
        sha: ref,
        trustedAppId,
      }),
    classify: trainCheckState,
  });
  if (result.usedSuiteFallback) {
    process.stdout.write(
      `candidate check suite fallback sha=${sha} state=${result.state} ` +
        `commit_runs=${result.commitCheckRunCount} trusted_runs=${result.trustedCheckRunCount} ` +
        `suites=${result.suiteCount} suite_pages=${result.suitePages} ` +
        `check_run_pages=${result.checkRunPages}\n`,
    );
  }
  return result.state;
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

function renderEmptyTrainIncidentBody({ now, stalledPulls }) {
  const numbers = stalledPulls.map((pull) => `#${pull.number}`).join(', ');
  return [
    EMPTY_TRAIN_INCIDENT_MARKER,
    '## Merge train liveness alarm',
    '',
    `- Observed: ${now.toISOString()}`,
    `- Condition: merge train reported \`Merge train is empty\``,
    `- Admission-eligible open PRs stalled >= 60m: ${stalledPulls.length}`,
    `- PRs: ${numbers}`,
    '',
    'This issue is managed by `.github/scripts/merge-train/reconcile.mjs`.',
  ].join('\n');
}

async function listOpenIncidentIssues() {
  const encodedLabel = encodeURIComponent(EMPTY_TRAIN_INCIDENT_LABEL);
  return paginate(
    token,
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodedLabel}&per_page=100`,
  );
}

function findManagedEmptyTrainIncident(openIncidents) {
  return openIncidents.find(
    (issue) =>
      issue.title === EMPTY_TRAIN_INCIDENT_TITLE &&
      String(issue.body || '').includes(EMPTY_TRAIN_INCIDENT_MARKER),
  );
}

async function closeManagedEmptyTrainIncidentIfAny(reason) {
  const openIncidents = await listOpenIncidentIssues();
  const existing = findManagedEmptyTrainIncident(openIncidents);
  if (!existing) return;
  const suffix = String(reason || '').trim();
  const body = suffix
    ? `${String(existing.body || '').trim()}\n\n- Auto-resolved: ${suffix}`
    : existing.body;
  await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
    method: 'PATCH',
    body: { state: 'closed', body },
  });
  process.stdout.write(`closed empty-train incident issue=#${existing.number}\n`);
}

async function upsertEmptyTrainIncident(stalledPulls, now = new Date()) {
  if (stalledPulls.length === 0) return;
  const openIncidents = await listOpenIncidentIssues();
  const body = renderEmptyTrainIncidentBody({ now, stalledPulls });
  const existing = findManagedEmptyTrainIncident(openIncidents);
  if (existing) {
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: { body },
    });
    process.stdout.write(
      `updated empty-train incident issue=#${existing.number} stalled=${stalledPulls.length}\n`,
    );
    return;
  }
  const created = await request(token, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: {
      title: EMPTY_TRAIN_INCIDENT_TITLE,
      labels: [EMPTY_TRAIN_INCIDENT_LABEL],
      body,
    },
  });
  process.stdout.write(
    `created empty-train incident issue=#${created.data.number} stalled=${stalledPulls.length}\n`,
  );
}

async function statusCommentBody(prNumber) {
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`);
  const stateComment = comments.find((comment) => hasLeadingMarker(comment.body, STATUS_MARKER));
  return stateComment ? String(stateComment.body || '') : '';
}

// Reads the persisted unadvanceable-strike record out of the merge-train status
// comment. Returns the shape `evaluateUnadvanceableStrike` expects.
function readUnadvanceableStrike(body) {
  const record = parseUnadvanceableStrike(body);
  return { recordedSha: record.headSha, recordedStrikes: record.strikes };
}

const STALLED_TRAIN_INCIDENT_TITLE =
  'CI incident: Merge train queue is non-empty but admitting nothing';

function renderStalledTrainIncidentBody({ now, queued, passes, headPull }) {
  const numbers = queued.map((pull) => `#${pull.number}`).join(', ');
  const head = headPull ? `#${headPull.number}` : 'unknown';
  return [
    EMPTY_TRAIN_INCIDENT_MARKER,
    '## Merge train stalled-queue alarm',
    '',
    `- Observed: ${now.toISOString()}`,
    `- Condition: queue is non-empty but no PR was admitted for candidate construction`,
    `- Consecutive stalled reconcile passes: ${passes}`,
    `- Head of FIFO queue (the likely blocker): ${head}`,
    `- Queued PRs starving behind it: ${queued.length}`,
    `- PRs: ${numbers}`,
    '',
    'The merge train exits `0` on this path, so the workflow reports success while',
    'nothing merges. Inspect the head-of-queue PR first: if the train cannot advance',
    'it (for example a restricted-branch `update-branch` 403), it will be ejected and',
    `quarantined with \`${BLOCKED_LABEL}\` after ${UNADVANCEABLE_STRIKE_THRESHOLD} consecutive strikes.`,
    '',
    'This issue is managed by `.github/scripts/merge-train/reconcile.mjs`.',
    renderStalledQueuePasses(passes),
  ].join('\n');
}

async function upsertStalledTrainIncident({ now, queued, passes, headPull }) {
  const openIncidents = await listOpenIncidentIssues();
  const existing = openIncidents.find(
    (issue) =>
      issue.title === STALLED_TRAIN_INCIDENT_TITLE &&
      String(issue.body || '').includes(EMPTY_TRAIN_INCIDENT_MARKER),
  );
  const body = renderStalledTrainIncidentBody({ now, queued, passes, headPull });
  if (existing) {
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: { body },
    });
    process.stdout.write(
      `updated stalled-train incident issue=#${existing.number} passes=${passes}\n`,
    );
    return;
  }
  const created = await request(token, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: { title: STALLED_TRAIN_INCIDENT_TITLE, labels: [EMPTY_TRAIN_INCIDENT_LABEL], body },
  });
  process.stdout.write(
    `created stalled-train incident issue=#${created.data.number} passes=${passes}\n`,
  );
}

// Reads the consecutive stalled-pass counter off the managed stalled-train
// incident issue, and closes it when the train recovers.
async function readStalledTrainPasses() {
  const openIncidents = await listOpenIncidentIssues();
  const existing = openIncidents.find(
    (issue) =>
      issue.title === STALLED_TRAIN_INCIDENT_TITLE &&
      String(issue.body || '').includes(EMPTY_TRAIN_INCIDENT_MARKER),
  );
  return existing ? parseStalledQueuePasses(existing.body) : 0;
}

async function closeStalledTrainIncidentIfAny(reason) {
  const openIncidents = await listOpenIncidentIssues();
  const existing = openIncidents.find(
    (issue) =>
      issue.title === STALLED_TRAIN_INCIDENT_TITLE &&
      String(issue.body || '').includes(EMPTY_TRAIN_INCIDENT_MARKER),
  );
  if (!existing) return;
  await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
    method: 'PATCH',
    body: {
      state: 'closed',
      body: `${String(existing.body || '').trim()}\n\n- Auto-resolved: ${reason}`,
    },
  });
  process.stdout.write(`closed stalled-train incident issue=#${existing.number}\n`);
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
  const review = await listReviewThreads(token, owner, repo, pr.number);
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${pr.number}/comments`);
  const closingIssues = await listClosingIssues(token, owner, repo, pr.number);
  const changedFiles =
    String(pr.head?.ref || '').trim() === 'assets/promote'
      ? await paginate(token, `/repos/${owner}/${repo}/pulls/${pr.number}/files`)
      : [];
  const approvalRejection = await resolveHumanApprovalRejection({
    pullRequest: pr,
    closingIssues,
    comments,
    ownerLogin: owner,
    fetchReviews: () => paginate(token, `/repos/${owner}/${repo}/pulls/${pr.number}/reviews`),
  });

  // D11 fix (Issue #1851): read the authoritative lifecycle phase so quarantined/abandoned
  // PRs are structurally rejected before entering the train, regardless of their labels.
  // If no lifecycle comment exists yet (pre-Issue-8 PRs), lifecyclePhase stays null and
  // the check is a no-op — harmless since no PR has been transitioned to quarantined yet.
  //
  // Trust boundary: only accept lifecycle comments that (a) have the marker at the START
  // of the comment (hasLeadingMarker, not .includes()), (b) were authored by a trusted App,
  // org member, or collaborator. Duplicate trusted comments fail closed (throw).  A trusted
  // but malformed comment also fails closed: we reject the PR rather than silently treating
  // a corrupted authoritative record as "no phase".
  let lifecyclePhase = null;
  {
    const isTrustedLifecycleAuthor = (comment) => {
      if (!comment) return false;
      // A GitHub App (performed_via_github_app non-null) from any App is trusted since
      // contributors cannot post comments via a GitHub App token.
      if (comment.performed_via_github_app != null) return true;
      const association = String(comment.author_association ?? '').toUpperCase();
      const login = String(comment.user?.login ?? '').toLowerCase();
      return TRUSTED_ASSOCIATIONS.has(association) || TRUSTED_BOT_LOGINS.has(login);
    };
    const trustedLifecycleComments = comments.filter(
      (comment) =>
        hasLeadingMarker(comment.body, LIFECYCLE_MARKER) && isTrustedLifecycleAuthor(comment),
    );
    if (trustedLifecycleComments.length > 1) {
      // Duplicate authoritative lifecycle comments are a data-integrity error.
      // Fail closed: reject admission rather than silently picking one.
      return {
        ok: false,
        reason: `lifecycle-comment-duplicate:${trustedLifecycleComments.length}`,
      };
    }
    if (trustedLifecycleComments.length === 1) {
      try {
        const record = parseLifecycleComment(trustedLifecycleComments[0].body);
        lifecyclePhase = record?.phase ?? null;
      } catch {
        // Malformed lifecycle comment from a trusted source — fail closed rather than
        // admitting the PR with an unknown/corrupted phase record.
        process.stdout.write(`lifecycle-comment-parse-error pr=#${pr.number}\n`);
        return { ok: false, reason: 'lifecycle-comment-malformed' };
      }
    }
  }

  // D1 fix (Issue #1851): evaluate admission from current live facts — no
  // state-comment fingerprint required. A green, mergeable, non-draft PR with
  // resolved threads and a substantive Copilot review is always admissible
  // regardless of whether the CI-recovery state comment fingerprint is current.
  // The old fingerprint gate was the root cause of D1: a PR that recovered its
  // checks could not re-enter the train until a separate CI-recovery run
  // updated the fingerprint first, creating a chicken-and-egg deadlock.
  const prFacts = {
    state: pr.state,
    draft: pr.draft,
    hasMergeConflict: pr.mergeable === false || pr.mergeable_state === 'dirty',
    // `pr.stack` is GitHub's stacked-PR object (present on both the list-pulls
    // and single-PR responses whenever another open PR is based on this PR's
    // head branch, or this PR is based on another open PR's head branch).
    // evaluateAdmission rejects it with reason `stacked-pr`: the classic
    // synchronous merge endpoint 403s on any stacked PR, so it must never be
    // admitted into the sequential squash-merge promotion loop.
    stack: pr.stack ?? null,
    checkRuns: runs,
    reviewThreads: review.threads,
    reviews: review.reviews || [],
    humanApprovalDisposition: approvalRejection,
    lifecyclePhase,
    // Scope-constrained escape hatch for asset-promotion PRs where Copilot cannot
    // review image-only diffs. Mixed diffs do not bypass substantive review.
    skipSubstantiveReview: shouldSkipSubstantiveReview(pr, changedFiles),
  };
  const admission = isAdmissible(prFacts, requiredAdmissionChecks);
  if (!admission.eligible) {
    return { ok: false, reason: admission.reasons.join(', ') };
  }
  return { ok: true };
}

async function createTrainCheck(
  sha,
  evidenceId,
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
      external_id: evidenceId,
      ...(conclusion ? { conclusion } : {}),
      output: {
        title: trainCheckTitle(status, conclusion),
        summary: [
          `Evidence: ${evidenceId}`,
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

// Gate all reconcile.mjs CI Recovery dispatches against the runtime-resolved
// trainCap so they participate in the same backpressure as the router workflow.
// resolvedTrainCap honours CI_GLOBAL_TRAIN_DISPATCH_CAP env override (repo
// Actions variable), falling back to the GLOBAL_TRAIN_DISPATCH_CAP default.
// This is best-effort: the router's concurrency group serialises its own
// invocations but cannot serialise against reconcile.mjs calls, so a narrow
// race window remains. See the router's `runFromEnv` comment for details.
const dispatchRecoveryGated = buildGatedDispatchRecovery({
  dispatchRecovery,
  countRuns: countOutstandingRecoveryRuns,
  cap: resolvedTrainCap,
  token,
  owner,
  repo,
});

// Bound on how many recent push-triggered CI runs we inspect (and fetch
// check-runs for) when looking for evidence on the current main SHA. Main
// only advances via merge-train promotions or rare direct pushes, so the
// exact-SHA match will normally be found within the first entry; this cap
// keeps the check-run fan-out small and predictable either way.
const MAIN_HEALTH_PUSH_RUN_LOOKBACK = 5;

// Failure-ATTRIBUTION probe. This is NOT a promotion gate (ADR 0077): the
// validated composite prefix is the sole promotion gate, and a green composite
// promotes onto a red `main` -- that is exactly how a PR that FIXES `main`
// lands. The verdict is consulted only to decide whether a RED composite is
// attributable to a queued PR, and only a positive 'red' pauses.
async function mainAttributionSignal() {
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
      // Runs for other SHAs are filtered by mainAttributionVerdict; no need to
      // fetch jobs for them.
      scheduleRuns.push({ ...run, isTrainFastPath: false });
      continue;
    }
    // For schedule runs on the current main SHA, verify they ran the full CI
    // gate. A scheduled run whose `changes` job is absent/skipped did no real
    // CI work, so it is not authoritative evidence either way.
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
  const verdict = mainAttributionVerdict({
    mainSha: currentMainSha,
    runs: [...scheduleRuns, ...pushRuns],
  });
  return verdict;
}

// Real GitHub squash-merge promotion. `mergePullRequest` merges each admitted
// PR through GitHub's own Merge API (the App bypasses the required-check
// ruleset), producing genuine `merged: true` + a real merge commit SHA -- the
// completion semantics the old atomic force-push could never produce. The
// bounded mergeability poll absorbs GitHub's async `mergeable` computation.
const mergePullRequest = createMergePullRequest({ request, token, owner, repo });
const mergeBottomOfStackPr = createMergeBottomOfStackPr({ request, token, owner, repo });
const mergePullRequestWithStackHandling = async (entry, options) => {
  if (options?.stack?.position === 1) {
    return mergeBottomOfStackPr(entry, options);
  }
  return mergePullRequest(entry, options);
};

// Fetch a landed commit's REST object (tree + parents) for the post-merge
// proof in promoteExactBatch.
async function fetchCommit(sha) {
  return (await request(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`)).data;
}

// Publish the fail-closed promotion-postcondition check on the SHA the caller
// selected. `promoteExactBatch` (reconcile-lib.mjs) already picks the
// semantically-correct target per failure mode -- the real landed commit for
// a post-merge proof failure, the last proven-good landed commit for the
// final whole-batch main-moved guard, or the confirmed pre-merge main for a
// pre-landing merge-API failure -- so this must attach to exactly that `sha`,
// never re-derive its own. Re-fetching `refs/heads/main` here would silently
// discard the caller's landed SHA and, under the exact race the final guard
// exists to catch (main advances again while this async call is in flight),
// post the failure onto an unrelated/foreign commit instead of the one that
// actually failed proof -- breaking the crash-recovery consumer
// (landedCommitHasPostconditionFailure) that looks for this check on a
// specific PR's `merge_commit_sha`. Candidate commits are transported as
// opaque bundles and are not repository commit objects, so `sha` here is
// always a real GitHub commit, never a candidate SHA. Deliberately named
// PROMOTION_POSTCONDITION_CHECK_NAME, never `merge-train`: a `merge-train`
// check on a real landed main commit would masquerade as the fast-path
// attestation ci.yml/mainAttributionVerdict key on.
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
// commit, a single (linear) parent, NO promotion-postcondition failure on it,
// and the LANDED_LABEL proof-complete marker (set only after the tree proof
// succeeded). A crash before the marker write is left for human review; a crash
// between marker write and comment/label cleanup is recovered here.
async function reconcileLandedSignals() {
  const staleByNumber = new Map();
  const staleLists = await Promise.all(
    [QUEUE_LABEL, RECOVERY_PENDING_LABEL].map((label) =>
      paginate(
        token,
        `/repos/${owner}/${repo}/issues?state=closed&labels=${encodeURIComponent(label)}`,
      ),
    ),
  );
  for (const item of staleLists.flat()) {
    staleByNumber.set(item.number, item);
  }

  const staleClosed = [...staleByNumber.values()];
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
    const hasLandedLabel = (pr.labels || []).some((label) => label.name === LANDED_LABEL);
    const decision = planLandedRecovery({
      merged: pr.merged,
      baseRef: pr.base?.ref,
      landedSha,
      trailerPrNumber,
      prNumber: pr.number,
      parentCount,
      hasPostconditionFailure,
      hasLandedLabel,
      factsComplete,
    });
    await applyLandedRecoveryDecision({
      prNumber: pr.number,
      landedSha,
      decision,
      postLandedComment,
      setLabel,
      removeLabel,
    });

    if (decision.action === 'finish') {
      process.stdout.write(`recovered interrupted landing for pr=#${pr.number} sha=${landedSha}\n`);
      continue;
    }
    if (decision.action === 'retry') {
      process.stdout.write(
        `deferred closed-pr landing recovery for pr=#${pr.number} (${decision.reason}); moved retry state to ${RECOVERY_PENDING_LABEL}\n`,
      );
      continue;
    }
    process.stdout.write(
      `cleared stale ${QUEUE_LABEL} state for closed pr=#${pr.number} (${decision.reason})\n`,
    );
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
  await dispatchRecoveryGated(entry.number, 'merge-train-noop');
}

async function dispatchValidation(sha, refName, fingerprint, entries) {
  const evidenceId = candidateEvidenceId(fingerprint, sha);
  await createTrainCheck(
    mainSha,
    evidenceId,
    'in_progress',
    undefined,
    CANDIDATE_CHECK_NAME,
    entries,
  );
  try {
    await baseDispatchValidation(sha, refName, mainSha, fingerprint, entries);
  } catch (error) {
    // Model a dispatch/API failure (workflow_dispatch rejected, token
    // issue, transient network error) as an infrastructure problem, not a
    // candidate code failure: use `cancelled` so trainCheckState() treats
    // it as retryable ("missing") on the next reconciliation instead of
    // being bisected as if the candidate's code actually failed CI.
    await createTrainCheck(mainSha, evidenceId, 'completed', 'cancelled');
    throw error;
  }
}

await ensureLabel(QUEUE_LABEL, '1f6feb', 'Ready for the repository-managed merge train');
await ensureLabel(BLOCKED_LABEL, 'd1242f', 'Merge-train candidate needs intervention');
await ensureLabel(
  RECOVERY_PENDING_LABEL,
  'fbca04',
  'Closed merge-train PR needs another landed-proof recovery attempt',
);
await ensureLabel(NOOP_LABEL, 'bf8700', 'PR squash diff is already present in the train base');
await ensureLabel(
  VALIDATION_FAILED_LABEL,
  'd1242f',
  'First failing addition isolated by merge-train validation',
);
await ensureLabel(LANDED_LABEL, '0e8a16', "This PR's change landed on main via the merge train");
await ensureLabel(
  EMPTY_TRAIN_INCIDENT_LABEL,
  'b60205',
  'Automated merge-train liveness or CI incident',
);

// Crash-after-merge recovery runs first, every reconcile: it backfills the
// durable landed signal for any PR that was really merged but whose
// label/comment update did not complete. Cheap in the normal case (successful
// landings remove QUEUE_LABEL, so this query is usually empty).
await reconcileLandedSignals();

const pulls = await paginate(token, `/repos/${owner}/${repo}/pulls?state=open&base=main`);
const queued = queueEntries(pulls, repository);
if (queued.length === 0) {
  const now = new Date();
  const staleCandidates = pulls.filter((pull) => {
    if (pull.state !== 'open' || pull.draft) return false;
    if (pull.base?.ref !== 'main') return false;
    if (pull.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) return false;
    const updatedAtMs = Date.parse(String(pull.updated_at || pull.created_at || ''));
    return (
      Number.isFinite(updatedAtMs) &&
      now.getTime() - updatedAtMs >= EMPTY_TRAIN_LIVENESS_THRESHOLD_MS
    );
  });
  const admissionByNumber = new Map();
  for (const pull of staleCandidates) {
    const admission = await eligible(pull);
    admissionByNumber.set(pull.number, admission.ok);
  }
  const stalled = stalledAdmissionEligiblePulls({
    pulls: staleCandidates,
    admissionByNumber,
    now,
    thresholdMs: EMPTY_TRAIN_LIVENESS_THRESHOLD_MS,
  });
  if (stalled.length > 0) {
    await upsertEmptyTrainIncident(stalled, now);
  } else {
    await closeManagedEmptyTrainIncidentIfAny('queue empty condition cleared before threshold');
  }
  process.stdout.write('Merge train is empty\n');
  process.exit(0);
}
await closeManagedEmptyTrainIncidentIfAny('merge train has queued entries again');

const admitted = [];
for (const pr of queued) {
  // D2 fix: fetch the authoritative per-PR payload BEFORE calling eligible(),
  // so both the BEHIND check and the conflict check (hasMergeConflict in
  // eligible) draw from the same authoritative snapshot.  The list-pulls
  // simplified response may cache a stale mergeable / mergeable_state, which
  // could reject a clean-BEHIND PR before this update path, or admit a
  // now-DIRTY PR.
  const livePr = (await request(token, `/repos/${owner}/${repo}/pulls/${pr.number}`)).data;
  const admission = await eligible(livePr);
  if (admission.ok) {
    // D2 fix: if the PR is clean-BEHIND main, call the update-branch API so
    // the strict up-to-date merge policy does not block it from merging.
    // Use updateBranchToken (CRAWLER_CI_PAT || GITHUB_TOKEN): CRAWLER_CI_PAT
    // emits normal push events that re-trigger required CI; GITHUB_TOKEN is
    // recursion-suppressed for push events and would leave the updated head
    // without check runs.
    //
    // Use `break` after the first non-fork BEHIND PR to preserve FIFO queue
    // ordering: newer PRs must not leapfrog an older BEHIND PR. Fork PRs that
    // got dequeued (403) fall through naturally so later entries can still be
    // admitted this cycle.
    if (livePr.mergeable_state === 'behind') {
      // Set when this BEHIND PR provably cannot be advanced by the train on
      // this pass, so holding the FIFO line behind it would stall the whole
      // queue rather than preserve ordering.
      let yieldFifoLine = false;
      try {
        await request(
          updateBranchToken,
          `/repos/${owner}/${repo}/pulls/${pr.number}/update-branch`,
          {
            method: 'PUT',
            body: { expected_head_sha: livePr.head.sha },
          },
        );
        process.stdout.write(`update-branch pr=#${pr.number} reason=clean-behind\n`);
      } catch (err) {
        if (err.status === 403 && !sameRepository(livePr, repository)) {
          // The token cannot update a fork's head branch. Dequeue the PR so
          // it does not poison every subsequent reconcile cycle. A human must
          // manually rebase the fork branch, then re-add the merge-train label.
          process.stderr.write(
            `update-branch pr=#${pr.number} fork/no-permission (403): dequeuing to unblock queue\n`,
          );
          await removeLabel(pr.number, QUEUE_LABEL);
          yieldFifoLine = true;
        } else if (err.status === 403) {
          // Same-repo PR: a 403 here is NOT proof of a fork (isCrossRepository
          // is false), so this must not be treated the same as the fork case.
          // The most common cause is a restricted branch our bot token cannot
          // push to (e.g. a `copilot/*` coding-agent branch, which GitHub
          // restricts to the Copilot App / branch owner). Dequeuing here would
          // just get the PR silently re-labeled by CI Recovery and re-hit the
          // same 403 on the next reconcile pass, producing an indefinite
          // label-churn livelock (observed on PR #3027: merge-train label
          // added/removed every 1-2 min for 3+ days). Leave the PR queued and
          // let the branch owner/agent session update it out-of-band; dispatch
          // recovery so the stall is visible instead of silently repeating.
          //
          // Yield the FIFO line as well. Keeping the line held here is what
          // turned a single un-updatable entry into a total train deadlock:
          // the train cannot advance this PR on any pass, so every later
          // queued PR was starved behind it indefinitely while reconcile
          // reported success and logged only "No admitted PR is ready for
          // candidate construction" (observed 2026-08-21: #3208 head-of-line,
          // #3216/#3218 both mergeable and starved for hours). FIFO exists to
          // stop newer PRs leapfrogging a PR the train is actively advancing;
          // it must not pin the queue behind one the train provably cannot
          // advance at all.
          process.stderr.write(
            `update-branch pr=#${pr.number} same-repo-restricted-branch (403): leaving queued, yielding FIFO line, dispatching recovery\n`,
          );
          await dispatchRecoveryGated(pr.number, 'merge-train-restricted-branch-update');
          yieldFifoLine = true;
          // Safeguard (3): count consecutive failures on the SAME head SHA.
          // Leaving the PR queued avoids the #3027 label-churn livelock, but
          // an entry the train can NEVER advance must not stay at the head of
          // the queue forever. After UNADVANCEABLE_STRIKE_THRESHOLD strikes,
          // eject it from the queue and quarantine it with BLOCKED_LABEL --
          // which router.mjs already treats as dispatch-blocked, so CI
          // Recovery will not immediately re-queue it into the same 403 loop.
          // Strikes reset on a new head SHA, so an out-of-band rebase (the
          // intended fix) clears the record instead of being penalized.
          const strike = evaluateUnadvanceableStrike({
            headSha: livePr.head.sha,
            ...readUnadvanceableStrike(await statusCommentBody(pr.number)),
          });
          if (strike.quarantine) {
            process.stderr.write(
              `quarantine pr=#${pr.number} reason=unadvanceable-restricted-branch strikes=${strike.strikes}\n`,
            );
            await removeLabel(pr.number, QUEUE_LABEL);
            await setLabel(pr.number, BLOCKED_LABEL);
            await updateStatus(
              pr.number,
              `${renderStatus({
                position: 0,
                candidateSha: '',
                state: 'blocked',
                detail: `Ejected from the merge train after ${strike.strikes} consecutive update-branch 403s on head \`${strike.headSha}\`. The train cannot push to this branch, so it was quarantined to stop it starving the queue. Rebase the branch onto \`main\` out-of-band, then remove the \`${BLOCKED_LABEL}\` label to re-queue.`,
              })}\n${renderUnadvanceableStrike(strike)}`,
            );
          } else {
            await updateStatus(
              pr.number,
              `${renderStatus({
                position: queued.indexOf(pr) + 1,
                candidateSha: '',
                state: 'waiting',
                detail: `update-branch blocked (403) on head \`${strike.headSha}\`; strike ${strike.strikes}/${UNADVANCEABLE_STRIKE_THRESHOLD} before quarantine.`,
              })}\n${renderUnadvanceableStrike(strike)}`,
            );
          }
        } else if (err.status === 422) {
          // 422 covers "already up-to-date" and stale expected_head_sha —
          // expected, benign, logged so stale-head races stay visible.
          process.stderr.write(
            `update-branch pr=#${pr.number} non-fatal: ${err.status} ${err.message}\n`,
          );
        } else {
          // Any novel status (404, 5xx, transient network) is logged LOUDLY
          // and skipped — never re-thrown. This catch sits inside the
          // `for (const pr of queued)` loop, so an escaping throw does not
          // just fail this PR: it abandons every remaining queued PR and
          // leaves nobody to unstick the train. That is exactly how a
          // re-thrown non-422 update-branch error deadlocked the queue for
          // ~90 minutes on 2026-07-29. Novel failures stay visible via this
          // distinct `unexpected-status` marker (greppable by CI recovery)
          // rather than via a process crash; the PR re-enters on the next
          // reconcile pass. Enforced by `crawler/no-rethrow-in-automation-catch`.
          process.stderr.write(
            `update-branch pr=#${pr.number} unexpected-status: ${err.status} ${err.message}\n`,
          );
        }
      }
      // Stop admitting further PRs this pass so newer PRs cannot leapfrog.
      // The BEHIND PR will re-enter on the next reconcile once its branch is
      // current and required CI passes. Skip the break when this entry could
      // not be advanced at all (dequeued fork, or a same-repo restricted
      // branch the train cannot push to): the line is no longer being held
      // for a PR that is making progress, so later entries can still be
      // admitted instead of starving behind a permanently stuck head.
      if (!yieldFifoLine) break;
    } else {
      // Fence the legacy auto-merge path before this PR can be sequentially
      // squash-merged, so it cannot land out of order underneath promotion.
      // Bottom-of-stack stacked PRs are now promoted through the same
      // candidate-validated promotion loop as every other admitted PR; the
      // per-entry merge helper switches those entries to GitHub's async
      // merge-stack endpoint at merge time.
      await disableAutoMerge(pr);
      admitted.push(pr);
    }
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
    await dispatchRecoveryGated(pr.number, 'merge-train-admission-stale');
  }
}

const train = admitted.slice(0, MAX_TRAIN_SIZE);
if (train.length === 0) {
  // Safeguard (2): a non-empty queue that admits nothing is the exact
  // signature of the 2026-08-21 FIFO deadlock, and the empty-queue liveness
  // detector above structurally cannot see it (it requires queued.length===0).
  // Reconcile exits 0 here, so without this alarm the workflow reports success
  // on every 30-minute pass while the queue starves indefinitely.
  const now = new Date();
  const stall = evaluateStalledQueue({
    queuedCount: queued.length,
    admittedCount: admitted.length,
    passes: (await readStalledTrainPasses()) + 1,
  });
  if (stall.alarm) {
    await upsertStalledTrainIncident({
      now,
      queued,
      passes: stall.passes,
      headPull: queued[0],
    });
  }
  process.stdout.write(
    `No admitted PR is ready for candidate construction queued=${queued.length} stalled-passes=${stall.passes}\n`,
  );
  process.exit(0);
}
await closeStalledTrainIncidentIfAny('merge train admitted a candidate again');

const mainSha = (await request(token, `/repos/${owner}/${repo}/git/ref/heads/main`)).data.object
  .sha;
const candidates = [];
const loopResult = await runTrainBuildLoop({
  train,
  candidates,
  buildEntry: async (index) => {
    const entries = train.slice(0, index + 1);
    const fingerprint = candidateFingerprint(mainSha, entries);
    const refName = candidateRef(index + 1, fingerprint);
    const candidateSha = buildCandidate({
      baseSha: mainSha,
      entries,
      refName,
      git,
      live: true,
    });
    const transportSha = git(['rev-parse', refName]);
    await removeLabel(train[index].number, BLOCKED_LABEL);
    await removeLabel(train[index].number, VALIDATION_FAILED_LABEL);
    return { candidateSha, transportSha, entries, fingerprint, refName };
  },
  finalizeEntry: async (index, builtEntry) => {
    const remoteTransportRef = `refs/remotes/merge-train/candidate-${index + 1}`;
    git(['fetch', 'origin', `${builtEntry.refName}:${remoteTransportRef}`, '--force']);
    const fetchedTransportSha = git(['rev-parse', remoteTransportRef]);
    if (fetchedTransportSha !== builtEntry.transportSha) {
      throw new Error(
        `Candidate transport ref changed while building slot ${index + 1}: expected ` +
          `${builtEntry.transportSha}, fetched ${fetchedTransportSha}`,
      );
    }
    if (git(['cat-file', '-t', remoteTransportRef]) !== 'blob') {
      throw new Error(`Candidate transport ref for slot ${index + 1} is not a Git blob`);
    }
    const state = await candidateCheckState(
      mainSha,
      candidateEvidenceId(builtEntry.fingerprint, builtEntry.candidateSha),
    );
    await updateStatus(
      train[index].number,
      renderStatus({
        position: index + 1,
        candidateSha: builtEntry.candidateSha,
        state,
        detail:
          state === 'failure'
            ? 'Candidate validation failed; the merge train will localize the first failing PR and return it to recovery, promoting the validated green prefix before it.'
            : 'Candidate is immutable and bound to the listed PR revisions.',
      }),
    );
    if (state === 'success' || state === 'failure') {
      deleteCandidateBundle({
        refName: builtEntry.refName,
        transportSha: builtEntry.transportSha,
        git,
      });
    }
    return { ...builtEntry, state };
  },
  onConflict: async (index, error) => {
    await blockEntry(train[index], { detail: error.message });
    const predecessor = train[index - 1]?.number || 0;
    await dispatchRecoveryGated(
      train[index].number,
      `merge-train-cumulative-conflict:${predecessor}`,
    );
    process.stdout.write(`returned conflict pr=#${train[index].number} to reconciliation\n`);
  },
  onNoop: async (index, error) => {
    await deAdmitNoop(train[index], error.message);
    process.stdout.write(`returned no-op pr=#${train[index].number} to reconciliation\n`);
  },
  onRetryableFailure: async (index, error, recovery) => {
    await updateStatus(
      train[index].number,
      renderStatus({
        position: queuePositionAfterRecovery(index, recovery),
        candidateSha: '',
        state: 'waiting',
        detail: error.message,
      }),
    );
  },
  promotePrefix,
});

async function promotePrefix(prefixLength, validationIndex) {
  const provenanceEntries = train.slice(0, prefixLength);
  const validationCandidate = candidates[validationIndex];
  if (!validationCandidate) {
    throw new Error(`Missing validation candidate at prefix index ${validationIndex}`);
  }
  let landedCount = 0;
  const promoted = await promoteExactBatch({
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
    mergePullRequest: mergePullRequestWithStackHandling,
    setLabel,
    removeLabel,
    updateStatus,
    postLandedComment,
    publishPostconditionCheck,
    // Re-confirm, immediately before every merge, that the selected maximal or
    // bisected batch candidate still has terminal SUCCESS evidence.
    verifyCandidateEvidence: async () => {
      const state = await candidateCheckState(
        mainSha,
        candidateEvidenceId(validationCandidate.fingerprint, validationCandidate.candidateSha),
      );
      return state === 'success';
    },
    provenanceEntries,
    recordMapping: () => {
      landedCount += 1;
    },
    // Coordinator slot ordering is recomputed LIVE from filenames here, so it
    // survives label removal — it must be gated on the same kill switch or the
    // train would keep enforcing an order nothing else is enforcing.
    // `undefined` falls through to promoteExactBatch's `async () => null`.
    verifyMergeSlot: coordinationEnforcementEnabled(process.env)
      ? async ({ currentPr, currentMain }) =>
          ciConflictOrderReasonForPromotion({
            pullRequest: currentPr,
            baseSha: currentMain,
            owner,
            repo,
            repository,
            trustedAppId,
            requiredChecks: requiredAdmissionChecks,
            git,
            fetchOpenPulls: async () =>
              paginate(token, `/repos/${owner}/${repo}/pulls?state=open&base=main`),
            fetchPullFiles: async (number) =>
              paginate(token, `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`),
            fetchComments: async (number) =>
              paginate(token, `/repos/${owner}/${repo}/issues/${number}/comments`),
            fetchCheckRuns: async (sha) => checkRuns(sha),
            fetchClosingIssues: async (number) => listClosingIssues(token, owner, repo, number),
            fetchReviews: async (number) =>
              paginate(token, `/repos/${owner}/${repo}/pulls/${number}/reviews`),
          })
      : undefined,
  });
  return { promoted, landedCount };
}

if (loopResult.action === 'conflict' || loopResult.action === 'noop') {
  process.exit(0);
}

if (loopResult.action === 'retryable-build-failure') {
  process.stdout.write(
    `retryable candidate build failure pr=#${loopResult.entry.number} error=${loopResult.error.message} green_prefix=${loopResult.recovery.greenPrefixLength} promotion_attempted=${loopResult.recovery.promotionAttempted}\n`,
  );
  process.exit(0);
}

// Validate the maximal candidate first. Only a genuine terminal maximal failure
// asks the bisection planner for a smaller prefix -- and only when `main` is not
// itself known-red, so an unrelated broken `main` cannot be misattributed to a
// queued PR and eject it (ADR 0077).
const plan = await planAttributedPrefixPromotion({
  prefixStates: candidates.map((candidate) => candidate.state),
  mainVerdict: mainAttributionSignal,
});

if (plan.action === 'pause') {
  process.stdout.write(
    `paused merge train attribution; ${plan.reason}; the failed composite is not attributable to any queued PR, so no PR was ejected and no bisection round was spent\n`,
  );
  process.exit(0);
}

if (plan.action === 'validate') {
  await Promise.all(
    plan.prefixes.map((index) =>
      dispatchValidation(
        candidates[index].candidateSha,
        candidates[index].refName,
        candidates[index].fingerprint,
        candidates[index].entries,
      ),
    ),
  );
  process.stdout.write(
    `dispatched ${plan.prefixes.length} prefix validation(s) prefixes=${plan.prefixes
      .map((index) => index + 1)
      .join(',')} total=${train.length}\n`,
  );
  process.exit(0);
}

if (plan.action === 'wait') {
  process.stdout.write(`waiting on prefix validation(s); total=${train.length}\n`);
  process.exit(0);
}

// plan.action === 'promote': either the maximal candidate passed, or bisection
// isolated the first failing addition. Localize a failure before promotion so
// moving main cannot make the failing-PR reattestation falsely stale.
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
  await dispatchRecoveryGated(failingEntry.number, 'merge-train-validation-failure');
  process.stdout.write(
    `isolated first failing pr=#${failingEntry.number} green_prefix=${plan.greenPrefixLength}\n`,
  );
}

if (plan.attribution) {
  // Red-`main` attribution suppressed the ejection (`firstFailure: -1`), so the
  // isolation block above logged nothing. Without this line an operator sees a
  // failed composite, a partial prefix landing, and no explanation for why the
  // failing PR was left in the queue.
  process.stdout.write(
    `main red attribution; ${plan.attribution}; ejected nothing, promoting proven-green prefix=${plan.greenPrefixLength}\n`,
  );
}

if (plan.greenPrefixLength > 0) {
  await promotePrefix(plan.greenPrefixLength, plan.validationIndex);
}
process.exit(0);
