import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { paginate, request } from './github.mjs';
import {
  isHealthyRecoveryOwner,
  OWNER_LABEL_PREFIX,
  ownerLabel,
  parseStateComment,
  STATE_MARKER,
  WAITING_LABEL,
  WAITING_TRANSITION_LABEL,
} from './state.mjs';
import {
  BLOCKED_LABEL,
  NOOP_LABEL,
  parseEnabledFlag,
  queueEntries,
  QUEUE_LABEL,
  VALIDATION_FAILED_LABEL,
} from '../merge-train/state.mjs';

const DEFAULT_MAX_DISPATCH_PER_RUN = 8;
// ── Load-aware dispatch budget constants ─────────────────────────────────────
// GitHub Free public repo: ~20 concurrent hosted-job ceiling (standard-hosted
// runners). Measured peaks: normal PR CI ~5 concurrent jobs; uncontended Merge
// Train Validation peaks at 7-9 concurrent jobs; a full AI Sweep Eval can fan
// out to ~19 concurrent matrix jobs, which is what starved Validation runners
// during the 2026-07-21 incident.
export const RUNNER_CEILING = 20;
// Runner slots to protect for Merge Train Validation when the queue is active.
// 9 is the measured peak of concurrent validation jobs; using it as the floor
// ensures recovery dispatch does not crowd out head-of-line validation.
export const VALIDATION_RESERVED_TRAIN_BUSY = 9;
// Smaller safety buffer when the train queue is empty / train feature is
// disabled (no active Validation run to protect, but sweep jobs may still
// be running).
export const VALIDATION_RESERVED_TRAIN_IDLE = 3;
// Upper bounds on the load-aware budget for each queue state. A full sweep
// run fans to ~10–19 concurrent jobs; leaving a MAX of 5 (busy) or 8 (idle)
// caps the blast radius while still allowing meaningful parallel recovery.
export const MAX_DISPATCH_BUDGET_TRAIN_BUSY = 5;
export const MAX_DISPATCH_BUDGET_TRAIN_IDLE = 8;
// Estimated concurrent runner jobs per in-progress AI Sweep run. Each
// ai-sweep.yml / ai-sweep-recover.yml run fans its round-eval matrix into
// many parallel jobs; 10 is a conservative mid-point of the 0–19 range
// observed in production. Used only by runFromEnv to convert run counts into
// estimated job counts before calling computeDispatchBudget.
export const SWEEP_RUNNER_WEIGHT = 10;
// Estimated concurrent runner jobs per active Merge Train Validation run.
// merge-train-validate.yml runs 7-9 concurrent gate jobs at peak; 9 matches
// VALIDATION_RESERVED_TRAIN_BUSY so the dynamic floor tracks measured load.
export const VALIDATION_RUNNER_WEIGHT = 9;
// Workflow files whose active run counts signal runner pressure to the budget.
export const SWEEP_WORKFLOW_FILES = Object.freeze(['ai-sweep.yml', 'ai-sweep-recover.yml']);
export const VALIDATION_WORKFLOW_FILE = 'merge-train-validate.yml';
// ── Legacy static caps (exported for reconcile.mjs buildGatedDispatchRecovery)
// These are now derived from the load-aware MAX constants above (raised from
// the previous 1/2). They act as a static ceiling for callers that cannot
// measure live runner pressure (e.g. reconcile.mjs dispatch sites).
export const GLOBAL_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_BUSY;
export const GLOBAL_IDLE_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_IDLE;
// GitHub Actions run states that represent a run not yet finished: actively
// running, waiting to be scheduled, or held by a concurrency group (queued
// runs whose concurrency group is busy report as `waiting`). `pending` is
// included even though the router itself never produces it, because it is a
// documented Actions run status and omitting it would let a run in that
// state go uncounted, silently widening the outstanding-run gap this cap
// exists to close.
const OUTSTANDING_RUN_STATUSES = ['queued', 'pending', 'in_progress', 'waiting', 'requested'];
const REPAIR_WINDOW_SIZE = 6;
const MANAGED_COMMENT_MARKERS = [
  '<!-- crawler-ci-state:v1 -->',
  '<!-- crawler-ci-task:v1',
  '<!-- crawler-merge-train:v1 -->',
  '<!-- crawler-review-request:v1',
  '<!-- crawler-review-conflict:v1',
];
const DEFAULT_RETRY_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
const FLAG_OFF_SWEEP_ROTATION_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_OUTSTANDING_VISIBILITY_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_OUTSTANDING_VISIBILITY_POLL_INTERVAL_MS = 5000;
// Labels owned by merge-train automation that must be drained during
// flag-off cleanup before legacy routing resumes normal operation. A PR that
// still carries one of these after MERGE_TRAIN_ENABLED=false needs the
// flag-off cleanup sweep in ci-recovery/reconcile.mjs to remove it before the
// PR can return to legacy automation. See collectPrNumbers() below.
const TRAIN_OWNED_LABELS = new Set([
  QUEUE_LABEL,
  BLOCKED_LABEL,
  NOOP_LABEL,
  VALIDATION_FAILED_LABEL,
]);
const OWNERSHIP_HYDRATION_BATCH_SIZE = 6;

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rotateList(values, rotation) {
  if (values.length <= 1) {
    return values;
  }
  const normalizedRotation = ((rotation % values.length) + values.length) % values.length;
  if (normalizedRotation === 0) {
    return values;
  }
  return [...values.slice(normalizedRotation), ...values.slice(0, normalizedRotation)];
}

