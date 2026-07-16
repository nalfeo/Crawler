import { describe, expect, it } from 'vitest';
import { hasComponent, removeComponent } from 'bitecs';
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
import { loadDenUnlockArchetypes } from '../../src/shared/data/den-unlock-archetypes.js';
import { acceptQuest, questSystem } from '../../src/core/systems/questSystem.js';
import {
  FamilyMembership,
  Invincible,
  applyDamage,
  DEFAULT_DAMAGE_OPTIONS,
  spawnEnemy,
  spawnPlayer,
} from '../../src/core/index.js';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { enemyAISystem } from '../../src/game/enemyAISystem.js';
import { familyFeudSystem, getFamilyAIDecision } from '../../src/game/systems/familyFeudSystem.js';

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
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const objectives = initializeFloor2Bosses(
      world,
      floorMap,
      world.floorExtendedState!.familyState!,
    );
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

    world.floorMap = floorMap;
    const encounter = world.floorExtendedState!.familyState!.bossEncounters!.get(target.familyId)!;
    doorSystem(world);
    for (const doorEid of encounter.doorEids) {
      expect(world.stores.doorState.isLocked[doorEid]).toBe(0);
      expect(world.stores.doorState.logicalOpen[doorEid]).toBe(1);
    }
    const denRoom = floorMap.roomGraph.get(encounter.roomId);
    expect(denRoom).toBeDefined();
    const denTile = denRoom!.interiorCells?.[0] ?? {
      x: denRoom!.bounds.x + 1,
      y: denRoom!.bounds.y + 1,
    };
    const playerPos = floorMap.tileToWorld(denTile.x, denTile.y);
    const playerEid = spawnPlayer(world, playerPos.x, playerPos.y);
    const bossHpBeforeEntry = world.stores.health.current[encounter.bossEid!] ?? 0;
    expect(hasComponent(world.ecs, encounter.bossEid!, Invincible)).toBe(true);
    expect(
      applyDamage(
        world,
        encounter.bossEid!,
        bossHpBeforeEntry,
        world.stores.position.x[encounter.bossEid!] ?? 0,
        world.stores.position.y[encounter.bossEid!] ?? 0,
        {
          ...DEFAULT_DAMAGE_OPTIONS,
          origin: 'player',
          sourceX: playerPos.x,
          sourceY: playerPos.y,
          sourceEid: playerEid,
        },
      ),
    ).toBe(0);
    expect(world.stores.health.current[encounter.bossEid!]).toBe(bossHpBeforeEntry);
    enemyAISystem(world);
    expect(world.stores.velocity.x[encounter.bossEid!]).toBe(0);
    expect(world.stores.velocity.y[encounter.bossEid!]).toBe(0);
    floor2ObjectiveTick(world);
    doorSystem(world);
    expect(encounter.started).toBe(true);
    expect(hasComponent(world.ecs, encounter.bossEid!, Invincible)).toBe(false);
    expect(
      applyDamage(
        world,
        encounter.bossEid!,
        1,
        world.stores.position.x[encounter.bossEid!] ?? 0,
        world.stores.position.y[encounter.bossEid!] ?? 0,
        {
          ...DEFAULT_DAMAGE_OPTIONS,
          origin: 'player',
          sourceX: playerPos.x,
          sourceY: playerPos.y,
          sourceEid: playerEid,
        },
      ),
    ).toBeGreaterThan(0);
    expect(world.stores.health.current[encounter.bossEid!]).toBe(bossHpBeforeEntry - 1);
    expect(world.stores.enemyBehavior.aggroedPermanently[encounter.bossEid!]).toBe(1);
    world.factionRelations.set(target.familyId, 50);
    familyFeudSystem(world);
    enemyAISystem(world);
    expect(getFamilyAIDecision(world, encounter.bossEid!)).toBeUndefined();
    expect(
      Math.hypot(
        world.stores.velocity.x[encounter.bossEid!] ?? 0,
        world.stores.velocity.y[encounter.bossEid!] ?? 0,
      ),
    ).toBeGreaterThan(0);
    expect(world.goalFlags.get(encounter.activeGoalId)).toBe(true);
    for (const doorEid of encounter.doorEids) {
      expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
      expect(world.stores.doorState.logicalOpen[doorEid]).toBe(0);
    }

    // Locate the boss entity and its familyIndex.
    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    const presentIndex = world.floorExtendedState!.familyState!.presentFamilies.indexOf(
      target.familyId,
    );
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
      familyIndex: presentIndex,
      isBoss: 1,
    } as (typeof world.combatEvents)[number]);

    floor2ObjectiveTick(world);
    doorSystem(world);

    expect(world.goalFlags.get(bossDefeatGoalId(target.familyId))).toBe(true);
    expect(isFamilySpawnGated(world, target.familyId)).toBe(true);
    expect(encounter.defeated).toBe(true);
    expect(world.goalFlags.get(encounter.activeGoalId)).toBe(false);
    for (const doorEid of encounter.doorEids) {
      expect(world.stores.doorState.isLocked[doorEid]).toBe(0);
      expect(world.stores.doorState.logicalOpen[doorEid]).toBe(1);
    }

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
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const objectives = initializeFloor2Bosses(
      world,
      floorMap,
      world.floorExtendedState!.familyState!,
    );
    const target = objectives[0]!;
    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    const idx = world.floorExtendedState!.familyState!.presentFamilies.indexOf(target.familyId);
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
        familyIndex: idx,
        isBoss: 1,
      } as (typeof world.combatEvents)[number]);
      floor2ObjectiveTick(world);
    }
    expect(isFamilySpawnGated(world, target.familyId)).toBe(true);
  });

  it('still latches boss defeat from death events even if membership component is removed first', () => {
    const seed = 11;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    const families = loadFamilies();
    const resources = loadResources();
    const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const floor2State = world.floorExtendedState?.familyState;
    expect(floor2State).toBeDefined();
    const objectives = initializeFloor2Bosses(world, floorMap, floor2State!);
    const target = objectives[0]!;

    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    const idx = floor2State!.presentFamilies.indexOf(target.familyId);
    let bossEid = -1;
    for (let eid = 0; eid < bossField.length; eid++) {
      if (bossField[eid] === 1 && familyIdxField[eid] === idx) {
        bossEid = eid;
        break;
      }
    }
    expect(bossEid).toBeGreaterThan(0);

    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 999,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: bossEid,
      familyIndex: idx,
      isBoss: 1,
    } as (typeof world.combatEvents)[number]);
    removeComponent(world.ecs, bossEid, FamilyMembership);
    floor2ObjectiveTick(world);

    expect(world.goalFlags.get(bossDefeatGoalId(target.familyId))).toBe(true);
    expect(isFamilySpawnGated(world, target.familyId)).toBe(true);
  });

  it('requires the production player-attributed family kill target and ignores non-player kills', () => {
    const seed = 99;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    const families = loadFamilies();
    const resources = loadResources();
    const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const floor2State = world.floorExtendedState?.familyState;
    expect(floor2State).toBeDefined();
    const objectives = initializeFloor2Bosses(world, floorMap, floor2State!);
    const target = objectives[0]!;
    const killTarget = loadDenUnlockArchetypes().find(
      (archetype) => archetype.kind === 'killTargets',
    )?.killTarget;
    expect(killTarget).toBe(50);
    if (killTarget === undefined) {
      throw new Error('Expected a production Floor 2 kill-target archetype');
    }
    expect(acceptQuest(world, target.questId)).toBeTruthy();
    const playerEid = spawnPlayer(world, 0, 0);
    const enemySourceEid = spawnEnemy(world, 0, 0, 10);

    const familyIdxField = world.stores.familyMembership.familyId;
    const bossField = world.stores.familyMembership.isBoss;
    const presentIndex = floor2State!.presentFamilies.indexOf(target.familyId);
    let trashEid = -1;
    for (let eid = 0; eid < bossField.length; eid++) {
      if (bossField[eid] === 0 && familyIdxField[eid] === presentIndex) {
        trashEid = eid;
        break;
      }
    }
    expect(trashEid).toBeGreaterThanOrEqual(0);

    const pushTrashDeath = (sourceEid: number, sequence: number): void => {
      world.combatEvents.push({
        type: 'death',
        x: 0,
        y: 0,
        amount: 999,
        targetType: 'enemy',
        timestamp: world.elapsedMs + sequence,
        targetEid: trashEid,
        sourceEid,
        familyIndex: presentIndex,
        isBoss: 0,
      } as (typeof world.combatEvents)[number]);
      floor2ObjectiveTick(world);
    };

    pushTrashDeath(enemySourceEid, 0);
    expect(floor2State!.trashKillsByFamily?.get(target.familyId)).toBe(0);
    for (let i = 1; i < killTarget; i += 1) {
      pushTrashDeath(playerEid, i);
    }
    expect(floor2State!.trashKillsByFamily?.get(target.familyId)).toBe(killTarget - 1);
    expect(world.goalFlags.get(denUnlockGoalId(target.familyId))).toBe(false);

    pushTrashDeath(playerEid, killTarget);
    questSystem(world);
    floor2ObjectiveTick(world);
    expect(floor2State!.trashKillsByFamily?.get(target.familyId)).toBe(killTarget);
    expect(world.goalFlags.get(denUnlockGoalId(target.familyId))).toBe(true);

    world.combatEvents.length = 0;
    pushTrashDeath(playerEid, killTarget + 1);
    expect(floor2State!.trashKillsByFamily?.get(target.familyId)).toBe(killTarget + 1);

    const retainedEvents = world.combatEvents;
    let numericEventReads = 0;
    world.combatEvents = new Proxy(retainedEvents, {
      get(targetEvents, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) numericEventReads += 1;
        return Reflect.get(targetEvents, property, receiver);
      },
    });
    floor2ObjectiveTick(world);
    expect(numericEventReads).toBeLessThanOrEqual(2);
  });

  it('ignores death events that are missing family metadata and membership', () => {
    const seed = 123;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    const families = loadFamilies();
    const resources = loadResources();
    const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const floor2State = world.floorExtendedState?.familyState;
    expect(floor2State).toBeDefined();
    const objectives = initializeFloor2Bosses(world, floorMap, floor2State!);
    const target = objectives[0]!;
    expect(acceptQuest(world, target.questId)).toBeTruthy();

    for (let i = 0; i < 12; i += 1) {
      world.combatEvents.push({
        type: 'death',
        x: 0,
        y: 0,
        amount: 1,
        targetType: 'enemy',
        timestamp: world.elapsedMs + i,
        targetEid: 900 + i,
      } as (typeof world.combatEvents)[number]);
      floor2ObjectiveTick(world);
    }

    expect(world.goalFlags.get(denUnlockGoalId(target.familyId))).toBe(false);
  });
});
