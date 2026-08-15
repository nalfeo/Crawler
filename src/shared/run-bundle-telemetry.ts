import type { RunBundle } from './run-bundle.js';
import type { PlaytestSurvey } from './playtest-survey.js';

export interface RunBundleUploadConfig {
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly source: 'window' | 'env' | 'none';
  readonly reason?: string;
}

export interface RunBundleUploadRequest {
  readonly kind: 'run_bundle' | 'survey';
  readonly issue?: boolean;
  readonly bundle?: RunBundle;
  readonly survey?: PlaytestSurvey;
  readonly comment?: string;
  readonly createdAt: string;
  readonly endReason?: string;
  readonly runStats?: unknown;
  readonly meta?: unknown;
}

const ENDPOINT_KEYS = [
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
  const endpoint = readWindowEndpoint() ?? readEnvEndpoint();
  if (endpoint) {
    return {
      enabled: true,
      endpoint,
      source: readWindowEndpoint() ? 'window' : 'env',
    };
  }
  return {
    enabled: false,
    endpoint: null,
    source: 'none',
    reason: 'Run bundle upload endpoint is not configured; silent uploads are disabled.',
  };
}

export function buildRunBundleUploadRequest(
  bundle: RunBundle,
  options: { endReason?: string } = {},
): RunBundleUploadRequest {
  return {
    kind: 'run_bundle',
    createdAt: new Date().toISOString(),
    endReason: options.endReason ?? bundle.meta.endReason,
    bundle,
    runStats: bundle.runStats,
    meta: bundle.meta,
  };
}

export function buildRunSurveyRequest(
  bundle: RunBundle,
  survey: PlaytestSurvey,
): RunBundleUploadRequest {
  const normalizedSurvey = {
    ...survey,
    comment: typeof survey.comment === 'string' ? survey.comment.trim() : undefined,
  };
  return {
    kind: 'survey',
    issue: true,
    createdAt: new Date().toISOString(),
    endReason: bundle.meta.endReason,
    bundle,
    survey: normalizedSurvey,
    runStats: bundle.runStats,
    meta: bundle.meta,
    comment: normalizedSurvey.comment,
  };
}

export async function submitRunBundleUpload(
  bundle: RunBundle,
  options: {
    endReason?: string;
    fetchImpl?: typeof fetch;
    navigatorLike?: Pick<Navigator, 'sendBeacon'>;
    windowLike?: Window;
  } = {},
): Promise<{
  ok: boolean;
  used: 'fetch' | 'sendBeacon' | 'disabled';
  status?: number;
  reason?: string;
}> {
  const config = resolveRunBundleUploadConfig();
  if (!config.enabled || !config.endpoint) {
    return { ok: false, used: 'disabled', reason: config.reason ?? 'disabled' };
  }
  const payload = buildRunBundleUploadRequest(bundle, { endReason: options.endReason });
  const body = JSON.stringify(payload);
  const useBeacon =
    (options.endReason ?? bundle.meta.endReason) === 'quit' ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const nav = options.navigatorLike ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (useBeacon && nav && typeof nav.sendBeacon === 'function') {
    const sent = nav.sendBeacon(config.endpoint, body);
    return { ok: sent, used: 'sendBeacon' };
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
      keepalive: true,
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

export async function submitRunSurvey(
  bundle: RunBundle,
  survey: PlaytestSurvey,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; used: 'fetch'; status?: number; reason?: string }> {
  const config = resolveRunBundleUploadConfig();
  if (!config.enabled || !config.endpoint) {
    return { ok: false, used: 'fetch', reason: config.reason ?? 'disabled' };
  }
  const payload = buildRunSurveyRequest(bundle, survey);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Run-Upload-Mode': 'survey',
      },
      body: JSON.stringify(payload),
      keepalive: true,
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
