import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOCKED_LABEL,
  CI_CONFLICT_ORDER_WAIT_LABEL,
  LANDED_LABEL,
  PROMOTION_POSTCONDITION_CHECK_NAME,
  QUEUE_LABEL,
  RECOVERY_PENDING_LABEL,
  candidateFingerprint,
  commitTimestamp,
  isAdmissible,
  renderStatus,
  squashCommitMessage,
  squashCommitTitle,
} from './state.mjs';

// Re-exported so train callers consume admissibility as a pure predicate over
// live PR facts instead of re-deriving it from labels/state comments. The
// lifecycle owner remains the sole initiator of the resulting label writes.
export { isAdmissible };

export class MergeTrainConflictError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MergeTrainConflictError';
  }
}

export class MergeTrainNoopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeTrainNoopError';
  }
}

// A hard, fail-closed promotion failure: a squash-merge landed (or the merge
// API failed non-retryably) and a post-merge proof (real merged-state,
// linear parent, or tree equality with the validated candidate) did not hold.
// Unlike a stale/retryable outcome (which returns false so the next reconcile
// rebuilds), this throws so the run fails loudly after publishing the
// promotion-postcondition failure check on the ACTUAL landed commit.
export class MergeTrainPromotionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MergeTrainPromotionError';
  }
}

export function isMergeTrainPromotionError(error) {
  return error instanceof MergeTrainPromotionError;
}

export function isMergeTrainConflictError(error) {
  return error instanceof MergeTrainConflictError;
}

export function isMergeTrainNoopError(error) {
  return error instanceof MergeTrainNoopError;
}

export function trainCheckTitle(status, conclusion) {
  if (status !== 'completed') return 'Merge-train validation queued';
  return conclusion === 'success'
    ? 'Candidate promoted to main'
    : 'Merge-train validation could not start';
}

export async function promoteValidatedPrefixAfterBuildFailure({ candidates, promotePrefix }) {
  let validationIndex = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index].state === 'success') validationIndex = index;
  }
  if (validationIndex === -1) {
    return {
      greenPrefixLength: 0,
      validationIndex,
      promotionAttempted: false,
      promoted: false,
    };
  }
  const greenPrefixLength = validationIndex + 1;
  const promotion = await promotePrefix(greenPrefixLength, validationIndex);
  const promoted = promotion === true || promotion?.promoted === true;
  const landedCount =
    promotion === true
      ? greenPrefixLength
      : Number.isInteger(promotion?.landedCount)
        ? promotion.landedCount
        : 0;
  return {
    greenPrefixLength,
    landedCount,
    validationIndex,
    promotionAttempted: true,
    promoted,
  };
}

export function queuePositionAfterRecovery(index, recovery) {
  let promotedCount = 0;
  if (
    recovery?.promoted === true &&
    Number.isInteger(recovery.greenPrefixLength) &&
    recovery.greenPrefixLength > 0 &&
    recovery.greenPrefixLength <= index
  ) {
    promotedCount = recovery.greenPrefixLength;
  } else if (
    Number.isInteger(recovery?.landedCount) &&
    recovery.landedCount > 0 &&
    recovery.landedCount <= index
  ) {
    promotedCount = recovery.landedCount;
  }
  return index + 1 - promotedCount;
}

export const EMPTY_TRAIN_LIVENESS_THRESHOLD_MS = 60 * 60 * 1000;

function stallAnchorMs(pull) {
  const updatedAtMs = Date.parse(String(pull?.updated_at || ''));
  if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) return updatedAtMs;
  const createdAtMs = Date.parse(String(pull?.created_at || ''));
  return Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : Number.NaN;
}

export function stalledAdmissionEligiblePulls({
  pulls,
  queuedNumbers = new Set(),
  admissionByNumber = new Map(),
  now = new Date(),
  thresholdMs = EMPTY_TRAIN_LIVENESS_THRESHOLD_MS,
}) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || nowMs <= 0) return [];
  return (pulls || [])
    .filter((pull) => {
      if (!pull || queuedNumbers.has(pull.number)) return false;
      if (admissionByNumber.get(pull.number) !== true) return false;
      const anchorMs = stallAnchorMs(pull);
      if (!Number.isFinite(anchorMs) || anchorMs <= 0) return false;
      return nowMs - anchorMs >= thresholdMs;
    })
    .sort(
      (left, right) => stallAnchorMs(left) - stallAnchorMs(right) || left.number - right.number,
    );
}

/**
 * Runs the candidate build loop for a merge train. For each train entry,
 * `buildEntry(index)` is called inside the retryable candidate-build boundary.
 * `finalizeEntry(index, builtEntry)` runs afterward, outside that boundary, so
 * validation/status failures still fail the reconcile instead of being
 * reclassified as candidate-build retries.
 *
 * Exit conditions:
 * - `MergeTrainConflictError` / `MergeTrainNoopError` → returns immediately with
 *   `action: 'conflict'` or `action: 'noop'`; the caller is responsible for exiting.
 * - Any other (retryable) error → promotes the accumulated validated prefix via
 *   `promoteValidatedPrefixAfterBuildFailure` and returns
 *   `action: 'retryable-build-failure'`; the caller is responsible for exiting.
 * - All entries built without error → returns `action: 'done'`.
 *
 * @param {object} opts
 * @param {object[]} opts.train - Admitted PR entries in positional order
 * @param {object[]} opts.candidates - Mutable array; successfully built candidate
 *   records are pushed here so that `promotePrefix` (captured by closure in the
 *   caller) can read them when invoked during retryable-failure recovery.
 * @param {Function} opts.buildEntry - (index: number) => Promise<object>
 *   Builds one cumulative candidate within the retryable build boundary.
 * @param {Function} opts.finalizeEntry - (index: number, builtEntry: object) => Promise<object>
 *   Reads validation state and publishes the built candidate status outside the
 *   retryable build boundary.
 * @param {Function} opts.onConflict - Handles a classified cumulative conflict.
 * @param {Function} opts.onNoop - Handles a classified no-op candidate.
 * @param {Function} opts.onRetryableFailure - Publishes retryable build status.
 * @param {Function} opts.promotePrefix - (prefixLength, validationIndex) =>
 *   Promise<boolean | {promoted: boolean, landedCount: number}>
 *   Forwarded to `promoteValidatedPrefixAfterBuildFailure`.
 * @returns {Promise<{action: string, entry?: object, error?: Error, recovery?: object}>}
 */
export async function runTrainBuildLoop({
  train,
  candidates,
  buildEntry,
  finalizeEntry = async (_index, builtEntry) => builtEntry,
  onConflict = async () => {},
  onNoop = async () => {},
  onRetryableFailure = async () => {},
  promotePrefix,
}) {
  for (let index = 0; index < train.length; index += 1) {
    let builtEntry;
    try {
      builtEntry = await buildEntry(index);
    } catch (error) {
      if (isMergeTrainConflictError(error)) {
        await onConflict(index, error);
        return { action: 'conflict', entry: train[index], error };
      }
      if (isMergeTrainNoopError(error)) {
        await onNoop(index, error);
        return { action: 'noop', entry: train[index], error };
      }
      const recovery = await promoteValidatedPrefixAfterBuildFailure({ candidates, promotePrefix });
      await onRetryableFailure(index, error, recovery);
      return { action: 'retryable-build-failure', entry: train[index], error, recovery };
    }
    candidates.push(await finalizeEntry(index, builtEntry));
  }
  return { action: 'done' };
}

