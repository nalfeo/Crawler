import { createGameWorld } from '../../src/core/world.js';
import {
  activateMobAbilityEncounter,
  createTongueRepossessionDefinition,
  type MobAbilityLaneGeometry,
  mobAbilitySystem,
  registerMobAbility,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
  statusEffectSystem,
} from '../../src/core/index.js';
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
import { AI_TYPE } from '../../src/game/enemyAISystem.js';

const DELTA = GAME.DELTA_MS;
const TOTAL_FRAMES = 1200;
const TELEGRAPH_1 = 480;
const RESOLUTION_1 = 555;
const TELEGRAPH_2 = 1035;
const RESOLUTION_2 = 1110;
const EXPECTED_TEXT = "TONGUE REPOSSESSION — Big Mama wants what's hers!";

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
  return { world, player };
}

function runArenaCadence() {
  const { world } = makeWorld();
  const preset = getEnemyPreset('f2-big-mama-bufo');
  const rng = new SeededRandom(42);
  const cx = world.floorMap!.widthFt / 2;
  const cy = world.floorMap!.heightFt * 0.35;
  const spawned = spawnPresetAroundCenter(world, world.floorMap!, preset, cx, cy, rng, 14);
  const bufo = spawned[0];
  if (bufo === undefined) throw new Error('Big Mama Bufo preset failed to spawn');
  const input = createInputState();
  const telegraphs: number[] = [];
  const resolutions: number[] = [];
  let prevAnnouncements = 0;
  let prevResolved = 0;
  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
    const castEvents = world.announcements.filter((entry) => entry.kind === 'bossAbilityCast');
    if (castEvents.length > prevAnnouncements) {
      telegraphs.push(world.frameCount);
      prevAnnouncements = castEvents.length;
    }
    const inst = world.mobAbilities.byEntity.get(bufo);
    if (inst && inst.resolvedCasts > prevResolved) {
      resolutions.push(world.frameCount);
      prevResolved = inst.resolvedCasts;
    }
  }
  return { world, bufo, telegraphs, resolutions };
}

function runNormalDefaultOff() {
  const { world, player } = makeWorld();
  const bufo = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, bufo, 'toadkin-boss');
  world.stores.position.x[player] = 40;
  world.stores.position.y[player] = 40;
  const input = createInputState();
  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
  }
  return world;
}

