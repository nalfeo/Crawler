import type Phaser from 'phaser';
import {
  pickGeneratedVariant,
  type GeneratedSpriteEntry,
  type GeneratedSpriteRegistry,
} from '../shared/generated-assets.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from './generatedAssets/index.js';

interface ResolveGeneratedIconOptions {
  readonly briefIds: readonly string[];
  readonly textureKeys: readonly string[];
  readonly seed: number;
}

export function resolveGeneratedIconEntry(
  scene: Phaser.Scene,
  options: ResolveGeneratedIconOptions,
): GeneratedSpriteEntry | null {
  const registry = getGeneratedRegistry(scene);
  if (!registry) return null;

  for (const briefId of options.briefIds) {
    if (!briefId) continue;
    const entry = pickGeneratedVariant(registry, briefId, options.seed);
    if (entry && scene.textures.exists(entry.textureKey)) return entry;
  }

  if (options.textureKeys.length === 0) return null;
  const wanted = new Set(options.textureKeys.filter((key) => key.length > 0));
  if (wanted.size === 0) return null;

  const byTexture = registry
    .entries()
    .filter((entry) => wanted.has(entry.textureKey))
    .sort((a, b) => a.variantIndex - b.variantIndex || a.textureKey.localeCompare(b.textureKey));

  for (const entry of byTexture) {
    if (scene.textures.exists(entry.textureKey)) return entry;
  }
  return null;
}

function getGeneratedRegistry(scene: Phaser.Scene): GeneratedSpriteRegistry | null {
  const registry = scene.game.registry.get(GENERATED_SPRITE_REGISTRY_KEY);
  if (!isGeneratedSpriteRegistry(registry)) return null;
  return registry;
}

function isGeneratedSpriteRegistry(value: unknown): value is GeneratedSpriteRegistry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GeneratedSpriteRegistry>;
  return typeof candidate.variants === 'function' && typeof candidate.lookup === 'function';
}
