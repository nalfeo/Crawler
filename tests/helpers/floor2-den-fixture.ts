/**
 * Deterministic Floor 2 den fixture — the shared seed-42 scenario used by the
 * den-boss telemetry contract tests.
 *
 * Builds a REAL Floor 2 world (cave map, den rooms, locked den doors, spawned
 * family bosses) via the production `initializeFloor2Bosses`, then drives the
 * production `doorSystem` / `floor2ObjectiveTick` so lifecycle transitions come
 * from real systems rather than hand-poked latches.
 */
import { removeEntity } from 'bitecs';
import { spawnPlayer } from '../../src/core/index.js';
import {
  floor2ObjectiveTick,
  initializeFloor2Bosses,
  markDenUnlocked,
} from '../../src/game/floor2Scenario.js';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import {
  asFamilyId,
  selectFloor2Roster,
  type Floor2FamilyBossEncounterState,
} from '../../src/core/faction-relations.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import type { GameWorld } from '../../src/core/world.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import { BiomeType, type MapConfig } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { createTestWorld } from './world-factory.js';

/** The seed from issue #3093 — Floor 2 seed 42, the Queen Mab den softlock. */
export const FLOOR2_DEN_FIXTURE_SEED = 42;

export interface Floor2DenFixture {
  world: GameWorld;
  playerEid: number;
  /** The first present family's den encounter — the fixture's subject. */
  encounter: Floor2FamilyBossEncounterState;
}

function caveConfig(seed: number): MapConfig {
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

/**
 * Create the deterministic Floor 2 den world. Identical for a given seed, so
 * every telemetry surface can be driven over the same world state.
 */
export function createFloor2DenFixture(seed = FLOOR2_DEN_FIXTURE_SEED): Floor2DenFixture {
  const generator = new CaveSystemGenerator({ presentCount: 4 });
  const floorMap = generator.generate(caveConfig(seed), new SeededRandom(seed));
  const world = createTestWorld({ seed, floor: 2 });
  world.floorId = 'floor2';
  world.floorMap = floorMap;

  const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources());
  const familyState = {
    presentFamilies: [...roster.presentFamilies],
    contestedResource: roster.contestedResource,
    betrayerFlag: false,
  };
  world.floorExtendedState = { familyState };

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  const playerEid = spawnPlayer(world, spawn.x, spawn.y);

  initializeFloor2Bosses(world, floorMap, familyState);

  const familyId = familyState.presentFamilies[0]!;
  const encounter = world.floorExtendedState.familyState!.bossEncounters!.get(familyId)!;
  return { world, playerEid, encounter };
}

/** Advance the production Floor 2 systems by one frame. */
export function stepFloor2(world: GameWorld, deltaMs = 16): void {
  world.elapsedMs += deltaMs;
  world.frameCount += 1;
  doorSystem(world);
  floor2ObjectiveTick(world);
}

/** Teleport an entity to a tile centre. */
export function moveToTile(world: GameWorld, eid: number, tileX: number, tileY: number): void {
  const point = world.floorMap!.tileToWorld(tileX, tileY);
  world.stores.position.x[eid] = point.x;
  world.stores.position.y[eid] = point.y;
}

/**
 * Move an entity into its den room. Cave-system rooms are irregular (no
 * rectangular bounds), so the boss's own spawn point is the reliable
 * in-den anchor.
 */
export function moveIntoDen(
  world: GameWorld,
  eid: number,
  encounter: Floor2FamilyBossEncounterState,
): void {
  world.stores.position.x[eid] = encounter.bossSpawnX ?? 0;
  world.stores.position.y[eid] = encounter.bossSpawnY ?? 0;
}

/**
 * Drive the fixture through the full den lifecycle using the production
 * systems: den unlock → player enters the den (the real objective tick starts
 * the encounter) → boss steps outside its den → boss returns → boss death event
 * (the real objective tick latches `defeated` and clears `bossEid`).
 *
 * `onFrame` is invoked after every simulated frame so a telemetry surface can
 * observe exactly the same sequence of world states.
 */
export function driveDenLifecycle(
  fixture: Floor2DenFixture,
  onFrame: (frame: number) => void,
  framesPerPhase = 2,
): number {
  const { world, playerEid, encounter } = fixture;
  let frames = 0;
  const step = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      stepFloor2(world);
      frames += 1;
      onFrame(frames);
    }
  };

  step(framesPerPhase);
  markDenUnlocked(world, asFamilyId(encounter.familyId));
  step(framesPerPhase);

  moveIntoDen(world, playerEid, encounter);
  step(framesPerPhase);

  const bossEid = encounter.bossEid;
  if (bossEid !== null) {
    // Boss wanders out of its den (the softlock signature from issue #3093) …
    moveToTile(world, bossEid, world.floorMap!.playerSpawn.x, world.floorMap!.playerSpawn.y);
    step(framesPerPhase);
    // … then comes home …
    moveIntoDen(world, bossEid, encounter);
    step(framesPerPhase);
    // … and finally dies. The real objective tick consumes this death event.
    world.combatEvents.push({
      type: 'death',
      x: world.stores.position.x[bossEid] ?? 0,
      y: world.stores.position.y[bossEid] ?? 0,
      amount: 0,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: bossEid,
      familyIndex: world.stores.familyMembership.familyId[bossEid] ?? 0,
      isBoss: 1,
      sourceEid: playerEid,
    });
    step(1);
    removeEntity(world.ecs, bossEid);
    step(framesPerPhase);
  }

  return frames;
}
