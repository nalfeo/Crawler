import { describe, expect, it } from 'vitest';
import { getActiveWeaponDef } from '../../src/core/active-weapon.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  getEquipmentState,
  initializeBaseStats,
  resolveEquipmentInstance,
} from '../../src/core/systems/equipmentSystem.js';
import { capturePlayerCarryover } from '../../src/game/playerCarryover.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { applyStartPlayerLevel } from '../../src/game/scenarios/playerLevelProgression.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

const DIRECT_START_FLOORS = ['floor2', 'floor3', 'floor4', 'floor5', 'floor6'] as const;

describe('floor skip direct-start baselines', () => {
  for (const floorId of DIRECT_START_FLOORS) {
    it(`seeds player progression when directly entering ${floorId}`, () => {
      const manifest = getFloorManifest(floorId)!;
      const baseline = manifest.player.directStart!;
      const world = createTestWorld({ seed: 7 });
      const player = spawnPlayer(world, 0, 0);
      const scenario = getScenarioDefinition(floorId);

      scenario.configureWorld(world, player);

      expect(world.playerLevel.level).toBe(baseline.level);
      expect(world.playerLevel.unspentPoints).toBe(0);

      const activeWeapon = getActiveWeaponDef(world);
      expect(activeWeapon).toBeDefined();

      const skills = world.skillStatesByEntity.get(player)!;
      expect(skills.get(activeWeapon!.weaponClassSkillId)?.level).toBe(baseline.weaponSkillLevel);
      expect(skills.get(activeWeapon!.weaponTypeSkillId)?.level).toBe(baseline.weaponSkillLevel);
      for (const [skillId, level] of Object.entries(baseline.skillLevels)) {
        expect(skills.get(skillId)?.level).toBe(level);
      }

      const abilityState = world.abilityStatesByEntity.get(player);
      expect(
        (abilityState?.ownedActiveAbilityIds?.length ?? 0) +
          (abilityState?.passiveAbilityIds.length ?? 0),
      ).toBeGreaterThan(0);
      expect(world.milestoneGrantLog.length).toBeGreaterThan(0);

      const equipmentState = getEquipmentState(world, player)!;
      const equippedItemIds = Object.values(equipmentState.equipped)
        .filter((instanceId): instanceId is NonNullable<typeof instanceId> => instanceId !== null)
        .map((instanceId) => resolveEquipmentInstance(world, equipmentState, instanceId)?.def.id);
      for (const itemId of baseline.equipmentItemIds) {
        expect(equippedItemIds).toContain(itemId);
      }
    });
  }

  it('does not replace explicit carryover progression with the direct-start baseline', () => {
    const carryoverWorld = createTestWorld({ seed: 7 });
    const carryoverPlayer = spawnPlayer(carryoverWorld, 0, 0);
    initializeBaseStats(carryoverWorld, carryoverPlayer);
    applyStartPlayerLevel(carryoverWorld, 2);
    const carryover = capturePlayerCarryover(carryoverWorld, carryoverPlayer);

    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);

    getScenarioDefinition('floor3').configureWorld(world, player, { playerCarryover: carryover });

    expect(world.playerLevel.level).toBe(2);
    expect(world.playerLevel.level).toBeLessThan(
      getFloorManifest('floor3')!.player.directStart!.level,
    );
  });
});
