import { describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { hashStringToSeed } from '../../src/shared/random.js';
import type { AchievementDef } from '../../src/shared/achievements.js';
import type { GeneratedSpriteEntry } from '../../src/shared/generated-assets.js';

const resolveGeneratedIconEntry = vi.fn();

vi.mock('../../src/engine/generated-icon-resolver.js', () => ({
  resolveGeneratedIconEntry: (...args: unknown[]) => resolveGeneratedIconEntry(...args),
}));

const { getAchievementIconEntry } = await import('../../src/engine/achievement-icon.js');

function makeAchievement(overrides: Partial<AchievementDef>): AchievementDef {
  return {
    id: 'ach-1',
    iconId: 'ach-1-icon',
    ...overrides,
  } as AchievementDef;
}

describe('getAchievementIconEntry', () => {
  const scene = {} as Phaser.Scene;
  const stubEntry = { textureKey: 'stub' } as GeneratedSpriteEntry;

  it('passes through the iconId unchanged when it has no -placeholder suffix', () => {
    resolveGeneratedIconEntry.mockReturnValueOnce(stubEntry);
    const achievement = makeAchievement({ id: 'ach-1', iconId: 'ach-1-icon' });

    const result = getAchievementIconEntry(scene, achievement);

    expect(result).toBe(stubEntry);
    expect(resolveGeneratedIconEntry).toHaveBeenCalledWith(scene, {
      briefIds: ['ach-1-icon'],
      textureKeys: ['ach-1-icon', 'ach-1-icon'],
      seed: hashStringToSeed('ach-1'),
    });
  });

  it('strips a trailing -placeholder suffix to derive the canonical brief id', () => {
    resolveGeneratedIconEntry.mockReturnValueOnce(stubEntry);
    const achievement = makeAchievement({ id: 'ach-2', iconId: 'ach-2-icon-placeholder' });

    getAchievementIconEntry(scene, achievement);

    expect(resolveGeneratedIconEntry).toHaveBeenCalledWith(scene, {
      briefIds: ['ach-2-icon'],
      textureKeys: ['ach-2-icon', 'ach-2-icon-placeholder'],
      seed: hashStringToSeed('ach-2'),
    });
  });

  it('returns null when resolution fails', () => {
    resolveGeneratedIconEntry.mockReturnValueOnce(null);
    const achievement = makeAchievement({ id: 'ach-3', iconId: 'ach-3-icon' });

    expect(getAchievementIconEntry(scene, achievement)).toBeNull();
  });
});
