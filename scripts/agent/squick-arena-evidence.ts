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
const TOTAL_FRAMES = 1540;
const EXPECTED_ANNOUNCEMENT = 'UNDERCITY MOB CALL — The guild always collects!';

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
  return { world };
}

function run(label: string, arm: boolean) {
  const { world } = makeWorld();
  const rng = new SeededRandom(42);
  if (arm) {
    const preset = getEnemyPreset('f2-squick');
    const cx = world.floorMap!.widthFt / 2;
    const cy = world.floorMap!.heightFt * 0.35;
    const eids = spawnPresetAroundCenter(world, world.floorMap!, preset, cx, cy, rng, 14);
    if (eids.length === 0) {
      throw new Error('Squick preset failed to spawn any enemies');
    }
  }
  const input = createInputState();
  const telegraphs: Array<{ frame: number; elapsedMs: number }> = [];
  const resolutions: Array<{ frame: number; elapsedMs: number; ownedMinions: number }> = [];
  let prevAnnounceCount = 0;
  let totalResolvedCasts = 0;
  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
    const casts = world.announcements.filter((a) => a.kind === 'bossAbilityCast');
    if (casts.length > prevAnnounceCount) {
      telegraphs.push({ frame: world.frameCount, elapsedMs: round(world.elapsedMs) });
      prevAnnounceCount = casts.length;
    }
    const resolved = [...world.mobAbilities.byEntity.values()].reduce(
      (sum, inst) => sum + inst.resolvedCasts,
      0,
    );
    if (resolved > totalResolvedCasts) {
      const ownedMinions = [...world.mobAbilities.byEntity.values()].reduce(
        (sum, inst) => sum + inst.ownedEntityGenerations.size,
        0,
      );
      resolutions.push({
        frame: world.frameCount,
        elapsedMs: round(world.elapsedMs),
        ownedMinions,
      });
      totalResolvedCasts = resolved;
    }
  }
  const casts = world.announcements.filter((a) => a.kind === 'bossAbilityCast');
  console.log(`\n=== ${label} ===`);
  console.log(`runtime.enabled        : ${world.mobAbilities.enabled}`);
  console.log(`registered casters     : ${world.mobAbilities.byEntity.size}`);
  console.log(
    `telegraph starts (ms)  : ${telegraphs.map((t) => t.elapsedMs).join(', ') || '(none)'}`,
  );
  console.log(`  telegraph frames     : ${telegraphs.map((t) => t.frame).join(', ') || '(none)'}`);
  console.log(
    `resolutions (ms)       : ${resolutions.map((r) => r.elapsedMs).join(', ') || '(none)'}`,
  );
  console.log(`  resolution frames    : ${resolutions.map((r) => r.frame).join(', ') || '(none)'}`);
  console.log(
    `  owned minions @res   : ${resolutions.map((r) => r.ownedMinions).join(', ') || '(none)'}`,
  );
  console.log(`bossAbilityCast events : ${casts.length}`);
  if (casts.length > 0) console.log(`announcement text      : "${casts[0]!.text}"`);
  return { telegraphs, resolutions, casts: casts.length, castsText: casts[0]?.text ?? null };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const arena = run('ARENA (Squick preset — runtime ENABLED)', true);
const normal = run('DEFAULT NORMAL GAME (runtime DEFAULT-OFF)', false);

const arenaOk =
  arena.casts === 2 &&
  arena.castsText === EXPECTED_ANNOUNCEMENT &&
  arena.telegraphs[0]?.frame === 660 &&
  arena.resolutions[0]?.frame === 750 &&
  arena.telegraphs[1]?.frame === 1410 &&
  arena.resolutions[1]?.frame === 1500 &&
  (arena.resolutions[1]?.ownedMinions ?? Number.POSITIVE_INFINITY) <= 6;
const normalOk = normal.casts === 0 && normal.resolutions.length === 0;

console.log('\n=== GATE ===');
console.log(`arena two-cast cadence (660/750/1410/1500)  : ${arenaOk ? 'PASS' : 'FAIL'}`);
console.log(
  `arena second-cast minion cap <= 6           : ${(arena.resolutions[1]?.ownedMinions ?? 0) <= 6 ? 'PASS' : 'FAIL'}`,
);
console.log(`normal-game zero casts                       : ${normalOk ? 'PASS' : 'FAIL'}`);

if (!arenaOk || !normalOk) {
  process.exitCode = 1;
}
