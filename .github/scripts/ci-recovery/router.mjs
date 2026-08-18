import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { encodeRefPath, paginate, request } from './github.mjs';
import { MANAGED_COMMENT_PREFIX, STALE_BASE_RETARGET_MARKER } from './markers.mjs';
import {
  AUTOMATION_STALE_MINUTES,
  isHealthyRecoveryOwner,
  OWNER_LABEL_PREFIX,
  ownerLabel,
  parseStateComment,
  STATE_MARKER,
  WAITING_LABEL,
  WAITING_TRANSITION_LABEL,
} from './state.mjs';
import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';
import {
  BLOCKED_LABEL,
  parseEnabledFlag,
  queueEntries,
  QUEUE_LABEL,
  VALIDATION_FAILED_LABEL,
} from '../merge-train/state.mjs';

const DEFAULT_MAX_DISPATCH_PER_RUN = 8;
// Runner-capacity model (load-aware budget architecture, 2026-07-22):
//   RUNNER_CEILING          = GitHub Free standard-hosted concurrency limit
//   VALIDATION_RESERVED_*   = runner slots reserved for Merge Train Validation
//                             (the stricter train-busy floor applies when the
//                             merge-train queue is non-empty)
//   MAX_DISPATCH_BUDGET_*   = ceiling on outstanding CI Recovery runs (applied
//                             after subtracting reserved and sweep headroom from
//                             RUNNER_CEILING).  Overridable at runtime via
//                             CI_GLOBAL_TRAIN_DISPATCH_CAP /
//                             CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP repo variables.
//   SWEEP_RUNNER_WEIGHT     = estimated concurrent jobs consumed by one active
//                             AI Sweep Eval run (used to credit sweep headroom
//                             without validation telemetry).
//   VALIDATION_RUNNER_WEIGHT = estimated concurrent jobs per active Validation
//                             run (used to measure live validation headroom).
export const RUNNER_CEILING = 20;
// Reserved runner slots for Merge Train Validation when the queue is non-empty.
// Keeps validation throughput protected from CI Recovery bursts.
export const VALIDATION_RESERVED_TRAIN_BUSY = 9;
// Reserved slots when the queue is empty / train is idle or disabled.
// Lower than TRAIN_BUSY because fewer Validation runs compete when idle.
export const VALIDATION_RESERVED_TRAIN_IDLE = 3;
// Default global cap on outstanding CI Recovery runs while the merge-train
// queue is non-empty. Overridable via CI_GLOBAL_TRAIN_DISPATCH_CAP (range 1-10).
// 2026-07-22 EMERGENCY raise 1 -> 5: pinning to 1 starved the train feeder.
export const MAX_DISPATCH_BUDGET_TRAIN_BUSY = 5;
// Default global cap on outstanding CI Recovery runs when the queue is empty,
// the train is idle, or disabled. Overridable via CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP
// (range 1-20). 8 leaves headroom for sweep peaks (~19 concurrent jobs observed).
export const MAX_DISPATCH_BUDGET_TRAIN_IDLE = 8;
// Estimated concurrent jobs consumed by one active AI Sweep Eval run.
// Used to deduct sweep headroom from the runner ceiling in computeDispatchBudget.
export const SWEEP_RUNNER_WEIGHT = 10;
// Estimated concurrent jobs per active Merge Train Validation run.
// Used to measure live validation headroom in computeDispatchBudget.
export const VALIDATION_RUNNER_WEIGHT = 9;
// Workflow files whose active run counts signal runner pressure to the budget.
// weapon-sweep.yml joins the AI sweeps here: it also runs on the shared
// standard-hosted pool and fans its weapon×shard matrix to ~24 concurrent
// jobs, so an in-progress weapon sweep saturates runners exactly like an AI
// sweep and must count toward the reserved-runner budget.
export const SWEEP_WORKFLOW_FILES = Object.freeze([
  'ai-sweep.yml',
  'ai-sweep-recover.yml',
  'weapon-sweep.yml',
]);
export const VALIDATION_WORKFLOW_FILE = 'merge-train-validate.yml';
// Legacy alias exports: these constants are read by reconcile.mjs and
// ci-recovery/reconcile.mjs via resolveGlobalDispatchCaps(process.env).
// They alias MAX_DISPATCH_BUDGET_* so that in-code defaults and env-driven
// overrides are always consistent.
export const GLOBAL_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_BUSY;
export const GLOBAL_IDLE_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_IDLE;
// Enforced runner-safety ceilings for env-driven cap overrides.
// Values above these are silently clamped so a typo in a repo variable
// cannot flood CI beyond the GitHub Free runner capacity ceiling.
// Structural constants: changing them requires evidence from incident metrics,
// not just a repo-variable update. Documented in ci-config-knobs.md.
const TRAIN_CAP_MAX = 10;
const IDLE_CAP_MAX = 20;
// GitHub Actions run states that represent a run not yet finished: actively
// running, waiting to be scheduled, or held by a concurrency group (queued
// runs whose concurrency group is busy report as `waiting`). `pending` is
// included even though the router itself never produces it, because it is a
// documented Actions run status and omitting it would let a run in that
// state go uncounted, silently widening the outstanding-run gap this cap
// exists to close.
const OUTSTANDING_RUN_STATUSES = ['queued', 'pending', 'in_progress', 'waiting', 'requested'];
const REPAIR_WINDOW_SIZE = 6;
// MANAGED_COMMENT_PREFIX is imported from markers.mjs above.
// isManagedCommentEvent uses MANAGED_COMMENT_PREFIX so new markers are covered automatically.
const DEFAULT_RETRY_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
const DEFAULT_OUTSTANDING_VISIBILITY_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_OUTSTANDING_VISIBILITY_POLL_INTERVAL_MS = 5000;
// Labels that indicate a PR is blocked by an external mechanism. These PRs
// must not consume a scarce dispatch slot — they cannot make forward progress
// through CI Recovery until the blocking condition is resolved externally.
// The exclusion is unconditional: even a PR explicitly named by the triggering
// event is excluded if it carries one of these labels.
// NOTE: 'ci-conflict-order-wait' and 'ci-conflict-escalation' are defined in
// .github/scripts/ci-conflict-coordinator/state.mjs, which is outside the
// trusted execution boundary of router.mjs. Use inline literals here to avoid
// expanding that boundary.
export const DISPATCH_BLOCKED_LABEL_NAMES = new Set([
  'ci-conflict-order-wait', // ci-conflict-coordinator/state.mjs ORDER_WAIT_LABEL
  'ci-conflict-escalation', // ci-conflict-coordinator/state.mjs ESCALATION_LABEL
  'ci-lifecycle-quarantined', // ci-recovery/pr-lifecycle.mjs PHASE_LABELS[PHASE.QUARANTINED]
  'ci-lifecycle-abandoned', // ci-recovery/pr-lifecycle.mjs PHASE_LABELS[PHASE.ABANDONED]
  BLOCKED_LABEL, // 'merge-train-blocked'
  VALIDATION_FAILED_LABEL, // 'merge-train-validation-failed'
  HUMAN_APPROVAL_LABEL, // 'human-approval-required'
  WAITING_LABEL, // 'ci-recovery-waiting'
]);
// Labels that identify a PR as a CI infrastructure or improvement change.
// CI-fix PRs are dispatched before general-purpose PRs in the schedule sweep
// because landing them accelerates throughput for all other PRs.
export const CI_FIX_LABEL_NAMES = new Set(['ci', 'ci-infra']);
const OWNERSHIP_HYDRATION_BATCH_SIZE = 6;
// Reserved dispatch slots for the lease-reaper GC pass. These slots are
// consumed on every scheduled sweep to release stale automation locks and
// are intentionally NOT counted against computeDispatchBudget, so GC can
// never be budget-starved to zero (Fix A / issue #1783).
export const REAPER_LANE_CAP = 2;
export const RECONCILIATION_LANE_CAP = 1;
// Sweep rotation window used by selectReaperBatch to cycle eligible reapable
// PRs across windows so none starve past the lane cap.
const FLAG_OFF_SWEEP_ROTATION_WINDOW_MS = 10 * 60 * 1000;

