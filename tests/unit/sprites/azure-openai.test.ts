/**
 * Tests for the Azure OpenAI image provider.
 *
 * The provider takes an injected `fetch`, so we never touch the network.
 * Each test stubs a `Response` and asserts the request shape, error
 * classification, and PNG decoding.
 */

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { AzureOpenAIImageProvider } from '../../../scripts/sprites/provider/azure-openai.js';
import { ProviderError } from '../../../scripts/sprites/provider/types.js';
import { createImageProvider } from '../../../scripts/sprites/provider/factory.js';
import { briefSchema, type Brief } from '../../../scripts/sprites/brief-schema.js';

function makeBrief(): Brief {
  return briefSchema.parse({
    type: 'weapon',
    name: 'iron-sword',
    size: { width: 16, height: 16 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 8, y: 8 },
    tags: ['sword'],
    prompt: 'iron sword',
    references: [
      { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
      { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
    ],
  });
}

function encodeSolidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AzureOpenAIImageProvider.generateSheet', () => {
  const provider = (fetchImpl: typeof fetch): AzureOpenAIImageProvider =>
    new AzureOpenAIImageProvider({
      endpoint: 'https://example.openai.azure.com/',
      deployment: 'gpt-image-1',
      apiKey: 'test-key',
      apiVersion: '2025-04-01-preview',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

  it('decodes a base64 PNG from data[0].b64_json and returns the buffer', async () => {
    const png = encodeSolidPng(32, 32);
    let capturedUrl: string | undefined;
    let capturedHeaders: HeadersInit | undefined;
    const stubFetch: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL | Request).toString();
      capturedHeaders = init?.headers;
      return jsonResponse(200, { data: [{ b64_json: png.toString('base64') }] });
    };
    const out = await provider(stubFetch).generateSheet({
      brief: makeBrief(),
      prompt: 'test',
      referencePngs: [encodeSolidPng(2, 2)],
      variants: 9,
    });
    expect(out.equals(png)).toBe(true);
    expect(capturedUrl).toContain('/openai/deployments/gpt-image-1/images/edits');
    expect(capturedUrl).toContain('api-version=2025-04-01-preview');
    // api-key header is what Azure expects, not Bearer.
    const headersObj = capturedHeaders as Record<string, string>;
    expect(headersObj['api-key']).toBe('test-key');
  });

  it('classifies HTTP 401 as ProviderError(auth)', async () => {
    const stubFetch: typeof fetch = async () => new Response('unauthorized', { status: 401 });
    await expect(
      provider(stubFetch).generateSheet({
        brief: makeBrief(),
        prompt: 'p',
        referencePngs: [encodeSolidPng(2, 2)],
        variants: 9,
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('classifies HTTP 429 as ProviderError(rate-limit)', async () => {
    const stubFetch: typeof fetch = async () =>
      new Response('slow down', { status: 429, headers: { 'retry-after-ms': '250' } });
    await expect(
      provider(stubFetch).generateSheet({
        brief: makeBrief(),
        prompt: 'p',
        referencePngs: [encodeSolidPng(2, 2)],
        variants: 9,
      }),
    ).rejects.toMatchObject({ kind: 'rate-limit', retryAfterMs: 250 });
  });

  it('classifies HTTP 500 as ProviderError(server-error)', async () => {
    const stubFetch: typeof fetch = async () => new Response('boom', { status: 500 });
    await expect(
      provider(stubFetch).generateSheet({
        brief: makeBrief(),
        prompt: 'p',
        referencePngs: [encodeSolidPng(2, 2)],
        variants: 9,
      }),
    ).rejects.toMatchObject({ kind: 'server-error' });
  });

  it('classifies a thrown fetch as ProviderError(network)', async () => {
    const stubFetch: typeof fetch = async () => {
      throw new Error('socket hangup');
    };
    await expect(
      provider(stubFetch).generateSheet({
        brief: makeBrief(),
        prompt: 'p',
        referencePngs: [encodeSolidPng(2, 2)],
        variants: 9,
      }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('classifies an AbortSignal.timeout abort as ProviderError(network) with a "timed out" message', async () => {
    // Simulate what `fetch` throws when its AbortSignal.timeout fires.
    const stubFetch: typeof fetch = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    };
    const timed = new AzureOpenAIImageProvider({
      endpoint: 'https://example.openai.azure.com/',
      deployment: 'gpt-image-1',
      apiKey: 'test-key',
      apiVersion: '2025-04-01-preview',
      timeoutMs: 1234,
      fetch: stubFetch,
      retry: { maxAttempts: 1 },
    });
    await expect(
      timed.generateSheet({
        brief: makeBrief(),
        prompt: 'p',
        referencePngs: [encodeSolidPng(2, 2)],
        variants: 9,
      }),
    ).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('timed out') });
  });

  it('classifies an undecodable PNG body as ProviderError(non-png)', async () => {
    const stubFetch: typeof fetch = async () =>
      jsonResponse(200, { data: [{ b64_json: Buffer.from('not a png').toString('base64') }] });
    await expect(
      provider(stubFetch).generateSheet({
        brief: makeBrief(),
        prompt: 'p',
        referencePngs: [encodeSolidPng(2, 2)],
        variants: 9,
      }),
    ).rejects.toMatchObject({ kind: 'non-png' });
  });

  it('classifies a missing data[0].b64_json as ProviderError(non-png)', async () => {
    const stubFetch: typeof fetch = async () => jsonResponse(200, { data: [] });
    await expect(
      provider(stubFetch).generateSheet({
        brief: makeBrief(),
        prompt: 'p',
        referencePngs: [encodeSolidPng(2, 2)],
        variants: 9,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('sends prompt, size, n, and response_format as multipart fields', async () => {
    const png = encodeSolidPng(8, 8);
    let body: BodyInit | null | undefined;
    const stubFetch: typeof fetch = async (_url, init) => {
      body = init?.body;
      return jsonResponse(200, { data: [{ b64_json: png.toString('base64') }] });
    };
    await provider(stubFetch).generateSheet({
      brief: makeBrief(),
      prompt: 'A test sheet prompt',
      referencePngs: [encodeSolidPng(2, 2), encodeSolidPng(2, 2)],
      variants: 9,
      size: 256,
    });
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('prompt')).toBe('A test sheet prompt');
    expect(form.get('size')).toBe('256x256');
    expect(form.get('n')).toBe('1');
    // gpt-image-1 always returns base64 and rejects `response_format`; we
    // must NOT send the field. (dall-e-3 required it; gpt-image-1 errors on it.)
    expect(form.has('response_format')).toBe(false);
    expect(form.getAll('image[]')).toHaveLength(2);
  });
});

describe('createImageProvider (factory)', () => {
  it('throws a clear error when AZURE_OPENAI_ENDPOINT is missing', () => {
    expect(() => createImageProvider({ env: { AZURE_OPENAI_API_KEY: 'x' } })).toThrow(
      /AZURE_OPENAI_ENDPOINT/,
    );
  });

  it('throws a clear error when AZURE_OPENAI_API_KEY is missing', () => {
    expect(() =>
      createImageProvider({ env: { AZURE_OPENAI_ENDPOINT: 'https://example.com' } }),
    ).toThrow(/AZURE_OPENAI_API_KEY/);
  });

  it('builds an Azure provider with sensible defaults', () => {
    const p = createImageProvider({
      env: {
        AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
        AZURE_OPENAI_API_KEY: 'k',
      },
    });
    expect(p).toBeInstanceOf(AzureOpenAIImageProvider);
  });

  it('rejects an unknown SPRITES_PROVIDER value', () => {
    expect(() =>
      createImageProvider({
        env: {
          SPRITES_PROVIDER: 'imaginary',
          AZURE_OPENAI_ENDPOINT: 'https://example.com',
          AZURE_OPENAI_API_KEY: 'k',
        },
      }),
    ).toThrow(/Unknown SPRITES_PROVIDER/);
  });
});
