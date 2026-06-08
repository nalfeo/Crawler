/**
 * Unit tests for the engine-side preload helpers.
 *
 * Targets `fetchGeneratedSpriteRegistry` (soft-fail fetch + parse) and
 * `preloadGeneratedSprites` (Phaser-loader glue). Both are tested via
 * injected dependencies so no Phaser instance or network is required.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fetchGeneratedSpriteRegistry,
  preloadGeneratedSprites,
} from '../../src/engine/generatedAssets/index.js';
import {
  buildGeneratedSpriteRegistry,
  emptyGeneratedSpriteRegistry,
  GENERATED_MANIFEST_VERSION,
} from '../../src/shared/generated-assets.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function makeEntry(briefId: string): Record<string, unknown> {
  return {
    briefId,
    spriteName: briefId,
    assetPath: `generated/${briefId}.png`,
    approvedAt: '2026-06-08T15:30:00.000Z',
    sourceRun: `generated/runs/${briefId}/2026-06-08T12-00-00-deadbeef`,
    variantIndex: 0,
    anchor: { x: 8, y: 13, source: 'brief' },
    sensorScore: '7/7',
    judgeScore: null,
  };
}

describe('fetchGeneratedSpriteRegistry', () => {
  it('returns an empty registry on 404 without logging an error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/manifest.json',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(registry.size).toBe(0);
    expect(fetcher).toHaveBeenCalledWith('/manifest.json');
  });

  it('returns a populated registry on a valid manifest fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        version: GENERATED_MANIFEST_VERSION,
        entries: { 'iron-sword': makeEntry('iron-sword') },
      }),
    );
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/m.json',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(registry.size).toBe(1);
    expect(registry.lookup('iron-sword')?.textureKey).toBe('iron-sword');
  });

  it('returns an empty registry when the fetch itself rejects', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/m.json',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(registry.size).toBe(0);
  });

  it('returns an empty registry when the response body is not JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('not json at all', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/m.json',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(registry.size).toBe(0);
  });

  it('returns an empty registry when the manifest schema is malformed', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ version: 99, entries: 'not-an-object' }));
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/m.json',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(registry.size).toBe(0);
  });

  it('returns an empty registry when no fetch implementation is available', async () => {
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/m.json',
      fetcher: undefined,
    });
    expect(registry.size).toBe(0);
  });
});

describe('preloadGeneratedSprites', () => {
  it('does nothing for an empty registry', () => {
    const image = vi.fn();
    const queued = preloadGeneratedSprites({ image }, emptyGeneratedSpriteRegistry());
    expect(image).not.toHaveBeenCalled();
    expect(queued).toEqual([]);
  });

  it('queues one image per entry with a public/-resolved URL', () => {
    const image = vi.fn();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'iron-sword': makeEntry('iron-sword'),
        'throwing-star': makeEntry('throwing-star'),
      },
    });
    const queued = preloadGeneratedSprites({ image }, registry);
    expect(image).toHaveBeenCalledTimes(2);
    expect(image).toHaveBeenCalledWith('iron-sword', '/assets/generated/iron-sword.png');
    expect(image).toHaveBeenCalledWith('throwing-star', '/assets/generated/throwing-star.png');
    expect(queued).toEqual([
      { textureKey: 'iron-sword', url: '/assets/generated/iron-sword.png' },
      { textureKey: 'throwing-star', url: '/assets/generated/throwing-star.png' },
    ]);
  });

  it('honours a custom assets base URL (e.g. for Vite base path)', () => {
    const image = vi.fn();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': makeEntry('iron-sword') },
    });
    preloadGeneratedSprites({ image }, registry, { assetsBaseUrl: '/crawler/assets' });
    expect(image).toHaveBeenCalledWith('iron-sword', '/crawler/assets/generated/iron-sword.png');
  });

  it('skips duplicate texture keys within a single call', () => {
    const image = vi.fn();
    const dupe = makeEntry('iron-sword');
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'iron-sword': dupe,
        // Second entry with a different briefId but identical spriteName
        'iron-sword-bis': { ...dupe, briefId: 'iron-sword-bis' },
      },
    });
    preloadGeneratedSprites({ image }, registry);
    expect(image).toHaveBeenCalledTimes(1);
  });
});
