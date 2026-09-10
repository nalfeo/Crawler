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
 * Self-healing against load-order races: if a texture hasn't finished
 * loading into the scene's `TextureManager` yet (this can happen right
 * after a scene restart, before the generated-sprite texture load
 * settles), the entry is skipped rather than registered as a broken
 * zero-frame animation — see `confirmGeneratedSpriteAnimation` below.
 * `PhaserBridge` retries any texture keys this leaves unregistered on every
 * subsequent frame until they succeed.
 *
 * Guarded on `scene.anims` existing so headless/test scene stubs that don't
 * implement the AnimationManager (see `tests/fixtures/phaser-bridge-harness.ts`)
 * can call this safely without crashing.
 */
import type {
  GeneratedSpriteAnimation,
  GeneratedSpriteRegistry,
} from '../../shared/generated-assets.js';
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
 * Attempt to (re)confirm the walk-cycle animation for a single texture key
 * is registered. Returns `true` once the animation exists — either it was
 * already registered, or it was just created this call — and `false` when
 * the texture is not yet loaded into the scene's `TextureManager`.
 *
 * Phaser's `AnimationManager#generateFrameNumbers` does not throw for an
 * unknown texture key: it logs its own `console.warn` and returns `[]`. If
 * we blindly `create()` an animation from that empty frame list, Phaser
 * caches a permanently-broken zero-frame `Animation` under the key —
 * `anims.exists(key)` is true forever after (this is a game-level registry,
 * unaffected by scene restarts), so the animation can NEVER heal even once
 * the texture finishes loading moments later. The first `.play()` call then
 * crashes with `Cannot read properties of undefined (reading 'duration')`
 * inside Phaser's `Animation#getFirstTick` (`state.currentFrame` is
 * `undefined` because there are no frames), which freezes the entire
 * render/update loop since it's thrown from inside `scene.update()`.
 *
 * Guarding here means a texture that hasn't loaded yet simply defers
 * animation registration to a later call (see `registerGeneratedSpriteAnimations`
 * and its per-frame retry in `PhaserBridge`) instead of poisoning the key.
 */
export function confirmGeneratedSpriteAnimation(
  anims: AnimationManagerLike,
  textureKey: string,
  animation: GeneratedSpriteAnimation,
): boolean {
  const key = walkAnimationKey(textureKey);
  if (anims.exists(key)) {
    return true;
  }
  const frames = anims.generateFrameNumbers(textureKey, {
    start: 0,
    end: animation.frameCount - 1,
  });
  if (Array.isArray(frames) && frames.length === 0) {
    // Texture not loaded yet — do not create a broken animation. Caller
    // retries on a later frame/registry pass.
    return false;
  }
  anims.create({
    key,
    frames,
    frameRate: animation.frameRate,
    repeat: animation.loop ? -1 : 0,
  });
  return true;
}

/**
 * Register one Phaser animation per registry entry carrying an `animation`
 * descriptor. Returns the list of animation keys that were (re)confirmed
 * present — either newly created this call or already existing — so callers
 * (and tests) can introspect what's registered. Entries whose texture isn't
 * loaded yet are silently skipped (see `confirmGeneratedSpriteAnimation`)
 * and are absent from the returned list, so a caller can tell registration
 * is incomplete and retry later.
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
    if (confirmGeneratedSpriteAnimation(anims, entry.textureKey, entry.animation)) {
      keys.push(walkAnimationKey(entry.textureKey));
    }
  }
  if (keys.length > 0) {
    logger.info('Registered generated sprite animations', { count: keys.length });
  }
  return keys;
}
