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
import {
  spawnPlayer,
  spawnBehaviorEnemy,
  setEnemyAppearanceKey,
  mobAbilitySystem,
  registerMobAbility,
  setMobAbilitiesEnabled,
  activateMobAbilityEncounter,
  createVerdigrisGlamourDefinition,
} from '../../src/core/index.js';
import { runCoreSimulationStep } from '../../src/core/simulation-core-step.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { enemyAISystem, weaponSystem } from '../../src/game/index.js';

const DELTA = GAME.DELTA_MS;
const QUEEN_KEY = 'faerie-boss';
const TOTAL_FRAMES = 1300; // ~21.7s, past the second resolution at 21,000ms

function makeWorld() {
  const world = createGameWorld({ seed: 42, floor: 1, entityCapacityMode: 'game' });
  const player = spawnPlayer(world, 40, 40);
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const queen = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, queen, QUEEN_KEY);
  return { world, player, queen };
}

function run(label: string, arm: boolean) {
  const { world, queen } = makeWorld();
  if (arm) {
    setMobAbilitiesEnabled(world, true);
    registerMobAbility(world, queen, createVerdigrisGlamourDefinition());
    activateMobAbilityEncounter(world);
  }
  const input = createInputState();
  const telegraphs: Array<{ frame: number; elapsedMs: number }> = [];
  const resolutions: Array<{ frame: number; elapsedMs: number }> = [];
  let prevAnnounce = 0;
  let prevResolved = 0;
  for (let i = 0; i < TOTAL_FRAMES; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, input, {
      preSystems: [weaponSystem, enemyAISystem, mobAbilitySystem],
    });
    const inst = world.mobAbilities.byEntity.get(queen);
    if (inst) {
      if (inst.announcementsEmitted > prevAnnounce) {
        telegraphs.push({ frame: world.frameCount, elapsedMs: round(world.elapsedMs) });
        prevAnnounce = inst.announcementsEmitted;
      }
      if (inst.resolvedCasts > prevResolved) {
        resolutions.push({ frame: world.frameCount, elapsedMs: round(world.elapsedMs) });
        prevResolved = inst.resolvedCasts;
      }
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
