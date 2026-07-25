import { describe, expect, it } from 'vitest';
import { addComponent, hasComponent, removeEntity } from 'bitecs';
import { createTestWorld } from '../../helpers/world-factory.js';
import { GAME } from '../../../src/shared/constants.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  activateMobAbilityEncounter,
  createBambooFedBerserkDefinition,
  damageSystem,
  disableMobAbilityEncounter,
  getMobAbilityKnockbackResistanceMultiplier,
  getMobAbilityMeleeDamageMultiplier,
  getMobAbilityMovementSpeedMultiplier,
  knockbackSystem,
  mobAbilitySourceId,
  mobAbilitySystem,
  registerMobAbility,
  set,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
  statusEffectSystem,
  Knockback,
} from '../../../src/core/index.js';
import { runCoreSimulationStep } from '../../../src/core/simulation-core-step.js';
import type { CollisionResult } from '../../../src/core/systems/collisionSystem.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import { enemyAISystem, weaponSystem } from '../../../src/game/index.js';
import {
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../../src/labs/combat-arena-lab/arena-data.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DELTA = GAME.DELTA_MS;
const PANDA_KEY = 'panda-boss';
const EXPECTED_ANNOUNCEMENT = 'BAMBOO-FED BERSERK — Big Wei is collecting personally!';

const FIRST_TELEGRAPH_FRAME = 600; // 10,000ms
const FIRST_RESOLUTION_FRAME = 690; // 11,500ms
const FIRST_BUFF_EXPIRE_FRAME = 930; // +4,000ms
const SECOND_TELEGRAPH_FRAME = 1290; // 21,500ms
const SECOND_RESOLUTION_FRAME = 1380; // 23,000ms

type World = ReturnType<typeof createTestWorld>;

interface Harness {
  world: World;
  player: number;
  wei: number;
}

function buildHarness(px = 40, py = 40, wx = 40, wy = 10): Harness {
  const world = createTestWorld();
  const player = spawnPlayer(world, px, py);
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const wei = spawnBehaviorEnemy(world, wx, wy, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, wei, PANDA_KEY);
  return { world, player, wei };
}

function arm(h: Harness): void {
  setMobAbilitiesEnabled(h.world, true);
  registerMobAbility(h.world, h.wei, createBambooFedBerserkDefinition());
  activateMobAbilityEncounter(h.world);
}

function stepRuntime(world: World, frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    statusEffectSystem(world);
    mobAbilitySystem(world);
  }
}

function recordTimeline(h: Harness, frames: number) {
  const telegraphs: number[] = [];
  const resolutions: number[] = [];
  let prevAnnouncements = 0;
  let prevResolves = 0;
  for (let i = 0; i < frames; i += 1) {
    h.world.frameCount += 1;
    h.world.elapsedMs += DELTA;
    statusEffectSystem(h.world);
    mobAbilitySystem(h.world);
    const inst = h.world.mobAbilities.byEntity.get(h.wei);
    if (!inst) continue;
    if (inst.announcementsEmitted > prevAnnouncements) {
      telegraphs.push(h.world.frameCount);
      prevAnnouncements = inst.announcementsEmitted;
    }
    if (inst.resolvedCasts > prevResolves) {
      resolutions.push(h.world.frameCount);
      prevResolves = inst.resolvedCasts;
    }
  }
  return { telegraphs, resolutions };
}

function collisionResultFor(player: number, enemy: number) {
  return {
    pairs: [{ a: player, b: enemy }],
    grid: { clear() {}, insert() {}, queryPairs: () => [], queryRadius: () => [] },
  } satisfies CollisionResult;
}

