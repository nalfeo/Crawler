/**
 * Azure OpenAI chat-completions adapter for brief synthesis.
 *
 * Sibling to `azure-chat.ts` (which handles variation expansion). Both
 * point at the same chat deployment but request very different
 * response shapes, so they're kept as separate classes — easier to
 * test, easier to reason about, no flag-of-flags inside one method.
 *
 * Conventions match `azure-chat.ts`:
 *   - `fetch` is injectable for tests.
 *   - No retries; the orchestrator owns retry policy.
 *   - HTTP / payload errors surface as `SynthProviderError` with a
 *     typed `kind`.
 *
 * The provider does NOT validate the structured response semantically
 * — it only parses it as JSON and confirms the top-level shape is
 * plausible. Field-level validation (banned adjectives, allow-list
 * membership, candidate count) is the synthesizer's job, so all the
 * rejection logic lives in one place.
 */

import type {
  SynthesizeBriefRequest,
  SynthesizeBriefResponse,
  SynthesizedCandidate,
  SynthProvider,
  SynthProviderErrorKind,
} from './synth-types.js';
import { SynthProviderError } from './synth-types.js';
import { formatCatalogForPrompt } from '../reference-allow-list.js';
import { SPRITE_TYPES } from '../brief-schema.js';

export interface AzureOpenAISynthProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /**
   * Sampling temperature. Default 0.85 — we want creative spread
   * across the three candidates but not so much that the model goes
   * off-format. Slightly below the variation-expander's 0.9 because
   * synthesis is more structured (must hit the JSON schema).
   */
  readonly temperature?: number;
  /** Hard cap on response tokens. 1500 covers 5 candidates with prose. */
  readonly maxTokens?: number;
  /** Injectable fetch implementation; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

interface ChatChoice {
  readonly message?: { readonly content?: string };
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<ChatChoice>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class AzureOpenAISynthProvider implements SynthProvider {
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  readonly providerLabel: string;

  constructor(opts: AzureOpenAISynthProviderOptions) {
    this.endpoint = stripTrailingSlash(opts.endpoint);
    this.deployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.temperature = opts.temperature ?? 0.85;
    this.maxTokens = opts.maxTokens ?? 1500;
    this.fetchImpl = opts.fetch ?? fetch;
    this.providerLabel = `azure-openai:${opts.deployment}`;
  }

  async synthesizeBrief(request: SynthesizeBriefRequest): Promise<SynthesizeBriefResponse> {
    const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(
      this.deployment,
    )}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;

    const body = {
      messages: [
        { role: 'system', content: buildSystemPrompt(request) },
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
      });
    } catch (err) {
      throw new SynthProviderError(
        'network',
        `network error calling Azure chat (synthesis): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new SynthProviderError(
        kind,
        `Azure chat (synthesis) returned ${response.status}: ${truncate(bodyText, 500)}`,
      );
    }

    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
    } catch (err) {
      throw new SynthProviderError(
        'malformed',
        `Azure chat (synthesis) response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (payload.error) {
      throw new SynthProviderError(
        'provider-error',
        `Azure chat (synthesis) error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new SynthProviderError(
        'malformed',
        'Azure chat (synthesis) response missing choices[0].message.content',
      );
    }

    return parseSynthResponse(content, request);
  }
}

export function buildSystemPrompt(request: SynthesizeBriefRequest): string {
  const wantClassify = request.type === null;
  const referenceList = formatCatalogForPrompt(request.referenceCatalog);
  const lines: string[] = [
    'You are a sprite-brief synthesizer for the game Crawler. Crawler uses 16x16 pixel-art sprites in the Kenney roguelike style. Your job is to turn a subject name into multiple distinct candidate briefs that a human will then pick from.',
    '',
    'HARD RULES (any violation rejects the candidate):',
    '1. Each candidate description MUST be concrete — describe pose, silhouette, orientation, and dominant colour. Vague adjectives such as "cool", "awesome", "epic", "amazing", or "nice" are forbidden.',
    '2. The three candidates MUST be visibly distinct from one another. Different silhouettes, different proportions, different on-theme embellishments — not three palette swaps of the same drawing.',
    '3. Every candidate description MUST mention an explicit pose / orientation hint (e.g. "held vertically", "side-profile angled 45 degrees up-right", "facing the camera"). Default for weapons is vertical with the grip at the bottom.',
    '4. Every candidate description MUST mention a dominant colour hint by name (e.g. "iron steel with brown wrap", "deep crimson cloth"). NEVER use hex codes — the downstream palette quantiser will pick exact RGB values.',
    '5. References MUST be chosen from the catalog below by id only. Do NOT invent paths. Pick 2-3 ids per candidate. Each reference id must come with a one-sentence note explaining why it grounds this specific candidate.',
    '6. embellishmentSeeds MUST be 3-5 short discrete on-theme ideas (4-12 words each) that the downstream variation expander can build on. Each entry stands alone — do not combine with "and". No vague adjectives.',
    '7. rationale MUST be one sentence explaining how this candidate\'s silhouette differs from the other candidates in the response.',
    '',
    `Allowed sprite types: ${SPRITE_TYPES.join(', ')}.`,
    '',
    'Reference catalog (id: contents):',
    referenceList,
    '',
  ];
  if (wantClassify) {
    lines.push(
      'CLASSIFICATION: the caller did not supply a type. In your response set `inferredType` to one of the allowed sprite types and `typeConfidence` to a number in [0,1] expressing how sure you are. If you are not at least 0.9 confident, still answer with your best guess and a low confidence — the caller will fail closed and ask the user for the type.',
    );
  } else {
    lines.push(
      `CLASSIFICATION: the caller supplied type='${request.type ?? ''}'. Set inferredType to null and typeConfidence to null.`,
    );
  }
  lines.push(
    '',
    'OUTPUT FORMAT: strict JSON object only. No prose, no markdown. Shape:',
    '{',
    '  "inferredType": "<sprite-type or null>",',
    '  "typeConfidence": <number 0..1 or null>,',
    '  "candidates": [',
    '    {',
    '      "description": "<concrete prose, 50-300 chars>",',
    '      "references": [{"id": "<catalog-id>", "note": "<one sentence>"}, ...],',
    '      "embellishmentSeeds": ["<idea1>", "<idea2>", ...],',
    '      "rationale": "<one sentence>"',
    '    }',
    '  ]',
    '}',
  );
  return lines.join('\n');
}

export function buildUserPrompt(request: SynthesizeBriefRequest): string {
  const typeLine =
    request.type === null ? 'SPRITE TYPE: <classify from the name>' : `SPRITE TYPE: ${request.type}`;
  return [
    `SUBJECT NAME: ${request.name}`,
    typeLine,
    `CANDIDATE COUNT: ${request.candidates}`,
    '',
    `Produce exactly ${request.candidates} candidate(s). Each must follow every hard rule in the system prompt.`,
  ].join('\n');
}

/**
 * Parse + lightly-validate the structured response. Heavy semantic
 * validation (banned adjectives, reference-id membership, file
 * existence) is the synthesizer's job — this function only confirms
 * the response is parseable JSON in the expected envelope so the
 * synthesizer doesn't have to deal with raw strings.
 */