function parsePositiveInt(raw, fallback) {
  const normalized = String(raw ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Like parsePositiveInt, but additionally:
//  1. Rejects strings with non-numeric content (e.g. "10oops" -> fallback).
//     Number.parseInt silently ignores trailing non-digits; this is intentional
//     for many uses but dangerous for operator-supplied runner caps.
//  2. Clamps the result to [1, max] so a typo cannot exceed the runner-safety
//     ceiling documented in ci-config-knobs.md.
function parseClampedPositiveInt(raw, fallback, max) {
  const str = String(raw ?? '').trim();
  // Strict: must be entirely digits (no leading sign, no decimals, no trailing junk).
  if (!/^\d+$/.test(str)) return fallback;
  const parsed = Number.parseInt(str, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
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

// A *primary* rate-limit exhaustion (`x-ratelimit-remaining: 0`) is not a
// transient blip: the budget only refills at `x-ratelimit-reset`, which can be
// up to a full hour away. Because `CRAWLER_CI_PAT` is a classic user PAT, that
// budget is shared across every token belonging to the owner, so exhaustion is
// account-wide and no amount of local backoff can clear it.
//
// Incident 2026-07-30: this was retried like any other 403. Each call burned
// DEFAULT_RETRY_MAX_ATTEMPTS requests against an already-empty budget, capped at
// DEFAULT_RETRY_MAX_DELAY_MS (30s) — so the retries could never outlast a 60m
// reset, and instead deepened the exhaustion they were waiting on. Detect the
// condition and fail fast so the caller surfaces it to the liveness alarm
// instead of silently grinding.
export function isPrimaryRateLimitExhausted(error) {
  const status = Number(error?.status || 0);
  if (status !== 403 && status !== 429) {
    return false;
  }
  const remaining = error?.headers?.get?.('x-ratelimit-remaining');
  if (remaining === undefined || remaining === null || remaining === '') {
    return false;
  }
  return Number.parseInt(remaining, 10) === 0;
}

export function isRetryableError(error) {
  const status = Number(error?.status || 0);
  if (status === 429 && isPrimaryRateLimitExhausted(error)) {
    return false;
  }
  if (status === 429) {
    return true;
  }
  if (status >= 500 && status <= 599) {
    return true;
  }
  if (status === 403) {
    const message = String(error?.data?.message || error?.message || '').toLowerCase();
    // Secondary rate limits are short-lived and carry `retry-after`, so they
    // stay retryable even though the budget header may read zero.
    if (message.includes('secondary rate limit')) {
      return true;
    }
    if (isPrimaryRateLimitExhausted(error)) {
      return false;
    }
    return message.includes('rate limit');
  }
  return false;
}

function isRateLimitError(error) {
  const status = Number(error?.status || 0);
  if (status !== 403 && status !== 429) {
    return false;
  }
  const message = String(error?.data?.message || error?.message || '').toLowerCase();
  return message.includes('rate limit');
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
        // This is a RETRY loop over attempts at a single request, not a batch
        // loop over work items. There are no "remaining items" to abandon: once
        // the error is non-retryable or attempts are exhausted, propagating to
        // the caller is the contract of requestWithBackoff, and each caller
        // decides whether to skip its own item. Swallowing here would silently
        // return undefined and corrupt every caller's result handling.
        // eslint-disable-next-line crawler/no-rethrow-in-automation-catch
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

// Returns true if the PR carries a CI infrastructure or improvement label,
// making it eligible for tier-1 priority in the schedule sweep.
export function isCiFixPr(pullRequest) {
  return (pullRequest.labels || []).some((label) => CI_FIX_LABEL_NAMES.has(label.name));
}

// Returns true if the PR carries a label that indicates it is blocked by an
// external mechanism and must not receive a CI Recovery dispatch slot.
export function isDispatchBlocked(pullRequest) {
  return (pullRequest.labels || []).some((label) => DISPATCH_BLOCKED_LABEL_NAMES.has(label.name));
}

// Genuine waiting PRs stay hidden from broad sweeps. Once reconcile has already
// converged a waiting PR back to an unowned state, broad repair sweeps may
// surface it again so the existing exact repair-dispatch path can reacquire it.
//
// 2026-07-27 incident: production parks admission-gated PRs as
// `owner=none,status=waiting,blockers=[]` (trigger `admission-wait`). Only
// `status=idle` was accepted here, so that state was excluded from every sweep
// and had no owner to advance it -- 17 of 31 open PRs became permanently
// unreachable (oldest parked >2 days) and the merge train ran empty.
//
// A `waiting` PR that still records blockers is a genuine wait: something is
// actively blocking it and reconcile parked it deliberately, so it stays
// hidden. A `waiting` PR with no owner and no blockers has nothing left to wait
// on and must be re-surfaced.
export function isRepairWakeEligible(pullRequest) {
  const labels = pullRequest.labels || [];
  if (!labels.some((label) => label.name === WAITING_LABEL)) return false;
  if (labels.some((label) => String(label.name || '').startsWith(OWNER_LABEL_PREFIX))) {
    return false;
  }
  if (labels.some((label) => label.name === WAITING_TRANSITION_LABEL)) return false;
  const state = pullRequest.recoveryState;
  if (state?.owner !== 'none') return false;
  if (state.status === 'idle') return true;
  return state.status === 'waiting' && (state.blockers || []).length === 0;
}

function ageOrder(left, right) {
  return (
    new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
    left.number - right.number
  );
}

function selectRepairWindowPulls({ direct, waitingTransitions, sweep, now = new Date() }) {
  const targetSize = Math.max(REPAIR_WINDOW_SIZE, direct.length);
  const remainingAfterDirect = Math.max(targetSize - direct.length, 0);
  if (remainingAfterDirect === 0) return direct;
  const prioritizedTransitions = [...waitingTransitions]
    .sort(ageOrder)
    .slice(0, remainingAfterDirect);
  const remainingAfterTransitions = Math.max(
    remainingAfterDirect - prioritizedTransitions.length,
    0,
  );
  if (remainingAfterTransitions === 0) {
    return [...direct, ...prioritizedTransitions];
  }
  const sweepOrdered = [...sweep].sort(ageOrder);
  const rotation =
    Number.isFinite(now.getTime()) && now.getTime() > 0
      ? Math.floor(now.getTime() / FLAG_OFF_SWEEP_ROTATION_WINDOW_MS)
      : 0;
  const rotated = rotateList(sweepOrdered, rotation);
  return [...direct, ...prioritizedTransitions, ...rotated.slice(0, remainingAfterTransitions)];
}

// Labels meaning an external mechanism currently owns this PR's progress, so a
// CI Recovery dispatch cannot advance it. This is DISPATCH_BLOCKED_LABEL_NAMES
// minus WAITING_LABEL: `ci-recovery-waiting` is CI Recovery's own parking
// label and is handled by the repair-wake predicate above, not here.
//
// 2026-07-27 incident: these were never applied on the train-enabled sweep
// path, so PRs fenced by the conflict coordinator (which reconcile skips
// unconditionally with `skip pr=#N reason=ci-conflict-order-wait`) and PRs
// awaiting human approval occupied slots in the bounded REPAIR_WINDOW_SIZE
// sweep, burning every dispatch on guaranteed no-ops.
const EXTERNALLY_BLOCKED_LABEL_NAMES = new Set(
  [...DISPATCH_BLOCKED_LABEL_NAMES].filter((name) => name !== WAITING_LABEL),
);

// Returns true if an external mechanism (conflict coordinator, merge-train
// block, validation failure, or human approval) currently gates this PR,
// making a broad-sweep CI Recovery dispatch a guaranteed no-op.
export function isExternallyBlocked(pullRequest) {
  return (pullRequest.labels || []).some((label) => EXTERNALLY_BLOCKED_LABEL_NAMES.has(label.name));
}

function isFlagOffDispatchEligibleByBlockState(pullRequest) {
  if (!pullRequest || !isDispatchBlocked(pullRequest)) return true;
  const labels = pullRequest.labels || [];
  const isWaiting = labels.some((label) => label.name === WAITING_LABEL);
  if (!isWaiting) return false;
  const hasOwner = labels.some((label) => String(label.name || '').startsWith(OWNER_LABEL_PREFIX));
  const hasTransition = labels.some((label) => label.name === WAITING_TRANSITION_LABEL);
  return hasOwner || hasTransition || isRepairWakeEligible(pullRequest);
}

function hasUnhydratedOwnerLabel(pullRequest) {
  const labels = pullRequest?.labels || [];
  return (
    labels.some((label) => String(label.name || '').startsWith(OWNER_LABEL_PREFIX)) &&
    pullRequest?.recoveryState === undefined &&
    pullRequest?.recoveryStateUnreadable === undefined
  );
}

function knownTrainNoopDecisionRow(pullRequest) {
  const labels = pullRequest?.labels || [];
  if (labels.some((label) => label.name === HUMAN_APPROVAL_LABEL)) return null;
  if (labels.some((label) => label.name === QUEUE_LABEL)) return 'R06';
  if (labels.some((label) => label.name === 'ci-conflict-order-wait')) return 'R07';
  return null;
}

function isRepeatedTrainNoopDirectDispatch(pullRequest) {
  const rowId = knownTrainNoopDecisionRow(pullRequest);
  if (!rowId) return false;
  const labels = pullRequest?.labels || [];
  const ownerLabels = labels.filter((label) =>
    String(label.name || '').startsWith(OWNER_LABEL_PREFIX),
  );
  if (ownerLabels.length !== 1 || ownerLabels[0].name !== ownerLabel(pullRequest.number)) {
    return false;
  }
  const state = pullRequest?.recoveryState;
  if (!state || state.owner !== 'automation') return false;
  if (!['active', 'dispatched', 'escalated'].includes(state.status)) return false;
  const liveHead = String(pullRequest.head?.sha || '').toLowerCase();
  const stateHead = String(state.headSha || '').toLowerCase();
  return Boolean(liveHead) && stateHead === liveHead;
}

function stalenessScore(pullRequest, now = new Date()) {
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : 0;
  const stateProgressMs = Date.parse(
    pullRequest?.recoveryState?.progressAt || pullRequest?.recoveryState?.updatedAt || '',
  );
  const updatedMs = Date.parse(pullRequest?.updated_at || pullRequest?.created_at || '');
  const progressAge = Number.isFinite(stateProgressMs)
    ? Math.max(nowMs - stateProgressMs, 0)
    : Number.MAX_SAFE_INTEGER;
  const updateAge = Number.isFinite(updatedMs)
    ? Math.max(nowMs - updatedMs, 0)
    : Number.MAX_SAFE_INTEGER;
  const blockerSeverity = Array.isArray(pullRequest?.recoveryState?.blockers)
    ? pullRequest.recoveryState.blockers.length
    : 0;
  return { progressAge, updateAge, blockerSeverity };
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
      return direct
        .filter((pullRequest) => !isRepeatedTrainNoopDirectDispatch(pullRequest))
        .map((pullRequest) => pullRequest.number);
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
    return selectRepairWindowPulls({ direct, waitingTransitions, sweep, now }).map(
      (pullRequest) => pullRequest.number,
    );
  }
  const directNumbers = eventPrNumbers(payload);
  const numbers = new Set(directNumbers);
  // Map from PR number → PR object, populated for ALL events so that
  // label-based blocked/ci-fix checks can work on any flag-off path,
  // including direct events such as pull_request_target, issue_comment,
  // and workflow_run.
  const pullsByNumber = new Map();

  const normalizedRepo = repository.toLowerCase();
  for (const pullRequest of scheduledPulls) {
    if (!pullRequest.draft && pullRequest.head?.repo?.full_name?.toLowerCase() === normalizedRepo) {
      const number = Number.parseInt(String(pullRequest.number ?? ''), 10);
      if (Number.isInteger(number) && number > 0) {
        pullsByNumber.set(number, pullRequest);
        if (
          (eventName === 'schedule' || eventName === 'workflow_dispatch') &&
          (pullRequest.base?.ref === undefined || pullRequest.base.ref === 'main')
        ) {
          numbers.add(number);
        }
      }
    }
  }

  const eligible = [...numbers];

  // Remove PRs blocked by external mechanisms for ALL flag-off paths.
  // The exclusion is unconditional — it applies regardless of the triggering
  // event (schedule, workflow_dispatch, pull_request_target, issue_comment,
  // workflow_run, etc.) because a blocked PR cannot make forward progress
  // through CI Recovery regardless of how the dispatch was triggered.
  // Exception: a ci-recovery-waiting PR that also carries an active owner
  // lease or an interrupted waiting-transition still needs to be dispatched
  // for cleanup work. Only a genuinely-waiting PR (waiting label alone, no
  // ownership, no interrupted transition) is excluded.
  // Note: if a directly-triggered PR is not present in scheduledPulls (e.g.
  // a just-opened PR not yet returned by the list API), pullsByNumber.get()
  // returns undefined and the filter passes it through as unblocked — safe
  // fallback behaviour that preserves the previous pass-through semantics.
  const unblocked = eligible.filter((number) =>
    isFlagOffDispatchEligibleByBlockState(pullsByNumber.get(number)),
  );

  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    // Sort helper — oldest created_at first, PR number as stable
    // tiebreaker so output is deterministic when timestamps are equal or absent.
    function byAge(a, b) {
      const timeA = Date.parse(pullsByNumber.get(a)?.created_at ?? '') || 0;
      const timeB = Date.parse(pullsByNumber.get(b)?.created_at ?? '') || 0;
      return timeA - timeB || a - b;
    }

    // Partition into three ordered tiers.
    // Tier 1 — PRs the triggering event explicitly named (highest priority).
    const directTier = unblocked.filter((n) => directNumbers.has(n));
    const rest = unblocked.filter((n) => !directNumbers.has(n));
    // Tier 2 — CI infrastructure / improvement PRs, oldest-first. Landing
    // these PRs accelerates throughput for all subsequent work.
    const ciFixTier = rest.filter((n) => {
      const pr = pullsByNumber.get(n);
      return pr !== undefined && isCiFixPr(pr);
    });
    // Tier 3 — All remaining eligible PRs, oldest-first (global FIFO).
    const generalTier = rest.filter((n) => {
      const pr = pullsByNumber.get(n);
      return pr === undefined || !isCiFixPr(pr);
    });

    const ordered = [
      ...directTier.sort(byAge),
      ...ciFixTier.sort(byAge),
      ...generalTier.sort(byAge),
    ];
    return ordered.slice(0, maxDispatchPerRun);
  }
  const directTier = unblocked.filter((number) => directNumbers.has(number));
  const staleLane = [...pullsByNumber.values()]
    .filter((pullRequest) => {
      const number = Number.parseInt(String(pullRequest.number ?? ''), 10);
      if (!Number.isInteger(number) || number <= 0 || directNumbers.has(number)) return false;
      if (pullRequest.base?.ref !== undefined && pullRequest.base.ref !== 'main') return false;
      if (!isFlagOffDispatchEligibleByBlockState(pullRequest)) return false;
      if (hasUnhydratedOwnerLabel(pullRequest)) return false;
      return !hasHealthyOwnerForSweep(pullRequest, now);
    })
    .sort((left, right) => {
      const scoreA = stalenessScore(left, now);
      const scoreB = stalenessScore(right, now);
      return (
        scoreB.blockerSeverity - scoreA.blockerSeverity ||
        scoreB.progressAge - scoreA.progressAge ||
        scoreB.updateAge - scoreA.updateAge ||
        left.number - right.number
      );
    })
    .slice(0, RECONCILIATION_LANE_CAP)
    .map((pullRequest) => pullRequest.number);
  return [...staleLane, ...directTier];
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
      const repairWakeEligible = isRepairWakeEligible(pullRequest);
      // Externally blocked PRs are skipped unconditionally by reconcile, so they
      // must not consume one of the bounded REPAIR_WINDOW_SIZE slots. Directly
      // triggered PRs still pass through so explicit dispatches stay honored.
      const externallyBlocked = isExternallyBlocked(pullRequest);
      const shouldExcludeByLabels =
        hasQueueLabel ||
        (!directlyTriggered &&
          (hasOptOutLabel ||
            externallyBlocked ||
            (waiting && !owned && !waitingTransition && !repairWakeEligible)));
      return (
        pullRequest.state === 'open' &&
        !pullRequest.draft &&
        pullRequest.base?.ref === 'main' &&
        pullRequest.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
        !shouldExcludeByLabels
      );
    })
    .sort(ageOrder);
}

export function isStaleBaseRecoveryCandidate(pullRequest, repository) {
  const labels = pullRequest.labels || [];
  const hasQueueLabel = labels.some((label) => label.name === QUEUE_LABEL);
  const hasOptOutLabel = labels.some((label) => label.name === 'ci-recovery-opt-out');
  const waiting = labels.some((label) => label.name === WAITING_LABEL);
  return (
    pullRequest.state === 'open' &&
    !pullRequest.draft &&
    pullRequest.base?.ref !== 'main' &&
    pullRequest.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
    !hasQueueLabel &&
    !hasOptOutLabel &&
    !waiting &&
    !isExternallyBlocked(pullRequest)
  );
}

export function classifyStaleBase({ pullRequest, basePulls, baseBranch, comparison }) {
  const baseRef = String(pullRequest.base?.ref || '');
  if (!baseRef || baseRef === 'main') return { action: 'skip', reason: 'main-base' };

  const matchingBasePulls = (basePulls || []).filter((basePull) => basePull?.head?.ref === baseRef);
  if (matchingBasePulls.some((basePull) => basePull.state === 'open')) {
    return { action: 'skip', reason: 'base-pr-open' };
  }

  if (!baseBranch) {
    return { action: 'retarget', reason: 'base-branch-missing' };
  }

  const branchSha = String(baseBranch.object?.sha || '').toLowerCase();
  const mergedBasePull = matchingBasePulls.find(
    (basePull) =>
      Boolean(basePull.merged_at || basePull.merged) &&
      basePull.state === 'closed' &&
      basePull.base?.ref === 'main',
  );
  if (
    mergedBasePull &&
    branchSha &&
    branchSha === String(mergedBasePull.head?.sha || '').toLowerCase()
  ) {
    return {
      action: 'retarget',
      reason: 'merged-base-pr',
      basePrNumber: mergedBasePull.number,
    };
  }

  if (comparison?.status === 'ahead' || comparison?.status === 'identical') {
    return { action: 'retarget', reason: 'base-contained-in-main' };
  }
  return { action: 'skip', reason: 'base-not-stale' };
}

export async function retargetStaleBasePulls({
  scheduledPulls,
  repository,
  token,
  mutationToken,
  requestFn = request,
  paginateFn = paginate,
  writeLog = (line) => process.stdout.write(`${line}\n`),
}) {
  const [owner, repo] = repository.split('/');
  const candidates = scheduledPulls.filter((pullRequest) =>
    isStaleBaseRecoveryCandidate(pullRequest, repository),
  );
  const baseFacts = new Map();
  const retargetedPulls = [];

  for (const pullRequest of candidates) {
    const baseRef = pullRequest.base.ref;
    let facts = baseFacts.get(baseRef);
    if (!facts) {
      const basePulls = await paginateFn(
        token,
        `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${baseRef}`)}`,
      );
      let baseBranch = null;
      let branchLookupError = null;
      try {
        baseBranch = (
          await requestFn(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeRefPath(baseRef)}`)
        ).data;
      } catch (error) {
        if (error?.status !== 404) branchLookupError = error;
      }
      if (branchLookupError) {
        writeLog(
          `stale-base pr=#${pullRequest.number} base=${baseRef} action=skip reason=base-branch-lookup-failed error=${branchLookupError.message}`,
        );
        continue;
      }
      let comparison = null;
      if (baseBranch) {
        try {
          comparison = (
            await requestFn(
              token,
              `/repos/${owner}/${repo}/compare/${encodeRefPath(baseRef)}...main`,
            )
          ).data;
        } catch (error) {
          writeLog(
            `stale-base pr=#${pullRequest.number} base=${baseRef} action=skip reason=base-compare-failed error=${error.message}`,
          );
          continue;
        }
      }
      facts = { basePulls, baseBranch, comparison };
      baseFacts.set(baseRef, facts);
    }

    const decision = classifyStaleBase({ pullRequest, ...facts });
    writeLog(
      `stale-base pr=#${pullRequest.number} base=${baseRef} action=${decision.action} reason=${decision.reason}`,
    );
    if (decision.action !== 'retarget') continue;
    if (!mutationToken) {
      throw new Error(
        `CRAWLER_CI_PAT is required to retarget stale base for PR #${pullRequest.number}`,
      );
    }

    const retargeted = (
      await requestFn(mutationToken, `/repos/${owner}/${repo}/pulls/${pullRequest.number}`, {
        method: 'PATCH',
        body: { base: 'main' },
      })
    ).data;
    await requestFn(
      mutationToken,
      `/repos/${owner}/${repo}/issues/${pullRequest.number}/comments`,
      {
        method: 'POST',
        body: {
          body: `${STALE_BASE_RETARGET_MARKER} base=${baseRef} reason=${decision.reason} -->\nCI Recovery auto-retargeted this PR to \`main\` because its stacked base is no longer active. Existing conflict-rebase recovery will now reconcile the refreshed diff.`,
        },
      },
    );
    retargetedPulls.push(retargeted);
    writeLog(
      `stale-base-retargeted pr=#${pullRequest.number} from=${baseRef} to=main reason=${decision.reason}`,
    );
  }

  return retargetedPulls;
}

