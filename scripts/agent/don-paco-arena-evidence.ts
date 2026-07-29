/**
 * Deterministic evidence harness for Don Paco's THE BIG GOB (issue #1952).
 *
 * Runs the same canonical combat-arena pipeline as the live game/lab and proves:
 *   - arena-enabled run: two telegraphs, two resolutions, two impact waves, and
 *     five slicks per cast at fixed cadence;
 *   - default normal-game run: zero casts over the same duration.
 */
import { createGameWorld } from '../../src/core/world.js';
import { mobAbilitySystem, spawnPlayer, statusEffectSystem } from '../../src/core/index.js';
import { runCoreSimulationStep } from '../../src/core/simulation-core-step.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { enemyAISystem, weaponSystem } from '../../src/game/index.js';
import { SeededRandom } from '../../src/shared/random.js';
import {
  ARENA_OBSERVER_PLAYER_HP,
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../src/labs/combat-arena-lab/arena-data.js';

const DELTA = GAME.DELTA_MS;
const TOTAL_FRAMES = 1300;

function makeWorld() {
  const world = createGameWorld({ seed: 42, floor: 1, entityCapacityMode: 'game' });
  const roomPreset = getRoomPreset('boss-arena');
  world.floorMap = roomPreset.buildMap();
  const spawnWorld = world.floorMap.tileToWorld(
    roomPreset.playerSpawnTile.x,
    roomPreset.playerSpawnTile.y,
  );
  const player = spawnPlayer(world, spawnWorld.x, spawnWorld.y);
  world.stores.health.current[player] = ARENA_OBSERVER_PLAYER_HP;
  world.stores.health.max[player] = ARENA_OBSERVER_PLAYER_HP;
  return world;
}

function run(label: string, arm: boolean) {
  const world = makeWorld();
  if (arm) {
    const preset = getEnemyPreset('f2-don-paco');
    const spawned = spawnPresetAroundCenter(
      world,
      world.floorMap!,
      preset,
      world.floorMap!.widthFt / 2,
      world.floorMap!.heightFt * 0.35,
      new SeededRandom(42),
      14,
    );
    if (spawned.length === 0) {
      throw new Error('Don Paco preset failed to spawn any enemies');
    }
  }
  const telegraphs: number[] = [];
  const resolutions: number[] = [];
  const impacts: number[] = [];
  let prevAnnouncements = 0;
  let prevResolved = 0;
  let prevZones = 0;
  const input = createInputState();
  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
    const casts = world.announcements.filter((event) => event.kind === 'bossAbilityCast');
    if (casts.length > prevAnnouncements) {
      telegraphs.push(world.frameCount);
      prevAnnouncements = casts.length;
    }
    const resolved = [...world.mobAbilities.byEntity.values()].reduce(
      (sum, inst) => sum + inst.resolvedCasts,
      0,
    );
    if (resolved > prevResolved) {
      resolutions.push(world.frameCount);
      prevResolved = resolved;
    }
    if (world.mobAbilities.activeZones.length > prevZones) {
      impacts.push(world.frameCount);
      prevZones = world.mobAbilities.activeZones.length;
    }
    if (world.mobAbilities.activeZones.length === 0) {
      prevZones = 0;
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log(`runtime.enabled        : ${world.mobAbilities.enabled}`);
  console.log(`registered casters     : ${world.mobAbilities.byEntity.size}`);
  console.log(`telegraph frames       : ${telegraphs.join(', ') || '(none)'}`);
  console.log(`resolution frames      : ${resolutions.join(', ') || '(none)'}`);
  console.log(`impact frames          : ${impacts.join(', ') || '(none)'}`);
  console.log(
    `bossAbilityCast events : ${world.announcements.filter((event) => event.kind === 'bossAbilityCast').length}`,
  );
  console.log(`active slicks at end   : ${world.mobAbilities.activeZones.length}`);
  return { telegraphs, resolutions, impacts };
}

const arena = run('ARENA (Don Paco preset — runtime ENABLED)', true);
const normal = run('DEFAULT NORMAL GAME (runtime DEFAULT-OFF)', false);

const arenaOk =
  arena.telegraphs[0] === 540 &&
  arena.resolutions[0] === 624 &&
  arena.impacts[0] === 654 &&
  arena.telegraphs[1] === 1164 &&
  arena.resolutions[1] === 1248 &&
  arena.impacts[1] === 1278;
const normalOk =
  normal.telegraphs.length === 0 && normal.resolutions.length === 0 && normal.impacts.length === 0;

console.log('\n=== GATE ===');
console.log(`arena two-cast cadence (540/624/654/1164/1248/1278) : ${arenaOk ? 'PASS' : 'FAIL'}`);
console.log(`normal-game zero casts                               : ${normalOk ? 'PASS' : 'FAIL'}`);

if (!arenaOk || !normalOk) {
  const nodeGlobal = globalThis as typeof globalThis & { process?: { exitCode?: number } };
  if (nodeGlobal.process) {
    nodeGlobal.process.exitCode = 1;
  }
}
