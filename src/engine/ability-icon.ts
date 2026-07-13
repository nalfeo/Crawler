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
  const briefId = getAbilityPresentation(abilityId)?.iconBriefId;
  if (!briefId) return null;

  const registry = scene.game.registry.get(GENERATED_SPRITE_REGISTRY_KEY);
  if (!isGeneratedSpriteRegistry(registry)) return null;

  const entry = pickGeneratedVariant(registry, briefId, hashStringToSeed(abilityId));
  return entry && scene.textures.exists(entry.textureKey) ? entry : null;
}

function isGeneratedSpriteRegistry(value: unknown): value is GeneratedSpriteRegistry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GeneratedSpriteRegistry>;
  return typeof candidate.variants === 'function' && typeof candidate.lookup === 'function';
}
