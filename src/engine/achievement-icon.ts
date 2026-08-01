import type Phaser from 'phaser';
import type { AchievementDef } from '../shared/achievements.js';
import { hashStringToSeed } from '../shared/random.js';
import { type GeneratedSpriteEntry } from '../shared/generated-assets.js';
import { resolveGeneratedIconEntry } from './generated-icon-resolver.js';

function toAchievementIconId(iconId: string): string {
  return iconId.endsWith('-placeholder') ? iconId.slice(0, -'-placeholder'.length) : iconId;
}

export function getAchievementIconEntry(
  scene: Phaser.Scene,
  achievement: AchievementDef,
): GeneratedSpriteEntry | null {
  const canonicalIconId = toAchievementIconId(achievement.iconId);
  return resolveGeneratedIconEntry(scene, {
    briefIds: [canonicalIconId],
    textureKeys: [canonicalIconId, achievement.iconId],
    seed: hashStringToSeed(achievement.id),
  });
}
