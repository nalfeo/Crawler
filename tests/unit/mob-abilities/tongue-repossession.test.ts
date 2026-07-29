import { describe, expect, it } from 'vitest';
import { GAME } from '../../../src/shared/constants.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  activateMobAbilityEncounter,
  createTongueRepossessionDefinition,
  disableMobAbilityEncounter,
  getMobAbilityRecoveryRemainingMs,
  mobAbilitySystem,
  registerMobAbility,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
  statusEffectSystem,
} from '../../../src/core/index.js';
import { runCoreSimulationStep } from '../../../src/core/simulation-core-step.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import { enemyAISystem, weaponSystem } from '../../../src/game/index.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { SeededRandom } from '../../../src/shared/random.js';
import {
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../../src/labs/combat-arena-lab/arena-data.js';

const DELTA = GAME.DELTA_MS;
const BUFO_KEY = 'toadkin-boss';
const EXPECTED_ANNOUNCEMENT = "TONGUE REPOSSESSION — Big Mama wants what's hers!";
const FIRST_TELEGRAPH_FRAME = 480; // 8,000ms
const FIRST_RESOLUTION_FRAME = 555; // +1,250ms
const SECOND_TELEGRAPH_FRAME = 1035; // +8,000ms after first resolution
const SECOND_RESOLUTION_FRAME = 1110;

type World = ReturnType<typeof createTestWorld>;
type AiTypeValue = (typeof AI_TYPE)[keyof typeof AI_TYPE];

function buildHarness(px = 40, py = 40, bx = 40, by = 10, aiType: AiTypeValue = AI_TYPE.CHASE) {
  const world = createTestWorld();
  const player = spawnPlayer(world, px, py);
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const bufo = spawnBehaviorEnemy(world, bx, by, 200, aiType, 0.17, 60, 0);
  setEnemyAppearanceKey(world, bufo, BUFO_KEY);
  return { world, player, bufo, def: createTongueRepossessionDefinition() };
}

function arm(world: World, casterEid: number): void {
  setMobAbilitiesEnabled(world, true);
  registerMobAbility(world, casterEid, createTongueRepossessionDefinition());
  activateMobAbilityEncounter(world);
}

function stepRuntime(world: World, frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    statusEffectSystem(world);
    mobAbilitySystem(world);
  }
}

function stepFullSimulation(
  world: World,
  inputState: ReturnType<typeof createInputState>,
  frames: number,
): void {
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    runCoreSimulationStep(world, inputState, {
      preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
    });
  }
}

describe('Tongue Repossession definition', () => {
  it('matches the catalog contract exactly', () => {
    const def = createTongueRepossessionDefinition();
    expect(def.abilityId).toBe('big-mama-bufo-tongue-repossession');
    expect(def.bossArchetypeKey).toBe(BUFO_KEY);
    expect(def.firstEligibleAfterMs).toBe(8000);
    expect(def.cooldownMs).toBe(8000);
    expect(def.telegraphDurationMs).toBe(1250);
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
    expect(def.dangerColor).toBe('hostile-red');
    expect(def.geometry).toEqual({ kind: 'lane', widthFt: 3, maxRangeFt: 30 });
  });
});

