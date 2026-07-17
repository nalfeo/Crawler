/**
 * Azure OpenAI chat-completions adapter used to expand a brief's
 * `variations` seed list with LLM-proposed on-theme embellishments.
 *
 * Same envelope conventions as `azure-openai.ts`:
 *
 *   - Constructor takes `fetch` so unit tests stub the network.
 *   - No retries here. The orchestrator owns retry policy and, for
 *     variation expansion specifically, the orchestrator chooses
 *     "swallow and degrade" over "retry" because the run can still
 *     succeed without the extra variations.
 *   - All failures surface as `TextProviderError` with a typed `kind`.
 *
 * Response parsing is deliberately permissive:
 *
 *   - Models sometimes wrap JSON in ```json ... ``` fences or prefix it
 *     with "Sure! Here are the variations:" prose. We strip fences,
 *     locate the first `{` or `[`, and parse from there.
 *   - We accept either a JSON array of strings or an object with a
 *     top-level `variations` array. Whichever the model picks today.
 *   - Non-string entries are filtered out; whitespace is trimmed;
 *     duplicates (case-insensitive) within the response are collapsed.
 *
 * This keeps the integration robust against the small instruction
 * drifts that text models inevitably exhibit.
 */

import type { ExpandVariationsRequest, TextProvider, TextProviderErrorKind } from './text-types.js';
import { TextProviderError } from './text-types.js';
import { contentDirectionBlock } from '../content-direction.js';
import { resolveDesignLanguageAddenda } from '../design-language-addenda.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  isTimeoutAbortError,
  providerTimeoutMessage,
} from './fetch-timeout.js';

export interface AzureOpenAIChatProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /** Sampling temperature for the brainstorm call. Defaults to 0.9 — we
   *  want creative spread, not deterministic output. */
  readonly temperature?: number;
  /** Hard cap on response tokens. 600 is plenty for ~20 short strings. */
  readonly maxTokens?: number;
  /** Injectable fetch implementation; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Per-request timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}.
   * Aborts a hung variation-expansion call instead of stalling the run.
   */
  readonly timeoutMs?: number;
}

