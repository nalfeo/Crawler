/**
 * Azure OpenAI `images/edits` adapter.
 *
 * Hits the Azure-hosted gpt-image-1 deployment with a multipart request that
 * contains the prompt text and the reference PNGs from the brief. Returns
 * the raw multi-variant sheet PNG as a Buffer.
 *
 * Design notes:
 *
 * - Constructor takes `fetch` so unit tests can stub the network without
 *   monkey-patching globals.
 * - Bounded transport retries stay in this layer; semantic retries such as a
 *   sterner prompt for a bad grid remain the orchestrator's responsibility.
 * - Uses Node 22's native FormData + Blob — no `form-data` package needed.
 *   If we ever drop to <18 we'll need a polyfill.
 *
 * TODO (provider swap): once MAI image-gen is accessible, add an
 * `MaiImageProvider` in this folder and have `factory.ts` switch on a
 * `SPRITES_PROVIDER` env var. The contract in `./types.ts` is the seam;
 * the MAI implementation can reuse the same `GenerateSheetRequest` and
 * `ImageProvider` interface. The Azure-specific bits (api-key header,
 * `images/edits` route, response shape parsing) all live below in this file.
 */

import { PNG } from 'pngjs';
import type { GenerateSheetRequest, ImageProvider, ProviderErrorKind } from './types.js';
import { ProviderError } from './types.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  isTimeoutAbortError,
  providerTimeoutMessage,
} from './fetch-timeout.js';
import {
  fetchWithProviderRetry,
  parseRetryAfterMs,
  type ProviderRetryOptions,
} from './provider-retry.js';

export interface AzureOpenAIImageProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /**
   * Injectable fetch implementation. Defaults to global fetch (Node 18+).
   * Tests pass a stub to avoid network IO.
   */
  readonly fetch?: typeof fetch;
  /**
   * Per-request timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}.
   * A request that exceeds it is aborted and surfaced as a `network` error so a
   * hung Azure call can't block the generate pipeline indefinitely.
   */
  readonly timeoutMs?: number;
  readonly retry?: ProviderRetryOptions;
}

interface AzureImagesResponse {
  readonly data?: ReadonlyArray<{ readonly b64_json?: string; readonly url?: string }>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class AzureOpenAIImageProvider implements ImageProvider {
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: ProviderRetryOptions;

  constructor(opts: AzureOpenAIImageProviderOptions) {
    this.endpoint = stripTrailingSlash(opts.endpoint);
    this.deployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.retry = opts.retry ?? {};
  }

  async generateSheet(request: GenerateSheetRequest): Promise<Buffer> {
    const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(
      this.deployment,
    )}/images/edits?api-version=${encodeURIComponent(this.apiVersion)}`;

    const size = request.size ?? request.brief.generation.sheet.nativeCanvas;
    const form = new FormData();
    form.set('prompt', request.prompt);
    form.set('size', `${size}x${size}`);
    form.set('n', '1');
    // gpt-image-1 always returns base64 and rejects `response_format`; do
    // not send it. (The original code targeted dall-e-3, which required it.)

    // Each reference image is attached as a separate `image[]` part.
    request.referencePngs.forEach((png, idx) => {
      form.append(
        'image[]',
        new Blob([new Uint8Array(png)], { type: 'image/png' }),
        `ref-${idx}.png`,
      );
    });

    let response: Response;
    try {
      response = await fetchWithProviderRetry(
        () =>
          this.fetchImpl(url, {
            method: 'POST',
            headers: { 'api-key': this.apiKey },
            body: form,
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        this.retry,
      );
    } catch (err) {
      if (isTimeoutAbortError(err)) {
        throw new ProviderError(
          'network',
          providerTimeoutMessage('Azure images/edits', this.timeoutMs),
          { cause: err },
        );
      }
      throw new ProviderError('network', `network error calling Azure: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new ProviderError(
        kind,
        `Azure images/edits returned ${response.status}: ${truncate(bodyText, 500)}`,
        { retryAfterMs: parseRetryAfterMs(response.headers) },
      );
    }

    // The response is JSON with a base64-encoded PNG in data[0].b64_json.
    let payload: AzureImagesResponse;
    try {
      payload = (await response.json()) as AzureImagesResponse;
    } catch (err) {
      throw new ProviderError(
        'provider-error',
        `Azure response was not valid JSON: ${(err as Error).message}`,
        { cause: err },
      );
    }

    if (payload.error) {
      throw new ProviderError(
        'request-error',
        `Azure error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }

    const b64 = payload.data?.[0]?.b64_json;
    if (!b64) {
      throw new ProviderError(
        'non-png',
        `Azure response missing data[0].b64_json (got keys: ${Object.keys(payload).join(', ')})`,
      );
    }

    const sheet = Buffer.from(b64, 'base64');

    // Decode-check so the orchestrator gets a clear non-png error before
    // it tries to slice.
    try {
      PNG.sync.read(sheet);
    } catch (err) {
      throw new ProviderError(
        'non-png',
        `provider returned undecodable PNG: ${(err as Error).message}`,
        {
          cause: err,
        },
      );
    }

    return sheet;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function httpStatusToKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500 && status < 600) return 'server-error';
  return 'request-error';
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
