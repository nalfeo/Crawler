/**
 * Azure OpenAI vision/chat-completions adapter used by the VLM judge.
 *
 * The judge sends ONE chat-completion request per variant with:
 *   - a system message containing the evaluator definitions and rubric,
 *   - a user message containing the prompt + multiple labelled images
 *     attached as `image_url` parts with base64 `data:` URLs.
 *
 * Conventions mirror `azure-openai.ts` and `azure-chat.ts`:
 *
 *   - Constructor takes `fetch` so unit tests stub the network.
 *   - Bounded transport retries cover rate limits, server failures, and
 *     network failures. Malformed or rejected judge output is never retried.
 *   - All failures surface as `VisionProviderError` with a typed `kind`.
 *
 * The provider validates that the model returned a JSON object (parses
 * with `JSON.parse` after stripping markdown fences) but does NOT
 * validate the shape — the judge's Zod schema does that. Keeping the
 * provider schema-agnostic means adding a fourth evaluator doesn't
 * touch this file.
 */

import type {
  EvaluateRequest,
  EvaluateResponse,
  VisionImageInput,
  VisionProvider,
  VisionProviderErrorKind,
  VisionUsage,
} from './vision-types.js';
import { VisionProviderError } from './vision-types.js';
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

export interface AzureOpenAIVisionProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /** Injectable fetch implementation; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Per-request timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}.
   * Aborts a hung judge call instead of blocking the run forever.
   */
  readonly timeoutMs?: number;
  readonly retry?: ProviderRetryOptions;
}

interface ChatChoice {
  readonly message?: { readonly content?: string };
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<ChatChoice>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class AzureOpenAIVisionProvider implements VisionProvider {
  private readonly endpoint: string;
  readonly modelDeployment: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: ProviderRetryOptions;

  constructor(opts: AzureOpenAIVisionProviderOptions) {
    this.endpoint = stripTrailingSlash(opts.endpoint);
    this.modelDeployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.retry = opts.retry ?? {};
  }

  async evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
    const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(
      this.modelDeployment,
    )}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;

    const userContent: Array<unknown> = [{ type: 'text', text: request.userPrompt }];
    for (const image of request.images) {
      userContent.push(buildImagePart(image));
    }

    const body = {
      messages: [
        { role: 'system', content: request.systemInstructions },
        { role: 'user', content: userContent },
      ],
      // Near-deterministic by default. Judges are evaluations, not
      // creative work; we want the same verdict on a re-run.
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 800,
      response_format: { type: 'json_object' },
    };

    let response: Response;
    try {
      response = await fetchWithProviderRetry(
        () =>
          this.fetchImpl(url, {
            method: 'POST',
            headers: {
              'api-key': this.apiKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        this.retry,
      );
    } catch (err) {
      if (isTimeoutAbortError(err)) {
        throw new VisionProviderError(
          'network',
          providerTimeoutMessage('Azure vision', this.timeoutMs),
          { cause: err },
        );
      }
      throw new VisionProviderError(
        'network',
        `network error calling Azure vision: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new VisionProviderError(
        kind,
        `Azure vision returned ${response.status}: ${truncate(bodyText, 500)}`,
        { retryAfterMs: parseRetryAfterMs(response.headers) },
      );
    }

    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
    } catch (err) {
      throw new VisionProviderError(
        'malformed',
        `Azure vision response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (payload.error) {
      throw new VisionProviderError(
        'request-error',
        `Azure vision error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new VisionProviderError(
        'malformed',
        'Azure vision response missing choices[0].message.content',
      );
    }

    const json = parseJsonObject(content);
    if (json === null) {
      throw new VisionProviderError(
        'malformed',
        `Azure vision response did not contain a JSON object: ${truncate(content, 200)}`,
      );
    }

    return {
      json,
      usage: extractUsage(payload),
      modelDeployment: this.modelDeployment,
    };
  }
}

function buildImagePart(image: VisionImageInput): unknown {
  const mediaType = image.mediaType ?? 'image/png';
  const dataUrl = `data:${mediaType};base64,${image.png.toString('base64')}`;
  return {
    type: 'image_url',
    image_url: { url: dataUrl, detail: 'high' },
  };
}

/**
 * Parse a JSON OBJECT from a model response that may have prose, code
 * fences, or trailing commentary. Strategy mirrors `azure-chat.ts` but
 * returns the parsed object directly (the chat provider returns an array
 * of strings, which is a slightly different post-processing problem).
 *
 * Returns `null` when no JSON object can be extracted — the caller
 * surfaces this as `VisionProviderError(malformed)`.
 */
function parseJsonObject(content: string): unknown {
  const candidates: string[] = [content];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const firstBrace = content.indexOf('{');
  if (firstBrace > 0) candidates.push(content.slice(firstBrace));

  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // try next strategy
    }
  }
  return null;
}

function extractUsage(payload: ChatResponse): VisionUsage | null {
  const usage = payload.usage;
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function httpStatusToKind(status: number): VisionProviderErrorKind {
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
