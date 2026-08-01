/**
 * LLM-driven tag enrichment for generated sprite assets.
 *
 * Generates 5-15 free-form descriptive tags per sprite using Azure OpenAI
 * chat completions. Tags cover materials, condition, function, theme,
 * room-fit, and visual traits so the `asset-search` extension can match
 * assets by natural-language queries.
 *
 * Design notes:
 *  - Pure core: no filesystem I/O. The CLI and approve hook manage reads/writes.
 *  - Provider injection: tests stub `EnrichTagsProvider` directly.
 *  - Never throws on enrichment failure; callers decide whether to propagate.
 */

import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  isTimeoutAbortError,
  providerTimeoutMessage,
} from './provider/fetch-timeout.js';
import { fetchWithProviderRetry, type ProviderRetryOptions } from './provider/provider-retry.js';
import { TextProviderError, type TextProviderErrorKind } from './provider/text-types.js';
import { resolveAzureChatConfig, type CreateProviderOptions } from './provider/factory.js';

// Re-export TextProviderError so callers can catch-by-type without an extra import.
export { TextProviderError };

/** Minimal description of a sprite needed to generate enrichment tags. */
export interface EnrichTagsRequest {
  /** The manifest shard key, e.g. `"anvil-v1-var-0"`. */
  readonly manifestKey: string;
  /** Sprite type from the brief (`"prop"`, `"mob"`, …) or `null` if unknown. */
  readonly type: string | null;
  /** Human-readable description from the catalog entry, or the brief prompt. */
  readonly description: string;
  /** The brief ID used to generate this sprite. */
  readonly briefId: string;
}

/** Abstraction over the LLM call — injectable for tests. */
export interface EnrichTagsProvider {
  generateTags(request: EnrichTagsRequest): Promise<string[]>;
}

export interface AzureEnrichTagsProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly retry?: ProviderRetryOptions;
}

interface ChatChoice {
  readonly message?: { readonly content?: string };
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<ChatChoice>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class AzureEnrichTagsProvider implements EnrichTagsProvider {
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: ProviderRetryOptions;

  constructor(opts: AzureEnrichTagsProviderOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.deployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
    this.retry = opts.retry ?? {};
  }

  async generateTags(request: EnrichTagsRequest): Promise<string[]> {
    const url =
      `${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}` +
      `/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;

    const body = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(request) },
      ],
      temperature: 0.3,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    };

    let response: Response;
    try {
      response = await fetchWithProviderRetry(
        () =>
          this.fetchImpl(url, {
            method: 'POST',
            headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        this.retry,
      );
    } catch (err) {
      if (isTimeoutAbortError(err)) {
        throw new TextProviderError(
          'network',
          providerTimeoutMessage('Azure chat (enrich-tags)', this.timeoutMs),
          { cause: err },
        );
      }
      throw new TextProviderError(
        'network',
        `network error calling Azure chat (enrich-tags): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new TextProviderError(
        kind,
        `Azure chat (enrich-tags) returned ${response.status}: ${bodyText.slice(0, 500)}`,
        { retryAfterMs: parseRetryAfter(response.headers) },
      );
    }

    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
    } catch (err) {
      throw new TextProviderError(
        'malformed',
        `Azure chat (enrich-tags) response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (payload.error) {
      throw new TextProviderError(
        'request-error',
        `Azure chat (enrich-tags) error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new TextProviderError(
        'malformed',
        'Azure chat (enrich-tags) response missing choices[0].message.content',
      );
    }

    const tags = parseTagsResponse(content);
    if (tags.length === 0) {
      throw new TextProviderError(
        'malformed',
        `Azure chat (enrich-tags) returned no usable tags: ${content.slice(0, 200)}`,
      );
    }
    return tags;
  }
}

export interface EnrichTagsProviderOptions extends CreateProviderOptions {
  /** Override the request timeout in milliseconds. Defaults to the factory config value. */
  readonly timeoutMs?: number;
}

/**
 * Build a provider from environment variables. Returns `null` when the Azure
 * chat deployment is not configured — callers treat enrichment as optional and
 * degrade gracefully.
 */
export function createEnrichTagsProvider(
  options: EnrichTagsProviderOptions = {},
): EnrichTagsProvider | null {
  try {
    const config = resolveAzureChatConfig(options);
    return new AzureEnrichTagsProvider({
      endpoint: config.endpoint,
      deployment: config.deployment,
      apiKey: config.apiKey,
      apiVersion: config.apiVersion,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are a pixel-art game asset cataloguer for a dungeon crawler.',
  'Your task is to tag sprite assets with descriptive lowercase tags to enable semantic search.',
  'Tags should cover the following categories where relevant:',
  '  - materials: wood, stone, iron, crystal, bone, cloth, leather, rope, glass, fabric',
  '  - condition: rusted, broken, worn, ancient, ornate, enchanted, burning, cracked, pristine',
  '  - function: furniture, storage, lighting, tool, decoration, altar, trap, container, weapon',
  '  - theme: fantasy, medieval, industrial, dungeon, cave, magic, nature, arcane, horror',
  '  - room-fit: smithy, library, boss-room, safe-room, workshop, shrine, market, graveyard, cave',
  '  - visual traits: large, small, dark, warm, glowing, symmetrical, asymmetric, tall, wide',
  '',
  'Return JSON: { "tags": ["tag1", "tag2", ...] }',
  'Rules: lowercase only, use hyphens for multi-word tags (e.g. "boss-room"), 5-15 tags total.',
  'No prose. No markdown. Only the JSON object.',
].join('\n');

export function buildUserPrompt(request: EnrichTagsRequest): string {
  const parts: string[] = [];
  parts.push(`Sprite: name="${request.manifestKey}"`);
  if (request.type) parts.push(`type="${request.type}"`);
  if (request.briefId && request.briefId !== request.manifestKey.replace(/-var-\d+$/, '')) {
    parts.push(`brief="${request.briefId}"`);
  }
  if (request.description) {
    parts.push(`description="${request.description.slice(0, 300)}"`);
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the model's JSON response into a cleaned tag array.
 * Deliberately permissive: strips markdown fences, tries bare array fallback.
 */
export function parseTagsResponse(content: string): string[] {
  const candidates: unknown[] = [];

  const tryPush = (text: string): void => {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      // ignore; try next extraction strategy
    }
  };

  tryPush(content);

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) tryPush(fenced[1].trim());

  const firstBrace = content.indexOf('{');
  const firstBracket = content.indexOf('[');
  const first =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (first > 0) tryPush(content.slice(first));

  for (const candidate of candidates) {
    const arr = extractTagArray(candidate);
    if (arr.length > 0) return arr;
  }
  return [];
}

function extractTagArray(value: unknown): string[] {
  // { "tags": [...] }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const arr = obj['tags'] ?? obj['result'] ?? obj['labels'];
    if (Array.isArray(arr)) return cleanTags(arr);
    // Any top-level array value
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        const cleaned = cleanTags(v);
        if (cleaned.length > 0) return cleaned;
      }
    }
  }
  // Bare array
  if (Array.isArray(value)) return cleanTags(value);
  return [];
}

function cleanTags(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag.length === 0 || tag.length > 50) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helpers (mirrors azure-chat.ts)
// ---------------------------------------------------------------------------

function httpStatusToKind(status: number): TextProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server-error';
  return 'request-error';
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}