describe('Tongue Repossession cadence and lock semantics', () => {
  it('records exactly two resolved casts on the fixed cadence', () => {
    const h = buildHarness();
    arm(h.world, h.bufo);
    const telegraphs: number[] = [];
    const resolutions: number[] = [];
    let prevAnnouncements = 0;
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 10; i += 1) {
      h.world.frameCount += 1;
      h.world.elapsedMs += DELTA;
      statusEffectSystem(h.world);
      mobAbilitySystem(h.world);
      const inst = h.world.mobAbilities.byEntity.get(h.bufo);
      if (!inst) continue;
      if (inst.announcementsEmitted > prevAnnouncements) {
        telegraphs.push(h.world.frameCount);
        prevAnnouncements = inst.announcementsEmitted;
      }
      if (inst.resolvedCasts > prevResolved) {
        resolutions.push(h.world.frameCount);
        prevResolved = inst.resolvedCasts;
      }
    }
    expect(telegraphs).toEqual([FIRST_TELEGRAPH_FRAME, SECOND_TELEGRAPH_FRAME]);
    expect(resolutions).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    expect(h.world.announcements.filter((event) => event.kind === 'bossAbilityCast')).toHaveLength(
      2,
    );
  });

  it('locks one committed lane at telegraph start and never retargets after lock', () => {
    const h = buildHarness(40, 40, 40, 10);
    arm(h.world, h.bufo);
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME);
    const inst = h.world.mobAbilities.byEntity.get(h.bufo)!;
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedGeometry?.kind).toBe('lane');
    if (inst.committedGeometry?.kind !== 'lane') {
      throw new Error('expected lane geometry');
    }
    const before = { ...inst.committedGeometry };
    h.world.stores.position.x[h.player] = 60;
    h.world.stores.position.y[h.player] = 60;
    stepRuntime(h.world, 10);
    const after = h.world.mobAbilities.byEntity.get(h.bufo)!.committedGeometry;
    expect(after).toEqual(before);
  });
});

describe('Tongue Repossession hit, pull, miss, and collision safety', () => {
  it('hit path deals damage and pulls the player to exactly 5ft in front of Bufo', () => {
    const h = buildHarness(40, 40, 40, 10);
    arm(h.world, h.bufo);
    const hpBefore = h.world.stores.health.current[h.player] ?? 0;
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME);
    const hpAfter = h.world.stores.health.current[h.player] ?? 0;
    expect(hpAfter).toBeLessThan(hpBefore);
    expect(h.world.stores.position.x[h.player]).toBeCloseTo(40, 6);
    expect(h.world.stores.position.y[h.player]).toBeCloseTo(15, 6);
  });

  it('miss path resolves on the same committed lane without dealing damage or pulling', () => {
    const h = buildHarness(40, 40, 40, 10);
    arm(h.world, h.bufo);
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME);
    const inst = h.world.mobAbilities.byEntity.get(h.bufo)!;
    if (inst.committedGeometry?.kind !== 'lane') {
      throw new Error('expected lane geometry');
    }
    const committedLane = { ...inst.committedGeometry };
    h.world.stores.position.x[h.player] = 55; // sidestep out of 3ft lane before lash
    h.world.stores.position.y[h.player] = 40;
    const hpBefore = h.world.stores.health.current[h.player] ?? 0;
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME - FIRST_TELEGRAPH_FRAME);
    expect(h.world.stores.health.current[h.player]).toBe(hpBefore);
    expect(h.world.stores.position.x[h.player]).toBeCloseTo(55, 6);
    expect(h.world.stores.position.y[h.player]).toBeCloseTo(40, 6);
    expect(committedLane).toEqual({
      kind: 'lane',
      originX: 40,
      originY: 10,
      endX: 40,
      endY: 40,
      dirX: 0,
      dirY: 1,
      widthFt: 3,
      lengthFt: 30,
    });
  });

  it('miss path creates a brief recovery window before Bufo resumes pursuit', () => {
    const h = buildHarness(40, 40, 40, 10, AI_TYPE.RANGED);
    arm(h.world, h.bufo);
    const inputState = createInputState();
    stepFullSimulation(h.world, inputState, FIRST_TELEGRAPH_FRAME);
    h.world.stores.position.x[h.player] = 55;
    h.world.stores.position.y[h.player] = 40;
    stepFullSimulation(h.world, inputState, FIRST_RESOLUTION_FRAME - FIRST_TELEGRAPH_FRAME);

    const missRecoveryMs = getMobAbilityRecoveryRemainingMs(h.world, h.bufo);
    expect(missRecoveryMs).toBeGreaterThan(0);
    const lockedX = h.world.stores.position.x[h.bufo] ?? 0;
    const lockedY = h.world.stores.position.y[h.bufo] ?? 0;
    const recoveryFrames = Math.max(0, Math.ceil(missRecoveryMs / DELTA) - 1);

    stepFullSimulation(h.world, inputState, recoveryFrames);
    expect(h.world.stores.position.x[h.bufo]).toBeCloseTo(lockedX, 6);
    expect(h.world.stores.position.y[h.bufo]).toBeCloseTo(lockedY, 6);
    expect(h.world.stores.enemyBehavior.telegraphActive[h.bufo]).toBe(0);

    stepFullSimulation(h.world, inputState, 12);
    const resumedDx = (h.world.stores.position.x[h.bufo] ?? 0) - lockedX;
    const resumedDy = (h.world.stores.position.y[h.bufo] ?? 0) - lockedY;
    expect(Math.hypot(resumedDx, resumedDy)).toBeGreaterThan(0);
  });

  it('pull fallback respects collision validity and never places the player in blocked geometry', () => {
    const h = buildHarness(20, 12, 20, 10);
    h.world.floorMap = {
      isPassableAt(_x: number, y: number) {
        return y < 14;
      },
    } as unknown as World['floorMap'];
    h.def.resolve(h.world, {
      abilityId: h.def.abilityId,
      casterEid: h.bufo,
      sourceId: `mob-ability:${h.def.abilityId}:${h.bufo}`,
      targetEid: h.player,
      geometry: {
        kind: 'lane',
        originX: 20,
        originY: 10,
        endX: 20,
        endY: 40,
        dirX: 0,
        dirY: 1,
        widthFt: 3,
        lengthFt: 30,
      },
    });
    const pulledY = h.world.stores.position.y[h.player] ?? 0;
    expect(pulledY).toBeCloseTo(12.5, 6);
    expect(pulledY).toBeLessThan(14);
  });
});

