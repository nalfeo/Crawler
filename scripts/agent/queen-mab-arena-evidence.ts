/**
 * Deterministic evidence harness for Queen Mab's Verdigris Glamour (issue #1260).
 *
 * Drives the SAME canonical `runCoreSimulationStep` pipeline the real game and
 * combat-arena lab use, with a fixed simulation step (no wall-clock, no RNG),
 * and prints:
 *   - the arena run: every telegraph-start + resolution timestamp; and
 *   - the default normal-game run: proof of zero casts over the same duration.
 *
 * Run with:  npx tsx scripts/agent/queen-mab-arena-evidence.ts
 */
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
const TOTAL_FRAMES = 1300; // ~21.7s, past the second resolution at 21,000ms

function makeWorld() {
  const world = createGameWorld({ seed: 42, floor: 1, entityCapacityMode: 'game' });
  const roomPreset = getRoomPreset('boss-arena');
  world.floorMap = roomPreset.buildMap();
  const spawnWorld = world.floorMap.tileToWorld(
    roomPreset.playerSpawnTile.x,
    roomPreset.playerSpawnTile.y,
  );
  const player = spawnPlayer(world, spawnWorld.x, spawnWorld.y);
  // Observer HP: shared with the arena lab's passive-observer / immortal-mode
  // setup. The player carries no weapon, so Queen cannot be killed before the
  // second cast and the full cadence is proven deterministically.
  world.stores.health.current[player] = ARENA_OBSERVER_PLAYER_HP;
  world.stores.health.max[player] = ARENA_OBSERVER_PLAYER_HP;
  return { world, player };
}

function run(label: string, arm: boolean) {
  const { world } = makeWorld();
  const rng = new SeededRandom(42);
  if (arm) {
    const preset = getEnemyPreset('f2-queen-mab');
    const cx = world.floorMap!.widthFt / 2;
    const cy = world.floorMap!.heightFt * 0.35;
    const eids = spawnPresetAroundCenter(world, world.floorMap!, preset, cx, cy, rng, 14);
    if (eids.length === 0) {
      throw new Error('Queen Mab preset failed to spawn any enemies');
    }
  }
  const input = createInputState();
  const telegraphs: Array<{ frame: number; elapsedMs: number }> = [];
  const resolutions: Array<{ frame: number; elapsedMs: number }> = [];
  let prevAnnounceCount = 0;
  let totalResolvedCasts = 0;
  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    // Use the combat arena's exact preSystems ordering.
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
    // Count announcements emitted this frame.
    const casts = world.announcements.filter((a) => a.kind === 'bossAbilityCast');
    if (casts.length > prevAnnounceCount) {
      telegraphs.push({ frame: world.frameCount, elapsedMs: round(world.elapsedMs) });
      prevAnnounceCount = casts.length;
    }
    // Count resolved casts from all registered casters.
    const resolved = [...world.mobAbilities.byEntity.values()].reduce(
      (sum, inst) => sum + inst.resolvedCasts,
      0,
    );
    if (resolved > totalResolvedCasts) {
      resolutions.push({ frame: world.frameCount, elapsedMs: round(world.elapsedMs) });
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
  console.log(`bossAbilityCast events : ${casts.length}`);
  if (casts.length > 0) console.log(`announcement text      : "${casts[0]!.text}"`);
  return { telegraphs, resolutions, casts: casts.length };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const arena = run('ARENA (Queen Mab preset — runtime ENABLED)', true);
const normal = run('DEFAULT NORMAL GAME (runtime DEFAULT-OFF)', false);

const arenaOk =
  arena.resolutions.length >= 2 &&
  arena.telegraphs[0]?.frame === 540 &&
  arena.resolutions[0]?.frame === 630 &&
  arena.telegraphs[1]?.frame === 1170 &&
  arena.resolutions[1]?.frame === 1260;
const normalOk = normal.casts === 0 && normal.resolutions.length === 0;

console.log('\n=== GATE ===');
console.log(`arena two-cast cadence (540/630/1170/1260) : ${arenaOk ? 'PASS' : 'FAIL'}`);
console.log(`normal-game zero casts                     : ${normalOk ? 'PASS' : 'FAIL'}`);

if (!arenaOk || !normalOk) {
  process.exitCode = 1;
}
