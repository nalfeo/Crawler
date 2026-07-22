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
// Hard global cap on outstanding CI Recovery workflow runs while the merge
// train queue is non-empty. This is intentionally independent of
// CI_RECOVERY_MAX_DISPATCH_PER_RUN: that var caps dispatch *per router
// invocation*, but with the router now serialized under a single
// concurrency group (see ci-recovery-router.yml), this cap is what actually
// bounds the number of CI Recovery runs competing with Merge Train
// Validation for runners at any moment.
export const GLOBAL_TRAIN_DISPATCH_CAP = 1;
// Cap applied whenever there is no active merge-train backlog to protect --
// the queue is empty, the train feature is enabled but idle, OR the train
// feature is disabled/paused entirely. Measured capacity evidence
// (2026-07-21 incident follow-up): this repo is public on GitHub Free
// (standard-hosted concurrency limit: 20 concurrent jobs). Representative
// peaks observed: a normal full PR CI run uses ~5 concurrent jobs;
// uncontended Merge Train Validation runs alone peak at 7-9 concurrent jobs;
// an active AI Sweep Eval run can spawn 200+ jobs and peak at ~19 concurrent,
// which is what starved Validation runners during the incident. Even with no
// backlog to protect, sweep-style jobs can still be running (and can be
// running whether or not the train feature itself is on), so dispatch is not
// left fully unbounded here -- 2 preserves at least some runner headroom
// instead of going back to effectively-unlimited (Infinity) dispatch. This
// cap must remain in force during train maintenance/disablement too: that is
// precisely when protecting shared runner capacity matters most, not a
// window where backpressure can safely lapse.
export const GLOBAL_IDLE_TRAIN_DISPATCH_CAP = 2;
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
    const eligiblePulls = eligibleTrainRecoveryPulls({
      scheduledPulls,
      repository,
      directlyTriggeredPrs,
    });
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

export function eligibleTrainRecoveryPulls({
  scheduledPulls,
  repository,
  directlyTriggeredPrs = new Set(),
}) {
  return scheduledPulls
    .filter((pullRequest) => {
      const directlyTriggered = directlyTriggeredPrs.has(pullRequest.number);
      const labels = pullRequest.labels || [];
      const hasQueueLabel = labels.some((label) => label.name === QUEUE_LABEL);
      const hasOptOutLabel = labels.some((label) => label.name === 'ci-recovery-opt-out');
      const waiting = labels.some((label) => label.name === WAITING_LABEL);
      const waitingTransition = labels.some((label) => label.name === WAITING_TRANSITION_LABEL);
      const owned = labels.some((label) => String(label.name || '').startsWith(OWNER_LABEL_PREFIX));
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
}

export function recoveryBacklogEntries(scheduledPulls, repository, now = new Date()) {
  return eligibleTrainRecoveryPulls({ scheduledPulls, repository }).filter(
    (pullRequest) => !hasHealthyOwnerForSweep(pullRequest, now),
  );
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
// (5 for the default set) rather than O(total_runs/100) for a full history
// paginator -- critical because the CI Recovery workflow can accumulate tens
// of thousands of completed runs. The minor TOCTOU window (a run could
// transition between two queried statuses while the concurrent requests are
// in-flight) is accepted as the price of keeping this call fast enough to
// run inside a 10-minute job timeout with repeated visibility polls.
export async function countOutstandingRecoveryRuns(
  token,
  owner,
  repo,
  workflowFile = 'ci-recovery.yml',
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
// While the merge train queue holds any PR, outstanding recovery runs are
// hard-capped at GLOBAL_TRAIN_DISPATCH_CAP so Merge Train Validation is not
// starved for runner capacity. Otherwise -- queue empty, train feature idle,
// OR the train feature disabled/paused entirely -- dispatch is capped at the
// looser GLOBAL_IDLE_TRAIN_DISPATCH_CAP rather than left unbounded (see that
// constant's comment for the measured capacity evidence).
//
// This budget is applied unconditionally, independent of MERGE_TRAIN_ENABLED:
// disabling/pausing the train is precisely the scenario runner-capacity
// protection must not lapse (2026-07-21 incident follow-up guidance), so
// there is no "train off -> Infinity" branch here. `trainQueueNonEmpty` is
// itself computed independent of the flag too (see runFromEnv) -- a stale
// `merge-train` label surviving a flag-off still counts as backlog and gets
// the stricter cap, which fails closed rather than open.
//
// The router's concurrency group (see ci-recovery-router.yml) is now an
// unconditional single global group in every mode -- a second follow-up
// correction that replaced the earlier per-mode group split, which left
// legacy/flag-off invocations on per-PR groups where two different-PR
// invocations could each read a stale outstanding count before either
// dispatch became visible. With one global group active in all modes,
// router invocations are always fully serialized, so this budget check is
// no longer merely a live-but-racy API read: it is enforced against a
// single invocation running at a time, closing that cross-PR race window.
// The residual TOCTOU window this budget still relies on
// (waitForOutstandingCount closing it) is the narrower one between a
// dispatch and its own visibility via the Actions list-runs API within the
// *same* serialized lineage -- see that function's comment.
export function computeDispatchBudget({ trainQueueNonEmpty, outstandingCount }) {
  const cap = trainQueueNonEmpty ? GLOBAL_TRAIN_DISPATCH_CAP : GLOBAL_IDLE_TRAIN_DISPATCH_CAP;
  return Math.max(0, cap - outstandingCount);
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
  // backlog and gets the stricter cap (fail closed). The router's
  // concurrency group (see ci-recovery-router.yml) is a single unconditional
  // global group in every mode, so this budget is enforced against fully
  // serialized invocations -- see computeDispatchBudget for what that does
  // and does not close.
  //
  // Best-effort cap: merge-train/reconcile.mjs's four dispatchRecovery() call
  // sites now go through buildGatedDispatchRecovery (GLOBAL_TRAIN_DISPATCH_CAP),
  // so both callers apply the same cap before dispatching. A narrow race window
  // still exists between each caller's countOutstandingRecoveryRuns read and
  // its POST, because the router's concurrency group serialises its own
  // invocations but cannot serialise against a concurrent reconcile.mjs run.
  // A durable reservation (e.g. a shared semaphore via repository variable) is
  // the required follow-up to close that gap completely.
  const trainQueueNonEmpty = queueEntries(scheduledPulls, repository).length > 0;
  const outstandingCount = await countOutstandingRecoveryRuns(token, owner, repo);
  const dispatchBudget = computeDispatchBudget({
    trainQueueNonEmpty,
    outstandingCount,
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
    const cap = trainQueueNonEmpty ? GLOBAL_TRAIN_DISPATCH_CAP : GLOBAL_IDLE_TRAIN_DISPATCH_CAP;
    process.stdout.write(
      `global backpressure applied deferred=${deferred.length} pr_numbers=${deferred.join(',')} outstanding=${outstandingCount} cap=${cap}\n`,
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
      `dispatch cap applied sent=${dispatchable.length} total_eligible=${scheduledPulls.length} cap=${maxDispatchPerRun}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromEnv();
}
