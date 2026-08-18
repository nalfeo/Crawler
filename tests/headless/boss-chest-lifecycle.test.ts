import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { asFamilyId } from '../../src/core/faction-relations.js';
import {
  createBossChestId,
  spawnBossChestForDefeatedBoss,
} from '../../src/game/boss-chest-resolver.js';
import { getGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { EQUIPMENT_REWARD_TIER_RARITIES } from '../../src/shared/generated-equipment-types.js';
import type { GameWorld } from '../../src/core/world.js';

/**
 * Locate the first present Floor 2 boss family's entity and push a real
 * `death` combat event for it. Runs as a `postSystems` hook so it executes
 * inside the actual headless simulation loop (appended after the canonical
 * Floor 2 `postSystems`, which includes `floor2ObjectiveTick` — see
 * `headless-runner.ts`'s composition comment), meaning the boss-chest
 * creation this exercises goes through the exact same real pipeline as the
 * visual game, not a lab shortcut. Guards on a captured flag so it only
 * fires once (frame 0), and no-ops if the roster/boss entity is not yet
 * resolvable that frame.
 */
function killFirstPresentBossOnce(): (world: GameWorld) => void {
  let fired = false;
  return (world: GameWorld) => {
    if (fired) return;
    const familyState = world.floorExtendedState?.familyState;
    const familyId = familyState?.presentFamilies[0];
    if (!familyId) return;
    const presentIndex = familyState!.presentFamilies.indexOf(asFamilyId(familyId));
    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    let bossEid = -1;
    for (let eid = 0; eid < bossField.length; eid++) {
      if (bossField[eid] === 1 && familyIdxField[eid] === presentIndex) {
        bossEid = eid;
        break;
      }
    }
    if (bossEid <= 0) return;
    fired = true;
    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 999,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: bossEid,
    } as (typeof world.combatEvents)[number]);
  };
}

describe('Boss chest lifecycle — real headless pipeline', () => {
  it('creates an available Floor 2 boss chest with a resolved reward bundle when a boss dies', async () => {
    let observed:
      | { chestCount: number; state: string | undefined; bundleCount: number }
      | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 61 }), {
      seed: 61,
      floorId: 'floor2',
      maxFrames: 5,
      floor2EquipmentFlags: {
        floor2EquipmentRegistry: true,
        floor2EquipmentCatalog: true,
        floor2EquipmentEconomy: true,
      },
      simulationOptions: {
        postSystems: [killFirstPresentBossOnce()],
      },
      onFinish: (world) => {
        const familyId = world.floorExtendedState?.familyState?.presentFamilies[0];
        const chestId = familyId ? createBossChestId(familyId) : null;
        observed = {
          chestCount: world.bossChests.size,
          state: chestId ? world.bossChests.get(chestId)?.state : undefined,
          bundleCount: world.generatedEquipmentRewardBundles.size,
        };
      },
    });

    expect(observed?.chestCount).toBe(1);
    expect(observed?.state).toBe('available');
    expect(observed?.bundleCount).toBeGreaterThanOrEqual(1);
  });

  it('resolves boss chest reward bundle at tier4 with Uncommon or Rare rarity (not Common) per PLAN.md §E3-C', async () => {
    // Verifies the 85%/15% Uncommon/Rare split is wired end-to-end through the
    // real headless pipeline. The specific rarity depends on the run-key-derived
    // RNG substream, but Common must never appear (tier4 pool: ['uncommon','rare']).
    let observedRarity: string | undefined;
    let observedTier: string | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 61 }), {
      seed: 61,
      floorId: 'floor2',
      maxFrames: 5,
      floor2EquipmentFlags: {
        floor2EquipmentRegistry: true,
        floor2EquipmentCatalog: true,
        floor2EquipmentEconomy: true,
      },
      simulationOptions: {
        postSystems: [killFirstPresentBossOnce()],
      },
      onFinish: (world) => {
        const familyId = world.floorExtendedState?.familyState?.presentFamilies[0];
        const chestId = familyId ? createBossChestId(familyId) : null;
        const bundle = chestId ? world.generatedEquipmentRewardBundles.get(chestId) : null;
        observedTier = bundle?.tier;
        if (bundle?.instanceKeys[0]) {
          const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]);
          observedRarity = instance?.rarity;
        }
      },
    });

    // The bundle must carry tier4 and the instance rarity must be in the tier4
    // allowed pool — never Common.
    expect(observedTier).toBe('tier4');
    expect(observedRarity).toBeDefined();
    expect(EQUIPMENT_REWARD_TIER_RARITIES.tier4).toContain(observedRarity);
    expect(observedRarity).not.toBe('common');
  });

  it('creates an available Floor 2 boss chest on the real default path (no flag override)', async () => {
    // Regression guard for the shipped-inert failure class (ADR 0034/0036):
    // this intentionally passes NO floor2EquipmentFlags override, so it only
    // passes if initializeFloor2Scenario itself enables floor2EquipmentEconomy
    // in the real production path.
    let observed:
      | { chestCount: number; state: string | undefined; bundleCount: number }
      | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 61 }), {
      seed: 61,
      floorId: 'floor2',
      maxFrames: 5,
      simulationOptions: {
        postSystems: [killFirstPresentBossOnce()],
      },
      onFinish: (world) => {
        const familyId = world.floorExtendedState?.familyState?.presentFamilies[0];
        const chestId = familyId ? createBossChestId(familyId) : null;
        observed = {
          chestCount: world.bossChests.size,
          state: chestId ? world.bossChests.get(chestId)?.state : undefined,
          bundleCount: world.generatedEquipmentRewardBundles.size,
        };
      },
    });

    expect(observed?.chestCount).toBe(1);
    expect(observed?.state).toBe('available');
    expect(observed?.bundleCount).toBeGreaterThanOrEqual(1);
  });

  it('creates a Floor 1 boss chest through the shared resolver on the real pipeline', async () => {
    let result: { created: boolean; reason?: string } | undefined;
    let bossChestCount = -1;

    await runHeadless(new BehaviorTreeAI({ seed: 62 }), {
      seed: 62,
      floorId: 'floor1',
      maxFrames: 1,
      floor2EquipmentFlags: {
        floor2EquipmentRegistry: true,
        floor2EquipmentCatalog: true,
        floor2EquipmentEconomy: true,
      },
      simulationOptions: {
        postSystems: [
          (world) => {
            if (result) return;
            result = spawnBossChestForDefeatedBoss(world, 'floor1-slime-rat-boss');
          },
        ],
      },
      onFinish: (world) => {
        bossChestCount = world.bossChests.size;
      },
    });

    expect(result?.created).toBe(true);
    expect(bossChestCount).toBe(1);
  });
});
