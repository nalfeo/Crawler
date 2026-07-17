import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { paginate, request } from './github.mjs';
import { WAITING_LABEL, WAITING_TRANSITION_LABEL } from './state.mjs';
import {
  BLOCKED_LABEL,
  NOOP_LABEL,
  parseEnabledFlag,
  QUEUE_LABEL,
  VALIDATION_FAILED_LABEL,
} from '../merge-train/state.mjs';

const DEFAULT_MAX_DISPATCH_PER_RUN = 8;
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
        !(pullRequest.labels || []).some((label) => label.name === WAITING_TRANSITION_LABEL),
    );
    return [...direct, ...waitingTransitions, ...sweep]
      .slice(0, Math.max(REPAIR_WINDOW_SIZE, direct.length))
      .filter(
        (pullRequest) =>
          directlyTriggeredPrs.has(pullRequest.number) ||
          eventName === 'schedule' ||
          eventName === 'workflow_dispatch' ||
          !(pullRequest.labels || []).some((label) =>
            String(label.name || '').startsWith('ci-owner-pr-'),
          ),
      )
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
  }

  const prNumbers = collectPrNumbers({
    payload,
    eventName,
    repository,
    scheduledPulls,
    maxDispatchPerRun,
    trainEnabled,
  });
  const directlyTriggeredPrs = eventPrNumbers(payload);

  for (const prNumber of prNumbers) {
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

  if (prNumbers.length === 0) {
    process.stdout.write(`no eligible PR found for ${eventName}\n`);
  } else if (
    (eventName === 'schedule' || eventName === 'workflow_dispatch') &&
    scheduledPulls.length > prNumbers.length
  ) {
    process.stdout.write(
      `dispatch cap applied sent=${prNumbers.length} total_eligible=${scheduledPulls.length} cap=${maxDispatchPerRun}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromEnv();
}
