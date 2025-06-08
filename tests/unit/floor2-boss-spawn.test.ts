import { describe, expect, it } from 'vitest';
import { hasComponent, query } from 'bitecs';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType, RoomRole } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { EnemyProjectile, FamilyMembership, spawnPlayer } from '../../src/core/index.js';
import {
  findBossDenRoom,
  initializeFloor2Bosses,
  spawnFamilyBoss,
  bossDefeatGoalId,
  denUnlockGoalId,
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

  it('beetlefolk-boss: wide sprite (6×3 ft) does not inflate collision radius beyond 1.5 ft', () => {
    // The Broodfather uses a wide (128×64, 6×3 ft) sprite. Without an explicit
    // collisionRadius the spawner would derive max(6, 3) * 0.5 = 3.0 ft, doubling
    // melee reach. The archetype must carry collisionRadius: 1.5 and the spawner
    // must honour it, so the physics footprint matches the 3-ft-tall visual.
    const archetype = floor2EnemyPack.archetypes.find((a) => a.id === 'beetlefolk-boss');
    expect(archetype).toBeDefined();
    expect(archetype!.spriteWidth).toBe(6.0);
    expect(archetype!.spriteHeight).toBe(3.0);
    expect(archetype!.collisionRadius).toBe(1.5);

    // Verify the spawner applies the explicit radius.
    const world = createTestWorld({ floor: 2 });
    const eid = spawnFamilyBoss(world, 0, 0, 0, asFamilyId('beetlefolk'));
    expect(world.stores.size.radius[eid]).toBeCloseTo(1.5);
  });
});
