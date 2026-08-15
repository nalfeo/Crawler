/**
 * Tests for the Azure OpenAI vision provider used by the VLM judge.
 *
 * Mirrors `azure-chat.test.ts`: inject `fetch`, stub `Response`, assert
 * request shape + response parsing + each error kind. No network.
 *
 * Cross-checks against `azure-vision.ts`:
 *   - URL contains the vision deployment + api-version
 *   - Headers include the api-key and JSON content-type
 *   - Body contains a system + user message; user content is an array
 *     with the text part plus `image_url` parts using base64 `data:` URLs
 *     with `detail: 'high'`
 *   - `response_format: { type: 'json_object' }` is requested
 *   - Each HTTP failure mode maps to the right typed kind
 */

import { describe, expect, it } from 'vitest';

import { AzureOpenAIVisionProvider } from '../../../scripts/sprites/provider/azure-vision.js';
import {
  VisionProviderError,
  type EvaluateRequest,
} from '../../../scripts/sprites/provider/vision-types.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatCompletion(content: string, usage?: Record<string, number>): unknown {
  return {
    id: 'chatcmpl-vision-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    ...(usage ? { usage } : {}),
  };
}

const baseOptions = {
  endpoint: 'https://example.openai.azure.com/',
  deployment: 'gpt-4o-vision',
  apiKey: 'test-key',
  apiVersion: '2025-04-01-preview',
  retry: { maxAttempts: 1 },
};

function fakeRequest(): EvaluateRequest {
  return {
    systemInstructions: 'You are a strict judge. Return JSON.',
    userPrompt: 'Evaluate the candidate.',
    images: [
      { png: Buffer.from([0xde, 0xad, 0xbe, 0xef]), label: 'candidate' },
      { png: Buffer.from([0x00, 0x11]), label: 'reference-1' },
    ],
  };
}

describe('AzureOpenAIVisionProvider.evaluate', () => {
  it('sends the expected request shape and parses a clean JSON-object response', async () => {
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
          JSON.stringify({
            style_match: { score: 5, rationale: 'matches' },
            brief_match: { score: 4, rationale: 'on target' },
            readability: { score: 5, rationale: 'pops' },
          }),
          { prompt_tokens: 1234, completion_tokens: 87, total_tokens: 1321 },
        ),
      );
    };

    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    const result = await provider.evaluate(fakeRequest());

    expect(result.modelDeployment).toBe('gpt-4o-vision');
    expect(result.usage).toEqual({ promptTokens: 1234, completionTokens: 87, totalTokens: 1321 });
    expect(result.json).toMatchObject({
      style_match: { score: 5, rationale: 'matches' },
      brief_match: { score: 4 },
      readability: { score: 5 },
    });

    expect(capturedUrl).toContain('/openai/deployments/gpt-4o-vision/chat/completions');
    expect(capturedUrl).toContain('api-version=2025-04-01-preview');
    expect(capturedHeaders?.['api-key']).toBe('test-key');
    expect(capturedHeaders?.['content-type']).toBe('application/json');

    const body = capturedBody as {
      messages: Array<{ role: string; content: unknown }>;
      response_format: { type: string };
      temperature: number;
      max_tokens: number;
    };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(800);
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('strict judge');
    expect(body.messages[1]?.role).toBe('user');

    const userParts = body.messages[1]?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string; detail: string };
    }>;
    expect(userParts).toHaveLength(3);
    expect(userParts[0]).toEqual({ type: 'text', text: 'Evaluate the candidate.' });
    expect(userParts[1]?.type).toBe('image_url');
    expect(userParts[1]?.image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64')}`,
    );
    expect(userParts[1]?.image_url?.detail).toBe('high');
    expect(userParts[2]?.type).toBe('image_url');
  });

  it('honours caller temperature and max_tokens overrides', async () => {
    let capturedBody: { temperature: number; max_tokens: number } | undefined;
    const stubFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse(200, chatCompletion(JSON.stringify({ ok: true })));
    };
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await provider.evaluate({ ...fakeRequest(), temperature: 0.4, maxTokens: 1500 });
    expect(capturedBody?.temperature).toBe(0.4);
    expect(capturedBody?.max_tokens).toBe(1500);
  });

  it('preserves the supplied screenshot MIME type in the image data URL', async () => {
    let capturedBody: { messages: Array<{ content: unknown }> } | undefined;
    const stubFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse(200, chatCompletion(JSON.stringify({ ok: true })));
    };
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await provider.evaluate({
      ...fakeRequest(),
      images: [
        { label: 'jpeg-screenshot', png: Buffer.from([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' },
      ],
    });
    const parts = capturedBody?.messages[1]?.content as Array<{ image_url?: { url: string } }>;
    expect(parts[1]?.image_url?.url).toBe(
      `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`,
    );
  });

  it('strips a ```json ... ``` fence before parsing', async () => {
    const fenced = '```json\n{ "style_match": { "score": 3, "rationale": "x" } }\n```';
    const stubFetch: typeof fetch = async () => jsonResponse(200, chatCompletion(fenced));
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    const result = await provider.evaluate(fakeRequest());
    expect(result.json).toEqual({ style_match: { score: 3, rationale: 'x' } });
  });

  it('falls back to extracting from the first { when prose precedes JSON', async () => {
    const messy = 'Sure! Here are the scores:\n{ "a": 1 }';
    const stubFetch: typeof fetch = async () => jsonResponse(200, chatCompletion(messy));
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    const result = await provider.evaluate(fakeRequest());
    expect(result.json).toEqual({ a: 1 });
  });

  it('throws malformed when content has no JSON object', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion('this is just prose, sorry'));
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({
      name: 'VisionProviderError',
      kind: 'malformed',
    });
  });

  it('throws malformed when content is a JSON array, not an object', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion(JSON.stringify([1, 2, 3])));
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({
      name: 'VisionProviderError',
      kind: 'malformed',
    });
  });

  it('throws malformed when message.content is missing', async () => {
    const stubFetch: typeof fetch = async () => jsonResponse(200, { choices: [{}] });
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({
      name: 'VisionProviderError',
      kind: 'malformed',
    });
  });

  it('maps HTTP 401 to auth', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(401, { error: { code: 'invalid_api_key', message: 'bad key' } });
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({
      name: 'VisionProviderError',
      kind: 'auth',
    });
  });

  it('maps HTTP 403 to auth', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(403, { error: { code: 'forbidden', message: 'no' } });
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps HTTP 429 to rate-limit', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } });
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('classifies network errors with preserved cause', async () => {
    const cause = new Error('ECONNRESET');
    const stubFetch: typeof fetch = async () => {
      throw cause;
    };
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({
      name: 'VisionProviderError',
      kind: 'network',
    });
  });

  it('flags a structured error payload as request-error even with HTTP 200', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, { error: { code: 'content_filter', message: 'blocked' } });
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toBeInstanceOf(VisionProviderError);
    await expect(provider.evaluate(fakeRequest())).rejects.toMatchObject({
      kind: 'request-error',
    });
  });

  it('honors an explicit single-attempt retry policy', async () => {
    let callCount = 0;
    const stubFetch: typeof fetch = async () => {
      callCount++;
      throw new Error('boom');
    };
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    await expect(provider.evaluate(fakeRequest())).rejects.toThrow();
    expect(callCount).toBe(1);
  });

  it('returns usage as null when payload omits it', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, chatCompletion(JSON.stringify({ ok: true })));
    const provider = new AzureOpenAIVisionProvider({ ...baseOptions, fetch: stubFetch });
    const result = await provider.evaluate(fakeRequest());
    expect(result.usage).toBeNull();
  });
});
