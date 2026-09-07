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
import { applyFloorSkipBaseline } from '../../src/game/scenarios/floorSkipBaseline.js';
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

      const skills = world.skillStatesByEntity.get(player)!;
      const activeWeapon = getActiveWeaponDef(world);
      if (floorId === 'floor3') {
        expect(activeWeapon).toBeUndefined();
        expect(
          [...skills.values()].filter((state) => state.level === baseline.weaponSkillLevel).length,
        ).toBeGreaterThanOrEqual(2);
        const studios = world.floorExtendedState?.floor3Studios?.studios ?? [];
        expect(
          studios.filter((studio) => studio.unlockLevel <= world.playerLevel.level),
        ).toHaveLength(1);
      } else {
        expect(activeWeapon).toBeDefined();
        expect(skills.get(activeWeapon!.weaponClassSkillId)?.level).toBe(baseline.weaponSkillLevel);
        expect(skills.get(activeWeapon!.weaponTypeSkillId)?.level).toBe(baseline.weaponSkillLevel);
      }
      for (const [skillId, level] of Object.entries(baseline.skillLevels)) {
        expect(skills.get(skillId)?.level).toBe(level);
      }

      const abilityState = world.abilityStatesByEntity.get(player);
      expect(
        (abilityState?.ownedActiveAbilityIds?.length ?? 0) +
          (abilityState?.passiveAbilityIds.length ?? 0),
      ).toBeGreaterThan(0);
      // Real progression bookkeeping (skill state, ability grants, milestone
      // log) must survive the synthetic seed.
      expect(world.milestoneGrantLog.length).toBeGreaterThan(0);
      // But the seed is silent: it must not leave behind stale runtime-only
      // presentation events (level-up floaters, milestone VFX) or queue a
      // skill-triggered ability to auto-activate on the first real frame
      // (PR #4392 review fix). Floor welcome banners (e.g. Floor 5's
      // "Hostile Takeover" announcement) are legitimate floor-level
      // presentation, not baseline-seeding noise, so `announcements` is
      // checked separately below for a floor with no such banner.
      expect(world.floaterEvents).toHaveLength(0);
      expect(world.vfxEvents).toHaveLength(0);
      expect(world.abilityTriggerEvents).toHaveLength(0);

      const equipmentState = getEquipmentState(world, player)!;
      const equippedItemIds = Object.values(equipmentState.equipped)
        .filter((instanceId): instanceId is NonNullable<typeof instanceId> => instanceId !== null)
        .map((instanceId) => resolveEquipmentInstance(world, equipmentState, instanceId)?.def.id);
      for (const itemId of baseline.equipmentItemIds) {
        expect(equippedItemIds).toContain(itemId);
      }

      if (manifest.player.hpBonus > 0) {
        // The manifest HP bonus must survive applyFloorSkipBaseline's
        // initializeBaseStats call, which otherwise reseeds Health.max from
        // the derived base value and silently discards a bonus applied
        // before it (PR #4392 review fix). Assert against the
        // baseline-derived max HP (computed independently, with the bonus
        // zeroed) plus the bonus, rather than a hardcoded absolute number,
        // so this targets the specific ordering regression instead of
        // pinning the whole stat-derivation pipeline's output.
        const baselineOnlyWorld = createTestWorld({ seed: 7 });
        const baselineOnlyPlayer = spawnPlayer(baselineOnlyWorld, 0, 0);
        applyFloorSkipBaseline(baselineOnlyWorld, baselineOnlyPlayer, {
          ...manifest,
          player: { ...manifest.player, hpBonus: 0 },
        });
        const baselineOnlyMaxHp = baselineOnlyWorld.stores.health.max[baselineOnlyPlayer]!;
        expect(world.stores.health.max[player]).toBe(baselineOnlyMaxHp + manifest.player.hpBonus);
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

  it('seeds the floor6 pistol baseline without any stale transient queue', () => {
    // Floor 6 has no floor-level welcome banner, so `announcements` (unlike
    // the per-floor loop above) can be asserted empty here too, matching the
    // exact "Floor 6 start" example from the PR #4392 review thread.
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);

    getScenarioDefinition('floor6').configureWorld(world, player);

    expect(world.milestoneGrantLog.length).toBeGreaterThan(0);
    expect(world.floaterEvents).toHaveLength(0);
    expect(world.vfxEvents).toHaveLength(0);
    expect(world.announcements).toHaveLength(0);
    expect(world.abilityTriggerEvents).toHaveLength(0);
  });
});
