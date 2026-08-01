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

const compareEntries = (a: GeneratedSpriteEntry, b: GeneratedSpriteEntry): number =>
  a.variantIndex - b.variantIndex || a.textureKey.localeCompare(b.textureKey);

const textureIndexCache = new WeakMap<
  GeneratedSpriteRegistry,
  ReadonlyMap<string, readonly GeneratedSpriteEntry[]>
>();

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
  const index = getTextureIndex(registry);
  let best: GeneratedSpriteEntry | null = null;
  for (const textureKey of options.textureKeys) {
    if (!textureKey) continue;
    const variants = index.get(textureKey);
    if (!variants) continue;
    for (const entry of variants) {
      if (!scene.textures.exists(entry.textureKey)) continue;
      if (!best || compareEntries(entry, best) < 0) best = entry;
      break;
    }
  }
  return best;
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

function getTextureIndex(
  registry: GeneratedSpriteRegistry,
): ReadonlyMap<string, readonly GeneratedSpriteEntry[]> {
  const cached = textureIndexCache.get(registry);
  if (cached) return cached;
  const byTexture = new Map<string, GeneratedSpriteEntry[]>();
  for (const entry of registry.entries()) {
    const bucket = byTexture.get(entry.textureKey);
    if (bucket) bucket.push(entry);
    else byTexture.set(entry.textureKey, [entry]);
  }
  for (const bucket of byTexture.values()) bucket.sort(compareEntries);
  textureIndexCache.set(registry, byTexture);
  return byTexture;
}
