/**
 * Tests for the enrich-tags LLM provider and response parser.
 *
 * Follows the pattern in `azure-chat.test.ts`: inject `fetch`, assert request
 * shape and response parsing, cover error classification and the 5–15 tag
 * cardinality contract.  No network calls.
 */

import { describe, expect, it } from 'vitest';

import {
  AzureEnrichTagsProvider,
  buildUserPrompt,
  parseTagsResponse,
  MIN_TAGS,
  MAX_TAGS,
  TextProviderError,
  type EnrichTagsRequest,
} from '../../../scripts/sprites/enrich-tags.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content } }],
  };
}

/** Build a valid 5-tag response JSON string. */
function tagsJson(tags: string[]): string {
  return JSON.stringify({ tags });
}

function makeRequest(overrides: Partial<EnrichTagsRequest> = {}): EnrichTagsRequest {
  return {
    manifestKey: 'anvil-v1-var-0',
    type: 'prop',
    description: 'A sturdy iron anvil with a flat striking surface.',
    briefId: 'anvil-v1',
    ...overrides,
  };
}

const baseOptions = {
  endpoint: 'https://test.openai.azure.com/',
  deployment: 'gpt-4o',
  apiKey: 'test-key',
  apiVersion: '2025-04-01-preview',
  retry: { maxAttempts: 1 },
};

const MIN_VALID_TAGS = Array.from({ length: MIN_TAGS }, (_, i) => `tag-${i + 1}`);
const MAX_VALID_TAGS = Array.from({ length: MAX_TAGS }, (_, i) => `tag-${i + 1}`);
const TOO_MANY_TAGS = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `tag-${i + 1}`);

// ---------------------------------------------------------------------------
// buildUserPrompt
// ---------------------------------------------------------------------------

describe('buildUserPrompt', () => {
  it('includes the manifest key', () => {
    expect(buildUserPrompt(makeRequest())).toContain('anvil-v1-var-0');
  });

  it('includes the type when present', () => {
    expect(buildUserPrompt(makeRequest({ type: 'prop' }))).toContain('prop');
  });

  it('omits type field when type is null', () => {
    const prompt = buildUserPrompt(makeRequest({ type: null }));
    expect(prompt).not.toContain('type=');
  });

  it('includes description up to 300 chars', () => {
    const longDesc = 'x'.repeat(400);
    const prompt = buildUserPrompt(makeRequest({ description: longDesc }));
    expect(prompt).toContain('x'.repeat(300));
    expect(prompt).not.toContain('x'.repeat(301));
  });
});

// ---------------------------------------------------------------------------
// parseTagsResponse
// ---------------------------------------------------------------------------

