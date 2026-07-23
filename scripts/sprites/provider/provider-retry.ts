import { randomInt } from 'node:crypto';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_TOTAL_DELAY_MS = 60_000;

export interface ProviderRetryOptions {
  /** Total attempts, including the initial request. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxTotalDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export async function fetchWithProviderRetry(
  request: () => Promise<Response>,
  options: ProviderRetryOptions = {},
): Promise<Response> {
  const maxAttempts = requirePositiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    'maxAttempts',
  );
  const baseDelayMs = requireNonNegative(
    options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    'baseDelayMs',
  );
  const maxDelayMs = requireNonNegative(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, 'maxDelayMs');
  const maxTotalDelayMs = requireNonNegative(
    options.maxTotalDelayMs ?? DEFAULT_MAX_TOTAL_DELAY_MS,
    'maxTotalDelayMs',
  );
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random ?? secureRandom;
  const now = options.now ?? (() => new Date().getTime());
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await request();
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      const delayMs = selectDelayMs({
        attempt,
        baseDelayMs,
        maxDelayMs,
        random,
        now,
      });
      if (totalDelayMs + delayMs > maxTotalDelayMs) {
        throw error;
      }
      totalDelayMs += delayMs;
      await sleep(delayMs);
      continue;
    }

    if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
      return response;
    }

    const delayMs = selectDelayMs({
      headers: response.headers,
      attempt,
      baseDelayMs,
      maxDelayMs,
      random,
      now,
    });
    if (totalDelayMs + delayMs > maxTotalDelayMs) {
      return response;
    }
    await response.body?.cancel();
    totalDelayMs += delayMs;
    await sleep(delayMs);
  }

  throw new Error('provider retry loop exhausted unexpectedly');
}

export function parseRetryAfterMs(
  headers: Headers,
  now: () => number = () => new Date().getTime(),
): number | undefined {
  const millisecondHint = headers.get('retry-after-ms');
  if (millisecondHint !== null) {
    const parsed = Number(millisecondHint);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.ceil(parsed);
    }
  }

  const retryAfter = headers.get('retry-after');
  if (retryAfter === null) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(retryAfter);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - now());
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function selectDelayMs(options: {
  readonly headers?: Headers;
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly random: () => number;
  readonly now: () => number;
}): number {
  const hinted = options.headers ? parseRetryAfterMs(options.headers, options.now) : undefined;
  if (hinted !== undefined) {
    return hinted;
  }

  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, options.attempt - 1),
  );
  const random = options.random();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new Error(`provider retry random source must return a value in [0, 1), got ${random}`);
  }
  return Math.floor(exponential / 2 + random * (exponential / 2));
}

function secureRandom(): number {
  return randomInt(0, 1_000_000) / 1_000_000;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`provider retry ${field} must be a positive integer, got ${value}`);
  }
  return value;
}

function requireNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`provider retry ${field} must be a non-negative finite number, got ${value}`);
  }
  return value;
}
