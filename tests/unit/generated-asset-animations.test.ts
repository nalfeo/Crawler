/**
 * Unit tests for `registerGeneratedSpriteAnimations` — the first Phaser
 * animation-registration glue in the engine.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  registerGeneratedSpriteAnimations,
  walkAnimationKey,
  walkDirectionFromVelocity,
} from '../../src/engine/generatedAssets/animations.js';
import {
  buildGeneratedSpriteRegistry,
  emptyGeneratedSpriteRegistry,
  GENERATED_MANIFEST_VERSION,
} from '../../src/shared/generated-assets.js';

function makeEntry(briefId: string, animation?: Record<string, unknown>): Record<string, unknown> {
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
    ...(animation ? { animation } : {}),
  };
}

function makeAnimsStub() {
  const created = new Map<string, unknown>();
  return {
    created,
    anims: {
      exists: vi.fn((key: string) => created.has(key)),
      create: vi.fn((config: { key: string }) => {
        created.set(config.key, config);
        return config;
      }),
      generateFrameNumbers: vi.fn((textureKey: string, cfg: { start: number; end: number }) => ({
        textureKey,
        ...cfg,
      })),
    },
  };
}

describe('walkAnimationKey', () => {
  it('derives a deterministic key from the texture key', () => {
    expect(walkAnimationKey('player-walk-v1-var-0')).toBe('player-walk-v1-var-0:walk');
    expect(walkAnimationKey('player-walk-v1-var-0', 'south')).toBe(
      'player-walk-v1-var-0:walk:south',
    );
  });

  it.each([
    [0, -1, 'north'],
    [1, -1, 'northEast'],
    [1, -0.1, 'east'],
    [1, 0, 'east'],
    [1, 0.1, 'east'],
    [1, 1, 'southEast'],
    [0, 1, 'south'],
    [-1, 1, 'southWest'],
    [-1, 0, 'west'],
    [-1, -1, 'northWest'],
  ] as const)('quantizes (%s, %s) to %s', (vx, vy, expected) => {
    expect(walkDirectionFromVelocity(vx, vy)).toBe(expected);
  });
});

describe('registerGeneratedSpriteAnimations', () => {
  it('does nothing for an empty registry', () => {
    const { anims } = makeAnimsStub();
    const keys = registerGeneratedSpriteAnimations({ anims }, emptyGeneratedSpriteRegistry());
    expect(keys).toEqual([]);
    expect(anims.create).not.toHaveBeenCalled();
  });

  it('skips entries without an animation descriptor', () => {
    const { anims } = makeAnimsStub();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': makeEntry('iron-sword') },
    });
    const keys = registerGeneratedSpriteAnimations({ anims }, registry);
    expect(keys).toEqual([]);
    expect(anims.create).not.toHaveBeenCalled();
  });

  it('registers one animation per entry carrying an animation descriptor', () => {
    const { anims, created } = makeAnimsStub();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-v1-var-0': makeEntry('player-walk-v1', {
          frameWidth: 16,
          frameHeight: 16,
          frameCount: 3,
          frameRate: 6,
          loop: true,
        }),
      },
    });
    const keys = registerGeneratedSpriteAnimations({ anims }, registry);
    expect(keys).toEqual(['player-walk-v1-var-0:walk']);
    expect(anims.create).toHaveBeenCalledTimes(1);
    const config = created.get('player-walk-v1-var-0:walk') as {
      frameRate: number;
      repeat: number;
    };
    expect(config.frameRate).toBe(6);
    expect(config.repeat).toBe(-1); // loop: true => infinite repeat
    expect(anims.generateFrameNumbers).toHaveBeenCalledWith('player-walk-v1-var-0', {
      start: 0,
      end: 2,
    });
  });

  it('uses repeat: 0 when loop is false', () => {
    const { anims, created } = makeAnimsStub();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'one-shot-var-0': makeEntry('one-shot', {
          frameWidth: 16,
          frameHeight: 16,
          frameCount: 2,
          frameRate: 4,
          loop: false,
        }),
      },
    });

    registerGeneratedSpriteAnimations({ anims }, registry);
    const config = created.get('one-shot-var-0:walk') as { repeat: number };
    expect(config.repeat).toBe(0);
  });

  it('registers eight directional clips from one atlas', () => {
    const { anims, created } = makeAnimsStub();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-8way': makeEntry('player-walk-8way', {
          frameWidth: 64,
          frameHeight: 64,
          frameCount: 32,
          frameRate: 8,
          loop: true,
          directions: {
            north: { start: 0, end: 3 },
            northEast: { start: 4, end: 7 },
            east: { start: 8, end: 11 },
            southEast: { start: 12, end: 15 },
            south: { start: 16, end: 19 },
            southWest: { start: 20, end: 23 },
            west: { start: 24, end: 27 },
            northWest: { start: 28, end: 31 },
          },
        }),
      },
    });
    const keys = registerGeneratedSpriteAnimations({ anims }, registry);
    expect(keys).toHaveLength(8);
    expect(created.has('player-walk-8way:walk:south')).toBe(true);
    expect(anims.generateFrameNumbers).toHaveBeenCalledWith('player-walk-8way', {
      start: 16,
      end: 19,
    });
  });

  it('is idempotent — does not re-create an already-registered animation key', () => {
    const { anims } = makeAnimsStub();
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-v1-var-0': makeEntry('player-walk-v1', {
          frameWidth: 16,
          frameHeight: 16,
          frameCount: 3,
          frameRate: 6,
          loop: true,
        }),
      },
    });
    registerGeneratedSpriteAnimations({ anims }, registry);
    registerGeneratedSpriteAnimations({ anims }, registry);
    expect(anims.create).toHaveBeenCalledTimes(1);
  });

  it('no-ops (returns empty array) when scene.anims is unavailable', () => {
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-v1-var-0': makeEntry('player-walk-v1', {
          frameWidth: 16,
          frameHeight: 16,
          frameCount: 3,
          frameRate: 6,
          loop: true,
        }),
      },
    });
    const keys = registerGeneratedSpriteAnimations({}, registry);
    expect(keys).toEqual([]);
  });
});
