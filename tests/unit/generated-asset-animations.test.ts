/**
 * Unit tests for `registerGeneratedSpriteAnimations` — the first Phaser
 * animation-registration glue in the engine.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  confirmGeneratedSpriteAnimation,
  registerGeneratedSpriteAnimations,
  walkAnimationKey,
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

  it('regression: does not permanently poison the anim key when the texture is not loaded yet', () => {
    // Reproduces the bug behind a real crash: Phaser's real
    // `AnimationManager#generateFrameNumbers` returns `[]` (not a throw) for
    // a texture key that isn't in the `TextureManager` yet — e.g. right
    // after a scene restart, before the generated-sprite texture finishes
    // loading. The old code unconditionally called `anims.create()` with
    // those empty frames, permanently caching a broken zero-frame
    // `Animation` under the key (since `anims.exists(key)` never resets),
    // which crashed the first time anything called `.play()` on it
    // (`Cannot read properties of undefined (reading 'duration')` inside
    // Phaser's `Animation#getFirstTick`, thrown from `scene.update()` and
    // freezing the whole render loop). The fix must skip creating on an
    // empty frame array and allow a later retry to succeed once frames are
    // available.
    let textureLoaded = false;
    const created = new Map<string, unknown>();
    const anims = {
      exists: vi.fn((key: string) => created.has(key)),
      create: vi.fn((config: { key: string }) => {
        created.set(config.key, config);
        return config;
      }),
      generateFrameNumbers: vi.fn(() =>
        textureLoaded
          ? [
              { key: 'tex', frame: 0 },
              { key: 'tex', frame: 1 },
            ]
          : [],
      ),
    };
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-v1-var-0': makeEntry('player-walk-v1', {
          frameWidth: 16,
          frameHeight: 16,
          frameCount: 2,
          frameRate: 6,
          loop: true,
        }),
      },
    });

    // First attempt: texture not loaded yet — must not create a broken anim.
    let keys = registerGeneratedSpriteAnimations({ anims }, registry);
    expect(keys).toEqual([]);
    expect(anims.create).not.toHaveBeenCalled();
    expect(anims.exists('player-walk-v1-var-0:walk')).toBe(false);

    // Texture becomes ready; a later call must successfully register it.
    textureLoaded = true;
    keys = registerGeneratedSpriteAnimations({ anims }, registry);
    expect(keys).toEqual(['player-walk-v1-var-0:walk']);
    expect(anims.create).toHaveBeenCalledTimes(1);
    expect(anims.exists('player-walk-v1-var-0:walk')).toBe(true);
  });

  it('confirmGeneratedSpriteAnimation returns false for an empty frame array and true once created/already-registered', () => {
    const created = new Set<string>();
    const anims = {
      exists: vi.fn((key: string) => created.has(key)),
      create: vi.fn((config: { key: string }) => {
        created.add(config.key);
        return config;
      }),
      generateFrameNumbers: vi.fn(() => [] as unknown[]),
    };
    const animation = { frameWidth: 16, frameHeight: 16, frameCount: 2, frameRate: 6, loop: true };
    expect(confirmGeneratedSpriteAnimation(anims, 'tex', animation)).toBe(false);
    expect(anims.create).not.toHaveBeenCalled();

    anims.generateFrameNumbers.mockReturnValue([{ key: 'tex', frame: 0 }]);
    expect(confirmGeneratedSpriteAnimation(anims, 'tex', animation)).toBe(true);
    expect(anims.create).toHaveBeenCalledTimes(1);

    // Already registered now — confirms true without touching create() again.
    expect(confirmGeneratedSpriteAnimation(anims, 'tex', animation)).toBe(true);
    expect(anims.create).toHaveBeenCalledTimes(1);
  });
});