describe('parseTagsResponse', () => {
  it('parses a clean JSON-object response', () => {
    const result = parseTagsResponse(tagsJson(MIN_VALID_TAGS));
    expect(result).toEqual(MIN_VALID_TAGS);
  });

  it('accepts a bare JSON array', () => {
    expect(parseTagsResponse(JSON.stringify(MIN_VALID_TAGS))).toEqual(MIN_VALID_TAGS);
  });

  it('strips markdown fences before parsing', () => {
    const fenced = '```json\n' + tagsJson(MIN_VALID_TAGS) + '\n```';
    expect(parseTagsResponse(fenced)).toEqual(MIN_VALID_TAGS);
  });

  it('extracts JSON when prose precedes it', () => {
    const messy = 'Sure! Here are the tags:\n' + tagsJson(MIN_VALID_TAGS);
    expect(parseTagsResponse(messy)).toEqual(MIN_VALID_TAGS);
  });

  it('lowercases tags and replaces spaces with hyphens', () => {
    const result = parseTagsResponse(JSON.stringify({ tags: ['Iron Anvil', 'Heavy Forge'] }));
    expect(result).toContain('iron-anvil');
    expect(result).toContain('heavy-forge');
  });

  it('deduplicates tags', () => {
    const result = parseTagsResponse(JSON.stringify({ tags: ['iron', 'iron', 'stone'] }));
    expect(result.filter((t) => t === 'iron')).toHaveLength(1);
  });

  it('drops tags that do not match allowed grammar (punctuation etc.)', () => {
    const result = parseTagsResponse(JSON.stringify({ tags: ['iron!', 'stone', 'ok_tag'] }));
    expect(result).not.toContain('iron!');
    expect(result).not.toContain('ok_tag'); // underscore not allowed
    expect(result).toContain('stone');
  });

  it('drops tags longer than 50 chars', () => {
    const longTag = 'a'.repeat(51);
    const result = parseTagsResponse(JSON.stringify({ tags: [longTag, 'short'] }));
    expect(result).not.toContain(longTag);
    expect(result).toContain('short');
  });

  it('returns empty array for pure prose', () => {
    expect(parseTagsResponse('Here are some tags for you!')).toHaveLength(0);
  });

  it('returns empty array for an empty tags array', () => {
    expect(parseTagsResponse(JSON.stringify({ tags: [] }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AzureEnrichTagsProvider — request shape
// ---------------------------------------------------------------------------

describe('AzureEnrichTagsProvider.generateTags — request shape', () => {
  it('sends the correct URL, headers, and JSON body', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: unknown;

    const stubFetch: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse(200, chatCompletion(tagsJson(MIN_VALID_TAGS)));
    };

    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });
    await provider.generateTags(makeRequest());

    expect(capturedUrl).toContain('/openai/deployments/gpt-4o/chat/completions');
    expect(capturedUrl).toContain('api-version=2025-04-01-preview');
    expect(capturedHeaders?.['api-key']).toBe('test-key');
    expect(capturedHeaders?.['content-type']).toBe('application/json');

    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[1]?.role).toBe('user');
    expect(body.messages[1]?.content).toContain('anvil-v1-var-0');
  });
});

// ---------------------------------------------------------------------------
// AzureEnrichTagsProvider — response parsing
// ---------------------------------------------------------------------------

describe('AzureEnrichTagsProvider.generateTags — response parsing', () => {
  it('returns exactly the parsed tags on a happy-path response', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion(tagsJson(MIN_VALID_TAGS)));
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    const result = await provider.generateTags(makeRequest());
    expect(result).toEqual(MIN_VALID_TAGS);
  });

  it('caps the result at MAX_TAGS even when the model returns more', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion(tagsJson(TOO_MANY_TAGS)));
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    const result = await provider.generateTags(makeRequest());
    expect(result).toHaveLength(MAX_TAGS);
    expect(result).toEqual(MAX_VALID_TAGS);
  });

  it('throws TextProviderError(malformed) when fewer than MIN_TAGS valid tags are returned', async () => {
    const fewTags = Array.from({ length: MIN_TAGS - 1 }, (_, i) => `tag-${i}`);
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion(tagsJson(fewTags)));
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'malformed',
    });
  });

  it('throws TextProviderError(malformed) when the response has no usable tags', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion('just some prose'));
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'malformed',
    });
  });

  it('throws TextProviderError(malformed) when choices[0].message.content is missing', async () => {
    const stubFetch: typeof fetch = async () => jsonResponse(200, { choices: [{ message: {} }] });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'malformed',
    });
  });

  it('throws TextProviderError(malformed) on non-JSON response body', async () => {
    const stubFetch: typeof fetch = async () => new Response('not json at all', { status: 200 });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'malformed',
    });
  });

  it('throws TextProviderError(request-error) for a structured error payload', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, { error: { code: 'content_filter', message: 'filtered' } });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'request-error',
    });
  });
});

// ---------------------------------------------------------------------------
// AzureEnrichTagsProvider — HTTP error mapping
// ---------------------------------------------------------------------------

describe('AzureEnrichTagsProvider.generateTags — HTTP errors', () => {
  it('maps HTTP 401 to auth', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(401, { error: { code: 'invalid_api_key', message: 'bad key' } });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'auth',
    });
  });

  it('maps HTTP 403 to auth', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(403, { error: { code: 'forbidden', message: 'no access' } });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'auth',
    });
  });

  it('maps HTTP 429 to rate-limit', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'rate-limit',
    });
  });

  it('maps HTTP 500 to server-error', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(500, { error: { code: 'internal_server_error', message: 'oops' } });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'server-error',
    });
  });

  it('maps HTTP 400 to request-error', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(400, { error: { code: 'bad_request', message: 'invalid params' } });
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    await expect(provider.generateTags(makeRequest())).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'request-error',
    });
  });
});

// ---------------------------------------------------------------------------
// AzureEnrichTagsProvider — network errors
// ---------------------------------------------------------------------------

describe('AzureEnrichTagsProvider.generateTags — network errors', () => {
  it('classifies network errors and preserves the cause', async () => {
    const cause = new Error('ECONNREFUSED');
    const stubFetch: typeof fetch = async () => {
      throw cause;
    };
    const provider = new AzureEnrichTagsProvider({ ...baseOptions, fetch: stubFetch });

    const err = await provider.generateTags(makeRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(TextProviderError);
    expect(err.kind).toBe('network');
    expect(err.cause).toBe(cause);
  });
});