export function parseRetryAfterMilliseconds(error) {
  const retryAfter = error?.headers?.get?.('retry-after');
  if (!retryAfter) {
    return null;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const until = Date.parse(retryAfter);
  if (Number.isNaN(until)) {
    return null;
  }
  return Math.max(0, until - Date.now());
}

export function parseRateLimitResetMilliseconds(error) {
  const reset = error?.headers?.get?.('x-ratelimit-reset');
  if (!reset) {
    return null;
  }
  const epochSeconds = Number.parseInt(reset, 10);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const waitMs = epochSeconds * 1000 - Date.now();
  return waitMs > 0 ? waitMs : null;
}

export function isRetryableError(error) {
  const status = Number(error?.status || 0);
  if (status === 429) {
    return true;
  }
  if (status >= 500 && status <= 599) {
    return true;
  }
  if (status === 403) {
    const message = String(error?.data?.message || error?.message || '').toLowerCase();
    return message.includes('rate limit') || message.includes('secondary rate limit');
  }
  return false;
}

export function computeBackoffDelayMs(error, attempt, baseDelayMs, maxDelayMs) {
  const retryAfterMs = parseRetryAfterMilliseconds(error);
  if (retryAfterMs !== null) {
    return Math.min(maxDelayMs, retryAfterMs);
  }

  const resetMs = parseRateLimitResetMilliseconds(error);
  if (resetMs !== null) {
    return Math.min(maxDelayMs, resetMs);
  }

  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(exp * 0.3)));
  return Math.min(maxDelayMs, exp + jitter);
}