export async function settleRetargetedPull({
  pullRequest,
  repository,
  token,
  requestFn = request,
  sleepFn = sleep,
  attempts = 3,
}) {
  const [owner, repo] = repository.split('/');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const current = (await requestFn(token, `/repos/${owner}/${repo}/pulls/${pullRequest.number}`))
      .data;
    const mergeabilityResolved =
      current.mergeable !== null &&
      current.mergeable_state !== 'unknown' &&
      current.mergeable_state !== null;
    if (current.base?.ref === 'main' && mergeabilityResolved) return current;
    if (attempt < attempts) await sleepFn(1000);
  }
  return null;
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

// Identifies automation-owned PRs that are candidates for the lease-reaper GC
// pass.  There are two categories:
//
//   1. Active automation state older than AUTOMATION_STALE_MINUTES: these hold
//      ci-owner-pr-N locks with no active session.  They will never be reached
//      by the normal dispatch path because the budget stays at zero while they
//      are stuck.
//
//   2. Owner-labeled PRs whose state is unreadable (recoveryStateUnreadable is
//      set) or null after hydration.  The reconciler already handles orphan
//      cleanup for these, but it can only run if dispatched; under a zero budget
//      they are similarly stuck.
//
// Note: PRs that are still not hydrated (recoveryState and recoveryStateUnreadable
// both absent) are skipped — the reaper hydration pass below ensures all
// owner-labeled PRs are hydrated before this function is called, so missing
// state here means hydration itself failed; the reconciler's orphan path will
// handle it on the next successful hydration sweep.
//
// Together with the reaper-triggered release in reconcile.mjs (which carries
// the attempt count forward and freezes progressAt instead of sliding it), this
// makes the automation TTL a true wall-clock ceiling: a lock held past the
// stale threshold stays eligible on every sweep until the bounded attempt
// ceiling releases it. Liveness is intentionally NOT inferred from head-SHA
// workflow runs -- unrelated CI / merge-train / sweep runs share the head SHA
// and would yield false-live signals that could make a dead lock immortal
// (adversarial plan review, 2026-07-22).
export function identifyReapablePrs(scheduledPulls, now = new Date()) {
  return scheduledPulls
    .filter((pullRequest) => {
      const owned = (pullRequest.labels || []).some((label) =>
        String(label.name || '').startsWith(OWNER_LABEL_PREFIX),
      );
      if (!owned) return false;
      const state = pullRequest.recoveryState;
      // Owner-labeled PR whose state was unreadable after hydration: always
      // eligible so the reconciler can run its orphan-cleanup path.
      if (pullRequest.recoveryStateUnreadable) return true;
      // Hydrated but absent/malformed state (null -- distinct from an
      // unhydrated `undefined`): the PR holds a ci-owner lock with no
      // recoverable automation state. The reconciler's orphan-cleanup path
      // releases it, but only if it is dispatched -- include it in the reaper
      // batch. An unhydrated PR (recoveryState === undefined) is still skipped
      // by the guard below: its age is unknown and the hydration pass retries
      // it on the next sweep.
      if (state === null) return true;
      // Only act on loaded, automation-owned active states.
      if (!state || state.owner !== 'automation') return false;
      if (!['active', 'dispatched', 'escalated'].includes(state.status)) return false;
      // Eligible when the last recorded progress is older than the stale threshold.
      const progressAt = Date.parse(state.progressAt || state.updatedAt);
      return now.getTime() - progressAt >= AUTOMATION_STALE_MINUTES * 60 * 1000;
    })
    .map((pr) => pr.number);
}

