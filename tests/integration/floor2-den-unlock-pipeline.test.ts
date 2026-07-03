import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  initializeFloor2Bosses,
  floor2ObjectiveTick,
  isFamilySpawnGated,
  isDenUnlocked,
  markDenUnlocked,
  denUnlockGoalId,
  bossDefeatGoalId,
} from '../../src/game/floor2Scenario.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';

/**
 * Slice 4 integration — the full unlock/defeat pipeline end-to-end.
 *
 *   floor init → unlock objective completes → goal flag latches → door opens →
 *   boss reachable → boss dies → boss-defeat flag latches → spawn-gated.
 *
 * Uses a synthesised combat 'death' event to avoid coupling this test to the
 * damage pipeline (unit-tested elsewhere).
 */

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

describe('Floor 2 Slice 4 — den-unlock pipeline', () => {
  it('unlock objective → goal flag → boss death → spawn-gated', () => {
    const seed = 7777;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    const families = loadFamilies();
    const resources = loadResources();
    const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
    world.floor2State = {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    };
    const objectives = initializeFloor2Bosses(world, floorMap, world.floor2State);
    expect(objectives.length).toBe(3);

    const target = objectives[0]!;
    // Initially: den locked, boss alive, family NOT gated.
    expect(isDenUnlocked(world, target.familyId)).toBe(false);
    expect(isFamilySpawnGated(world, target.familyId)).toBe(false);
    expect(world.goalFlags.get(target.unlockGoalId)).toBe(false);
    expect(world.goalFlags.get(target.defeatGoalId)).toBe(false);

    // Simulate objective completion: quest system would set the unlock flag.
    markDenUnlocked(world, target.familyId);
    expect(world.goalFlags.get(denUnlockGoalId(target.familyId))).toBe(true);
    expect(isDenUnlocked(world, target.familyId)).toBe(true);

    // Locate the boss entity and its familyIndex.
    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    const presentIndex = world.floor2State.presentFamilies.indexOf(target.familyId);
    expect(presentIndex).toBeGreaterThanOrEqual(0);
    let bossEid = -1;
    for (let eid = 0; eid < bossField.length; eid++) {
      if (bossField[eid] === 1 && familyIdxField[eid] === presentIndex) {
        bossEid = eid;
        break;
      }
    }
    expect(bossEid).toBeGreaterThan(0);

    // Fabricate a death event; the objective tick should latch the defeat flag.
    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 999,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: bossEid,
    } as (typeof world.combatEvents)[number]);

    floor2ObjectiveTick(world);

    expect(world.goalFlags.get(bossDefeatGoalId(target.familyId))).toBe(true);
    expect(isFamilySpawnGated(world, target.familyId)).toBe(true);

    // Other families remain un-gated.
    for (const other of objectives.slice(1)) {
      expect(isFamilySpawnGated(world, other.familyId)).toBe(false);
    }
  });

  it('is idempotent: repeated ticks + duplicate events do not re-latch or throw', () => {
    const seed = 8;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    const families = loadFamilies();
    const resources = loadResources();
    const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
    world.floor2State = {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    };
    const objectives = initializeFloor2Bosses(world, floorMap, world.floor2State);
    const target = objectives[0]!;
    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    const idx = world.floor2State.presentFamilies.indexOf(target.familyId);
    let bossEid = -1;
    for (let eid = 0; eid < bossField.length; eid++) {
      if (bossField[eid] === 1 && familyIdxField[eid] === idx) {
        bossEid = eid;
        break;
      }
    }
    for (let i = 0; i < 3; i++) {
      world.combatEvents.push({
        type: 'death',
        x: 0,
        y: 0,
        amount: 999,
        targetType: 'enemy',
        timestamp: world.elapsedMs,
        targetEid: bossEid,
      } as (typeof world.combatEvents)[number]);
      floor2ObjectiveTick(world);
    }
    expect(isFamilySpawnGated(world, target.familyId)).toBe(true);
  });
});