export async function requestWithBackoff(
  execute,
  {
    maxAttempts = DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    label = 'request',
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(error, attempt, baseDelayMs, maxDelayMs);
      process.stdout.write(
        `retry ${label} attempt=${attempt}/${maxAttempts} status=${error.status || 'n/a'} wait_ms=${delayMs}\n`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`exhausted retries for ${label}`);
}

export function collectPrNumbers({
  payload,
  eventName,
  repository,
  scheduledPulls = [],
  maxDispatchPerRun = DEFAULT_MAX_DISPATCH_PER_RUN,
  trainEnabled = false,
  now = new Date(),
}) {
  if (trainEnabled) {
    const directlyTriggeredPrs = eventPrNumbers(payload);
    const repairWindowSweep = isRepairWindowSweepEvent({
      payload,
      eventName,
      trainEnabled,
    });
    const eligiblePulls = scheduledPulls
      .filter((pullRequest) => {
        const directlyTriggered = directlyTriggeredPrs.has(pullRequest.number);
        const labels = pullRequest.labels || [];
        const hasQueueLabel = labels.some((label) => label.name === QUEUE_LABEL);
        const hasOptOutLabel = labels.some((label) => label.name === 'ci-recovery-opt-out');
        const waiting = labels.some((label) => label.name === WAITING_LABEL);
        const waitingTransition = labels.some((label) => label.name === WAITING_TRANSITION_LABEL);
        const owned = labels.some((label) => String(label.name || '').startsWith('ci-owner-pr-'));
        const shouldExcludeByLabels =
          hasQueueLabel ||
          (!directlyTriggered && (hasOptOutLabel || (waiting && !owned && !waitingTransition)));
        return (
          pullRequest.state === 'open' &&
          !pullRequest.draft &&
          pullRequest.base?.ref === 'main' &&
          pullRequest.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
          !shouldExcludeByLabels
        );
      })
      .sort(
        (left, right) =>
          new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
          left.number - right.number,
      );
    const direct = eligiblePulls.filter((pullRequest) =>
      directlyTriggeredPrs.has(pullRequest.number),
    );

    if (!repairWindowSweep) {
      return direct.map((pullRequest) => pullRequest.number);
    }

    const waitingTransitions = eligiblePulls.filter(
      (pullRequest) =>
        !directlyTriggeredPrs.has(pullRequest.number) &&
        (pullRequest.labels || []).some((label) => label.name === WAITING_TRANSITION_LABEL),
    );
    const sweep = eligiblePulls.filter(
      (pullRequest) =>
        !directlyTriggeredPrs.has(pullRequest.number) &&
        !(pullRequest.labels || []).some((label) => label.name === WAITING_TRANSITION_LABEL) &&
        !hasHealthyOwnerForSweep(pullRequest, now),
    );
    return [...direct, ...waitingTransitions, ...sweep]
      .slice(0, Math.max(REPAIR_WINDOW_SIZE, direct.length))
      .sort(
        (left, right) =>
          new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
          left.number - right.number,
      )
      .map((pullRequest) => pullRequest.number);
  }
  const directNumbers = eventPrNumbers(payload);
  const numbers = new Set(directNumbers);
  // PRs still carrying a train-owned label after flag-off. These must not be
  // starved by the dispatch cap below: the flag-off cleanup in
  // ci-recovery/reconcile.mjs only runs for PRs it actually receives, so an
  // unbounded backlog of newly-updated PRs could otherwise keep pushing an
  // older, still-labeled PR past the cap on every sweep (never cleaned up).
  const trainLabeledNumbers = new Set();
  const waitingTransitionNumbers = new Set();
  const ownedNumbers = new Set();

  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    const normalizedRepo = repository.toLowerCase();
    for (const pullRequest of scheduledPulls) {
      const directlyTriggered = directNumbers.has(pullRequest.number);
      const waiting = (pullRequest.labels || []).some((label) => label.name === WAITING_LABEL);
      const waitingTransition = (pullRequest.labels || []).some(
        (label) => label.name === WAITING_TRANSITION_LABEL,
      );
      const owned = (pullRequest.labels || []).some((label) =>
        String(label.name || '').startsWith('ci-owner-pr-'),
      );
      if (
        !pullRequest.draft &&
        (directlyTriggered || !waiting || owned || waitingTransition) &&
        pullRequest.head?.repo?.full_name?.toLowerCase() === normalizedRepo
      ) {
        const number = Number.parseInt(String(pullRequest.number ?? ''), 10);
        if (Number.isInteger(number) && number > 0) {
          numbers.add(number);
          if (hasTrainOwnedLabel(pullRequest)) {
            trainLabeledNumbers.add(number);
          }
          if (waitingTransition) {
            waitingTransitionNumbers.add(number);
          }
          if (owned) {
            ownedNumbers.add(number);
          }
        }
      }
    }
  }

  const eligible = [...numbers];
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    // Prioritize PRs the event directly named plus any still carrying a
    // train-owned label so the flag-off cleanup sweep completes for them
    // before the cap is spent on unrelated recently-updated PRs.
    const prioritized = eligible.filter(
      (number) =>
        directNumbers.has(number) ||
        trainLabeledNumbers.has(number) ||
        waitingTransitionNumbers.has(number),
    );
    const remaining = eligible.filter(
      (number) =>
        !directNumbers.has(number) &&
        !trainLabeledNumbers.has(number) &&
        !waitingTransitionNumbers.has(number),
    );
    // Keep already-owned PRs behind PRs that have not yet received an owner
    // label, then rotate each bucket once per 10-minute sweep window. Without
    // this, the later global budget slice in partitionDispatchable() keeps
    // selecting the same updated-desc prefix in flag-off mode, and PRs later in
    // the sweep can starve indefinitely.
    const rotation =
      Number.isFinite(now.getTime()) && now.getTime() > 0
        ? Math.floor(now.getTime() / FLAG_OFF_SWEEP_ROTATION_WINDOW_MS)
        : 0;
    const remainingUnowned = remaining.filter((number) => !ownedNumbers.has(number));
    const remainingOwned = remaining.filter((number) => ownedNumbers.has(number));
    const ordered = [
      ...prioritized,
      ...rotateList(remainingUnowned, rotation),
      ...rotateList(remainingOwned, rotation),
    ];
    return ordered.slice(0, maxDispatchPerRun);
  }
  return eligible;
}

export function recoveryStateFromComments(comments) {
  const stateComments = (comments || []).filter((comment) =>
    String(comment.body || '')
      .trimStart()
      .startsWith(STATE_MARKER),
  );
  if (stateComments.length !== 1) return null;
  try {
    return parseStateComment(stateComments[0].body);
  } catch {
    return null;
  }
}