function hasLabel(pr, name) {
  return (pr.labels || []).some((label) => label.name === name);
}

function sameRepository(pr, repository) {
  return pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase();
}

function fetchCandidateHead(git, entry) {
  const refName = `refs/remotes/merge-train/pr-${entry.number}`;
  const expectedSha = String(entry.head?.sha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error(`PR #${entry.number} has invalid API head SHA: ${expectedSha || '<empty>'}`);
  }
  try {
    git(['fetch', 'origin', `${expectedSha}:${refName}`, '--force']);
  } catch (shaError) {
    const headRef = String(entry.head?.ref || '').trim();
    if (!headRef) {
      throw new Error(
        `PR #${entry.number} head ${expectedSha} is not fetchable and has no branch ref fallback: ${shaError.message}`,
        { cause: shaError },
      );
    }
    git(['fetch', 'origin', `refs/heads/${headRef}:${refName}`, '--force']);
  }
  const fetchedSha = git(['rev-parse', refName]);
  if (fetchedSha !== expectedSha) {
    throw new Error(
      `PR #${entry.number} head changed while building candidate (expected ${expectedSha}, got ${fetchedSha}); reconcile will retry on the next run`,
    );
  }
  return refName;
}

function gitCommandSucceeded(git, args) {
  try {
    git(args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

const CANDIDATE_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'crawler-merge-train[bot]',
  GIT_AUTHOR_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'crawler-merge-train[bot]',
  GIT_COMMITTER_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
};

export function resolveMergeTrainTokens(environment) {
  const liveActionsRun = environment.GITHUB_ACTIONS === 'true';
  const promotionToken =
    environment.MERGE_TRAIN_TOKEN || (!liveActionsRun ? environment.GITHUB_TOKEN || '' : '');
  // The repository App receives 403 from workflow_dispatch; never reuse it here.
  const workflowDispatchToken = environment.GITHUB_TOKEN || '';
  // CRAWLER_CI_PAT is a user token that emits normal push events (re-triggers
  // required CI); GITHUB_TOKEN is recursion-suppressed for push events so
  // update-branch via GITHUB_TOKEN does not restart required checks.
  const updateBranchToken = environment.CRAWLER_CI_PAT || environment.GITHUB_TOKEN || '';
  if (!promotionToken) {
    throw new Error('Merge train requires MERGE_TRAIN_TOKEN for promotion operations');
  }
  if (!workflowDispatchToken) {
    throw new Error('Merge train requires GITHUB_TOKEN for workflow dispatch operations');
  }
  return { promotionToken, workflowDispatchToken, updateBranchToken };
}

export function mergeTrainGitEnvironment(environment, overrides = {}) {
  const childEnvironment = { ...environment, ...overrides };
  delete childEnvironment.MERGE_TRAIN_WORKFLOW_TOKEN;
  return childEnvironment;
}

export async function dispatchRecoveryWorkflow({ request, token, owner, repo, prNumber, trigger }) {
  await request(token, `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`, {
    method: 'POST',
    body: {
      ref: 'main',
      inputs: {
        operation: 'reconcile',
        pr_number: String(prNumber),
        trigger,
        lease_id: '',
      },
    },
  });
}

export async function dispatchValidationWorkflow({
  request,
  token,
  owner,
  repo,
  sha,
  refName,
  attestationSha,
  fingerprint,
  entries,
}) {
  await request(
    token,
    `/repos/${owner}/${repo}/actions/workflows/merge-train-validate.yml/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: {
          candidate_sha: sha,
          candidate_ref: refName,
          attestation_sha: attestationSha,
          fingerprint,
          pr_numbers: entries.map((entry) => entry.number).join(','),
        },
      },
    },
  );
}

const CANDIDATE_REF_PREFIX = 'refs/merge-train-candidates/';

function pushCandidateBundle({ baseSha, refName, git }) {
  const bundleDirectory = mkdtempSync(join(tmpdir(), 'crawler-merge-train-'));
  const bundlePath = join(bundleDirectory, 'candidate.bundle');
  try {
    git(['bundle', 'create', bundlePath, 'HEAD', `^${baseSha}`]);
    const transportSha = git(['hash-object', '-w', bundlePath]);
    if (!/^[0-9a-f]{40}$/i.test(transportSha)) {
      throw new Error('Merge-train candidate transport did not produce a Git blob SHA');
    }
    git(['update-ref', refName, transportSha]);
    git(['push', '--force', 'origin', `${refName}:${refName}`]);
    return transportSha;
  } finally {
    rmSync(bundleDirectory, { recursive: true, force: true });
  }
}

export function deleteCandidateBundle({ refName, transportSha, git }) {
  if (!refName.startsWith(CANDIDATE_REF_PREFIX)) {
    throw new Error(`Candidate cleanup requires the ref namespace ${CANDIDATE_REF_PREFIX}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(transportSha)) {
    throw new Error('Candidate cleanup requires a Git blob SHA');
  }
  const remoteLine = git(['ls-remote', '--refs', 'origin', refName]).trim();
  if (!remoteLine) return false;
  const [remoteSha, remoteRef] = remoteLine.split(/\s+/);
  if (remoteRef !== refName || remoteSha !== transportSha) {
    throw new Error(
      `Candidate transport ref changed before cleanup: expected ${transportSha}, found ${remoteSha || 'unknown'}`,
    );
  }
  git(['push', `--force-with-lease=${refName}:${transportSha}`, 'origin', `:${refName}`]);
  return true;
}

// The generated INDEX.md must never appear on PR branches (enforced by
// pr-preflight guard), but if it does slip through, auto-resolve it during
// candidate builds so it never serializes the merge queue (issue #1856).
const INDEX_MD_PATH = 'docs/knowledge/handoffs/INDEX.md';

export function buildCandidate({ baseSha, entries, refName, git, live }) {
  if (live && !refName.startsWith(CANDIDATE_REF_PREFIX)) {
    throw new Error(
      `Live merge-train candidates must use the non-event ref namespace ${CANDIDATE_REF_PREFIX}`,
    );
  }
  git(['fetch', 'origin', 'main', '--prune']);
  const candidateRefs = entries.map((entry) => fetchCandidateHead(git, entry));
  git(['checkout', '--detach', baseSha]);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const candidateRef = candidateRefs[index];
    try {
      git(['merge', '--squash', '--no-commit', candidateRef], {
        env: CANDIDATE_GIT_IDENTITY,
      });
    } catch (error) {
      let unmergedFiles = [];
      let operationalError = error;
      try {
        const unmergedOutput = git(['ls-files', '--unmerged']);
        // ls-files --unmerged format: "mode sha stage\tpath" — one line per
        // conflict stage (1=base, 2=ours, 3=theirs) so deduplicate by path.
        unmergedFiles = [
          ...new Set(
            unmergedOutput
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => line.split('\t')[1])
              .filter(Boolean),
          ),
        ];
      } catch (inspectionError) {
        operationalError = new Error(
          `could not inspect the failed candidate merge: ${inspectionError.message}`,
          { cause: error },
        );
      }
      // Auto-resolve: if the only conflict is INDEX.md (a generated file that
      // must not appear on PR branches), keep HEAD's version and continue the
      // candidate build rather than aborting the whole train.
      if (unmergedFiles.length > 0 && unmergedFiles.every((f) => f === INDEX_MD_PATH)) {
        git(['checkout', 'HEAD', '--', INDEX_MD_PATH]);
        // A squash-merge leaves newly-added files from the merged branch as
        // untracked (not staged). Stage everything so the candidate commit
        // captures the PR's full diff, not just its pre-existing modifications.
        git(['add', '--all']);
        // Fall through — merge is now clean, continue to commit below.
      } else {
        git(['reset', '--hard', baseSha]);
        if (unmergedFiles.length > 0) {
          // Aborting the remaining entries is the intended behaviour here: a
          // conflicting PR invalidates the cumulative candidate, so there is no
          // meaningful "next entry" to continue to. `runTrainBuildLoop` catches
          // this and reports `action: 'conflict'` — the process does not die.
          // eslint-disable-next-line crawler/no-rethrow-in-automation-catch
          throw new MergeTrainConflictError(
            `PR #${entry.number} conflicts in the cumulative candidate: ${error.message}`,
            { cause: error },
          );
        }
        // Same contract: `runTrainBuildLoop` catches this as a retryable build
        // failure and promotes the validated prefix. The candidate base is
        // already `reset --hard`, so continuing the loop would stack later PRs
        // on an unbuilt base.
        // eslint-disable-next-line crawler/no-rethrow-in-automation-catch
        throw new Error(
          `PR #${entry.number} candidate merge failed operationally: ${operationalError.message}`,
          { cause: operationalError },
        );
      }
    }
    if (gitCommandSucceeded(git, ['diff', '--cached', '--quiet'])) {
      throw new MergeTrainNoopError(
        `PR #${entry.number} no longer changes main; its squash diff is already present in the candidate base`,
      );
    }
    const timestamp = commitTimestamp(entry);
    git(['commit', '-m', squashCommitTitle(entry), '-m', squashCommitMessage(entry)], {
      env: {
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
        ...CANDIDATE_GIT_IDENTITY,
      },
    });
  }
  const sha = git(['rev-parse', 'HEAD']);
  if (live) {
    pushCandidateBundle({ baseSha, refName, git });
  }
  return sha;
}

