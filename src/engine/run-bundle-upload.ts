/**
 * Browser-facing endpoint resolution and network delivery for RunBundle/survey
 * uploads. Kept out of `src/shared/` (which must stay dependency-free pure
 * data/functions) because this module reads `window`/`process.env`/`navigator`
 * globals, generates wall-clock-adjacent request bodies, and performs network
 * side effects.
 */
import type { RunBundle } from '../shared/run-bundle.js';
import type { PlaytestSurvey } from '../shared/playtest-survey.js';
import {
  buildRunSurveyAppendRequest,
  buildRunBundleUploadRequest,
} from '../shared/run-bundle-telemetry.js';

export interface RunBundleUploadConfig {
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly source: 'window' | 'env' | 'none';
  readonly reason?: string;
}

const ENDPOINT_KEYS = [
  'VITE_RUNS_INGEST_URL',
  'CRAWLER_RUN_BUNDLE_ENDPOINT',
  'CRAWLER_RUNS_ENDPOINT',
  'CRAWLER_RUNS_API_URL',
  'CRAWLER_RUNS_API_ENDPOINT',
  'VITE_CRAWLER_RUN_BUNDLE_ENDPOINT',
  'VITE_CRAWLER_RUNS_ENDPOINT',
  'VITE_CRAWLER_RUNS_API_URL',
  'VITE_CRAWLER_RUNS_API_ENDPOINT',
] as const;

const toTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

