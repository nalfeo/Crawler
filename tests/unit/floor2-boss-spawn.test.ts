import { describe, expect, it } from 'vitest';
import { hasComponent, query } from 'bitecs';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType, RoomRole } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  EnemyProjectile,
  FamilyMembership,
  Invincible,
  spawnPlayer,
} from '../../src/core/index.js';
import {
  findBossDenRoom,
  initializeFloor2Bosses,
  spawnFamilyBoss,
  bossDefeatGoalId,
  denUnlockGoalId,
  floor2ObjectiveTick,
  resolveFloor2BossTuning,
  resolveFloor2ArchetypeAIType,
} from '../../src/game/floor2Scenario.js';
import { asFamilyId } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';
import { floor2EnemyPack } from '../../src/shared/enemy-packs.js';
import { AI_TYPE, enemyAISystem } from '../../src/game/enemyAISystem.js';

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

describe('resolveFloor2BossTuning', () => {
  it('resolves the requested hard, medium, and easy anchors', () => {
    expect(resolveFloor2BossTuning(5)).toEqual({ hpScale: 1, contactDamage: 18 });
    expect(resolveFloor2BossTuning(10)).toEqual({ hpScale: 0.6, contactDamage: 12 });
    expect(resolveFloor2BossTuning(12)).toEqual({ hpScale: 0.3, contactDamage: 8 });
  });

  it('interpolates intermediate levels and clamps values outside the anchor range', () => {
    expect(resolveFloor2BossTuning(1)).toEqual(resolveFloor2BossTuning(5));
    expect(resolveFloor2BossTuning(Number.NaN)).toEqual(resolveFloor2BossTuning(5));
    expect(resolveFloor2BossTuning(99)).toEqual(resolveFloor2BossTuning(12));
    expect(resolveFloor2BossTuning(6).hpScale).toBeCloseTo(0.92);
    expect(resolveFloor2BossTuning(6).contactDamage).toBe(17);
    expect(resolveFloor2BossTuning(9).hpScale).toBeCloseTo(0.68);
    expect(resolveFloor2BossTuning(9).contactDamage).toBe(13);
    expect(resolveFloor2BossTuning(11).hpScale).toBeCloseTo(0.45);
    expect(resolveFloor2BossTuning(11).contactDamage).toBe(10);
  });

  it('decreases both durability and pressure monotonically from level 5 through 12', () => {
    let previous = resolveFloor2BossTuning(5);
    for (let level = 6; level <= 12; level += 1) {
      const current = resolveFloor2BossTuning(level);
      expect(current.hpScale).toBeLessThan(previous.hpScale);
      expect(current.contactDamage).toBeLessThan(previous.contactDamage);
      previous = current;
    }
  });
});