describe('Bamboo-Fed Berserk definition', () => {
  it('matches the catalog contract exactly', () => {
    const def = createBambooFedBerserkDefinition();
    expect(def.abilityId).toBe('big-panda-wei-bamboo-fed-berserk');
    expect(def.bossArchetypeKey).toBe(PANDA_KEY);
    expect(def.firstEligibleAfterMs).toBe(10_000);
    expect(def.cooldownMs).toBe(10_000);
    expect(def.telegraphDurationMs).toBe(1500);
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
    expect(def.dangerColor).toBe('ability-theme');
    expect(def.targetingMode).toBe('self');
    expect(def.originMode).toBe('follows-caster');
    expect(def.lockCasterDuringTelegraph).toBe(true);
    expect(def.selfBuff).toEqual({
      durationMs: 4000,
      movementSpeedMultiplier: 1.4,
      meleeDamageMultiplier: 1.4,
      knockbackResistanceMultiplier: 0.35,
      auraRadiusFt: 10,
    });
  });
});

describe('Bamboo-Fed Berserk cadence and telegraph', () => {
  it('records exactly two recurring casts on the expected fixed cadence', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs, resolutions } = recordTimeline(h, SECOND_RESOLUTION_FRAME + 5);
    expect(telegraphs).toEqual([FIRST_TELEGRAPH_FRAME, SECOND_TELEGRAPH_FRAME]);
    expect(resolutions).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(2);
  });

  it('keeps Wei planted during the 1.5s telegraph and does not lock a player target', () => {
    const h = buildHarness();
    arm(h);
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME);
    const inst = h.world.mobAbilities.byEntity.get(h.wei)!;
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedTargetEid).toBeNull();
    expect(h.world.stores.velocity.x[h.wei]).toBe(0);
    expect(h.world.stores.velocity.y[h.wei]).toBe(0);
  });

  it('cancels knockback during telegraph so Wei cannot be displaced while planted', () => {
    const h = buildHarness();
    arm(h);
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME);
    addComponent(h.world.ecs, h.wei, set(Knockback, { dirX: 1, dirY: 0, speed: 2, remaining: 2 }));
    const xBefore = h.world.stores.position.x[h.wei] ?? 0;
    h.world.frameCount += 1;
    h.world.elapsedMs += DELTA;
    statusEffectSystem(h.world);
    mobAbilitySystem(h.world);
    knockbackSystem(h.world);
    expect(hasComponent(h.world.ecs, h.wei, Knockback)).toBe(false);
    expect(h.world.stores.position.x[h.wei] ?? 0).toBeCloseTo(xBefore, 10);
  });
});

describe('Bamboo-Fed Berserk active buff modifiers', () => {
  it('applies all three multipliers while active and returns to baseline on exact 4s expiry', () => {
    const h = buildHarness();
    arm(h);
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME);
    expect(getMobAbilityMovementSpeedMultiplier(h.world, h.wei)).toBeCloseTo(1.4, 10);
    expect(getMobAbilityMeleeDamageMultiplier(h.world, h.wei)).toBeCloseTo(1.4, 10);
    expect(getMobAbilityKnockbackResistanceMultiplier(h.world, h.wei)).toBeCloseTo(0.35, 10);

    stepRuntime(h.world, FIRST_BUFF_EXPIRE_FRAME - FIRST_RESOLUTION_FRAME);
    expect(getMobAbilityMovementSpeedMultiplier(h.world, h.wei)).toBe(1);
    expect(getMobAbilityMeleeDamageMultiplier(h.world, h.wei)).toBe(1);
    expect(getMobAbilityKnockbackResistanceMultiplier(h.world, h.wei)).toBe(1);
  });

  it('does not stack or extend itself when resolve is re-fired during an active window', () => {
    const h = buildHarness();
    setMobAbilitiesEnabled(h.world, true);
    activateMobAbilityEncounter(h.world);
    const def = createBambooFedBerserkDefinition();
    const sourceId = mobAbilitySourceId(def.abilityId, h.wei);
    def.resolve(h.world, {
      abilityId: def.abilityId,
      casterEid: h.wei,
      sourceId,
      geometry: { kind: 'circle', x: 40, y: 10, radiusFt: 10 },
      targetEid: null,
    });
    stepRuntime(h.world, 20);
    def.resolve(h.world, {
      abilityId: def.abilityId,
      casterEid: h.wei,
      sourceId,
      geometry: { kind: 'circle', x: 40, y: 10, radiusFt: 10 },
      targetEid: null,
    });
    const after = h.world.mobAbilities.activeBuffsByEntity.get(h.wei)!.remainingMs;
    expect(after).toBeCloseTo(4000 - 20 * DELTA, 6);
  });
});

