export {
  fetchGeneratedSpriteRegistry,
  preloadGeneratedSprites,
  DEFAULT_MANIFEST_URL,
  resolvePublicAssetUrl,
  type FetchManifestOptions,
  type LoaderLike,
  type PreloadOptions,
} from './preload.js';

export {
  registerGeneratedSpriteAnimations,
  walkAnimationKey,
  type AnimatableSceneLike,
  type AnimationManagerLike,
} from './animations.js';

/**
 * Key under which the generated-sprite registry is stashed on
 * `scene.game.registry`. Consumers (PhaserBridge, InventoryUI) read it
 * from there so the registry doesn't have to be threaded through scene
 * constructors.
 */
export const GENERATED_SPRITE_REGISTRY_KEY = 'generatedSpriteRegistry';