/**
 * Determine whether a schedule-triggered CI run executed the full gate or was
 * a disabled-train no-op. When `MERGE_TRAIN_ENABLED=false`, `ci.yml` gates
 * the `changes` (Detect change scope) job on the flag, so a scheduled run
 * with the flag off completes as `success` without running any real CI jobs.
 * A no-op schedule run is NOT authoritative main-health evidence: after the
 * flag is re-enabled, it could outrank a genuine failed push and let promotion
 * proceed from a red `main`.
 *
 * `jobs` is the list of workflow-run jobs from the GitHub Actions API
 * (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`).
 *
 * Returns `true` when the run is NOT full-CI evidence (disabled-train no-op
 * or jobs data is unavailable). Fails closed: if no jobs are returned or the
 * `changes` job is absent, the run cannot be confirmed as full CI.
 */
export function isDisabledTrainScheduleRun(jobs) {
  if (!jobs || jobs.length === 0) return true;
  const changesJob = jobs.find((job) => job.name === 'Detect change scope');
  return !changesJob || changesJob.conclusion === 'skipped';
}

/**
 * Classify `main`'s own CI health for the merge train's failure-ATTRIBUTION
 * circuit breaker. Considers authoritative full-CI ("ci.yml", the `CI`
 * workflow) runs for the exact SHA `main` is on right now -- both `schedule`
 * and `push` runs -- but excludes push runs that merely attest a merge-train
 * fast-path shortcut (`isTrainFastPath: true`; their own green conclusion is
 * not full-CI evidence). A pending duplicate cannot hide completed evidence
 * for the same SHA; the newest completed run remains authoritative, including
 * a later completed failure.
 *
 * Returns `{ verdict, reason }` where verdict is:
 *   - `'red'`     the newest completed authoritative run concluded non-success
 *   - `'green'`   the newest completed authoritative run succeeded
 *   - `'unknown'` no authoritative evidence exists yet, or it is still pending
 *
 * This deliberately fails OPEN on `'unknown'`, unlike the promotion gate it
 * replaced (ADR 0077). Main health is no longer a promotion gate -- the
 * composite prefix validation is the sole promotion gate -- so this verdict is
 * only consulted to decide whether a RED composite is attributable to a queued
 * PR. Absence of evidence attributes nothing. Failing closed here would be
 * ruinous rather than safe: after every train promotion the only run on the new
 * `main` is the excluded fast-path attestation, so "no evidence" is the steady
 * state, and with a daily full-CI backstop a fail-closed breaker would suspend
 * ejection of genuinely broken PRs for up to a day. An unattributed ejection is
 * recoverable (the PR returns to ci-recovery and re-queues); a train that
 * cannot eject anything is not self-healing.
 */
export function mainAttributionVerdict({ mainSha, runs }) {
  const authoritative = (runs || [])
    .filter((run) => run.head_sha === mainSha && run.name === 'CI' && !run.isTrainFastPath)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  if (authoritative.length === 0) {
    return { verdict: 'unknown', reason: `no full-CI evidence yet for current main ${mainSha}` };
  }
  const latestCompleted = authoritative.find((run) => run.status === 'completed');
  if (!latestCompleted) {
    return {
      verdict: 'unknown',
      reason: `full-CI run for current main ${mainSha} is still ${authoritative[0].status}`,
    };
  }
  // Only conclusions that represent an actual test failure count as positive red
  // evidence. Infra-only outcomes (cancelled, skipped, stale, neutral) are not
  // authoritative: treat them the same as `unknown` so a manually cancelled run
  // does not suppress bisection/ejection until the next daily backstop.
  // Mirrors the incident router's gate (incident.mjs: only failure/timed_out/
  // startup_failure/action_required raise incidents).
  const FAILURE_CONCLUSIONS = new Set([
    'failure',
    'timed_out',
    'startup_failure',
    'action_required',
  ]);
  if (FAILURE_CONCLUSIONS.has(latestCompleted.conclusion)) {
    return {
      verdict: 'red',
      reason: `latest completed full-CI run for current main ${mainSha} concluded ${latestCompleted.conclusion}`,
    };
  }
  if (latestCompleted.conclusion === 'success') {
    return { verdict: 'green', reason: null };
  }
  // cancelled / skipped / stale / neutral — not authoritative evidence either way
  return {
    verdict: 'unknown',
    reason: `latest completed full-CI run for current main ${mainSha} has non-authoritative conclusion ${latestCompleted.conclusion}`,
  };
}