describe('Bamboo-Fed Berserk seam consumption', () => {
  it('enemy movement speed increases while buffed', () => {
    const baseline = buildHarness(40, 40, 40, 5);
    baseline.world.frameCount += 1;
    baseline.world.elapsedMs += DELTA;
    enemyAISystem(baseline.world);
    const baseSpeed = Math.hypot(
      baseline.world.stores.velocity.x[baseline.wei] ?? 0,
      baseline.world.stores.velocity.y[baseline.wei] ?? 0,
    );

    const buffed = buildHarness(40, 40, 40, 5);
    const def = createBambooFedBerserkDefinition();
    def.resolve(buffed.world, {
      abilityId: def.abilityId,
      casterEid: buffed.wei,
      sourceId: mobAbilitySourceId(def.abilityId, buffed.wei),
      geometry: { kind: 'circle', x: 40, y: 5, radiusFt: 10 },
      targetEid: null,
    });
    buffed.world.frameCount += 1;
    buffed.world.elapsedMs += DELTA;
    enemyAISystem(buffed.world);
    const buffedSpeed = Math.hypot(
      buffed.world.stores.velocity.x[buffed.wei] ?? 0,
      buffed.world.stores.velocity.y[buffed.wei] ?? 0,
    );

    expect(buffedSpeed).toBeGreaterThan(baseSpeed * 1.35);
  });

  it('enemy contact melee damage is multiplied while buffed', () => {
    const baseline = buildHarness(40, 40, 40, 40);
    baseline.world.elapsedMs = 1000;
    const playerHpBefore = baseline.world.stores.health.current[baseline.player] ?? 0;
    damageSystem(baseline.world, collisionResultFor(baseline.player, baseline.wei));
    const baselineDelta =
      playerHpBefore - (baseline.world.stores.health.current[baseline.player] ?? 0);

    const buffed = buildHarness(40, 40, 40, 40);
    const def = createBambooFedBerserkDefinition();
    def.resolve(buffed.world, {
      abilityId: def.abilityId,
      casterEid: buffed.wei,
      sourceId: mobAbilitySourceId(def.abilityId, buffed.wei),
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 10 },
      targetEid: null,
    });
    buffed.world.elapsedMs = 1000;
    const hpBeforeBuffed = buffed.world.stores.health.current[buffed.player] ?? 0;
    damageSystem(buffed.world, collisionResultFor(buffed.player, buffed.wei));
    const buffedDelta = hpBeforeBuffed - (buffed.world.stores.health.current[buffed.player] ?? 0);

    expect(buffedDelta).toBeGreaterThan(baselineDelta * 1.35);
  });

  it('knockback displacement is reduced while buffed', () => {
    const baseline = buildHarness(40, 40, 40, 40);
    baseline.world.floorMap = null;
    baseline.world.stores.weight.value[baseline.wei] = 120;
    addComponent(
      baseline.world.ecs,
      baseline.wei,
      set(Knockback, { dirX: 1, dirY: 0, speed: 2, remaining: 2 }),
    );
    knockbackSystem(baseline.world);
    const baselineStep = (baseline.world.stores.position.x[baseline.wei] ?? 0) - 40;

    const buffed = buildHarness(40, 40, 40, 40);
    buffed.world.floorMap = null;
    const def = createBambooFedBerserkDefinition();
    def.resolve(buffed.world, {
      abilityId: def.abilityId,
      casterEid: buffed.wei,
      sourceId: mobAbilitySourceId(def.abilityId, buffed.wei),
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 10 },
      targetEid: null,
    });
    buffed.world.stores.weight.value[buffed.wei] = 120;
    addComponent(
      buffed.world.ecs,
      buffed.wei,
      set(Knockback, { dirX: 1, dirY: 0, speed: 2, remaining: 2 }),
    );
    knockbackSystem(buffed.world);
    const buffedStep = (buffed.world.stores.position.x[buffed.wei] ?? 0) - 40;

    expect(buffedStep).toBeLessThan(baselineStep * 0.5);
  });
});

