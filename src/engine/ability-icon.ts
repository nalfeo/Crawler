import type Phaser from 'phaser';
import { getAbilityPresentation } from '../shared/ability-presentation.js';
import { type GeneratedSpriteEntry } from '../shared/generated-assets.js';
import { hashStringToSeed } from '../shared/random.js';
import { resolveGeneratedIconEntry } from './generated-icon-resolver.js';

export function getAbilityIconEntry(
  scene: Phaser.Scene,
  abilityId: string,
): GeneratedSpriteEntry | null {
  const briefId = getAbilityPresentation(abilityId)?.iconBriefId;
  const canonicalIconId = `ability-icon-${abilityId}`;
  const unversionedBrief =
    briefId && /-v\d+$/.test(briefId) ? briefId.replace(/-v\d+$/, '') : undefined;
  const briefIds = [briefId, unversionedBrief, canonicalIconId].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  const textureKeys = [canonicalIconId, briefId].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  return resolveGeneratedIconEntry(scene, {
    briefIds,
    textureKeys,
    seed: hashStringToSeed(abilityId),
  });
}
