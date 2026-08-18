import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  claimAchievementReward,
  unlockAchievement,
} from '../../src/game/systems/achievementSystem.js';
import {
  acknowledgeAchievementRewardPresentation,
  getPendingAchievementRewardPresentation,
} from '../../src/core/systems/achievementRewards.js';
import { _LOOT_BOX_GOLD_BY_TIER as LOOT_BOX_GOLD_BY_TIER } from '../../src/shared/achievements.js';
import { createTestWorld } from '../helpers/world-factory.js';

function floor2World(runKey = 'reward-presentation-test') {
  const world = createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey });
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentRewards = true;
  return world;
}

describe('achievement reward presentation snapshot (pendingPresentations)', () => {
  it('claiming a lootBox achievement populates a presentation snapshot matching the actual grant', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, 'first-bonk');

    expect(getPendingAchievementRewardPresentation(world, 'first-bonk')).toBeUndefined();
    const result = claimAchievementReward(world, 'first-bonk');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(getPendingAchievementRewardPresentation(world, 'first-bonk')).toBeDefined();
    const presentation = getPendingAchievementRewardPresentation(world, 'first-bonk');
    expect(presentation).toEqual({
      kind: 'lootBox',
      tier: 'trash',
      gold: result.grantedLootBox!.gold,
      materials: result.grantedLootBox!.materials,
    });
    // Summary accuracy: the snapshot must match the tier-scaled canonical value.
    expect(presentation).toMatchObject({ gold: LOOT_BOX_GOLD_BY_TIER.trash });
  });

  it('claiming an equipment achievement populates a presentation snapshot matching the actual grant', () => {
    const world = floor2World();
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, 'floor2-field-kit');

    const result = claimAchievementReward(world, 'floor2-field-kit');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const presentation = getPendingAchievementRewardPresentation(world, 'floor2-field-kit');
    expect(presentation).toEqual({
      kind: 'equipment',
      tier: 'tier1',
      instanceKeys: result.grantedEquipment!.map((entry) => entry.instanceKey),
    });
  });

  it('acknowledge consumes the snapshot exactly once and is idempotent on duplicate/repeat input', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, 'first-bonk');
    claimAchievementReward(world, 'first-bonk');
    expect(getPendingAchievementRewardPresentation(world, 'first-bonk')).toBeDefined();

    acknowledgeAchievementRewardPresentation(world, 'first-bonk');
    expect(getPendingAchievementRewardPresentation(world, 'first-bonk')).toBeUndefined();

    // Duplicate acknowledge input is a safe no-op — never throws, never re-grants.
    expect(() => acknowledgeAchievementRewardPresentation(world, 'first-bonk')).not.toThrow();
    expect(getPendingAchievementRewardPresentation(world, 'first-bonk')).toBeUndefined();
  });

  it('acknowledging an achievement that never had a presentation (directorMessage reward) is a safe no-op', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, 'safe-room-breather');
    const result = claimAchievementReward(world, 'safe-room-breather');
    expect(result.ok).toBe(true);

    expect(getPendingAchievementRewardPresentation(world, 'safe-room-breather')).toBeUndefined();
    expect(() =>
      acknowledgeAchievementRewardPresentation(world, 'safe-room-breather'),
    ).not.toThrow();
  });

  it('a second claim attempt never mutates or re-creates the presentation snapshot (exact-once)', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, 'first-bonk');
    claimAchievementReward(world, 'first-bonk');
    const snapshotBefore = getPendingAchievementRewardPresentation(world, 'first-bonk');

    const second = claimAchievementReward(world, 'first-bonk');
    expect(second).toEqual({ ok: false, reason: 'alreadyClaimed' });
    expect(getPendingAchievementRewardPresentation(world, 'first-bonk')).toEqual(snapshotBefore);
  });
});
