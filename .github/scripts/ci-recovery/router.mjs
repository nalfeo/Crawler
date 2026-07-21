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
// Cap applied when the train feature is enabled but its queue is currently
// empty. Measured capacity evidence (2026-07-21 incident follow-up): this
// repo is public on GitHub Free (standard-hosted concurrency limit: 20
// concurrent jobs). Representative peaks observed: a normal full PR CI run
// uses ~5 concurrent jobs; uncontended Merge Train Validation runs alone
// peak at 7-9 concurrent jobs; an active AI Sweep Eval run can spawn 200+
// jobs and peak at ~19 concurrent, which is what starved Validation runners
// during the incident. With the queue empty there is no Validation run to
// protect, but sweep-style jobs can still be running, so dispatch is not
// left fully unbounded here -- 2 preserves at least some runner headroom
// instead of going back to effectively-unlimited (Infinity) dispatch.
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
        }
      }
    }
  }

  const eligible = [...numbers];
  if (
    (eventName === 'schedule' || eventName === 'workflow_dispatch') &&
    eligible.length > maxDispatchPerRun
  ) {
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
    return [...prioritized, ...remaining].slice(0, maxDispatchPerRun);
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

// Fetches every run of `workflowFile` currently in `status`, paginating
// until a short page confirms the end. The Actions "list workflow runs"
// endpoint returns `{ total_count, workflow_runs }`, not a bare array, so
// this cannot reuse the generic `paginate()` helper from github.mjs.
export async function listWorkflowRunsByStatus(
  token,
  owner,
  repo,
  workflowFile,
  status,
  requestFn = request,
) {
  const results = [];
  let page = 1;
  while (true) {
    const { data } = await requestWithBackoff(
      () =>
        requestFn(
          token,
          `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?status=${status}&per_page=100&page=${page}`,
        ),
      { label: `list-runs-${workflowFile}-${status}-page${page}` },
    );
    const runs = data?.workflow_runs || [];
    results.push(...runs);
    if (runs.length < 100) {
      return results;
    }
    page += 1;
  }
}

// Total number of `workflowFile` runs currently outstanding (not yet
// completed) across every status that represents unfinished work,
// including runs held `waiting`/`requested` behind a concurrency group --
// those still occupy a dispatch slot even though a runner hasn't picked
// them up yet.
export async function countOutstandingRecoveryRuns(
  token,
  owner,
  repo,
  workflowFile = 'ci-recovery.yml',
  statuses = OUTSTANDING_RUN_STATUSES,
  requestFn = request,
) {
  let total = 0;
  for (const status of statuses) {
    const runs = await listWorkflowRunsByStatus(
      token,
      owner,
      repo,
      workflowFile,
      status,
      requestFn,
    );
    total += runs.length;
  }
  return total;
}

// How many more CI Recovery dispatches this router invocation may send.
// While the merge train queue holds any PR, outstanding recovery runs are
// hard-capped at GLOBAL_TRAIN_DISPATCH_CAP so Merge Train Validation is not
// starved for runner capacity. With the train feature enabled but its queue
// currently empty, there's no Validation run to protect but other jobs
// (e.g. sweep evals) can still be consuming runners, so dispatch is capped
// at the looser GLOBAL_IDLE_TRAIN_DISPATCH_CAP rather than left unbounded
// (see that constant's comment for the measured capacity evidence). Only
// when the train feature itself is off does this return Infinity: without
// the shared concurrency group (see ci-recovery-router.yml), invocations
// aren't serialized, so a global outstanding-count cap can't be enforced
// consistently -- the existing per-run maxDispatchPerRun cap in
// collectPrNumbers is what bounds dispatch in that legacy mode.
export function computeDispatchBudget({ trainEnabled, trainQueueNonEmpty, outstandingCount }) {
  if (!trainEnabled) {
    return Infinity;
  }
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
// its slot before the dispatch it just made shows up in
// countOutstandingRecoveryRuns, the *next* serialized invocation can read a
// stale (too-low) outstanding count and dispatch again, breaching the
// global cap. Polling here, before this invocation's slot is released,
// makes that race unlikely rather than airtight: the wait is deliberately
// bounded (a handful of short retries), and a slow/unavailable API still
// degrades to a logged warning and lets this invocation end anyway -- the
// 10-minute sweep is the eventual-consistency backstop, not a guarantee
// that the cap is never exceeded if Actions API visibility lags longer
// than the bounded retry window.
export async function waitForOutstandingCount(
  token,
  owner,
  repo,
  expectedMinimum,
  { attempts = 5, delayMs = 2000, sleepFn = sleep, countFn = countOutstandingRecoveryRuns } = {},
) {
  let lastObserved = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastObserved = await countFn(token, owner, repo);
    if (lastObserved >= expectedMinimum) {
      return lastObserved;
    }
    if (attempt < attempts) {
      await sleepFn(delayMs);
    }
  }
  return lastObserved;
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

  let scheduledPulls = [];
  if (trainEnabled || eventName === 'schedule' || eventName === 'workflow_dispatch') {
    scheduledPulls = await requestWithBackoff(
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

  // Global backpressure: only meaningful while the train feature is on,
  // since that's the only mode where router runs share a single
  // concurrency group (see ci-recovery-router.yml) and a global
  // outstanding-count cap can be enforced consistently. Skip the extra API
  // call in legacy/off mode.
  const trainQueueNonEmpty = trainEnabled && queueEntries(scheduledPulls, repository).length > 0;
  const outstandingCount = trainEnabled
    ? await countOutstandingRecoveryRuns(token, owner, repo)
    : 0;
  const dispatchBudget = computeDispatchBudget({
    trainEnabled,
    trainQueueNonEmpty,
    outstandingCount,
  });
  const { dispatchable, deferred } = partitionDispatchable(prNumbers, dispatchBudget);

  for (const prNumber of dispatchable) {
    const prTrigger = recoveryTriggerForPr({
      trainEnabled,
      directlyTriggeredPrs,
      prNumber,
      eventName,
      dispatchTrigger,
    });
    await requestWithBackoff(
      () =>
        request(token, `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`, {
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
        }),
      { label: `dispatch-pr-${prNumber}` },
    );
    process.stdout.write(`dispatched pr=#${prNumber} trigger=${prTrigger}\n`);
  }

  if (deferred.length > 0) {
    const cap = trainQueueNonEmpty ? GLOBAL_TRAIN_DISPATCH_CAP : GLOBAL_IDLE_TRAIN_DISPATCH_CAP;
    process.stdout.write(
      `global backpressure applied deferred=${deferred.length} pr_numbers=${deferred.join(',')} outstanding=${outstandingCount} cap=${cap}\n`,
    );
  }

  if (trainEnabled && dispatchable.length > 0) {
    const expectedMinimum = outstandingCount + dispatchable.length;
    const observed = await waitForOutstandingCount(token, owner, repo, expectedMinimum);
    if (observed < expectedMinimum) {
      process.stdout.write(
        `warning: dispatched run(s) not yet visible via Actions API after backoff observed=${observed} expected>=${expectedMinimum} -- relying on scheduled sweep for eventual consistency\n`,
      );
    }
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