interface ChatChoice {
  readonly message?: { readonly content?: string };
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<ChatChoice>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class AzureOpenAIChatProvider implements TextProvider {
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AzureOpenAIChatProviderOptions) {
    this.endpoint = stripTrailingSlash(opts.endpoint);
    this.deployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.temperature = opts.temperature ?? 0.9;
    this.maxTokens = opts.maxTokens ?? 600;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async expandVariations(request: ExpandVariationsRequest): Promise<ReadonlyArray<string>> {
    const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(
      this.deployment,
    )}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;

    const body = {
      messages: [
        { role: 'system', content: buildSystemPrompt(request.brief) },
        { role: 'user', content: buildUserPrompt(request) },
      ],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      response_format: { type: 'json_object' },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (isTimeoutAbortError(err)) {
        throw new TextProviderError(
          'network',
          providerTimeoutMessage('Azure chat', this.timeoutMs),
          { cause: err },
        );
      }
      throw new TextProviderError(
        'network',
        `network error calling Azure chat: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new TextProviderError(
        kind,
        `Azure chat returned ${response.status}: ${truncate(bodyText, 500)}`,
      );
    }

    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
    } catch (err) {
      throw new TextProviderError(
        'malformed',
        `Azure chat response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (payload.error) {
      throw new TextProviderError(
        'provider-error',
        `Azure chat error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new TextProviderError(
        'malformed',
        'Azure chat response missing choices[0].message.content',
      );
    }

    const variations = parseVariationsResponse(content);
    if (variations.length === 0) {
      throw new TextProviderError(
        'malformed',
        `Azure chat response contained no usable variation strings: ${truncate(content, 200)}`,
      );
    }
    return variations;
  }
}

export function buildSystemPrompt(brief: ExpandVariationsRequest['brief']): string {
  return [
    'You design visual variations for 256x256-source pixel-art sprites that resolve cleanly at game scale.',
    contentDirectionBlock(brief.floor, resolveDesignLanguageAddenda(brief.name, brief.floor)),
    "Each variation is one discrete, on-theme embellishment that preserves the subject's identity, gameplay role, orientation, and inanimate/animate category.",
    'Variations must be visually distinct, appropriate to the supplied floor, free of detail that collapses when scaled down, and described concisely (4-25 words). Never anthropomorphize an item unless the brief explicitly requests it.',
    'Output STRICT JSON only: an object with a single key "variations" whose value is an array of strings. No prose, no markdown.',
  ].join('\n\n');
}

function buildUserPrompt(request: ExpandVariationsRequest): string {
  const { brief, existing, count } = request;
  const lines: string[] = [];
  lines.push(`SUBJECT: ${brief.prompt}`);
  lines.push(`SPRITE TYPE: ${brief.type}`);
  lines.push(`FLOOR: ${brief.floor} of 20`);
  if (brief.tags.length > 0) lines.push(`TAGS: ${brief.tags.join(', ')}`);
  if (existing.length > 0) {
    lines.push('');
    lines.push('AUTHOR-PROVIDED VARIATIONS (do not duplicate, do not paraphrase):');
    for (const v of existing) lines.push(`- ${v}`);
  }
  lines.push('');
  lines.push(
    `Propose exactly ${count} additional on-theme embellishment(s) following these rules:`,
  );
  lines.push(`- Preserve the subject's silhouette family, role, and orientation.`);
  lines.push(`- Each entry stands alone — do not combine multiple ideas with "and".`);
  lines.push(
    `- Stay readable after downscaling in-engine: avoid fine text, complex gradients, and tiny secondary objects.`,
  );
  lines.push(
    `- Prefer a specific material, subculture, contraption, social role, or anatomical twist over a generic adjective.`,
  );
  lines.push(`- Keep the weirdness coherent and at the requested floor intensity.`);
  lines.push('');
  lines.push(`Return JSON: {"variations": ["...", "..."]}`);
  return lines.join('\n');
}

/**
 * Extract the variations array from a model response.
 *
 * Strategy:
 *   1. Try direct JSON.parse — fast path for well-behaved models.
 *   2. If that fails, strip markdown code fences and try again.
 *   3. As a last resort, locate the first `{` or `[` and try parsing
 *      the rest of the string from there. `JSON.parse` requires the
 *      entire input to be a single valid JSON value with only trailing
 *      whitespace allowed, so this only succeeds when the model's reply
 *      ends cleanly at the JSON's closing token. Trailing prose after
 *      the JSON makes this last-resort path fail. We do NOT attempt to
 *      find a "matching close" — the brace-walker that would do that
 *      is more code than it's worth for the rare cases this fallback
 *      exists to catch.
 *
 * The returned list is trimmed, non-empty-filtered, and de-duplicated
 * case-insensitively in declared order.
 */
function parseVariationsResponse(content: string): string[] {
  const candidates: unknown[] = [];

  const tryPush = (text: string): void => {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      // ignore; we'll try other extraction strategies
    }
  };

  tryPush(content);

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) tryPush(fenced[1].trim());

  // Locate the first JSON-ish token and try parsing the tail.
  const firstObj = content.indexOf('{');
  const firstArr = content.indexOf('[');
  const first =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (first > 0) tryPush(content.slice(first));

  for (const candidate of candidates) {
    const arr = extractStringArray(candidate);
    if (arr) return arr;
  }
  return [];
}

function extractStringArray(value: unknown): string[] | null {
  let arr: unknown;
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === 'object' && 'variations' in value) {
    arr = (value as { variations: unknown }).variations;
  } else {
    return null;
  }
  if (!Array.isArray(arr)) return null;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function httpStatusToKind(status: number): TextProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  return 'provider-error';
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
