/**
 * Registers Phaser animations for every generated-sprite manifest entry that
 * carries an `animation` descriptor (see `GeneratedSpriteAnimation` in
 * `src/shared/generated-assets.ts`).
 *
 * This is the FIRST Phaser animation infrastructure in the engine. Every
 * other entity render path uses `scene.add.image` (a single static frame);
 * this module is what lets a `scene.add.sprite` play a multi-frame walk
 * cycle once its texture is a Phaser spritesheet (queued via
 * `preloadGeneratedSprites`'s `loader.spritesheet` branch).
 *
 * Idempotent: safe to call multiple times (e.g. on scene restart) — an
 * already-registered anim key is left untouched rather than re-created,
 * which would otherwise throw in Phaser's AnimationManager.
 *
 * Guarded on `scene.anims` existing so headless/test scene stubs that don't
 * implement the AnimationManager (see `tests/fixtures/phaser-bridge-harness.ts`)
 * can call this safely without crashing.
 */
import type { GeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('engine:generated-assets');

/** Suffix applied to a texture key to derive its walk-cycle animation key. */
const WALK_ANIM_SUFFIX = ':walk';

/** Deterministically derive the Phaser animation key for a texture's walk cycle. */
export function walkAnimationKey(textureKey: string): string {
  return `${textureKey}${WALK_ANIM_SUFFIX}`;
}

/** Minimum subset of `Phaser.Animations.AnimationManager` this module needs. */
export interface AnimationManagerLike {
  exists(key: string): boolean;
  // Structural glue type: must accept Phaser's real `Animation` config object
  // (frames typed as `string | AnimationFrame[]`) without importing Phaser's
  // animation types here, and accept plain test-stub configs too.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create(config: { key: string; frames: any; frameRate: number; repeat: number }): unknown;
  // See create() above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateFrameNumbers(textureKey: string, config: { start: number; end: number }): any;
}

/** Minimum subset of `Phaser.Scene` this module needs. */
export interface AnimatableSceneLike {
  anims?: AnimationManagerLike;
}

/**
 * Register one Phaser animation per registry entry carrying an `animation`
 * descriptor. Returns the list of animation keys that were (re)confirmed
 * present — either newly created this call or already existing — so callers
 * (and tests) can introspect what's registered.
 *
 * No-ops entirely (returns `[]`) when `scene.anims` is unavailable, which is
 * the case for lightweight test/lab scene stubs that don't need real
 * animation playback.
 */
export function registerGeneratedSpriteAnimations(
  scene: AnimatableSceneLike,
  registry: GeneratedSpriteRegistry,
): readonly string[] {
  const anims = scene.anims;
  if (!anims || typeof anims.exists !== 'function' || typeof anims.create !== 'function') {
    return [];
  }

  const keys: string[] = [];
  for (const entry of registry.entries()) {
    if (!entry.animation) {
      continue;
    }
    const key = walkAnimationKey(entry.textureKey);
    keys.push(key);
    if (anims.exists(key)) {
      // Already registered (e.g. scene restart) — do not re-create.
      continue;
    }
    anims.create({
      key,
      frames: anims.generateFrameNumbers(entry.textureKey, {
        start: 0,
        end: entry.animation.frameCount - 1,
      }),
      frameRate: entry.animation.frameRate,
      repeat: entry.animation.loop ? -1 : 0,
    });
  }
  if (keys.length > 0) {
    logger.info('Registered generated sprite animations', { count: keys.length });
  }
  return keys;
}
