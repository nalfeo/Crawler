import { createGameWorld } from '../../src/core/world.js';
import { spawnPlayer, mobAbilitySystem, statusEffectSystem } from '../../src/core/index.js';
import { runCoreSimulationStep } from '../../src/core/simulation-core-step.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { enemyAISystem, weaponSystem } from '../../src/game/index.js';
import { SeededRandom } from '../../src/shared/random.js';
import {
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
  ARENA_OBSERVER_PLAYER_HP,
} from '../../src/labs/combat-arena-lab/arena-data.js';

const DELTA = GAME.DELTA_MS;
const TOTAL_FRAMES = 1450;

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

function run(label: string, arm: boolean) {
  const { world, player } = makeWorld();
  const rng = new SeededRandom(42);
  let sovereign = -1;
  if (arm) {
    const preset = getEnemyPreset('f2-sovereign-cap');
    const cx = world.floorMap!.widthFt / 2;
    const cy = world.floorMap!.heightFt * 0.35;
    const eids = spawnPresetAroundCenter(world, world.floorMap!, preset, cx, cy, rng, 14);
    sovereign = eids[0] ?? -1;
    if (sovereign < 0) throw new Error('Sovereign Cap preset failed to spawn');
  }
  const input = createInputState();
  const telegraphs: number[] = [];
  const resolutions: number[] = [];
  const snapshots: Array<{ frame: number; hp: number; zones: number; cues: number }> = [];
  let prevAnnouncements = 0;
  let prevResolved = 0;
  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
    const casts = world.announcements.filter((a) => a.kind === 'bossAbilityCast');
    if (casts.length > prevAnnouncements) {
      telegraphs.push(world.frameCount);
      prevAnnouncements = casts.length;
    }
    if (sovereign >= 0) {
      const inst = world.mobAbilities.byEntity.get(sovereign);
      if (inst && inst.resolvedCasts > prevResolved) {
        resolutions.push(world.frameCount);
        prevResolved = inst.resolvedCasts;
      }
      if (
        world.frameCount === 539 ||
        world.frameCount === 540 ||
        world.frameCount === 636 ||
        world.frameCount === 666 ||
        world.frameCount === 876 ||
        world.frameCount === 1176 ||
        world.frameCount === 1272
      ) {
        snapshots.push({
          frame: world.frameCount,
          hp: world.stores.health.current[player] ?? 0,
          zones: world.mobAbilities.ownedZones.length,
          cues: world.mobAbilities.cues.length,
        });
      }
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log(`runtime.enabled        : ${world.mobAbilities.enabled}`);
  console.log(`registered casters     : ${world.mobAbilities.byEntity.size}`);
  console.log(`telegraph frames       : ${telegraphs.join(', ') || '(none)'}`);
  console.log(`resolution frames      : ${resolutions.join(', ') || '(none)'}`);
  console.log(
    `bossAbilityCast events : ${world.announcements.filter((a) => a.kind === 'bossAbilityCast').length}`,
  );
  for (const snap of snapshots) {
    console.log(
      `snapshot @${snap.frame}: hp=${snap.hp.toFixed(2)} cues=${snap.cues} zones=${snap.zones}`,
    );
  }
  return { telegraphs, resolutions, snapshots, casts: prevAnnouncements };
}

const arena = run('ARENA (Sovereign Cap preset — runtime ENABLED)', true);
const normal = run('DEFAULT NORMAL GAME (runtime DEFAULT-OFF)', false);

const cadenceOk =
  arena.telegraphs[0] === 540 &&
  arena.resolutions[0] === 636 &&
  arena.telegraphs[1] === 1176 &&
  arena.resolutions[1] === 1272;
const firstResolveSnapshot = arena.snapshots.find((s) => s.frame === 636);
const firstTickSnapshot = arena.snapshots.find((s) => s.frame === 666);
const firstExpireSnapshot = arena.snapshots.find((s) => s.frame === 876);
const firstTelegraphSnapshot = arena.snapshots.find((s) => s.frame === 540);
const repeatedDamageOk =
  firstResolveSnapshot !== undefined &&
  firstTickSnapshot !== undefined &&
  firstTickSnapshot.hp < firstResolveSnapshot.hp;
const zoneLifecycleOk =
  firstTelegraphSnapshot?.zones === 0 &&
  firstResolveSnapshot?.zones === 1 &&
  firstExpireSnapshot?.zones === 0;
const normalOk = normal.casts === 0 && normal.resolutions.length === 0;

console.log('\n=== GATE ===');
console.log(`arena two-cast cadence (540/636/1176/1272): ${cadenceOk ? 'PASS' : 'FAIL'}`);
console.log(
  `cloud repeated damage + zone lifecycle      : ${repeatedDamageOk && zoneLifecycleOk ? 'PASS' : 'FAIL'}`,
);
console.log(`normal-game zero casts                      : ${normalOk ? 'PASS' : 'FAIL'}`);

if (!cadenceOk || !repeatedDamageOk || !zoneLifecycleOk || !normalOk) {
  process.exitCode = 1;
}
