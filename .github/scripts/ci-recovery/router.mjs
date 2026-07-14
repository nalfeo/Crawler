import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { paginate, request } from './github.mjs';

const DEFAULT_MAX_DISPATCH_PER_RUN = 8;
const DEFAULT_RETRY_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;

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
}) {
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

  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    const normalizedRepo = repository.toLowerCase();
    for (const pullRequest of scheduledPulls) {
      if (
        !pullRequest.draft &&
        pullRequest.head?.repo?.full_name?.toLowerCase() === normalizedRepo
      ) {
        add(pullRequest.number);
      }
    }
  }

  const sorted = [...numbers].sort((left, right) => left - right);
  if (
    (eventName === 'schedule' || eventName === 'workflow_dispatch') &&
    sorted.length > maxDispatchPerRun
  ) {
    return sorted.slice(0, maxDispatchPerRun);
  }
  return sorted;
}

export async function runFromEnv(env = process.env) {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  const eventName = env.GITHUB_EVENT_NAME || '';
  const eventPath = env.GITHUB_EVENT_PATH;
  const trigger = env.RECOVERY_TRIGGER || eventName;
  const maxDispatchPerRun = parsePositiveInt(
    env.CI_RECOVERY_MAX_DISPATCH_PER_RUN,
    DEFAULT_MAX_DISPATCH_PER_RUN,
  );

  if (!token || !owner || !repo || !eventPath) {
    throw new Error('Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or GITHUB_EVENT_PATH');
  }

  const payload = JSON.parse(await readFile(eventPath, 'utf8'));

  let scheduledPulls = [];
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
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
  });

  for (const prNumber of prNumbers) {
    await requestWithBackoff(
      () =>
        request(token, `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`, {
          method: 'POST',
          body: {
            ref: payload.repository?.default_branch || 'main',
            inputs: {
              operation: 'reconcile',
              pr_number: String(prNumber),
              trigger,
              lease_id: '',
            },
          },
        }),
      { label: `dispatch-pr-${prNumber}` },
    );
    process.stdout.write(`dispatched pr=#${prNumber} trigger=${trigger}\n`);
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
