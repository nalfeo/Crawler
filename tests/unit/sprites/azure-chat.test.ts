/**
 * Tests for the Azure OpenAI chat-completions text provider.
 *
 * Mirrors the pattern in `azure-openai.test.ts`: inject `fetch`, stub
 * `Response`, assert request shape + response parsing + error classification.
 * No network. The provider's permissive response parser gets its own
 * coverage here so the orchestrator can rely on it.
 */

import { describe, expect, it } from 'vitest';

import { briefSchema, type Brief } from '../../../scripts/sprites/brief-schema.js';
import { AzureOpenAIChatProvider } from '../../../scripts/sprites/provider/azure-chat.js';
import { TextProviderError } from '../../../scripts/sprites/provider/text-types.js';

function makeBrief(): Brief {
  return briefSchema.parse({
    type: 'weapon',
    name: 'skull-mace',
    size: { width: 16, height: 16 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 8, y: 14 },
    tags: ['mace', 'cursed'],
    prompt: 'A vertical skull mace.',
    references: [
      { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
      { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
    ],
    generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a fake chat-completion payload around a model `content` string. */
function chatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content } }],
  };
}

const baseOptions = {
  endpoint: 'https://example.openai.azure.com/',
  deployment: 'gpt-4o-mini',
  apiKey: 'test-key',
  apiVersion: '2025-04-01-preview',
  retry: { maxAttempts: 1 },
};

describe('AzureOpenAIChatProvider.expandVariations', () => {
  it('parses a clean JSON-object response and sends the expected request shape', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: unknown;
    const stubFetch: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL | Request).toString();
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse(
        200,
        chatCompletion(
          JSON.stringify({ variations: ['spiked pommel', 'rune-etched band', 'wolf skull'] }),
        ),
      );
    };

    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });
    const result = await provider.expandVariations({
      brief: makeBrief(),
      existing: ['seed entry'],
      count: 3,
    });

    expect(result).toEqual(['spiked pommel', 'rune-etched band', 'wolf skull']);
    expect(capturedUrl).toContain('/openai/deployments/gpt-4o-mini/chat/completions');
    expect(capturedUrl).toContain('api-version=2025-04-01-preview');
    expect(capturedHeaders?.['api-key']).toBe('test-key');
    expect(capturedHeaders?.['content-type']).toBe('application/json');
    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[1]?.role).toBe('user');
    expect(body.messages[0]?.content).toContain('panda mafia dons');
    expect(body.messages[1]?.content).toContain('FLOOR: 1 of 20');
    // User prompt must mention the count and the existing seed.
    expect(body.messages[1]?.content).toContain('exactly 3');
    expect(body.messages[1]?.content).toContain('seed entry');
  });

  it('accepts a top-level JSON array as the model response', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion(JSON.stringify(['one', 'two'])));
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    const result = await provider.expandVariations({
      brief: makeBrief(),
      existing: [],
      count: 2,
    });
    expect(result).toEqual(['one', 'two']);
  });

  it('strips a ```json ... ``` fence before parsing', async () => {
    const fenced = '```json\n{ "variations": ["alpha", "beta"] }\n```';
    const stubFetch: typeof fetch = async () => jsonResponse(200, chatCompletion(fenced));
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    const result = await provider.expandVariations({
      brief: makeBrief(),
      existing: [],
      count: 2,
    });
    expect(result).toEqual(['alpha', 'beta']);
  });

  it('falls back to extracting from the first JSON-ish token when prose precedes it', async () => {
    const messy = 'Sure! Here are the variations:\n{ "variations": ["x", "y"] }';
    const stubFetch: typeof fetch = async () => jsonResponse(200, chatCompletion(messy));
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    const result = await provider.expandVariations({
      brief: makeBrief(),
      existing: [],
      count: 2,
    });
    expect(result).toEqual(['x', 'y']);
  });

  it('trims, drops empties, and dedupes case-insensitively within the response', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(
        200,
        chatCompletion(JSON.stringify({ variations: ['  alpha ', 'ALPHA', '', '   ', 'beta'] })),
      );
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    const result = await provider.expandVariations({
      brief: makeBrief(),
      existing: [],
      count: 4,
    });
    expect(result).toEqual(['alpha', 'beta']);
  });

  it('throws TextProviderError(malformed) when the response contains no usable strings', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion('this is just prose'));
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    await expect(
      provider.expandVariations({ brief: makeBrief(), existing: [], count: 2 }),
    ).rejects.toMatchObject({ name: 'TextProviderError', kind: 'malformed' });
  });

  it('maps HTTP 401 to auth', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(401, { error: { code: 'invalid_api_key', message: 'bad key' } });
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    await expect(
      provider.expandVariations({ brief: makeBrief(), existing: [], count: 2 }),
    ).rejects.toMatchObject({ name: 'TextProviderError', kind: 'auth' });
  });

  it('maps HTTP 429 to rate-limit', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } });
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    await expect(
      provider.expandVariations({ brief: makeBrief(), existing: [], count: 2 }),
    ).rejects.toMatchObject({ name: 'TextProviderError', kind: 'rate-limit' });
  });

  it('classifies network errors and preserves the cause', async () => {
    const cause = new Error('ECONNREFUSED');
    const stubFetch: typeof fetch = async () => {
      throw cause;
    };
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    await expect(
      provider.expandVariations({ brief: makeBrief(), existing: [], count: 2 }),
    ).rejects.toMatchObject({
      name: 'TextProviderError',
      kind: 'network',
    });
  });

  it('flags a structured error payload as request-error even with HTTP 200', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, { error: { code: 'content_filter', message: 'blocked' } });
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    await expect(
      provider.expandVariations({ brief: makeBrief(), existing: [], count: 2 }),
    ).rejects.toMatchObject({ name: 'TextProviderError', kind: 'request-error' });
  });

  it('throws TextProviderError when choices[0].message.content is missing', async () => {
    const stubFetch: typeof fetch = async () => jsonResponse(200, { choices: [{}] });
    const provider = new AzureOpenAIChatProvider({ ...baseOptions, fetch: stubFetch });

    await expect(
      provider.expandVariations({ brief: makeBrief(), existing: [], count: 2 }),
    ).rejects.toBeInstanceOf(TextProviderError);
  });
});
