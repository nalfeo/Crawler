import type {
  BriefSelectorProvider,
  SelectBriefRequest,
  SelectBriefResult,
} from './brief-selector-types.js';
import { TextProviderError } from './text-types.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  isTimeoutAbortError,
  providerTimeoutMessage,
} from './fetch-timeout.js';

export interface AzureOpenAIBriefSelectorProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class AzureOpenAIBriefSelectorProvider implements BriefSelectorProvider {
  readonly modelDeployment: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AzureOpenAIBriefSelectorProviderOptions) {
    this.endpoint = options.endpoint.endsWith('/')
      ? options.endpoint.slice(0, -1)
      : options.endpoint;
    this.apiKey = options.apiKey;
    this.apiVersion = options.apiVersion;
    this.modelDeployment = options.deployment;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async selectBrief(request: SelectBriefRequest): Promise<SelectBriefResult> {
    const url =
      `${this.endpoint}/openai/deployments/${encodeURIComponent(this.modelDeployment)}` +
      `/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(request) },
          ],
          temperature: 0.2,
          max_tokens: 400,
          response_format: { type: 'json_object' },
        }),
      });
    } catch (err) {
      if (isTimeoutAbortError(err)) {
        throw new TextProviderError(
          'network',
          providerTimeoutMessage('Azure chat (brief-selector)', this.timeoutMs),
          { cause: err },
        );
      }
      throw new TextProviderError(
        'network',
        `network error calling Azure chat (brief-selector): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new TextProviderError(
        response.status === 401 || response.status === 403
          ? 'auth'
          : response.status === 429
            ? 'rate-limit'
            : 'provider-error',
        `Azure chat (brief-selector) returned ${response.status}: ${detail.slice(0, 300)}`,
      );
    }
    const payload = (await response.json()) as {
      readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new TextProviderError(
        'malformed',
        'Azure chat (brief-selector) response missing choices[0].message.content',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new TextProviderError(
        'malformed',
        `Azure chat (brief-selector) response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new TextProviderError('malformed', 'brief-selector JSON must be an object');
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.index !== 'number' ||
      !Number.isInteger(obj.index) ||
      !request.candidates.some((c) => c.index === obj.index)
    ) {
      throw new TextProviderError(
        'malformed',
        'brief-selector JSON.index must reference a provided candidate index',
      );
    }
    if (typeof obj.rationale !== 'string' || obj.rationale.trim() === '') {
      throw new TextProviderError(
        'malformed',
        'brief-selector JSON.rationale must be a non-empty string',
      );
    }
    return {
      index: obj.index,
      rationale: obj.rationale.trim(),
      modelDeployment: this.modelDeployment,
    };
  }
}

const SYSTEM_PROMPT =
  'Pick the single best sprite brief candidate for Crawler art direction. ' +
  'Prioritize readability at game scale, clear silhouette, and fit to the user request. ' +
  'Return strict JSON only: {"index": <number>, "rationale": "<one sentence>"}';

function buildUserPrompt(request: SelectBriefRequest): string {
  return [
    `NAME: ${request.name}`,
    `REQUEST: ${request.briefSentence}`,
    'CANDIDATES:',
    ...request.candidates.map((c) => `- index=${c.index}: ${c.description}`),
  ].join('\n');
}