export function hasHealthyOwnerForSweep(pullRequest, now = new Date()) {
  const ownerLabels = (pullRequest.labels || []).filter((label) =>
    String(label.name || '').startsWith(OWNER_LABEL_PREFIX),
  );
  if (
    ownerLabels.length !== 1 ||
    ownerLabels[0].name !== ownerLabel(pullRequest.number) ||
    pullRequest.recoveryStateUnreadable
  ) {
    return false;
  }
  // An automation state recorded for an older head incorrectly suppresses the
  // PR for up to 30 minutes after a push or rebase. Require the state head to
  // match the live PR head for automation owners so any head advance clears
  // suppression immediately. Shepherd leases are governed by their explicit
  // lease expiry and are not gated on head SHA.
  const state = pullRequest.recoveryState;
  if (state?.owner === 'automation') {
    const liveHead = String(pullRequest.head?.sha || '').toLowerCase();
    const stateHead = String(state.headSha || '').toLowerCase();
    if (liveHead && stateHead !== liveHead) {
      return false;
    }
  }
  return isHealthyRecoveryOwner({
    prNumber: pullRequest.number,
    state: pullRequest.recoveryState,
    now,
  });
}

export async function hydrateRecoveryOwnership(
  pulls,
  loadComments,
  batchSize = OWNERSHIP_HYDRATION_BATCH_SIZE,
  { targetDispatchable = null, countDispatchable = null } = {},
) {
  const hydrated = [...pulls];
  const orderedPulls = hydrated
    .map((pullRequest, index) => ({ pullRequest, index }))
    .sort(
      (left, right) =>
        (Date.parse(left.pullRequest.created_at) || 0) -
          (Date.parse(right.pullRequest.created_at) || 0) ||
        left.pullRequest.number - right.pullRequest.number,
    )
    .map((entry, orderIndex) => ({ ...entry, orderIndex }));
  const ownerIndexes = orderedPulls.filter(({ pullRequest }) =>
    (pullRequest.labels || []).some((label) =>
      String(label.name || '').startsWith(OWNER_LABEL_PREFIX),
    ),
  );

  const resolvedDispatchableCount = (endOrderIndex) => {
    if (!countDispatchable) return 0;
    return countDispatchable(
      orderedPulls.slice(0, endOrderIndex).map(({ index }) => hydrated[index]),
    );
  };

  const firstOwnerOrderIndex = ownerIndexes[0]?.orderIndex ?? orderedPulls.length;
  if (
    targetDispatchable !== null &&
    resolvedDispatchableCount(firstOwnerOrderIndex) >= targetDispatchable
  ) {
    return hydrated;
  }

  for (let offset = 0; offset < ownerIndexes.length; offset += batchSize) {
    const batch = ownerIndexes.slice(offset, offset + batchSize);
    await Promise.all(
      batch.map(async ({ pullRequest, index }) => {
        try {
          const comments = await loadComments(pullRequest.number);
          hydrated[index] = {
            ...pullRequest,
            recoveryState: recoveryStateFromComments(comments),
          };
        } catch (error) {
          hydrated[index] = {
            ...pullRequest,
            recoveryState: null,
            recoveryStateUnreadable: String(error?.message || error),
          };
        }
      }),
    );
    const nextOwner = ownerIndexes[offset + batch.length];
    const resolvedEndOrderIndex = nextOwner?.orderIndex ?? orderedPulls.length;
    if (
      targetDispatchable !== null &&
      resolvedDispatchableCount(resolvedEndOrderIndex) >= targetDispatchable
    ) {
      break;
    }
  }
  return hydrated;
}

export function isRepairWindowSweepEvent({ payload, eventName, trainEnabled }) {
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    return true;
  }
  if (!trainEnabled) {
    return false;
  }
  if (eventName === 'pull_request_target' && payload.action === 'closed') {
    return true;
  }
  if (eventName !== 'workflow_run' || eventPrNumbers(payload).size > 0) {
    return false;
  }

  const workflowRun = payload.workflow_run;
  const defaultBranch = payload.repository?.default_branch || 'main';
  return workflowRun?.name === 'CI' && workflowRun.head_branch === defaultBranch;
}

function hasTrainOwnedLabel(pullRequest) {
  return (pullRequest.labels || []).some((label) => TRAIN_OWNED_LABELS.has(label.name));
}

export function eventPrNumbers(payload) {
  const numbers = new Set();
  function add(value) {
    const number = Number.parseInt(String(value ?? ''), 10);
    if (Number.isInteger(number) && number > 0) {
      numbers.add(number);
    }
  }

  add(payload.pull_request?.number);
  add(payload.issue?.pull_request ? payload.issue.number : null);
  for (const pullRequest of payload.workflow_run?.pull_requests || []) {
    add(pullRequest.number);
  }
  return numbers;
}

