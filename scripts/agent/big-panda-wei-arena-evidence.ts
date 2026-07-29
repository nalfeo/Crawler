import { createGameWorld } from '../../src/core/world.js';
import { spawnPlayer, mobAbilitySystem, statusEffectSystem } from '../../src/core/index.js';
import {
  getMobAbilityKnockbackResistanceMultiplier,
  getMobAbilityMeleeDamageMultiplier,
  getMobAbilityMovementSpeedMultiplier,
} from '../../src/core/mob-abilities/runtime.js';
import { runCoreSimulationStep } from '../../src/core/simulation-core-step.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { enemyAISystem, weaponSystem } from '../../src/game/index.js';
import { SeededRandom } from '../../src/shared/random.js';
import {
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
  spawnFromArchetype,
  findWalkablePosition,
  ARENA_OBSERVER_PLAYER_HP,
} from '../../src/labs/combat-arena-lab/arena-data.js';
import { floor2EnemyPack } from '../../src/shared/enemy-packs.js';

const DELTA = GAME.DELTA_MS;
const TOTAL_FRAMES = 1660;

// Big Panda Wei's floor-2 archetype, same as used by the arena preset internally
const F2_BIG_PANDA_WEI = floor2EnemyPack.archetypes.find((a) => a.id === 'panda-boss')!;

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
  let wei: number;
  if (arm) {
    const preset = getEnemyPreset('f2-big-panda-wei');
    const cx = world.floorMap!.widthFt / 2;
    const cy = world.floorMap!.heightFt * 0.35;
    const eids = spawnPresetAroundCenter(world, world.floorMap!, preset, cx, cy, rng, 14);
    wei = eids[0] ?? -1;
    if (wei < 0) throw new Error('Big Panda Wei preset failed to spawn');
  } else {
    // Spawn Wei through the base production path (same archetype, no mob-ability hooks).
    // This confirms that normal-game Wei spawning does NOT accidentally register or
    // enable the ability — mobAbilities.byEntity must remain empty.
    const cx = world.floorMap!.widthFt / 2;
    const cy = world.floorMap!.heightFt * 0.35;
    const pos = findWalkablePosition(world.floorMap!, cx, cy, rng);
    wei = spawnFromArchetype(world, pos.x, pos.y, F2_BIG_PANDA_WEI);
    world.stores.enemyBehavior.aggroedPermanently[wei] = 1;
    // Deliberately no setMobAbilitiesEnabled / registerMobAbility / activateMobAbilityEncounter.
  }
  const input = createInputState();
  const telegraphs: number[] = [];
  const resolutions: number[] = [];
  let prevAnnouncements = 0;
  let prevResolved = 0;
  const modifierSnapshots: Array<{
    frame: number;
    move: number;
    melee: number;
    knockback: number;
  }> = [];
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
    if (wei >= 0) {
      const inst = world.mobAbilities.byEntity.get(wei);
      if (inst && inst.resolvedCasts > prevResolved) {
        resolutions.push(world.frameCount);
        prevResolved = inst.resolvedCasts;
      }
      if (
        world.frameCount === 599 ||
        world.frameCount === 690 ||
        world.frameCount === 820 ||
        world.frameCount === 930 ||
        world.frameCount === 1290 ||
        world.frameCount === 1380 ||
        world.frameCount === 1620
      ) {
        modifierSnapshots.push({
          frame: world.frameCount,
          move: getMobAbilityMovementSpeedMultiplier(world, wei),
          melee: getMobAbilityMeleeDamageMultiplier(world, wei),
          knockback: getMobAbilityKnockbackResistanceMultiplier(world, wei),
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
  for (const snap of modifierSnapshots) {
    console.log(
      `modifiers @ frame ${snap.frame}: move=${snap.move.toFixed(2)} melee=${snap.melee.toFixed(2)} knockback=${snap.knockback.toFixed(2)}`,
    );
  }
  return {
    telegraphs,
    resolutions,
    modifierSnapshots,
    casts: prevAnnouncements,
    byEntitySize: world.mobAbilities.byEntity.size,
  };
}

const arena = run('ARENA (Big Panda Wei preset — runtime ENABLED)', true);
const normal = run('DEFAULT NORMAL GAME (runtime DEFAULT-OFF)', false);

const cadenceOk =
  arena.telegraphs[0] === 600 &&
  arena.resolutions[0] === 690 &&
  arena.telegraphs[1] === 1290 &&
  arena.resolutions[1] === 1380;
const firstResolveOk = arena.modifierSnapshots.some(
  (s) =>
    s.frame === 690 &&
    Math.abs(s.move - 1.4) < 1e-6 &&
    Math.abs(s.melee - 1.4) < 1e-6 &&
    Math.abs(s.knockback - 0.35) < 1e-6,
);
const firstWindowMidOk = arena.modifierSnapshots.some(
  (s) =>
    s.frame === 820 &&
    Math.abs(s.move - 1.4) < 1e-6 &&
    Math.abs(s.melee - 1.4) < 1e-6 &&
    Math.abs(s.knockback - 0.35) < 1e-6,
);
const secondResolveOk = arena.modifierSnapshots.some(
  (s) =>
    s.frame === 1380 &&
    Math.abs(s.move - 1.4) < 1e-6 &&
    Math.abs(s.melee - 1.4) < 1e-6 &&
    Math.abs(s.knockback - 0.35) < 1e-6,
);
const baselineBeforeFirstOk = arena.modifierSnapshots.some(
  (s) =>
    s.frame === 599 &&
    Math.abs(s.move - 1) < 1e-6 &&
    Math.abs(s.melee - 1) < 1e-6 &&
    Math.abs(s.knockback - 1) < 1e-6,
);
const baselineBeforeSecondOk = arena.modifierSnapshots.some(
  (s) =>
    s.frame === 1290 &&
    Math.abs(s.move - 1) < 1e-6 &&
    Math.abs(s.melee - 1) < 1e-6 &&
    Math.abs(s.knockback - 1) < 1e-6,
);
const firstExpiryOk = arena.modifierSnapshots.some(
  (s) =>
    s.frame === 930 &&
    Math.abs(s.move - 1) < 1e-6 &&
    Math.abs(s.melee - 1) < 1e-6 &&
    Math.abs(s.knockback - 1) < 1e-6,
);
const secondExpiryOk = arena.modifierSnapshots.some(
  (s) =>
    s.frame === 1620 &&
    Math.abs(s.move - 1) < 1e-6 &&
    Math.abs(s.melee - 1) < 1e-6 &&
    Math.abs(s.knockback - 1) < 1e-6,
);
const normalOk = normal.casts === 0 && normal.resolutions.length === 0 && normal.byEntitySize === 0;
const modifiersOk = firstResolveOk && firstWindowMidOk && secondResolveOk;
const expiryOk = baselineBeforeFirstOk && baselineBeforeSecondOk && firstExpiryOk && secondExpiryOk;

console.log('\n=== GATE ===');
console.log(`arena two-cast cadence (600/690/1290/1380): ${cadenceOk ? 'PASS' : 'FAIL'}`);
console.log(
  `buff modifiers both windows + baseline      : ${modifiersOk && expiryOk ? 'PASS' : 'FAIL'}`,
);
console.log(`normal-game zero registrations+casts       : ${normalOk ? 'PASS' : 'FAIL'}`);

if (!cadenceOk || !modifiersOk || !expiryOk || !normalOk) {
  process.exitCode = 1;
}
