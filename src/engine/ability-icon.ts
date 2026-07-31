import type Phaser from 'phaser';
import { getAbilityPresentation } from '../shared/ability-presentation.js';
import {
  pickGeneratedVariant,
  type GeneratedSpriteEntry,
  type GeneratedSpriteRegistry,
} from '../shared/generated-assets.js';
import { hashStringToSeed } from '../shared/random.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from './generatedAssets/index.js';

export function getAbilityIconEntry(
  scene: Phaser.Scene,
  abilityId: string,
): GeneratedSpriteEntry | null {
  const iconRef = getAbilityPresentation(abilityId)?.iconBriefId;
  if (!iconRef) return null;

  const registry = scene.game.registry.get(GENERATED_SPRITE_REGISTRY_KEY);
  if (!isGeneratedSpriteRegistry(registry)) return null;

  // Try the common case first: iconRef is a briefId grouping approved variants.
  const byBrief = pickGeneratedVariant(registry, iconRef, hashStringToSeed(abilityId));
  if (byBrief && scene.textures.exists(byBrief.textureKey)) return byBrief;

  // Fallback: iconRef might actually be a per-icon manifest key/textureKey
  // (the approveIconBatch path writes per-icon manifest keys). Search the
  // flattened entries for a matching textureKey.
  const byTexture = registry.entries().find((e) => e.textureKey === iconRef);
  return byTexture && scene.textures.exists(byTexture.textureKey) ? byTexture : null;
}

function isGeneratedSpriteRegistry(value: unknown): value is GeneratedSpriteRegistry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GeneratedSpriteRegistry>;
  return typeof candidate.variants === 'function' && typeof candidate.lookup === 'function';
}