export function recoveryTriggerForPr({
  trainEnabled,
  directlyTriggeredPrs,
  prNumber,
  eventName,
  dispatchTrigger,
}) {
  return trainEnabled && !directlyTriggeredPrs.has(prNumber)
    ? `${eventName}:sweep`
    : dispatchTrigger;
}

export function isManagedCommentEvent(payload, eventName) {
  if (eventName !== 'issue_comment') return false;
  const body = String(payload.comment?.body || '').trimStart();
  return MANAGED_COMMENT_MARKERS.some((marker) => body.startsWith(marker));
}

// Total number of `workflowFile` runs currently outstanding (not yet
// completed) across every status that represents unfinished work,
// including runs held `waiting`/`requested` behind a concurrency group --
// those still occupy a dispatch slot even though a runner hasn't picked
// them up yet.
//
// Implementation: fires one concurrent `?status=<s>&per_page=1` request per
// status and sums the `total_count` fields. This is O(len(statuses)) requests
// rather than O(total_runs/100) for a full history paginator -- critical
// because the CI Recovery workflow can accumulate tens of thousands of
// completed runs. The minor TOCTOU window (a run could transition between two
// queried statuses while the concurrent requests are in-flight) is accepted as
// the price of keeping this call fast enough to run inside a 10-minute job
// timeout with repeated visibility polls.
export async function countOutstandingWorkflowRuns(
  token,
  owner,
  repo,
  workflowFile,
  statuses = OUTSTANDING_RUN_STATUSES,
  requestFn = request,
) {
  const counts = await Promise.all(
    statuses.map((status) =>
      requestWithBackoff(
        () =>
          requestFn(
            token,
            `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?status=${encodeURIComponent(status)}&per_page=1`,
          ),
        { label: `list-runs-count-${workflowFile}-${status}` },
      ).then(({ data }) => data?.total_count ?? 0),
    ),
  );
  return counts.reduce((sum, c) => sum + c, 0);
}

// Convenience wrapper for CI Recovery runs specifically.  Delegates to the
// generic countOutstandingWorkflowRuns so callers that already import this
// name do not need to change.
export async function countOutstandingRecoveryRuns(
  token,
  owner,
  repo,
  workflowFile = 'ci-recovery.yml',
  statuses = OUTSTANDING_RUN_STATUSES,
  requestFn = request,
) {
  return countOutstandingWorkflowRuns(token, owner, repo, workflowFile, statuses, requestFn);
}

// Returns the IDs of currently outstanding runs from the first page of the
// workflow run history (up to 100 most-recent runs). Used by runFromEnv to
// build a pre-dispatch snapshot so waitForDispatchedRunsVisible can
// distinguish newly created runs from pre-existing outstanding ones.
//
// Restricting to the first page is safe here because GitHub orders workflow
// runs by created_at descending, so newly dispatched runs always appear at
// the top. The only risk of missing a pre-existing outstanding run is if
// there are >100 outstanding runs simultaneously, which well exceeds any
// realistic level at this repo's scale.
export async function listRecentOutstandingRunIds(
  token,
  owner,
  repo,
  workflowFile = 'ci-recovery.yml',
  statuses = OUTSTANDING_RUN_STATUSES,
  requestFn = request,
) {
  const { data } = await requestWithBackoff(
    () =>
      requestFn(
        token,
        `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=100`,
      ),
    { label: `list-runs-recent-${workflowFile}` },
  );
  const outstandingStatuses = new Set(statuses);
  return new Set(
    (data?.workflow_runs || []).filter((r) => outstandingStatuses.has(r.status)).map((r) => r.id),
  );
}