export function promotionStaleReason({ currentMain, currentPr, expectedBase, pr, repository }) {
  if (currentMain !== expectedBase) return 'main moved since validation';
  if (currentPr.head?.sha !== pr.head?.sha) return 'PR head changed since validation';
  if (currentPr.title !== pr.title) return 'PR title changed since validation';
  if (currentPr.state !== 'open') return 'PR is no longer open';
  if (currentPr.draft) return 'PR is now a draft';
  if (currentPr.base?.ref !== 'main')
    return `PR retargeted to ${currentPr.base?.ref || '<unknown>'}`;
  if (!sameRepository(currentPr, repository)) return 'PR head repository changed';
  if (!hasLabel(currentPr, QUEUE_LABEL)) return `PR no longer has the ${QUEUE_LABEL} label`;
  if (hasLabel(currentPr, BLOCKED_LABEL)) return `PR is marked ${BLOCKED_LABEL}`;
  if (hasLabel(currentPr, CI_CONFLICT_ORDER_WAIT_LABEL))
    return `PR has ${CI_CONFLICT_ORDER_WAIT_LABEL} label`;
  return null;
}

export async function promoteExactCandidate({
  pr,
  candidateSha,
  expectedBase,
  position,
  repository,
  live,
  fetchCurrentPr,
  fetchCurrentMain,
  fetchCommit,
  eligible,
  git,
  mergePullRequest,
  setLabel,
  removeLabel,
  updateStatus,
  postLandedComment,
  publishPostconditionCheck,
  provenanceEntries = [pr],
  recordMapping,
}) {
  return promoteExactBatch({
    entries: [pr],
    candidateShas: [candidateSha],
    expectedBase,
    repository,
    live,
    fetchCurrentPr: async () => fetchCurrentPr(),
    fetchCurrentMain,
    fetchCommit,
    eligible,
    git,
    mergePullRequest,
    setLabel,
    removeLabel,
    updateStatus,
    postLandedComment,
    publishPostconditionCheck,
    provenanceEntries,
    positions: [position],
    recordMapping,
  });
}