describe('Bamboo-Fed Berserk cleanup', () => {
  it('clears active buff and cues when Wei dies/despawns/encounter disables', () => {
    const dead = buildHarness();
    arm(dead);
    stepRuntime(dead.world, FIRST_RESOLUTION_FRAME);
    expect(dead.world.mobAbilities.activeBuffsByEntity.has(dead.wei)).toBe(true);
    dead.world.stores.health.current[dead.wei] = 0;
    stepRuntime(dead.world, 1);
    expect(dead.world.mobAbilities.activeBuffsByEntity.has(dead.wei)).toBe(false);

    const despawned = buildHarness();
    arm(despawned);
    stepRuntime(despawned.world, FIRST_RESOLUTION_FRAME);
    expect(despawned.world.mobAbilities.activeBuffsByEntity.has(despawned.wei)).toBe(true);
    removeEntity(despawned.world.ecs, despawned.wei);
    stepRuntime(despawned.world, 1);
    expect(despawned.world.mobAbilities.activeBuffsByEntity.has(despawned.wei)).toBe(false);

    const h2 = buildHarness();
    arm(h2);
    stepRuntime(h2.world, FIRST_RESOLUTION_FRAME);
    disableMobAbilityEncounter(h2.world);
    expect(h2.world.mobAbilities.activeBuffsByEntity.size).toBe(0);
    expect(h2.world.mobAbilities.byEntity.size).toBe(0);
  });
});

describe('Bamboo-Fed Berserk canonical combat arena', () => {
  it('default normal-game configuration records zero casts over the same duration', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 100_000;
    const wei = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(world, wei, PANDA_KEY);
    const inputState = createInputState();

    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
    }

    expect(world.mobAbilities.enabled).toBe(false);
    expect(world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('arena preset f2-big-panda-wei records exactly two resolved casts', () => {
    const world = createTestWorld();
    const roomPreset = getRoomPreset('boss-arena');
    world.floorMap = roomPreset.buildMap();
    const spawnWorld = world.floorMap.tileToWorld(
      roomPreset.playerSpawnTile.x,
      roomPreset.playerSpawnTile.y,
    );
    const player = spawnPlayer(world, spawnWorld.x, spawnWorld.y);
    world.stores.health.current[player] = 100_000;
    world.stores.health.max[player] = 100_000;
    const preset = getEnemyPreset('f2-big-panda-wei');
    const rng = new SeededRandom(42);
    const cx = world.floorMap.widthFt / 2;
    const cy = world.floorMap.heightFt * 0.35;
    const spawned = spawnPresetAroundCenter(world, world.floorMap, preset, cx, cy, rng, 14);
    const wei = spawned[0];
    expect(wei).toBeDefined();
    const inputState = createInputState();

    const resolutionFrames: number[] = [];
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
      const inst = world.mobAbilities.byEntity.get(wei!);
      if (inst && inst.resolvedCasts > prevResolved) {
        resolutionFrames.push(world.frameCount);
        prevResolved = inst.resolvedCasts;
      }
    }

    expect(resolutionFrames).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    const announcements = world.announcements.filter((a) => a.kind === 'bossAbilityCast');
    expect(announcements).toHaveLength(2);
    expect(announcements[0]?.text).toBe(EXPECTED_ANNOUNCEMENT);
  });
});
