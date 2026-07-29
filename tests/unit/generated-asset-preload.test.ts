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
  resolvePublicAssetUrl,
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
  it('resolves public asset URLs under a Pages base path', () => {
    expect(resolvePublicAssetUrl('assets/generated/manifest.json', '/Crawler/')).toBe(
      '/Crawler/assets/generated/manifest.json',
    );
    expect(resolvePublicAssetUrl('/assets/generated/iron-sword.png', '/Crawler/dev/')).toBe(
      '/Crawler/dev/assets/generated/iron-sword.png',
    );
  });

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
      { textureKey: 'iron-sword', url: '/assets/generated/iron-sword.png', kind: 'image' },
      { textureKey: 'throwing-star', url: '/assets/generated/throwing-star.png', kind: 'image' },
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

  it('queues every approved variant of a brief on its own texture key', () => {
    const image = vi.fn();
    const v1 = makeEntry('skull-mace');
    const v2 = makeEntry('skull-mace');
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        // Both variants share briefId + spriteName (legacy shape) but have
        // distinct map keys + asset paths. The preloader must queue BOTH.
        'skull-mace-var-1': { ...v1, assetPath: 'generated/skull-mace-var-1.png', variantIndex: 1 },
        'skull-mace-var-2': { ...v2, assetPath: 'generated/skull-mace-var-2.png', variantIndex: 2 },
      },
    });
    const queued = preloadGeneratedSprites({ image }, registry);
    expect(image).toHaveBeenCalledTimes(2);
    expect(queued.map((q) => q.textureKey).sort()).toEqual([
      'skull-mace-var-1',
      'skull-mace-var-2',
    ]);
    expect(image).toHaveBeenCalledWith(
      'skull-mace-var-1',
      '/assets/generated/skull-mace-var-1.png',
    );
    expect(image).toHaveBeenCalledWith(
      'skull-mace-var-2',
      '/assets/generated/skull-mace-var-2.png',
    );
  });

  it('routes an entry with an animation descriptor through loader.spritesheet', () => {
    const image = vi.fn();
    const spritesheet = vi.fn();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-v1-var-0': {
          ...makeEntry('player-walk-v1'),
          assetPath: 'generated/player-walk-v1-var-0.png',
          animation: { frameWidth: 16, frameHeight: 16, frameCount: 3, frameRate: 6, loop: true },
        },
      },
    });
    const queued = preloadGeneratedSprites({ image, spritesheet }, registry);
    expect(spritesheet).toHaveBeenCalledTimes(1);
    expect(spritesheet).toHaveBeenCalledWith(
      'player-walk-v1-var-0',
      '/assets/generated/player-walk-v1-var-0.png',
      { frameWidth: 16, frameHeight: 16 },
    );
    expect(image).not.toHaveBeenCalled();
    expect(queued).toEqual([
      {
        textureKey: 'player-walk-v1-var-0',
        url: '/assets/generated/player-walk-v1-var-0.png',
        kind: 'spritesheet',
      },
    ]);
  });

  it('falls back to loader.image for an animated entry when spritesheet() is unavailable', () => {
    const image = vi.fn();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-v1-var-0': {
          ...makeEntry('player-walk-v1'),
          assetPath: 'generated/player-walk-v1-var-0.png',
          animation: { frameWidth: 16, frameHeight: 16, frameCount: 3, frameRate: 6, loop: true },
        },
      },
    });
    // Fake loader only implements image() — the defensive guard must still work.
    const queued = preloadGeneratedSprites({ image }, registry);
    expect(image).toHaveBeenCalledTimes(1);
    expect(queued).toEqual([
      {
        textureKey: 'player-walk-v1-var-0',
        url: '/assets/generated/player-walk-v1-var-0.png',
        kind: 'image',
      },
    ]);
  });

  it('skips duplicate texture keys within a single call', () => {
    const image = vi.fn();
    // textureKeys are unique per variant in real manifests, but the loader's
    // de-dupe guard is defensive. Drive it with a hand-built registry whose
    // entries() deliberately returns two entries sharing a textureKey.
    const shared = {
      briefId: 'iron-sword',
      textureKey: 'iron-sword-var-1',
      assetPath: 'generated/iron-sword-var-1.png',
      anchor: { x: 8, y: 8 },
      centerOfGravity: { x: 8, y: 8 },
      anchorIsDefault: false,
      approvedAt: '2026-06-08T15:30:00.000Z',
      sourceRun: 'generated/runs/iron-sword/run',
      variantIndex: 1,
      sensorScore: '7/7',
      judgeScore: null,
      facingDirection: 'right',
    } as const;
    const registry = {
      version: GENERATED_MANIFEST_VERSION,
      size: 2,
      has: () => true,
      lookup: () => shared,
      variants: () => [shared],
      entries: () => [shared, { ...shared, assetPath: 'generated/other.png' }],
      briefIds: () => ['iron-sword'],
    };
    preloadGeneratedSprites({ image }, registry);
    expect(image).toHaveBeenCalledTimes(1);
  });
});