export async function promoteExactBatch({
  entries,
  candidateShas,
  expectedBase,
  repository,
  live,
  fetchCurrentPr,
  fetchCurrentMain,
  fetchCommit,
  eligible,
  git,
  mergePullRequest,
  setLabel,
  removeLabel,
  updateStatus,
  postLandedComment,
  publishPostconditionCheck,
  verifyCandidateEvidence = async () => true,
  provenanceEntries = entries,
  positions = entries.map((_, index) => index + 1),
  recordMapping = () => {},
  verifyMergeSlot = async () => null,
  proofPollDelaysMs,
  proofSleep,
}) {
  if (entries.length === 0 || entries.length !== candidateShas.length) {
    throw new Error('Promotion requires one candidate SHA per non-empty PR entry');
  }
  const currentMain = await fetchCurrentMain();
  const currentPrs = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const currentPr = await fetchCurrentPr(entry, index);
    const staleReason = promotionStaleReason({
      currentMain,
      currentPr,
      expectedBase,
      pr: entry,
      repository,
    });
    if (staleReason) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${staleReason}; rebuilding on next reconcile\n`,
      );
      return false;
    }
    const admission = await eligible(currentPr);
    if (!admission.ok) {
      process.stdout.write(`blocked promotion pr=#${entry.number} reason=${admission.reason}\n`);
      return false;
    }
    const expectedParent = index === 0 ? expectedBase : candidateShas[index - 1];
    const parent = git(['rev-parse', `${candidateShas[index]}^`]);
    if (parent !== expectedParent) {
      throw new Error(
        `Candidate ${candidateShas[index]} is not a direct child of ${expectedParent}`,
      );
    }
    const headRef = currentPr.head.ref;
    if (!/^[A-Za-z0-9._/-]+$/.test(headRef)) {
      throw new Error(`Unsafe PR head ref: ${headRef}`);
    }
    // An armed auto-merge could land this PR out of order underneath the
    // sequential squash-merge loop below (see #1131's real merge-then-force-
    // push-2s-later race). Fail closed; reconcile disables the arming and
    // rebuilds before the next attempt.
    if (currentPr.auto_merge) {
      process.stdout.write(
        `blocked promotion pr=#${entry.number}; auto_merge is armed; disabling and rebuilding next reconcile\n`,
      );
      return false;
    }
    currentPrs.push(currentPr);
  }
  if (!live) {
    process.stdout.write(
      `dry-run would-promote prs=${entries.map((entry) => `#${entry.number}`).join(',')} sha=${candidateShas.at(-1)}\n`,
    );
    return false;
  }
  const finalMain = await fetchCurrentMain();
  if (finalMain !== expectedBase) {
    process.stdout.write('stale promotion; main moved during final reattestation\n');
    return false;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const finalPr = await fetchCurrentPr(entry, index);
    const staleReason = promotionStaleReason({
      currentMain: finalMain,
      currentPr: finalPr,
      expectedBase,
      pr: entry,
      repository,
    });
    const admission = staleReason ? null : await eligible(finalPr);
    if (staleReason || !admission.ok) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${staleReason || admission.reason}; final reattestation failed\n`,
      );
      return false;
    }
    if (finalPr.auto_merge) {
      process.stdout.write(
        `blocked promotion pr=#${entry.number}; auto_merge armed at final reattestation\n`,
      );
      return false;
    }
    currentPrs[index] = finalPr;
  }
  // Main's OWN health is deliberately NOT re-checked here (ADR 0077). The
  // validated composite candidate -- built on exactly `expectedBase` and proven
  // green by the full merge-gate -- is the sole promotion gate; re-asserting
  // that `main` alone is green would only reinstate the deadlock where a PR
  // that FIXES a red `main` can never land. Everything this re-check used to
  // add is still covered: `main` moving is caught by `promotionStaleReason`
  // above, by the whole-batch `finalMain` guard, and by the per-merge base-CAS
  // below; a divergent landing is caught fail-closed by the post-merge
  // parent/tree proof (`landedCommitProofError`). The only case it uniquely
  // covered -- `main` going red WITHOUT moving, i.e. a re-run of CI on the same
  // SHA concluding differently -- is not a promotion concern, because the
  // candidate was validated against that exact SHA. Main health now feeds only
  // the failure-ATTRIBUTION breaker in reconcile.mjs.
  const finalCandidateSha = candidateShas.at(-1);
  const promotionFingerprint = candidateFingerprint(expectedBase, currentPrs);
  // ---- Sequential GitHub squash-merge promotion. ----
  // The atomic multi-ref force-push is gone. Each PR is merged through
  // GitHub's own squash machinery (the trusted App bypasses the required-check
  // ruleset), so GitHub records it with `merged: true` and a real merge commit
  // -- the completion semantics the force-push could never produce (it left
  // every promoted PR permanently `merged:false, merged_at:null`; see the
  // superseded ADR 0062 DEC-025). buildCandidate already built a linear
  // one-squash-commit-per-PR chain, so merging each PR in order onto the
  // growing `main` reproduces exactly that chain, and `main` stays linear.
  //
  // Every landed commit is PROVEN (landedCommitProofError) to be recorded
  // merged, be a single-parent child of the expected base, and carry the exact
  // tree of the corresponding validated candidate prefix -- else the run fails
  // closed after publishing the postcondition-failure check on the ACTUAL
  // landed commit. Because each merge is a genuine GitHub merge, partial
  // promotion is naturally idempotent-recoverable: any PR that already landed
  // is real-merged (dropped from the next open-queue scan) and any that did
  // not rebuilds from the new `main` next reconcile. We therefore stop (return
  // false) on the first stale/retryable outcome rather than forcing the rest,
  // and only THROW on a proof violation (a divergent/foreign commit reached
  // main). A landed PR is never re-closed and never marked landed before its
  // merge response and full proof succeed.
  const landed = [];
  const publishPostcondition = async (sha) => {
    try {
      await publishPostconditionCheck(sha, promotionFingerprint, provenanceEntries);
    } catch (error) {
      process.stdout.write(
        `failed to publish ${PROMOTION_POSTCONDITION_CHECK_NAME} on ${sha}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  };
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    // Re-read the selected batch candidate's immutable validation immediately
    // before every merge. A deleted/superseded result fails closed even after
    // earlier PRs in the same FIFO prefix have landed.
    if (!(await verifyCandidateEvidence())) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; batch candidate lost its validation evidence; rebuilding next reconcile\n`,
      );
      return false;
    }
    const expectedParent = index === 0 ? expectedBase : landed[index - 1].sha;
    const expectedTree = git(['rev-parse', `${candidateShas[index]}^{tree}`]);
    // Base-CAS: GitHub's merge API has no expected-base parameter, so assert
    // main is still exactly the base this squash will land on, immediately
    // before the merge. This shrinks the base-movement window to the few ms
    // before the PUT; the post-merge parent/tree proof catches any residual
    // race and fails closed. Auto-merge fencing above removes the most likely
    // competing writer.
    const mainBeforeMerge = await fetchCurrentMain();
    if (mainBeforeMerge !== expectedParent) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; main moved to ${mainBeforeMerge} (expected ${expectedParent}); rebuilding next reconcile\n`,
      );
      return false;
    }
    // Per-merge admission recheck: earlier merges + proofs in this loop take
    // seconds, during which THIS not-yet-merged PR could gain an unresolved
    // review thread, lose its queue label, change title/base, or re-arm
    // auto-merge. The batch-wide reattestation ran only once before the loop,
    // and the merge helper pins just the head SHA -- so re-verify this exact
    // PR's admission immediately before its PUT. (promotionStaleReason is reused
    // with expectedBase = the current prefix base so its main-moved check is a
    // no-op here; the base itself was already asserted just above.)
    const freshPr = await fetchCurrentPr(entry, index);
    const freshStale = promotionStaleReason({
      currentMain: mainBeforeMerge,
      currentPr: freshPr,
      expectedBase: mainBeforeMerge,
      pr: entry,
      repository,
    });
    if (freshStale) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${freshStale}; rebuilding next reconcile\n`,
      );
      return false;
    }
    const freshAdmission = await eligible(freshPr);
    if (!freshAdmission.ok) {
      process.stdout.write(
        `blocked promotion pr=#${entry.number} reason=${freshAdmission.reason}; rebuilding next reconcile\n`,
      );
      return false;
    }
    if (freshPr.auto_merge) {
      process.stdout.write(
        `blocked promotion pr=#${entry.number}; auto_merge re-armed before merge; rebuilding next reconcile\n`,
      );
      return false;
    }
    const mergeSlotReason = await verifyMergeSlot({
      entry,
      index,
      currentPr: freshPr,
      currentMain: mainBeforeMerge,
    });
    if (mergeSlotReason) {
      process.stdout.write(
        `blocked promotion pr=#${entry.number} reason=${mergeSlotReason}; rebuilding next reconcile\n`,
      );
      return false;
    }
    // Re-read main immediately after the potentially long coordinator scan:
    // verifyMergeSlot fetches files, comments, checks, and runs git proofs for
    // every group member, which can take several seconds. Re-assert that main
    // has not advanced since the base-CAS check above so we do not land onto an
    // unexpected parent.
    const mainAfterSlotVerify = await fetchCurrentMain();
    if (mainAfterSlotVerify !== mainBeforeMerge) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; main moved to ${mainAfterSlotVerify} during coordinator scan (expected ${mainBeforeMerge}); rebuilding next reconcile\n`,
      );
      return false;
    }
    // Post-slot admission re-check: verifyMergeSlot can take several seconds
    // during which admission state can change — a new unresolved review thread
    // can be opened, human approval withdrawn, or CI-recovery evidence updated.
    // main is unchanged (checked just above) but those changes are invisible to
    // it, so re-fetch the PR and re-run the full stale/admission/auto-merge
    // gate immediately before the merge PUT.
    const postSlotPr = await fetchCurrentPr(entry, index);
    const postSlotStale = promotionStaleReason({
      currentMain: mainAfterSlotVerify,
      currentPr: postSlotPr,
      expectedBase: mainAfterSlotVerify,
      pr: entry,
      repository,
    });
    if (postSlotStale) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${postSlotStale} (post-slot recheck); rebuilding next reconcile\n`,
      );
      return false;
    }
    const postSlotAdmission = await eligible(postSlotPr);
    if (!postSlotAdmission.ok) {
      process.stdout.write(
        `blocked promotion pr=#${entry.number} reason=${postSlotAdmission.reason} (post-slot recheck); rebuilding next reconcile\n`,
      );
      return false;
    }
    if (postSlotPr.auto_merge) {
      process.stdout.write(
        `blocked promotion pr=#${entry.number}; auto_merge re-armed during slot verification; rebuilding next reconcile\n`,
      );
      return false;
    }
    // Use postSlotPr.head.sha as the merge anchor. promotionStaleReason above
    // already compares postSlotPr.head.sha against entry.head.sha (the
    // batch-validated snapshot); if a push landed during the coordinator scan
    // they diverge and we return false above with "PR head changed since
    // validation". So if we reach here, postSlotPr.head.sha === entry.head.sha
    // === freshPr.head.sha and all three are equivalent.
    const merge = await mergePullRequest(entry, {
      expectedHeadSha: postSlotPr.head.sha,
      commitTitle: squashCommitTitle(freshPr),
      commitMessage: squashCommitMessage(freshPr),
    });
    if (!merge.ok) {
      if (merge.retryable) {
        process.stdout.write(
          `stale promotion pr=#${entry.number}; ${merge.reason}; rebuilding next reconcile\n`,
        );
        return false;
      }
      // Nothing landed for this entry -- the merge API call itself failed --
      // so there is no landed commit to blame. Publish on `mainBeforeMerge`,
      // the confirmed-current, real main commit asserted by the base-CAS
      // check just above, not a candidate SHA: candidates are transported as
      // opaque git blobs and are never real commit objects on GitHub, so a
      // check-run attached to one would not resolve.
      await publishPostcondition(mainBeforeMerge);
      throw new MergeTrainPromotionError(
        `promotion aborted at pr=#${entry.number}: ${merge.reason}`,
      );
    }
    const landedSha = merge.sha;
    const proofError = await landedCommitProofError({
      fetchCommit,
      fetchCurrentMain,
      fetchCurrentPr,
      entry,
      index,
      landedSha,
      expectedParent,
      expectedTree,
      ...(proofPollDelaysMs ? { pollDelaysMs: proofPollDelaysMs } : {}),
      ...(proofSleep ? { sleep: proofSleep } : {}),
    });
    if (proofError) {
      await publishPostcondition(landedSha);
      throw new MergeTrainPromotionError(
        `post-merge proof failed for pr=#${entry.number} at ${landedSha}: ${proofError}`,
      );
    }
    landed.push({ entry, sha: landedSha });
    recordMapping(entry.number, landedSha);
    // Durable landed signal -- only AFTER the merge response + full proof. A
    // label/comment hiccup must never abort the batch or re-close a genuinely
    // merged PR; record and continue, and startup reconciliation finishes any
    // interrupted cleanup idempotently next run.
    //
    // Ordering matters for crash recovery: set LANDED_LABEL FIRST (it is the
    // durable proof-complete marker -- reconcileLandedSignals only finishes a
    // landing that carries it), post the comment/status, and remove QUEUE_LABEL
    // (the recovery journal key) LAST. If any middle step fails, the PR still
    // carries both LANDED (proven) and QUEUE (discoverable), so recovery can
    // finish it; removing QUEUE early would hide an incomplete landing forever.
    try {
      await setLabel(entry.number, LANDED_LABEL);
      await postLandedComment(entry.number, landedSha, finalCandidateSha);
      await updateStatus(
        entry.number,
        renderStatus({
          position: positions[index],
          candidateSha: finalCandidateSha,
          state: 'merged',
          detail: `Landed on main as ${landedSha}; GitHub recorded this PR as merged.`,
        }),
      );
      await removeLabel(entry.number, BLOCKED_LABEL);
      await removeLabel(entry.number, QUEUE_LABEL);
    } catch (error) {
      process.stdout.write(
        `landed pr=#${entry.number} sha=${landedSha} but landed-signal update failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  // Final whole-batch guard: main must end exactly at our last landed commit
  // (whose tree was already proven == the full candidate's, since the last
  // prefix IS the full candidate). Catches an external writer that moved main
  // after our final merge. Poll through the same bounded consistency window
  // used by landedCommitProofError -- a stale replica on the final read must
  // not publish a false postcondition failure on an already-proven commit. A
  // transient fetchCurrentMain error within the budget is retried (not an
  // immediate failure) so a network blip never bypasses the success path.
  const finalExpectedSha = landed.at(-1).sha;
  const finalDelays = proofPollDelaysMs || [1000, 2000, 3000, 5000, 8000, 8000, 8000];
  const finalSleep = proofSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let mainAfter;
  for (let attempt = 0; attempt <= finalDelays.length; attempt += 1) {
    try {
      mainAfter = await fetchCurrentMain();
    } catch (error) {
      process.stdout.write(
        `final main guard: transient fetchCurrentMain error on attempt ${attempt + 1}/${finalDelays.length + 1}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      mainAfter = undefined;
    }
    if (mainAfter === finalExpectedSha) break;
    if (attempt < finalDelays.length) await finalSleep(finalDelays[attempt]);
  }
  if (mainAfter !== finalExpectedSha) {
    await publishPostcondition(finalExpectedSha);
    throw new MergeTrainPromotionError(
      `main moved to ${mainAfter} after promotion (expected last landed ${finalExpectedSha})`,
    );
  }
  process.stdout.write(
    `promoted prs=${entries.map((entry) => `#${entry.number}`).join(',')} landed=${landed
      .map((item) => `#${item.entry.number}=${item.sha}`)
      .join(',')}\n`,
  );
  return true;
}

/**
 * Post-merge proof for a single sequentially squash-merged PR. Returns null
 * when every invariant holds, or a human-readable reason string when a
 * fail-closed tripwire fires. This is the guard that makes real GitHub merges
 * safe as promotion: it proves the commit GitHub actually created is exactly
 * the validated candidate prefix (tree), a single-parent child of the expected
 * base (linear main), that `main` advanced to it, and that GitHub recorded the
 * PR as merged with a timestamp. A non-null result means a divergent or
 * foreign commit reached `main` -- the caller publishes the postcondition
 * failure check on the ACTUAL landed commit and throws.
 *
 * `main` ref and PR merged-state are EVENTUALLY CONSISTENT after `PUT /merge`
 * (GitHub REST read replicas lag the write, historically ~20s). We therefore
 * POLL those reads (bounded) before failing, so transient replica lag never
 * falsely fails a valid land (which would publish a red postcondition check on a
 * good main commit). The commit object is immutable/content-addressed, so its
 * tree/parents are authoritative once readable; only ref/merged-state lag.
 *
 * `fetchCommit(sha)` returns the REST commit object
 * (`GET /repos/{o}/{r}/commits/{sha}`): `{ sha, commit: { tree: { sha } },
 * parents: [{ sha }] }`. Tree SHAs are content-addressed, so comparing the
 * landed commit's tree to the locally-built candidate prefix tree
 * (`git rev-parse <candidate>^{tree}`) is an exact content-equality proof.
 */
export async function landedCommitProofError({
  fetchCommit,
  fetchCurrentMain,
  fetchCurrentPr,
  entry,
  index,
  landedSha,
  expectedParent,
  expectedTree,
  pollDelaysMs = [1000, 2000, 3000, 5000, 8000, 8000, 8000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!/^[0-9a-f]{40}$/i.test(String(landedSha || ''))) {
    return `merge response returned an invalid landed sha: ${landedSha}`;
  }
  // Poll the eventually-consistent reads (main ref, PR merged-state + recorded
  // merge commit, and the commit object) until they reflect the just-completed
  // merge, or the budget is exhausted. The budget (~41s) intentionally exceeds
  // the ~20s read-replica lag this promotion path has historically observed, so
  // a normal lag never fails a valid land. Break as soon as they are consistent
  // so the happy path does not sleep at all. Each read is wrapped: a transient
  // 5xx/network failure on any of them must retry within the budget, NOT reject
  // the proof immediately (which would bypass the caller's postcondition publish
  // on a valid land).
  const landedMergeCommitMatches = (pr) =>
    pr?.merged === true &&
    Boolean(pr.merged_at) &&
    String(pr.merge_commit_sha || '').toLowerCase() === String(landedSha).toLowerCase();
  let commit = null;
  let mainAfter;
  let prAfter;
  for (let attempt = 0; attempt <= pollDelaysMs.length; attempt += 1) {
    try {
      [mainAfter, prAfter] = await Promise.all([fetchCurrentMain(), fetchCurrentPr(entry, index)]);
    } catch {
      mainAfter = undefined;
      prAfter = undefined;
    }
    if (!commit) {
      try {
        commit = await fetchCommit(landedSha);
      } catch {
        commit = null;
      }
    }
    if (commit && mainAfter === landedSha && landedMergeCommitMatches(prAfter)) {
      break;
    }
    if (attempt < pollDelaysMs.length) await sleep(pollDelaysMs[attempt]);
  }
  if (mainAfter !== landedSha) {
    return `main is ${mainAfter}, not the landed commit ${landedSha} (after polling for consistency)`;
  }
  if (!commit) {
    return `landed commit ${landedSha} was not readable after polling`;
  }
  const parents = (commit.parents || []).map((parent) => parent.sha);
  if (parents.length !== 1) {
    return `landed commit ${landedSha} has ${parents.length} parents (expected 1 for a squash merge; main must stay linear)`;
  }
  if (parents[0] !== expectedParent) {
    return `landed commit ${landedSha} parent is ${parents[0]} (expected ${expectedParent})`;
  }
  const landedTree = commit.commit?.tree?.sha;
  if (landedTree !== expectedTree) {
    return `landed commit ${landedSha} tree ${landedTree} != validated candidate prefix tree ${expectedTree}`;
  }
  // The hard gate: GitHub itself must record the PR merged with a real
  // timestamp AND with its recorded merge commit equal to the landed SHA.
  // `state === 'closed'` alone is INSUFFICIENT (the forbidden force-push
  // outcome); `merge_commit_sha` non-null alone is also insufficient (for a
  // closed-unmerged PR it is an ephemeral test-merge SHA), which is why it is
  // only trusted here together with `merged === true` and an exact match to the
  // commit we proved on `main`.
  if (prAfter?.merged !== true) {
    return `GitHub did not record PR #${entry.number} as merged (merged=${prAfter?.merged}, state=${prAfter?.state}) after polling`;
  }
  if (!prAfter.merged_at) {
    return `GitHub recorded PR #${entry.number} merged but with no merged_at timestamp after polling`;
  }
  if (String(prAfter.merge_commit_sha || '').toLowerCase() !== String(landedSha).toLowerCase()) {
    return `GitHub's recorded merge commit for PR #${entry.number} is ${prAfter.merge_commit_sha} (expected the landed ${landedSha})`;
  }
  return null;
}