// How many more CI Recovery dispatches this router invocation may send.
//
// Implements a load-aware budget that scales up when runners are idle and
// contracts to protect Merge Train Validation + PR CI when the box is
// saturated.  Formula:
//
//   budget = clamp(
//     RUNNER_CEILING - validationReserved - activeSweepJobs - outstandingCount,
//     0,
//     maxBudget
//   )
//
// Where:
//   validationReserved  = VALIDATION_RESERVED_TRAIN_BUSY (9) when the train
//                         queue is non-empty; VALIDATION_RESERVED_TRAIN_IDLE
//                         (3) when idle.  The floor is raised to
//                         activeValidationJobs when measured activity exceeds
//                         the static constant (guards against unexpected spikes
//                         in validation concurrency).
//   activeSweepJobs     = estimated concurrent sweep jobs -- callers (e.g.
//                         runFromEnv) multiply an in-progress sweep run count
//                         by SWEEP_RUNNER_WEIGHT to get this value.  Passing 0
//                         disables sweep-pressure contraction (safe default for
//                         callers without sweep telemetry, e.g. reconcile.mjs).
//   activeValidationJobs = estimated concurrent validation jobs -- callers
//                         multiply active validation run count by
//                         VALIDATION_RUNNER_WEIGHT.  Passed as 0 by callers
//                         without validation telemetry.
//   maxBudget           = MAX_DISPATCH_BUDGET_TRAIN_BUSY (5) when the train
//                         queue is non-empty; MAX_DISPATCH_BUDGET_TRAIN_IDLE
//                         (8) when idle -- a ceiling so that the budget never
//                         fully opens even when runners look fully free.
//
// This budget is applied unconditionally, independent of MERGE_TRAIN_ENABLED:
// disabling/pausing the train is precisely the scenario runner-capacity
// protection must not lapse, so there is no "train off -> Infinity" branch.
// `trainQueueNonEmpty` is computed independent of the flag too (see runFromEnv)
// -- a stale `merge-train` label surviving a flag-off still counts as backlog
// and gets the stricter reserved floor (fails closed rather than open).
export function computeDispatchBudget({
  trainQueueNonEmpty,
  outstandingCount,
  activeSweepJobs = 0,
  activeValidationJobs = 0,
}) {
  const reservedFloor = trainQueueNonEmpty
    ? VALIDATION_RESERVED_TRAIN_BUSY
    : VALIDATION_RESERVED_TRAIN_IDLE;
  const validationReserved = Math.max(reservedFloor, activeValidationJobs);
  const maxBudget = trainQueueNonEmpty
    ? MAX_DISPATCH_BUDGET_TRAIN_BUSY
    : MAX_DISPATCH_BUDGET_TRAIN_IDLE;
  const headroom = RUNNER_CEILING - validationReserved - activeSweepJobs - outstandingCount;
  return Math.max(0, Math.min(maxBudget, headroom));
}

// Splits the PRs collectPrNumbers deemed eligible into what this run may
// actually dispatch now versus what must wait. Deferred PRs are not lost:
// the next scheduled sweep (every 10 minutes) re-evaluates ownership and
// picks up any PR still lacking a healthy recovery owner, guaranteeing
// eventual processing once capacity frees up.
export function partitionDispatchable(prNumbers, budget) {
  if (budget === Infinity) {
    return { dispatchable: prNumbers, deferred: [] };
  }
  return {
    dispatchable: prNumbers.slice(0, budget),
    deferred: prNumbers.slice(budget),
  };
}