describe('Tongue Repossession cleanup and canonical arena gate', () => {
  it('clears in-flight lane cues when encounter disables', () => {
    const h = buildHarness();
    arm(h.world, h.bufo);
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME + 5);
    expect(h.world.mobAbilities.cues.length).toBeGreaterThan(0);
    disableMobAbilityEncounter(h.world);
    expect(h.world.mobAbilities.byEntity.size).toBe(0);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
  });

  it('default normal-game config records zero casts while arena preset records exactly two', () => {
    const normal = buildHarness();
    const inputState = createInputState();
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 20; i += 1) {
      normal.world.frameCount += 1;
      normal.world.elapsedMs += DELTA;
      runCoreSimulationStep(normal.world, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
    }
    expect(normal.world.mobAbilities.enabled).toBe(false);
    expect(
      normal.world.announcements.filter((event) => event.kind === 'bossAbilityCast'),
    ).toHaveLength(0);

    const arenaWorld = createTestWorld();
    const roomPreset = getRoomPreset('boss-arena');
    arenaWorld.floorMap = roomPreset.buildMap();
    const spawnWorld = arenaWorld.floorMap.tileToWorld(
      roomPreset.playerSpawnTile.x,
      roomPreset.playerSpawnTile.y,
    );
    const player = spawnPlayer(arenaWorld, spawnWorld.x, spawnWorld.y);
    arenaWorld.stores.health.current[player] = 100_000;
    arenaWorld.stores.health.max[player] = 100_000;
    const preset = getEnemyPreset('f2-big-mama-bufo');
    const rng = new SeededRandom(42);
    const cx = arenaWorld.floorMap.widthFt / 2;
    const cy = arenaWorld.floorMap.heightFt * 0.35;
    const spawned = spawnPresetAroundCenter(
      arenaWorld,
      arenaWorld.floorMap,
      preset,
      cx,
      cy,
      rng,
      14,
    );
    const bufo = spawned[0];
    expect(bufo).toBeDefined();
    const resolutions: number[] = [];
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 20; i += 1) {
      arenaWorld.frameCount += 1;
      arenaWorld.elapsedMs += DELTA;
      runCoreSimulationStep(arenaWorld, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
      const inst = arenaWorld.mobAbilities.byEntity.get(bufo!);
      if (!inst || inst.resolvedCasts <= prevResolved) continue;
      resolutions.push(arenaWorld.frameCount);
      prevResolved = inst.resolvedCasts;
    }
    expect(resolutions).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
  });
});