/**
 * Pure decision for crash-recovery of a merged-but-still-queued PR (an
 * interrupted landing). Because the candidate is not reconstructable after main
 * advances, recovery cannot re-run the per-commit tree proof; instead it
 * re-establishes the strongest post-hoc evidence and refuses anything weaker:
 *
 *   - the PR is genuinely GitHub-merged INTO `main` (real merged-state), and
 *   - its recorded merge commit is a valid SHA, and
 *   - that commit carries THIS PR's `Merge-Train-PR` trailer (train provenance;
 *     the trailer is only ever written by a promotion merge, which is
 *     structurally preceded by the base-CAS that fixes the landing tree), and
 *   - the commit is linear (exactly one parent), and
 *   - there is NO `merge-train-promotion-postcondition` failure recorded on it
 *     (that check is published precisely for the rare base-race that would have
 *     produced a divergent tree).
 *   - every one of those recovery facts was read successfully. An API outage is
 *     not evidence that the postcondition check is absent.
 *
 * Only when ALL hold does recovery finish the interrupted cleanup; otherwise it
 * skips (never asserting an unproven or known-divergent landing), or retries
 * when the proof facts could not be fetched (transient API outage). Returns
 * `{ action: 'finish' | 'skip' | 'retry', reason }`.
 */
export function planLandedRecovery({
  merged,
  baseRef,
  landedSha,
  trailerPrNumber,
  prNumber,
  parentCount,
  hasPostconditionFailure,
  hasLandedLabel,
  factsComplete,
}) {
  if (merged !== true) return { action: 'skip', reason: 'PR is not recorded merged' };
  if (baseRef !== 'main') return { action: 'skip', reason: 'PR was not merged into main' };
  if (!/^[0-9a-f]{40}$/i.test(String(landedSha || ''))) {
    return { action: 'skip', reason: 'PR has no valid recorded merge commit sha' };
  }
  if (factsComplete !== true) {
    return { action: 'retry', reason: 'could not reconstruct all landed-commit proof facts' };
  }
  if (trailerPrNumber !== prNumber) {
    return {
      action: 'skip',
      reason: "merge commit lacks this PR's Merge-Train-PR provenance trailer",
    };
  }
  if (parentCount !== 1) {
    return { action: 'skip', reason: 'landed commit is not linear (expected exactly one parent)' };
  }
  if (hasPostconditionFailure) {
    return {
      action: 'skip',
      reason:
        'a promotion-postcondition failure is recorded on the landed commit (possible divergence)',
    };
  }
  if (!hasLandedLabel) {
    return {
      action: 'skip',
      reason:
        'LANDED_LABEL proof-complete marker is absent; crash may have occurred before tree proof ran — leaving for human review',
    };
  }
  return { action: 'finish', reason: 'proven interrupted landing' };
}