function readWindowEndpoint(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  for (const candidate of [
    (window as typeof window & { __CRAWLER_RUN_BUNDLE_ENDPOINT__?: unknown })
      .__CRAWLER_RUN_BUNDLE_ENDPOINT__,
    (window as typeof window & { __CRAWLER_RUNS_ENDPOINT__?: unknown }).__CRAWLER_RUNS_ENDPOINT__,
    (window as typeof window & { __CRAWLER_RUNS_API_URL__?: unknown }).__CRAWLER_RUNS_API_URL__,
    (window as typeof window & { __CRAWLER_RUNS_API_ENDPOINT__?: unknown })
      .__CRAWLER_RUNS_API_ENDPOINT__,
    (window as typeof window & { CRAWLER_RUN_BUNDLE_ENDPOINT?: unknown })
      .CRAWLER_RUN_BUNDLE_ENDPOINT,
    (window as typeof window & { CRAWLER_RUNS_ENDPOINT?: unknown }).CRAWLER_RUNS_ENDPOINT,
    (window as typeof window & { CRAWLER_RUNS_API_URL?: unknown }).CRAWLER_RUNS_API_URL,
    (window as typeof window & { CRAWLER_RUNS_API_ENDPOINT?: unknown }).CRAWLER_RUNS_API_ENDPOINT,
  ]) {
    const trimmed = toTrimmedString(candidate);
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function readEnvEndpoint(): string | null {
  const envSource =
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as { env?: Record<string, unknown> }).env !== 'undefined'
      ? (import.meta as { env?: Record<string, unknown> }).env
      : undefined;
  for (const key of ENDPOINT_KEYS) {
    const value =
      envSource?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
    const trimmed = toTrimmedString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

export function resolveRunBundleUploadConfig(): RunBundleUploadConfig {
  const windowEndpoint = readWindowEndpoint();
  const endpoint = windowEndpoint ?? readEnvEndpoint();
  if (endpoint) {
    return {
      enabled: true,
      endpoint,
      source: windowEndpoint ? 'window' : 'env',
    };
  }
  return {
    enabled: false,
    endpoint: null,
    source: 'none',
    reason: 'Run bundle upload endpoint is not configured; silent uploads are disabled.',
  };
}

/**
 * The Fetch Standard gives `keepalive` requests (and `navigator.sendBeacon`) a
 * shared per-origin inflight body quota of 64 KiB. A larger body is rejected by
 * the browser before any network activity happens, surfacing as an opaque
 * `TypeError: Failed to fetch` that looks exactly like a CORS or DNS failure.
 * Real dev-build run bundles run ~67 KB, so they tripped this every time while
 * the same payload replayed fine outside the browser.
 */
const KEEPALIVE_BODY_LIMIT_BYTES = 64 * 1024;

function bodyByteLength(body: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(body).length;
  }
  // Fall back to a conservative upper bound (UTF-16 code units cannot expand to
  // more than 3 UTF-8 bytes each for the BMP, and surrogate pairs stay within
  // 4 bytes across 2 units), so we only ever err toward disabling keepalive.
  return body.length * 3;
}

function canUseKeepalive(body: string): boolean {
  return bodyByteLength(body) <= KEEPALIVE_BODY_LIMIT_BYTES;
}

export interface RunBundleUploadResult {
  readonly ok: boolean;
  readonly used: 'fetch' | 'sendBeacon' | 'disabled';
  readonly status?: number;
  readonly reason?: string;
}

export async function submitRunBundleUpload(
  bundle: RunBundle,
  options: {
    endReason?: string;
    fetchImpl?: typeof fetch;
    navigatorLike?: Pick<Navigator, 'sendBeacon'>;
  } = {},
): Promise<RunBundleUploadResult> {
  const config = resolveRunBundleUploadConfig();
  if (!config.enabled || !config.endpoint) {
    return { ok: false, used: 'disabled', reason: config.reason ?? 'disabled' };
  }
  const payload = buildRunBundleUploadRequest(bundle);
  const body = JSON.stringify(payload);
  const withinKeepaliveQuota = canUseKeepalive(body);
  let beaconRefused = false;
  const useBeacon =
    ((options.endReason ?? bundle.meta.endReason) === 'quit' ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')) &&
    withinKeepaliveQuota;
  const nav = options.navigatorLike ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (useBeacon && nav && typeof nav.sendBeacon === 'function') {
    // sendBeacon shares the keepalive quota and returns false when the body is
    // refused, so only report success when the browser actually queued it.
    const sent = nav.sendBeacon(config.endpoint, body);
    if (sent) {
      return { ok: true, used: 'sendBeacon' };
    }
    beaconRefused = true;
  }
  if (typeof fetch === 'undefined' && !options.fetchImpl) {
    return { ok: false, used: 'disabled', reason: 'fetch is not available in this runtime.' };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Run-Upload-Mode': 'silent' },
      body,
      keepalive: withinKeepaliveQuota && !beaconRefused,
    });
    return { ok: response.ok, used: 'fetch', status: response.status };
  } catch (error) {
    return {
      ok: false,
      used: 'fetch',
      reason: error instanceof Error ? error.message : 'run bundle upload failed',
    };
  }
}

export interface RunSurveyUploadResult {
  readonly ok: boolean;
  readonly used: 'fetch' | 'disabled';
  readonly status?: number;
  readonly reason?: string;
}

export async function submitRunSurvey(
  bundle: RunBundle,
  survey: PlaytestSurvey,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RunSurveyUploadResult> {
  return submitRunSurveyAppend(bundle.meta.runId, survey, options);
}

async function submitRunSurveyAppend(
  runId: string | undefined,
  survey: PlaytestSurvey,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RunSurveyUploadResult> {
  const config = resolveRunBundleUploadConfig();
  if (!config.enabled || !config.endpoint) {
    return { ok: false, used: 'disabled', reason: config.reason ?? 'disabled' };
  }
  const payload = buildRunSurveyAppendRequest(runId, survey);
  const body = JSON.stringify(payload);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Run-Upload-Mode': 'survey',
      },
      body,
      keepalive: canUseKeepalive(body),
    });
    return { ok: response.ok, used: 'fetch', status: response.status };
  } catch (error) {
    return {
      ok: false,
      used: 'fetch',
      reason: error instanceof Error ? error.message : 'survey upload failed',
    };
  }
}