function parseSynthResponse(
  content: string,
  request: SynthesizeBriefRequest,
): SynthesizeBriefResponse {
  const text = stripFences(content).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SynthProviderError(
      'malformed',
      `synthesizer response was not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `First 200 chars: ${truncate(text, 200)}`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SynthProviderError(
      'malformed',
      `synthesizer response top-level value must be an object, got ${typeof parsed}.`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const candidatesRaw = obj.candidates;
  if (!Array.isArray(candidatesRaw)) {
    throw new SynthProviderError(
      'malformed',
      'synthesizer response missing required `candidates` array.',
    );
  }
  if (candidatesRaw.length === 0) {
    throw new SynthProviderError(
      'malformed',
      'synthesizer response contained zero candidates. Retry or lower the candidate count.',
    );
  }
  const candidates: SynthesizedCandidate[] = candidatesRaw.map((c, idx) =>
    parseCandidate(c, idx),
  );
  const inferredType = parseInferredType(obj.inferredType);
  const typeConfidence = parseConfidence(obj.typeConfidence);
  // When the caller passed a type, ignore any classifier output the
  // model may have produced anyway — the user's choice is canonical.
  if (request.type !== null) {
    return { inferredType: null, typeConfidence: null, candidates };
  }
  return { inferredType, typeConfidence, candidates };
}

function parseCandidate(value: unknown, idx: number): SynthesizedCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SynthProviderError(
      'malformed',
      `candidates[${idx}] is not an object.`,
    );
  }
  const obj = value as Record<string, unknown>;
  const description = stringField(obj.description, `candidates[${idx}].description`);
  const rationale = stringField(obj.rationale, `candidates[${idx}].rationale`);
  const refsRaw = obj.references;
  if (!Array.isArray(refsRaw) || refsRaw.length === 0) {
    throw new SynthProviderError(
      'malformed',
      `candidates[${idx}].references must be a non-empty array.`,
    );
  }
  const references = refsRaw.map((r, j) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new SynthProviderError(
        'malformed',
        `candidates[${idx}].references[${j}] is not an object.`,
      );
    }
    const robj = r as Record<string, unknown>;
    const id = stringField(robj.id, `candidates[${idx}].references[${j}].id`);
    const note = stringField(robj.note, `candidates[${idx}].references[${j}].note`);
    return { id, note };
  });
  const seedsRaw = obj.embellishmentSeeds;
  if (!Array.isArray(seedsRaw)) {
    throw new SynthProviderError(
      'malformed',
      `candidates[${idx}].embellishmentSeeds must be an array.`,
    );
  }
  const embellishmentSeeds = seedsRaw.map((s, j) => {
    if (typeof s !== 'string' || s.trim().length === 0) {
      throw new SynthProviderError(
        'malformed',
        `candidates[${idx}].embellishmentSeeds[${j}] must be a non-empty string.`,
      );
    }
    return s.trim();
  });
  return { description, rationale, references, embellishmentSeeds };
}

function parseInferredType(value: unknown): SynthesizeBriefResponse['inferredType'] {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new SynthProviderError(
      'malformed',
      `inferredType must be a string or null, got ${typeof value}.`,
    );
  }
  const found = (SPRITE_TYPES as ReadonlyArray<string>).includes(value);
  if (!found) {
    throw new SynthProviderError(
      'malformed',
      `inferredType '${value}' is not one of ${SPRITE_TYPES.join(', ')}.`,
    );
  }
  return value as (typeof SPRITE_TYPES)[number];
}

function parseConfidence(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new SynthProviderError(
      'malformed',
      `typeConfidence must be a number in [0,1] or null, got ${String(value)}.`,
    );
  }
  return value;
}

function stringField(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SynthProviderError('malformed', `${path} must be a non-empty string.`);
  }
  return value.trim();
}

function stripFences(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1];
  return content;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function httpStatusToKind(status: number): SynthProviderErrorKind {
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