export async function applyLandedRecoveryDecision({
  prNumber,
  landedSha,
  decision,
  postLandedComment,
  setLabel,
  removeLabel,
}) {
  if (decision.action === 'finish') {
    await postLandedComment(prNumber, landedSha, '', true);
    await removeLabel(prNumber, QUEUE_LABEL);
    await removeLabel(prNumber, BLOCKED_LABEL);
    await removeLabel(prNumber, RECOVERY_PENDING_LABEL);
    return;
  }

  if (decision.action === 'retry') {
    await setLabel(prNumber, RECOVERY_PENDING_LABEL);
    await removeLabel(prNumber, QUEUE_LABEL);
    return;
  }

  await removeLabel(prNumber, QUEUE_LABEL);
  await removeLabel(prNumber, RECOVERY_PENDING_LABEL);
}

/**
 * Create a `mergePullRequest(entry, { expectedHeadSha, commitTitle,
 * commitMessage })` bound to `request`/`token`. It waits (bounded) for GitHub
 * to compute mergeability, then squash-merges the PR through GitHub's own
 * Merge API, pinning the exact head SHA as a race guard and writing the
 * durable `Merge-Train-PR` trailer into the squash commit message.
 *
 * Returns `{ ok: true, sha }` with GitHub's REAL merge commit SHA on success.
 * Returns `{ ok: false, retryable: true, reason }` for a stale/transient
 * outcome (head moved, not-yet-mergeable, 405/409) so the caller rebuilds on
 * the next reconcile. Returns `{ ok: false, retryable: false, reason }` for a
 * policy/configuration or ambiguous failure (403/422/5xx, a network error, or a
 * response not recorded merged); the caller then publishes the
 * promotion-postcondition failure check and fails loudly (nothing landed for
 * this entry, so it is safe to surface hard rather than be misclassified as a
 * stale candidate and silently retried forever). It does not throw, so the
 * caller's fail-closed postcondition publish is never bypassed.
 */