function runHitAndMissLaneProof() {
  const hitWorld = createGameWorld({ seed: 42, floor: 1, entityCapacityMode: 'game' });
  const hitPlayer = spawnPlayer(hitWorld, 40, 40);
  hitWorld.stores.health.current[hitPlayer] = 100_000;
  hitWorld.stores.health.max[hitPlayer] = 100_000;
  const hitBufo = spawnBehaviorEnemy(hitWorld, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(hitWorld, hitBufo, 'toadkin-boss');
  setMobAbilitiesEnabled(hitWorld, true);
  registerMobAbility(hitWorld, hitBufo, createTongueRepossessionDefinition());
  activateMobAbilityEncounter(hitWorld);
  for (let i = 0; i < RESOLUTION_1; i += 1) {
    hitWorld.frameCount += 1;
    hitWorld.elapsedMs += DELTA;
    statusEffectSystem(hitWorld);
    mobAbilitySystem(hitWorld);
  }
  const hitPos = {
    x: hitWorld.stores.position.x[hitPlayer] ?? 0,
    y: hitWorld.stores.position.y[hitPlayer] ?? 0,
  };

  const missWorld = createGameWorld({ seed: 42, floor: 1, entityCapacityMode: 'game' });
  const missPlayer = spawnPlayer(missWorld, 40, 40);
  missWorld.stores.health.current[missPlayer] = 100_000;
  missWorld.stores.health.max[missPlayer] = 100_000;
  const missBufo = spawnBehaviorEnemy(missWorld, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(missWorld, missBufo, 'toadkin-boss');
  setMobAbilitiesEnabled(missWorld, true);
  registerMobAbility(missWorld, missBufo, createTongueRepossessionDefinition());
  activateMobAbilityEncounter(missWorld);
  for (let i = 0; i < TELEGRAPH_1; i += 1) {
    missWorld.frameCount += 1;
    missWorld.elapsedMs += DELTA;
    statusEffectSystem(missWorld);
    mobAbilitySystem(missWorld);
  }
  const committedGeometry = missWorld.mobAbilities.byEntity.get(missBufo)?.committedGeometry;
  if (committedGeometry?.kind !== 'lane') {
    throw new Error('expected a committed lane before sidestep evidence capture');
  }
  const laneBeforeSidestep: MobAbilityLaneGeometry = { ...committedGeometry };
  missWorld.stores.position.x[missPlayer] = 55;
  missWorld.stores.position.y[missPlayer] = 40;
  for (let i = TELEGRAPH_1; i < RESOLUTION_1; i += 1) {
    missWorld.frameCount += 1;
    missWorld.elapsedMs += DELTA;
    statusEffectSystem(missWorld);
    mobAbilitySystem(missWorld);
  }
  return {
    hitPos,
    missPos: {
      x: missWorld.stores.position.x[missPlayer] ?? 0,
      y: missWorld.stores.position.y[missPlayer] ?? 0,
    },
    laneBeforeSidestep,
  };
}

const arena = runArenaCadence();
const normal = runNormalDefaultOff();
const laneProof = runHitAndMissLaneProof();
const arenaCasts = arena.world.announcements.filter((entry) => entry.kind === 'bossAbilityCast');

console.log('=== ARENA (f2-big-mama-bufo) ===');
console.log(`telegraph frames: ${arena.telegraphs.join(', ')}`);
console.log(`resolution frames: ${arena.resolutions.join(', ')}`);
console.log(`announcement text: ${arenaCasts[0]?.text ?? '(none)'}`);

console.log('\n=== LANE PROOF ===');
console.log(
  `hit pull position: (${laneProof.hitPos.x.toFixed(3)}, ${laneProof.hitPos.y.toFixed(3)})`,
);
console.log(
  `miss kept sidestep: (${laneProof.missPos.x.toFixed(3)}, ${laneProof.missPos.y.toFixed(3)})`,
);
console.log(`locked lane before sidestep: ${JSON.stringify(laneProof.laneBeforeSidestep)}`);

console.log('\n=== DEFAULT NORMAL GAME (runtime OFF) ===');
console.log(`runtime.enabled: ${normal.mobAbilities.enabled}`);
console.log(
  `bossAbilityCast events: ${normal.announcements.filter((entry) => entry.kind === 'bossAbilityCast').length}`,
);

const cadenceOk =
  arena.telegraphs[0] === TELEGRAPH_1 &&
  arena.resolutions[0] === RESOLUTION_1 &&
  arena.telegraphs[1] === TELEGRAPH_2 &&
  arena.resolutions[1] === RESOLUTION_2;
const laneOk =
  Math.abs(laneProof.hitPos.x - 40) < 1e-6 &&
  Math.abs(laneProof.hitPos.y - 15) < 1e-6 &&
  Math.abs(laneProof.missPos.x - 55) < 1e-6 &&
  Math.abs(laneProof.missPos.y - 40) < 1e-6;
const normalOk =
  normal.mobAbilities.enabled === false &&
  normal.announcements.filter((entry) => entry.kind === 'bossAbilityCast').length === 0;
const announcementOk =
  arenaCasts.length === 2 && arenaCasts.every((event) => event.text === EXPECTED_TEXT);

console.log('\n=== GATE ===');
console.log(`arena two-cast cadence (480/555/1035/1110): ${cadenceOk ? 'PASS' : 'FAIL'}`);
console.log(`lane lock + hit/miss behavior consistency   : ${laneOk ? 'PASS' : 'FAIL'}`);
console.log(`normal-game zero casts                       : ${normalOk ? 'PASS' : 'FAIL'}`);

if (!cadenceOk || !laneOk || !normalOk || !announcementOk) {
  process.exitCode = 1;
}