// Closes the TOCTOU window between "dispatch a recovery run" and "that run
// becomes visible to the Actions list-runs API". The router concurrency
// group (see ci-recovery-router.yml) serializes invocations, but only for
// the duration each invocation is running: if this run finishes and frees
// its slot before the dispatch it just made shows up in the API, the *next*
// serialized invocation can read a stale outstanding count and dispatch again,
// breaching the global cap.
//
// This function accepts a pre-dispatch snapshot of outstanding run IDs and
// polls until `count` NEW runs (IDs not in `preDispatchIds`) appear. Using
// pre-dispatch IDs rather than an aggregate minimum count correctly handles
// the case where pre-existing outstanding runs complete while we are waiting:
// those completions lower the aggregate count but do not affect the new-run
// tally, so the wait converges correctly regardless of concurrent completions.
//
// The router holds its concurrency slot until either the new runs become
// visible or a long timeout expires, at which point it fails closed (throws)
// rather than silently succeeding. That means the residual race now requires
// Actions list-runs visibility to lag for nearly the whole workflow timeout,
// not just a couple of quick polls; fully closing it still needs a durable
// reservation the next invocation can observe.
export async function waitForDispatchedRunsVisible(
  token,
  owner,
  repo,
  preDispatchIds,
  count,
  {
    timeoutMs = DEFAULT_OUTSTANDING_VISIBILITY_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_OUTSTANDING_VISIBILITY_POLL_INTERVAL_MS,
    nowFn = () => Date.now(),
    sleepFn = sleep,
    listFn = (t, o, r) => listRecentOutstandingRunIds(t, o, r),
  } = {},
) {
  const deadline = nowFn() + timeoutMs;
  while (true) {
    const currentIds = await listFn(token, owner, repo);
    const newCount = [...currentIds].filter((id) => !preDispatchIds.has(id)).length;
    if (newCount >= count) {
      return newCount;
    }
    const remainingMs = deadline - nowFn();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for ${count} dispatched run(s) to become visible via Actions API observed_new=${newCount} timeout_ms=${timeoutMs}`,
      );
    }
    await sleepFn(Math.min(pollIntervalMs, remainingMs));
  }
}

// Kept for backward compatibility. New callers should use
// waitForDispatchedRunsVisible, which accepts pre-dispatch run IDs to avoid
// false timeouts when pre-existing outstanding runs complete while waiting.
export async function waitForOutstandingCount(
  token,
  owner,
  repo,
  expectedMinimum,
  {
    timeoutMs = DEFAULT_OUTSTANDING_VISIBILITY_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_OUTSTANDING_VISIBILITY_POLL_INTERVAL_MS,
    nowFn = () => Date.now(),
    sleepFn = sleep,
    countFn = countOutstandingRecoveryRuns,
  } = {},
) {
  let lastObserved = 0;
  const deadline = nowFn() + timeoutMs;
  while (true) {
    lastObserved = await countFn(token, owner, repo);
    if (lastObserved >= expectedMinimum) {
      return lastObserved;
    }
    const remainingMs = deadline - nowFn();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for dispatched run(s) to become visible via Actions API observed=${lastObserved} expected>=${expectedMinimum} timeout_ms=${timeoutMs}`,
      );
    }
    await sleepFn(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function runFromEnv(env = process.env) {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  const eventName = env.GITHUB_EVENT_NAME || '';
  const eventPath = env.GITHUB_EVENT_PATH;
  const trigger = env.RECOVERY_TRIGGER || eventName;
  const trainEnabled = parseEnabledFlag(env.MERGE_TRAIN_ENABLED);
  const maxDispatchPerRun = parsePositiveInt(
    env.CI_RECOVERY_MAX_DISPATCH_PER_RUN,
    DEFAULT_MAX_DISPATCH_PER_RUN,
  );

  if (!token || !owner || !repo || !eventPath) {
    throw new Error('Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or GITHUB_EVENT_PATH');
  }

  const payload = JSON.parse(await readFile(eventPath, 'utf8'));
  if (isManagedCommentEvent(payload, eventName)) {
    process.stdout.write('ignored managed automation comment\n');
    return;
  }
  const dispatchTrigger =
    payload.action && !trigger.includes(':') ? `${trigger}:${payload.action}` : trigger;

  // Always fetched now (previously only for schedule/workflow_dispatch or
  // train-enabled events): the global backpressure check below needs to
  // determine merge-train backlog state consistently on every invocation,
  // including direct per-PR events with the train feature disabled, so that
  // runner-capacity protection does not lapse whenever the train is paused.
  // This does not change collectPrNumbers' own routing semantics -- it still
  // only consults scheduledPulls for schedule/workflow_dispatch events or
  // when trainEnabled is true, exactly as before.
  let scheduledPulls = await requestWithBackoff(
    () =>
      paginate(
        token,
        `/repos/${owner}/${repo}/pulls?state=open&base=main&sort=updated&direction=desc`,
      ),
    { label: 'list-open-prs' },
  );
  if (
    trainEnabled &&
    isRepairWindowSweepEvent({
      payload,
      eventName,
      trainEnabled,
    })
  ) {
    // Snapshot the reference time before hydration so the age-ordering and
    // "healthy owner" checks inside the callback all share the same clock.
    const hydrateNow = new Date();
    scheduledPulls = await hydrateRecoveryOwnership(
      scheduledPulls,
      (number) =>
        requestWithBackoff(
          () => paginate(token, `/repos/${owner}/${repo}/issues/${number}/comments`),
          { label: `load-owner-state-${number}` },
        ),
      OWNERSHIP_HYDRATION_BATCH_SIZE,
      {
        targetDispatchable: REPAIR_WINDOW_SIZE,
        countDispatchable: (resolvedPulls) =>
          collectPrNumbers({
            payload: {},
            eventName: 'workflow_dispatch',
            repository,
            scheduledPulls: resolvedPulls,
            maxDispatchPerRun: REPAIR_WINDOW_SIZE,
            trainEnabled: true,
            now: hydrateNow,
          }).length,
      },
    );
  }

  const prNumbers = collectPrNumbers({
    payload,
    eventName,
    repository,
    scheduledPulls,
    maxDispatchPerRun,
    trainEnabled,
    now: new Date(),
  });
  const directlyTriggeredPrs = eventPrNumbers(payload);

  // Global backpressure applies unconditionally now -- independent of
  // MERGE_TRAIN_ENABLED -- because runner-capacity protection must hold even
  // while the train feature is paused/disabled (2026-07-21 incident
  // follow-up guidance). `trainQueueNonEmpty` is computed independent of the
  // flag too: a `merge-train` label surviving a flag-off still counts as
  // backlog and gets the stricter reserved floor (fail closed). The router's
  // concurrency group (see ci-recovery-router.yml) is a single unconditional
  // global group in every mode, so this budget is enforced against fully
  // serialized invocations -- see computeDispatchBudget for what that does
  // and does not close.
  //
  // Best-effort cap: merge-train/reconcile.mjs's four dispatchRecovery() call
  // sites go through buildGatedDispatchRecovery (GLOBAL_TRAIN_DISPATCH_CAP),
  // so both callers apply a cap before dispatching. A narrow race window still
  // exists between each caller's countOutstandingRecoveryRuns read and its
  // POST, because the router's concurrency group serialises its own invocations
  // but cannot serialise against a concurrent reconcile.mjs run. A durable
  // reservation (e.g. a shared semaphore via repository variable) is the
  // required follow-up to close that gap completely.
  const trainQueueNonEmpty = queueEntries(scheduledPulls, repository).length > 0;

  // Measure live runner pressure from in-progress sweep runs and all
  // outstanding validation runs. Sweep runs are counted with 'in_progress'
  // only because queued/waiting runs have not yet spawned their matrix jobs
  // and therefore have not consumed any runner slots. Each in-progress sweep
  // run is then weighted by SWEEP_RUNNER_WEIGHT to produce an estimated job
  // count (a full ai-sweep.yml run fans to ~10–19 concurrent jobs). Validation
  // runs use the full outstanding-status set so even a queued/waiting
  // validation run contributes to the reserved floor.
  const [activeSweepRunCount, activeValidationRunCount] = await Promise.all([
    Promise.all(
      SWEEP_WORKFLOW_FILES.map((f) =>
        countOutstandingWorkflowRuns(token, owner, repo, f, ['in_progress']),
      ),
    ).then((counts) => counts.reduce((sum, c) => sum + c, 0)),
    countOutstandingWorkflowRuns(token, owner, repo, VALIDATION_WORKFLOW_FILE),
  ]);
  const activeSweepJobs = activeSweepRunCount * SWEEP_RUNNER_WEIGHT;
  const activeValidationJobs = activeValidationRunCount * VALIDATION_RUNNER_WEIGHT;

  const outstandingCount = await countOutstandingRecoveryRuns(token, owner, repo);
  const dispatchBudget = computeDispatchBudget({
    trainQueueNonEmpty,
    outstandingCount,
    activeSweepJobs,
    activeValidationJobs,
  });
  const { dispatchable, deferred } = partitionDispatchable(prNumbers, dispatchBudget);

  // Capture pre-dispatch outstanding run IDs so waitForDispatchedRunsVisible
  // below can identify newly appeared runs rather than relying on an aggregate
  // count that would break if pre-existing runs complete while we are
  // dispatching (they would lower the aggregate, preventing convergence).
  const preDispatchIds =
    dispatchable.length > 0 ? await listRecentOutstandingRunIds(token, owner, repo) : new Set();

  for (const prNumber of dispatchable) {
    const prTrigger = recoveryTriggerForPr({
      trainEnabled,
      directlyTriggeredPrs,
      prNumber,
      eventName,
      dispatchTrigger,
    });
    // Use a direct request() -- do NOT wrap in requestWithBackoff. The
    // workflow_dispatch POST is non-idempotent: if GitHub accepts the first
    // request but the response is lost or returns an ambiguous 5xx, retrying
    // would create a second run, immediately violating the global cap. The
    // 10-minute scheduled sweep retries failed dispatches instead.
    await request(token, `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`, {
      method: 'POST',
      body: {
        ref: payload.repository?.default_branch || 'main',
        inputs: {
          operation: 'reconcile',
          pr_number: String(prNumber),
          trigger: prTrigger,
          lease_id: '',
        },
      },
    });
    process.stdout.write(`dispatched pr=#${prNumber} trigger=${prTrigger}\n`);
  }

  if (deferred.length > 0) {
    process.stdout.write(
      `global backpressure applied deferred=${deferred.length} pr_numbers=${deferred.join(',')} outstanding=${outstandingCount} budget=${dispatchBudget} sweep_runs=${activeSweepRunCount} validation_runs=${activeValidationRunCount}\n`,
    );
  }

  if (dispatchable.length > 0) {
    await waitForDispatchedRunsVisible(token, owner, repo, preDispatchIds, dispatchable.length);
  }

  if (dispatchable.length === 0 && deferred.length === 0) {
    process.stdout.write(`no eligible PR found for ${eventName}\n`);
  } else if (
    (eventName === 'schedule' || eventName === 'workflow_dispatch') &&
    scheduledPulls.length > prNumbers.length
  ) {
    process.stdout.write(
      `dispatch cap applied sent=${dispatchable.length} total_eligible=${scheduledPulls.length} budget=${dispatchBudget} outstanding=${outstandingCount} sweep_runs=${activeSweepRunCount} validation_runs=${activeValidationRunCount}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromEnv();
}