export function createMergePullRequest({
  request,
  token,
  owner,
  repo,
  mergeablePollDelaysMs = [1000, 2000, 3000, 5000, 8000, 12000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  return async function mergePullRequest(entry, { expectedHeadSha, commitTitle, commitMessage }) {
    for (let attempt = 0; attempt <= mergeablePollDelaysMs.length; attempt += 1) {
      let pr;
      try {
        pr = (await request(token, `/repos/${owner}/${repo}/pulls/${entry.number}`)).data;
      } catch (error) {
        // A transient GET failure during mergeability polling happens BEFORE any
        // merge, so nothing landed. Treat as retryable (rebuild next reconcile)
        // rather than throwing -- throwing here would bubble past the caller's
        // fail-closed handling. (Contract: this function never throws.)
        return {
          ok: false,
          retryable: true,
          reason: `mergeability poll failed (${error?.status ?? 'network'}): ${error?.message ?? String(error)}`,
        };
      }
      if (pr.head?.sha !== expectedHeadSha) {
        return {
          ok: false,
          retryable: true,
          reason: `head moved to ${pr.head?.sha} (expected ${expectedHeadSha})`,
        };
      }
      if (pr.mergeable === false) {
        return {
          ok: false,
          retryable: true,
          reason: `PR is not mergeable (mergeable_state: ${pr.mergeable_state || 'unknown'})`,
        };
      }
      if (pr.mergeable === true) break;
      // mergeable === null: GitHub is still computing mergeability; wait and
      // retry within the bounded budget.
      if (attempt < mergeablePollDelaysMs.length) {
        await sleep(mergeablePollDelaysMs[attempt]);
      } else {
        return { ok: false, retryable: true, reason: 'mergeability still unknown after polling' };
      }
    }
    let response;
    try {
      response = await request(token, `/repos/${owner}/${repo}/pulls/${entry.number}/merge`, {
        method: 'PUT',
        body: {
          sha: expectedHeadSha,
          merge_method: 'squash',
          commit_title: commitTitle,
          commit_message: commitMessage,
        },
      });
    } catch (error) {
      const status = error?.status;
      // 405 Method Not Allowed = PR not currently mergeable; 409 Conflict =
      // head SHA no longer matches the pinned `sha` (moved). Both definitively
      // mean nothing merged and the candidate is stale, so rebuild next
      // reconcile rather than failing hard.
      if (status === 405 || status === 409) {
        return {
          ok: false,
          retryable: true,
          reason: `merge API rejected the merge (${status}): ${error?.message ?? String(error)}`,
        };
      }
      // 5xx/network failures are AMBIGUOUS: GitHub may have merged the PR before
      // the response was lost. Disambiguate by re-reading the PR -- if it is now
      // merged with a real merge commit, return that SHA as success so the
      // caller runs the full post-merge proof on it (rather than skipping the
      // proof and letting recovery later trust it unverified). Only if it truly
      // did not merge do we return a non-retryable failure (so the caller
      // publishes the postcondition check and fails loudly). Merged-state is
      // eventually consistent (~20s lag), so POLL (bounded) before concluding
      // the PUT did not merge -- a single stale read could otherwise misreport a
      // successful merge as a hard failure.
      for (let attempt = 0; attempt <= mergeablePollDelaysMs.length; attempt += 1) {
        try {
          const after = (await request(token, `/repos/${owner}/${repo}/pulls/${entry.number}`))
            .data;
          if (
            after?.merged === true &&
            /^[0-9a-f]{40}$/i.test(String(after.merge_commit_sha || ''))
          ) {
            return { ok: true, sha: String(after.merge_commit_sha) };
          }
        } catch {
          // transient re-read failure; keep polling within the budget
        }
        if (attempt < mergeablePollDelaysMs.length) await sleep(mergeablePollDelaysMs[attempt]);
      }
      return {
        ok: false,
        retryable: false,
        reason: `merge API failed (${status ?? 'network'}): ${error?.message ?? String(error)}`,
      };
    }
    const data = response.data || {};
    if (data.merged !== true || !/^[0-9a-f]{40}$/i.test(String(data.sha || ''))) {
      return {
        ok: false,
        retryable: false,
        reason: `merge API did not record PR #${entry.number} as merged (merged=${data.merged}, sha=${data.sha})`,
      };
    }
    return { ok: true, sha: String(data.sha) };
  };
}

/**
 * Create dispatch functions bound to `workflowDispatchToken` (GITHUB_TOKEN).
 * Both recovery and validation workflow dispatches must use the built-in
 * Actions token rather than the repository App promotion token; using the
 * App token causes 403 responses on workflow_dispatch endpoints. Binding the
 * token through this factory makes the routing unit-testable: a test can
 * verify that the returned functions always forward `workflowDispatchToken`
 * to the underlying helpers regardless of what other tokens are in scope.
 */
export function buildDispatchBindings({ request, workflowDispatchToken, owner, repo }) {
  async function dispatchRecovery(prNumber, trigger) {
    await dispatchRecoveryWorkflow({
      request,
      token: workflowDispatchToken,
      owner,
      repo,
      prNumber,
      trigger,
    });
  }
  async function dispatchValidation(sha, refName, attestationSha, fingerprint, entries) {
    await dispatchValidationWorkflow({
      request,
      token: workflowDispatchToken,
      owner,
      repo,
      sha,
      refName,
      attestationSha,
      fingerprint,
      entries,
    });
  }
  return { dispatchRecovery, dispatchValidation };
}

/**
 * Wraps a `dispatchRecovery` function with a per-call admission check against
 * `cap` outstanding CI Recovery runs.  Used by reconcile.mjs so that its four
 * direct `dispatchRecovery` call sites are gated by the same cap applied by
 * the router workflow.
 *
 * An in-process `pendingDispatches` counter tracks successful dispatches made
 * during this reconcile.mjs invocation that may not yet be visible in the
 * GitHub Actions API (due to visibility lag).  The admission check uses
 * `outstandingCount + pendingDispatches >= cap` so that sequential calls in
 * an admission loop cannot all see a stale API count of zero and each dispatch
 * independently while exceeding `cap`.
 *
 * The check remains best-effort across processes: there is a narrow race
 * window between this read and the router's own read/dispatch (the router's
 * concurrency group serialises its own invocations but does not serialise
 * against reconcile.mjs calls).  The window is acceptably small for the
 * target repo scale; a durable reservation would be needed to close it
 * completely.
 *
 * @param {object} opts
 * @param {(prNumber: number, trigger: string) => Promise<void>} opts.dispatchRecovery
 * @param {(token: string, owner: string, repo: string) => Promise<number>} opts.countRuns
 * @param {number} opts.cap  Maximum outstanding runs to allow dispatch.
 * @param {string} opts.token  GitHub token for the count request.
 * @param {string} opts.owner  Repository owner.
 * @param {string} opts.repo   Repository name.
 * @returns {(prNumber: number, trigger: string) => Promise<void>}
 */
export function buildGatedDispatchRecovery({
  dispatchRecovery,
  countRuns,
  cap,
  token,
  owner,
  repo,
}) {
  // Tracks dispatches made during this invocation that may not yet be visible
  // in the API. Incremented after a confirmed successful dispatch; never
  // decremented so the reservation persists for all subsequent calls within
  // the same reconcile.mjs run.
  let pendingDispatches = 0;
  return async function dispatchRecoveryGated(prNumber, trigger) {
    const outstandingCount = await countRuns(token, owner, repo);
    if (outstandingCount + pendingDispatches >= cap) {
      process.stdout.write(
        `backpressure: skipping dispatch pr=#${prNumber} trigger=${trigger} outstanding=${outstandingCount} pending=${pendingDispatches} cap=${cap} (10-min sweep will retry)\n`,
      );
      return;
    }
    await dispatchRecovery(prNumber, trigger);
    // Reserve the slot only after a successful dispatch so a failed
    // workflow_dispatch does not permanently consume capacity.
    pendingDispatches++;
  };
}