// Selects the subset of reapable PRs to dispatch this sweep, rotating the
// eligible list once per sweep window BEFORE applying REAPER_LANE_CAP. Without
// rotation a fixed prefix would be taken every sweep, so when more than
// REAPER_LANE_CAP locks are stale the tail could starve indefinitely.
//
// The rotation only distributes fairly if the underlying list has a STABLE
// order across sweeps. The caller derives reaperPrNumbers from the
// updated-desc pull list, whose order churns as reaping bumps a PR's
// updated_at (a reaped PR jumps back to the front next sweep), which would
// defeat the rotation and let tail locks starve. So sort by PR number
// (ascending, stable and sweep-invariant) before rotating. Reuses the flag-off
// sweep rotation window and rotateList helper already used by
// collectPrNumbers/eligibleTrainRecoveryPulls. Accepts an injectable `now`
// (like collectPrNumbers) so the fairness property is deterministically
// testable.
export function selectReaperBatch(reaperPrNumbers, now = new Date(), cap = REAPER_LANE_CAP) {
  const rotation =
    Number.isFinite(now.getTime()) && now.getTime() > 0
      ? Math.floor(now.getTime() / FLAG_OFF_SWEEP_ROTATION_WINDOW_MS)
      : 0;
  const stableList = [...reaperPrNumbers].sort((a, b) => a - b);
  return rotateList(stableList, rotation).slice(0, cap);
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
  // Use the shared prefix from markers.mjs so any new '<!-- crawler-...' marker
  // is automatically filtered without touching this file.
  return body.startsWith(MANAGED_COMMENT_PREFIX);
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
export function computeDispatchBudget({
  trainQueueNonEmpty,
  outstandingCount,
  activeSweepJobs = 0,
  activeValidationJobs = 0,
  maxBudgetTrainBusy = MAX_DISPATCH_BUDGET_TRAIN_BUSY,
  maxBudgetTrainIdle = MAX_DISPATCH_BUDGET_TRAIN_IDLE,
  trainCap = maxBudgetTrainBusy,
  idleCap = maxBudgetTrainIdle,
}) {
  const reservedFloor = trainQueueNonEmpty
    ? VALIDATION_RESERVED_TRAIN_BUSY
    : VALIDATION_RESERVED_TRAIN_IDLE;
  const validationReserved = Math.max(reservedFloor, activeValidationJobs);
  const maxBudget = trainQueueNonEmpty ? trainCap : idleCap;
  const headroom = RUNNER_CEILING - validationReserved - activeSweepJobs - outstandingCount;
  return Math.max(0, Math.min(maxBudget, headroom));
}

// Resolves the runtime-overridable dispatch caps from the environment.
// Both values default to their in-code constants when the env vars are absent
// or malformed, so the hardcoded defaults serve as safe fallbacks.
// Called by runFromEnv (this file) and reconcile.mjs so both dispatch sites
// honour the same env-driven caps.
export function resolveGlobalDispatchCaps(env = process.env) {
  const trainCap = parseClampedPositiveInt(
    env.CI_GLOBAL_TRAIN_DISPATCH_CAP,
    GLOBAL_TRAIN_DISPATCH_CAP,
    TRAIN_CAP_MAX,
  );
  const idleCap = parseClampedPositiveInt(
    env.CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    GLOBAL_IDLE_TRAIN_DISPATCH_CAP,
    IDLE_CAP_MAX,
  );
  return {
    maxBudgetTrainBusy: parsePositiveInt(env.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY, trainCap),
    maxBudgetTrainIdle: parsePositiveInt(env.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE, idleCap),
    globalTrainDispatchCap: parsePositiveInt(env.CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP, trainCap),
    maxDispatchPerRun: parsePositiveInt(
      env.CI_RECOVERY_MAX_DISPATCH_PER_RUN,
      DEFAULT_MAX_DISPATCH_PER_RUN,
    ),
    trainCap,
    idleCap,
  };
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
  const caps = resolveGlobalDispatchCaps(env);
  const maxDispatchPerRun = caps.maxDispatchPerRun;

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
  const directlyTriggeredPrs = eventPrNumbers(payload);
  const repairWindowSweepEvent = isRepairWindowSweepEvent({
    payload,
    eventName,
    trainEnabled,
  });

  // Always fetched now (previously only for schedule/workflow_dispatch or
  // train-enabled events): the global backpressure check below needs to
  // determine merge-train backlog state consistently on every invocation,
  // including direct per-PR events with the train feature disabled, so that
  // runner-capacity protection does not lapse whenever the train is paused.
  // This does not change collectPrNumbers' own routing semantics -- it still
  // only consults scheduledPulls for schedule/workflow_dispatch events or
  // when trainEnabled is true, exactly as before.
  let scheduledPulls = await requestWithBackoff(
    () => paginate(token, `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc`),
    { label: 'list-open-prs' },
  );
  const retargetedExpectedMetadata = new Map();
  const staleBaseSweep =
    eventName === 'schedule' || eventName === 'workflow_dispatch' || directlyTriggeredPrs.size > 0;
  if (staleBaseSweep) {
    const retargetedPulls = await retargetStaleBasePulls({
      scheduledPulls,
      repository,
      token,
      mutationToken: env.CRAWLER_CI_PAT || '',
    });
    if (retargetedPulls.length > 0) {
      const settledPulls = [];
      for (const pullRequest of retargetedPulls) {
        const settled = await settleRetargetedPull({ pullRequest, repository, token });
        if (settled) {
          settledPulls.push(settled);
          retargetedExpectedMetadata.set(settled.number, {
            expectedHeadSha: settled.head?.sha || '',
            expectedBaseRef: 'main',
          });
          process.stdout.write(
            `stale-base-ready pr=#${pullRequest.number} base=main mergeable_state=${settled.mergeable_state}\n`,
          );
        } else {
          process.stdout.write(
            `stale-base-deferred pr=#${pullRequest.number} reason=mergeability-pending retry=next-sweep\n`,
          );
        }
      }
      const retargetedByNumber = new Map(
        settledPulls.map((pullRequest) => [pullRequest.number, pullRequest]),
      );
      scheduledPulls = scheduledPulls.map(
        (pullRequest) => retargetedByNumber.get(pullRequest.number) ?? pullRequest,
      );
    }
  } else {
    process.stdout.write(`stale-base-scan skipped event=${eventName} reason=no-pr-trigger\n`);
  }
  if (trainEnabled && repairWindowSweepEvent) {
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

  if (trainEnabled && !repairWindowSweepEvent) {
    const directlyTriggeredOwned = scheduledPulls.filter(
      (pr) => directlyTriggeredPrs.has(pr.number) && hasUnhydratedOwnerLabel(pr),
    );
    if (directlyTriggeredOwned.length > 0) {
      const hydratedDirect = await hydrateRecoveryOwnership(
        directlyTriggeredOwned,
        (number) =>
          requestWithBackoff(
            () => paginate(token, `/repos/${owner}/${repo}/issues/${number}/comments`),
            { label: `direct-owner-load-state-${number}` },
          ),
        directlyTriggeredOwned.length,
      );
      const patchByNumber = new Map(hydratedDirect.map((pr) => [pr.number, pr]));
      scheduledPulls = scheduledPulls.map((pr) => patchByNumber.get(pr.number) ?? pr);
    }
  }

  // Bounded hydration pass for waiting/no-owner repair-wake candidates.
  // hydrateRecoveryOwnership only covers owner-labelled PRs (it filters by
  // OWNER_LABEL_PREFIX internally). isRepairWakeEligible requires the
  // ABSENCE of an owner label, so those PRs always arrive at collectPrNumbers
  // with recoveryState === undefined in production — making the predicate
  // permanently false. This separate pass loads the recovery state comment
  // for waiting/no-owner/no-transition candidates so isRepairWakeEligible
  // can become true for a PR that reconcile has already converged to idle.
  if (repairWindowSweepEvent) {
    const waitingNoOwnerCandidates = scheduledPulls.filter(
      (pr) =>
        (pr.labels || []).some((l) => l.name === WAITING_LABEL) &&
        !(pr.labels || []).some((l) => String(l.name || '').startsWith(OWNER_LABEL_PREFIX)) &&
        !(pr.labels || []).some((l) => l.name === WAITING_TRANSITION_LABEL) &&
        pr.recoveryState === undefined &&
        pr.recoveryStateUnreadable === undefined,
    );
    if (waitingNoOwnerCandidates.length > 0) {
      const hydratedWaiting = await Promise.all(
        waitingNoOwnerCandidates.slice(0, OWNERSHIP_HYDRATION_BATCH_SIZE).map(async (pr) => {
          try {
            const comments = await requestWithBackoff(
              () => paginate(token, `/repos/${owner}/${repo}/issues/${pr.number}/comments`),
              { label: `repair-wake-load-state-${pr.number}` },
            );
            return { ...pr, recoveryState: recoveryStateFromComments(comments) };
          } catch (error) {
            return {
              ...pr,
              recoveryState: null,
              recoveryStateUnreadable: String(error?.message || error),
            };
          }
        }),
      );
      const patchByNumber = new Map(hydratedWaiting.map((pr) => [pr.number, pr]));
      scheduledPulls = scheduledPulls.map((pr) => patchByNumber.get(pr.number) ?? pr);
    }
  }

  // Lease-reaper pass (Fix A / issue #1783): runs on every scheduled sweep
  // OUTSIDE the dispatch budget. Ensures all owner-labeled PRs have been
  // hydrated (train-mode hydration above may stop early at targetDispatchable;
  // non-train mode does not hydrate at all), then dispatches reconcile for any
  // stale automation lock. GC is therefore never budget-starved to zero.
  //
  // The reapered PR numbers are excluded from the normal prNumbers set below so
  // a PR is never double-dispatched by both the reaper and the normal path in
  // the same router run.
  const reaperDispatchedSet = new Set();
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    // Identify owner-labeled PRs still missing recoveryState (and not already
    // marked as unreadable). This covers non-train mode (never hydrated) and
    // train mode where hydration stopped early at targetDispatchable.
    const unhydratedOwned = scheduledPulls.filter(
      (pr) =>
        (pr.labels || []).some((l) => String(l.name || '').startsWith(OWNER_LABEL_PREFIX)) &&
        pr.recoveryState === undefined &&
        pr.recoveryStateUnreadable === undefined,
    );
    if (unhydratedOwned.length > 0) {
      const hydratedOwned = await hydrateRecoveryOwnership(unhydratedOwned, (number) =>
        requestWithBackoff(
          () => paginate(token, `/repos/${owner}/${repo}/issues/${number}/comments`),
          { label: `reaper-load-state-${number}` },
        ),
      );
      const patchByNumber = new Map(hydratedOwned.map((pr) => [pr.number, pr]));
      scheduledPulls = scheduledPulls.map((pr) => patchByNumber.get(pr.number) ?? pr);
    }

    const reaperNow = new Date();
    const reaperPrNumbers = identifyReapablePrs(scheduledPulls, reaperNow);

    // Closed-fence reclaim: find ci-owner-pr-* repo labels whose PR is no longer
    // open. These represent owner fences left behind when a PR was closed or
    // merged while owned. They are NOT in scheduledPulls (open-only), so they
    // must be discovered via the repo-label listing and merged into the shared
    // reaper pool BEFORE selectReaperBatch so the combined set benefits from the
    // same fair-rotation and REAPER_LANE_CAP budget accounting as stale open PRs.
    const scheduledSet = new Set(scheduledPulls.map((p) => p.number));
    const closedFenceCandidates = [];
    try {
      const allLabels = await requestWithBackoff(
        () => paginate(token, `/repos/${owner}/${repo}/labels`),
        { label: 'closed-fence-label-scan' },
      );
      const fenceNumbers = [
        ...new Set(
          allLabels
            .map((l) => String(l.name || ''))
            .filter((n) => n.startsWith(OWNER_LABEL_PREFIX))
            .map((n) => Number.parseInt(n.slice(OWNER_LABEL_PREFIX.length), 10))
            .filter((n) => Number.isInteger(n) && n > 0 && !scheduledSet.has(n)),
        ),
      ].sort((a, b) => a - b);
      // Probe each candidate's state. Bound to avoid excessive API calls; the
      // sweep runs every 10 minutes so unprobed candidates are retried soon.
      const CAP_PROBE = 10;
      for (const number of fenceNumbers.slice(0, CAP_PROBE)) {
        let pull;
        try {
          pull = (
            await requestWithBackoff(
              () => request(token, `/repos/${owner}/${repo}/pulls/${number}`),
              { label: `closed-fence-probe-${number}` },
            )
          ).data;
        } catch {
          continue;
        }
        if (String(pull?.state || '').toLowerCase() !== 'open') {
          closedFenceCandidates.push(number);
        }
      }
    } catch (error) {
      process.stdout.write(`closed-fence-scan-error: ${error?.message || error}\n`);
    }

    // Merge stale-open and closed-fence candidates into one pool and select via
    // the shared rotation + cap so neither category can starve the other.
    const combinedReaperPool = [...new Set([...reaperPrNumbers, ...closedFenceCandidates])];
    // Rotate the eligible list once per sweep window before applying the cap
    // (see selectReaperBatch) so the tail cannot starve when more than
    // REAPER_LANE_CAP locks are stale.
    const reaperBatch = selectReaperBatch(combinedReaperPool, reaperNow);
    for (const reaperPrNumber of reaperBatch) {
      // Closed-fence candidates use a distinct trigger so reconcile.mjs and
      // telemetry can distinguish them from stale-lock reclaims.
      const reaperTrigger = closedFenceCandidates.includes(reaperPrNumber)
        ? 'liveness-sweep:closed-owner-fence'
        : 'lease-reaper';
      // Use a direct request() -- do NOT wrap in requestWithBackoff. Same
      // rationale as the normal dispatch loop: non-idempotent POST, retries
      // would create duplicate runs.
      await request(token, `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`, {
        method: 'POST',
        body: {
          ref: payload.repository?.default_branch || 'main',
          inputs: {
            operation: 'reconcile',
            pr_number: String(reaperPrNumber),
            trigger: reaperTrigger,
            lease_id: '',
          },
        },
      });
      reaperDispatchedSet.add(reaperPrNumber);
      process.stdout.write(`reaper-dispatch pr=#${reaperPrNumber} trigger=${reaperTrigger}\n`);
    }
    if (reaperBatch.length > 0) {
      process.stdout.write(
        `reaper dispatched=${reaperBatch.length} pr_numbers=${reaperBatch.join(',')}\n`,
      );
    }
  }

  let prNumbers = collectPrNumbers({
    payload,
    eventName,
    repository,
    scheduledPulls,
    maxDispatchPerRun,
    trainEnabled,
    now: new Date(),
  });
  // Exclude PRs already dispatched by the reaper this run to prevent
  // double-dispatch (fix for plan-review concern #1 / issue #1783).
  if (reaperDispatchedSet.size > 0) {
    prNumbers = prNumbers.filter((n) => !reaperDispatchedSet.has(n));
  }

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
  // sites now go through buildGatedDispatchRecovery (trainCap), so both
  // callers apply the same cap before dispatching. A narrow race window still
  // exists between each caller's countOutstandingRecoveryRuns read and its
  // POST, because the router's concurrency group serialises its own
  // invocations but cannot serialise against a concurrent reconcile.mjs run.
  // A durable reservation (e.g. a shared semaphore via repository variable) is
  // the required follow-up to close that gap completely.
  const trainQueueNonEmpty = queueEntries(scheduledPulls, repository).length > 0;

  // Measure live runner pressure from in-progress sweep runs and all
  // outstanding validation runs. Sweep runs are counted with 'in_progress'
  // only because queued/waiting runs have not yet spawned their matrix jobs
  // and therefore have not consumed any runner slots. Each in-progress sweep
  // run is then weighted by SWEEP_RUNNER_WEIGHT to produce an estimated job
  // count (a full ai-sweep.yml run fans to ~10–19 concurrent jobs). Validation
  // runs use the full outstanding-status set so even a queued/waiting
  // validation run contributes to the reserved floor.
  let outstandingCountLabel = 'unknown';
  let boundedDispatchBudget = 0;
  let activeSweepRunCount = 0;
  let activeValidationRunCount = 0;
  let dispatchBudgetTelemetryStep = 'runner-pressure';
  try {
    [activeSweepRunCount, activeValidationRunCount] = await Promise.all([
      Promise.all(
        SWEEP_WORKFLOW_FILES.map((f) =>
          countOutstandingWorkflowRuns(token, owner, repo, f, ['in_progress']),
        ),
      ).then((counts) => counts.reduce((sum, c) => sum + c, 0)),
      countOutstandingWorkflowRuns(token, owner, repo, VALIDATION_WORKFLOW_FILE),
    ]);
    const activeSweepJobs = activeSweepRunCount * SWEEP_RUNNER_WEIGHT;
    const activeValidationJobs = activeValidationRunCount * VALIDATION_RUNNER_WEIGHT;

    dispatchBudgetTelemetryStep = 'recovery-outstanding';
    const outstandingCount = await countOutstandingRecoveryRuns(token, owner, repo);
    outstandingCountLabel = String(outstandingCount);
    const dispatchBudget = computeDispatchBudget({
      trainQueueNonEmpty,
      outstandingCount,
      activeSweepJobs,
      activeValidationJobs,
      maxBudgetTrainBusy: caps.maxBudgetTrainBusy,
      maxBudgetTrainIdle: caps.maxBudgetTrainIdle,
    });
    boundedDispatchBudget = trainQueueNonEmpty
      ? Math.min(dispatchBudget, caps.globalTrainDispatchCap)
      : dispatchBudget;
  } catch (error) {
    if (!isRateLimitError(error)) {
      throw error;
    }
    boundedDispatchBudget = 0;
    process.stdout.write(
      `dispatch budget telemetry rate-limited; deferring normal dispatches step=${dispatchBudgetTelemetryStep} status=${error.status || 'n/a'}\n`,
    );
  }
  const { dispatchable, deferred } = partitionDispatchable(prNumbers, boundedDispatchBudget);

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
    const expectedMetadata = retargetedExpectedMetadata.get(prNumber);
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
          ...(expectedMetadata
            ? {
                expected_head_sha: expectedMetadata.expectedHeadSha,
                expected_base_ref: expectedMetadata.expectedBaseRef,
              }
            : {}),
          lease_id: '',
        },
      },
    });
    process.stdout.write(`dispatched pr=#${prNumber} trigger=${prTrigger}\n`);
  }

  if (deferred.length > 0) {
    const cap = trainQueueNonEmpty ? caps.globalTrainDispatchCap : caps.maxBudgetTrainIdle;
    process.stdout.write(
      `global backpressure applied deferred=${deferred.length} pr_numbers=${deferred.join(',')} outstanding=${outstandingCountLabel} cap=${cap} budget=${boundedDispatchBudget} sweep_runs=${activeSweepRunCount} validation_runs=${activeValidationRunCount}\n`,
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
      `dispatch cap applied sent=${dispatchable.length} total_eligible=${scheduledPulls.length} cap=${maxDispatchPerRun} budget=${boundedDispatchBudget} outstanding=${outstandingCountLabel} sweep_runs=${activeSweepRunCount} validation_runs=${activeValidationRunCount}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromEnv();
}