describe('spawnFamilyBoss / initializeFloor2Bosses', () => {
  it('spawns exactly one boss per present family, tagged isBoss:1', () => {
    const seed = 1234;
    const gen = new CaveSystemGenerator({ presentCount: 4 });
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
    expect(objectives.length).toBe(roster.presentFamilies.length);

    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    const bossEids: number[] = [];
    const capacity = bossField.length;
    for (let eid = 0; eid < capacity; eid++) {
      if (bossField[eid] === 1 && hasComponent(world.ecs, eid, FamilyMembership)) {
        bossEids.push(eid);
      }
    }
    expect(bossEids.length).toBe(roster.presentFamilies.length);

    // Each boss's familyIndex maps back to a present family.
    const seenIdx = new Set<number>();
    for (const eid of bossEids) {
      const idx = familyIdxField[eid]!;
      expect(idx).toBeLessThan(roster.presentFamilies.length);
      expect(seenIdx.has(idx)).toBe(false);
      seenIdx.add(idx);
    }
  });

  it('seeds unlock + defeat goal flags to false at init', () => {
    const seed = 4321;
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
    initializeFloor2Bosses(world, floorMap, world.floorExtendedState!.familyState!);
    for (const familyId of roster.presentFamilies) {
      expect(world.goalFlags.get(denUnlockGoalId(familyId))).toBe(false);
      expect(world.goalFlags.get(bossDefeatGoalId(familyId))).toBe(false);
    }
  });

  it('is defensive: if the boss den for an index is missing, skips gracefully', () => {
    const seed = 999;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    // Sanity check the generator DID stamp bosses; then confirm findBossDenRoom
    // returns undefined for an out-of-range index (unspawned family).
    for (let i = 0; i < 3; i++) {
      expect(findBossDenRoom(floorMap, i)).toBeDefined();
    }
    expect(findBossDenRoom(floorMap, 99)).toBeUndefined();
    // BOSS_DEN rooms carry the correct role.
    for (const r of floorMap.roomGraph.getAll()) {
      if (r.role === RoomRole.BOSS_DEN) {
        expect(r.familyIndex).toBeDefined();
      }
    }
  });

  it('spawnFamilyBoss throws when no archetype is registered for the family', () => {
    const world = createTestWorld({ seed: 1, floor: 2 });
    expect(() => spawnFamilyBoss(world, 10, 10, 0, asFamilyId('no-such-family'))).toThrow();
  });

  it.each([
    { level: 5, hpScale: 1, contactDamage: 18 },
    { level: 10, hpScale: 0.6, contactDamage: 12 },
    { level: 12, hpScale: 0.3, contactDamage: 8 },
  ])(
    'applies level $level tuning to every authored family boss',
    ({ level, hpScale, contactDamage }) => {
      const world = createTestWorld({ seed: 1, floor: 2 });
      world.playerLevel.level = level;
      const bosses = floor2EnemyPack.archetypes.filter(
        (archetype) => archetype.isBoss === true && archetype.familyId !== undefined,
      );

      for (const [familyIndex, archetype] of bosses.entries()) {
        const eid = spawnFamilyBoss(
          world,
          familyIndex * 10,
          0,
          familyIndex,
          asFamilyId(archetype.familyId!),
        );
        const expectedHp = Math.max(1, Math.round(archetype.hp * hpScale));
        expect(world.stores.health.current[eid]).toBe(expectedHp);
        expect(world.stores.health.max[eid]).toBe(expectedHp);
        expect(world.stores.damage.amount[eid]).toBe(contactDamage);
      }
    },
  );

  it.each([
    { level: 5, hpScale: 1, contactDamage: 18 },
    { level: 10, hpScale: 0.6, contactDamage: 12 },
    { level: 12, hpScale: 0.3, contactDamage: 8 },
  ])(
    'locks level $level tuning when the production den encounter starts',
    ({ level, hpScale, contactDamage }) => {
      const seed = 1234;
      const gen = new CaveSystemGenerator({ presentCount: 4 });
      const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
      const world = createTestWorld({ seed, floor: 2 });
      const families = loadFamilies();
      const resources = loadResources();
      const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
      world.floorMap = floorMap;
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [...roster.presentFamilies],
          contestedResource: roster.contestedResource,
          betrayerFlag: false,
        },
      };
      world.playerLevel.level = 5;
      initializeFloor2Bosses(world, floorMap, world.floorExtendedState.familyState!);

      const familyId = roster.presentFamilies[0]!;
      const encounter = world.floorExtendedState.familyState!.bossEncounters!.get(familyId)!;
      const bossEid = encounter.bossEid!;
      const archetype = floor2EnemyPack.archetypes.find(
        (candidate) => candidate.isBoss === true && candidate.familyId === familyId,
      )!;
      const denRoom = findBossDenRoom(floorMap, 0)!;
      const spawnTile = denRoom.interiorCells?.[0] ?? {
        x: denRoom.bounds.x + Math.floor(denRoom.bounds.width / 2),
        y: denRoom.bounds.y + Math.floor(denRoom.bounds.height / 2),
      };
      const playerPosition = floorMap.tileToWorld(spawnTile.x, spawnTile.y);
      spawnPlayer(world, playerPosition.x, playerPosition.y);
      world.playerLevel.level = level;
      world.goalFlags.set(denUnlockGoalId(familyId), true);

      expect(hasComponent(world.ecs, bossEid, Invincible)).toBe(true);
      floor2ObjectiveTick(world);

      const expectedHp = Math.max(1, Math.round(archetype.hp * hpScale));
      expect(encounter.started).toBe(true);
      expect(hasComponent(world.ecs, bossEid, Invincible)).toBe(false);
      expect(world.stores.health.current[bossEid]).toBe(expectedHp);
      expect(world.stores.health.max[bossEid]).toBe(expectedHp);
      expect(world.stores.damage.amount[bossEid]).toBe(contactDamage);

      world.stores.health.current[bossEid] = 1;
      world.playerLevel.level = level === 12 ? 5 : 12;
      floor2ObjectiveTick(world);
      expect(world.stores.health.current[bossEid]).toBe(1);
      expect(world.stores.health.max[bossEid]).toBe(expectedHp);
      expect(world.stores.damage.amount[bossEid]).toBe(contactDamage);
    },
  );

  it('routes ranged Floor 2 archetypes into the existing ranged combat AI', () => {
    const ranged = floor2EnemyPack.archetypes.find((archetype) => archetype.aiType === 'ranged');
    const chase = floor2EnemyPack.archetypes.find((archetype) => archetype.aiType === 'chase');
    expect(ranged).toBeDefined();
    expect(chase).toBeDefined();
    expect(resolveFloor2ArchetypeAIType(ranged!)).toBe(AI_TYPE.RANGED);
    expect(resolveFloor2ArchetypeAIType(chase!)).toBe(AI_TYPE.CHASE);
  });

  it('spawns a ranged family boss that attacks the player', () => {
    const world = createTestWorld({ floor: 2 });
    world.elapsedMs = 100;
    spawnPlayer(world, 0, 0);
    spawnFamilyBoss(world, 50, 0, 0, asFamilyId('llamas'));

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(1);
  });

  it('does not give chase bosses a ranged projectile attack', () => {
    const world = createTestWorld({ floor: 2 });
    world.elapsedMs = 100;
    spawnPlayer(world, 0, 0);
    spawnFamilyBoss(world, 50, 0, 0, asFamilyId('goblins'));

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
  });
});
