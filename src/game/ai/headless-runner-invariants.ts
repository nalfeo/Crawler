import type { GameWorld } from '../../core/index.js';
import { getGeneratedEquipmentInstance } from '../../core/generated-equipment-registry.js';
import { isAchievementClaimed } from '../../core/systems/achievementRewards.js';
import { getEquipmentState } from '../../core/systems/equipmentSystem.js';
import { type GeneratedEquipmentInstanceKey } from '../../shared/generated-equipment-types.js';
import { listGeneratedEquipmentReferences } from '../../shared/inventory.js';
import { FLOOR2_TIMEOUT_GOAL_ID } from '../floor2Scenario.js';
import { FLOOR3_TIMEOUT_GOAL_ID } from '../floor3Scenario.js';
import type { EquipmentPlayabilityMetrics } from './types.js';

export function classifyGameOverOutcome(world: GameWorld): 'timeout' | 'death' {
  const floor1Timeout = world.floorScenario?.failReason === 'stair_timeout';
  const floor2Timeout = world.goalFlags.get(FLOOR2_TIMEOUT_GOAL_ID) === true;
  const floor3Timeout = world.goalFlags.get(FLOOR3_TIMEOUT_GOAL_ID) === true;
  return floor1Timeout || floor2Timeout || floor3Timeout ? 'timeout' : 'death';
}

export function collectEquipmentPlayabilityMetrics(
  world: GameWorld,
  playerEid: number,
  goldSpentOnEquipment: number,
): EquipmentPlayabilityMetrics {
  const bag = world.inventories.get(playerEid);
  const equipmentState = getEquipmentState(world, playerEid);
  const baggedEntries = bag ? listGeneratedEquipmentReferences(bag) : [];
  const equippedInstanceIds = new Set(
    Object.values(equipmentState?.equipped ?? {}).filter(
      (instanceId): instanceId is GeneratedEquipmentInstanceKey => typeof instanceId === 'string',
    ),
  );
  const unopenedAchievementRewards = [...world.achievements.unlockedIds].filter(
    (achievementId) => !isAchievementClaimed(world, achievementId),
  ).length;
  const unopenedBossChests = [...world.bossChests.values()].filter(
    (chest) => chest.state !== 'claimed',
  ).length;
  let unequippedWithEmptySlotCount = 0;
  for (const entry of baggedEntries) {
    const instance = getGeneratedEquipmentInstance(world, entry.instanceKey);
    if (!instance) continue;
    if (
      instance.frozen.slots.some((slotId) => {
        const equipped = equipmentState?.equipped[slotId];
        return equipped === null || equipped === undefined;
      })
    ) {
      unequippedWithEmptySlotCount += 1;
    }
  }
  return {
    goldSpentOnEquipment,
    baggedGeneratedCount: baggedEntries.length,
    equippedGeneratedCount: equippedInstanceIds.size,
    unopenedRewardBoxes:
      unopenedAchievementRewards +
      unopenedBossChests +
      world.achievements.pendingPresentations.size,
    unequippedWithEmptySlotCount,
  };
}

export function collectEquipmentPlayabilityViolations(
  metrics: EquipmentPlayabilityMetrics,
): string[] {
  const violations: string[] = [];
  if (
    metrics.goldSpentOnEquipment > 0 &&
    metrics.baggedGeneratedCount + metrics.equippedGeneratedCount < 1
  ) {
    violations.push(
      `Spent ${metrics.goldSpentOnEquipment} gold on equipment but ended with no generated equipment bagged or equipped`,
    );
  }
  if (metrics.unopenedRewardBoxes > 0) {
    violations.push(`Run ended with ${metrics.unopenedRewardBoxes} unopened reward boxes`);
  }
  if (metrics.unequippedWithEmptySlotCount > 0) {
    violations.push(
      `${metrics.unequippedWithEmptySlotCount} generated items remained bagged while a matching slot stayed empty`,
    );
  }
  return violations;
}
