/**
 * Deterministic evidence harness for Overseer Fizzwick's Clockwork Kill-Saw.
 *
 * Drives the SAME canonical `runCoreSimulationStep` pipeline the live combat
 * arena uses and prints both:
 *   - the armed arena preset's two-cast cadence / phase checkpoints; and
 *   - the default normal-game configuration's zero-cast proof over the same duration.
 *
 * Run with: npx tsx scripts/agent/overseer-fizzwick-arena-evidence.ts
 */
import { createGameWorld } from '../../src/core/world.js';
import { spawnPlayer, mobAbilitySystem, statusEffectSystem } from '../../src/core/index.js';
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
const TOTAL_FRAMES = 1430;
const EXPECTED_TELEGRAPHS = [540, 1240];
const EXPECTED_RESOLUTIONS = [700, 1400];

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

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function run(label: string, arm: boolean) {
  const { world } = makeWorld();
  let casterEid: number | null = null;
  if (arm) {
    const preset = getEnemyPreset('f2-overseer-fizzwick');
    const rng = new SeededRandom(42);
    const cx = world.floorMap!.widthFt / 2;
    const cy = world.floorMap!.heightFt * 0.35;
    const eids = spawnPresetAroundCenter(world, world.floorMap!, preset, cx, cy, rng, 14);
    casterEid = eids[0] ?? null;
    if (casterEid === null) throw new Error('Overseer Fizzwick preset failed to spawn');
  }
  const input = createInputState();
  const telegraphs: Array<{ frame: number; elapsedMs: number }> = [];
  const resolutions: Array<{ frame: number; elapsedMs: number }> = [];
  const phases: Array<{ frame: number; phase: string; projectileY: number | null }> = [];
  let prevCastCount = 0;
  let prevResolved = 0;
  let prevPhase: string | null = null;

  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
    const castCount = world.announcements.filter((a) => a.kind === 'bossAbilityCast').length;
    if (castCount > prevCastCount) {
      telegraphs.push({ frame: world.frameCount, elapsedMs: round(world.elapsedMs) });
      prevCastCount = castCount;
    }
    const inst = casterEid !== null ? world.mobAbilities.byEntity.get(casterEid) : undefined;
    const resolved = inst?.resolvedCasts ?? 0;
    if (resolved > prevResolved) {
      resolutions.push({ frame: world.frameCount, elapsedMs: round(world.elapsedMs) });
      prevResolved = resolved;
    }
    const cue = world.mobAbilities.cues[0];
    const phase = cue?.phase ?? null;
    if (phase !== null && phase !== prevPhase) {
      phases.push({
        frame: world.frameCount,
        phase,
        projectileY: cue?.projectileY ?? null,
      });
    }
    prevPhase = phase;
  }

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
    `phase checkpoints      : ${
      phases
        .map(
          (entry) =>
            `${entry.phase}@${entry.frame}${entry.projectileY === null ? '' : ` y=${round(entry.projectileY)}`}`,
        )
        .join(', ') || '(none)'
    }`,
  );
  console.log(
    `bossAbilityCast events : ${world.announcements.filter((a) => a.kind === 'bossAbilityCast').length}`,
  );
  return { telegraphs, resolutions, phases, casts: prevCastCount };
}

const arena = run('ARENA (Overseer Fizzwick preset — runtime ENABLED)', true);
const normal = run('DEFAULT NORMAL GAME (runtime DEFAULT-OFF)', false);

const arenaOk =
  arena.telegraphs[0]?.frame === EXPECTED_TELEGRAPHS[0] &&
  arena.telegraphs[1]?.frame === EXPECTED_TELEGRAPHS[1] &&
  arena.resolutions[0]?.frame === EXPECTED_RESOLUTIONS[0] &&
  arena.resolutions[1]?.frame === EXPECTED_RESOLUTIONS[1];
const normalOk =
  normal.casts === 0 && normal.resolutions.length === 0 && normal.phases.length === 0;

console.log('\n=== GATE ===');
console.log(`arena two-cast cadence (540/700/1240/1400) : ${arenaOk ? 'PASS' : 'FAIL'}`);
console.log(`normal-game zero casts                    : ${normalOk ? 'PASS' : 'FAIL'}`);

if (!arenaOk || !normalOk) {
  process.exitCode = 1;
}
