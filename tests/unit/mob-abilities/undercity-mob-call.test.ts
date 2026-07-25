import { describe, expect, it } from 'vitest';
import { removeEntity } from 'bitecs';
import { GAME } from '../../../src/shared/constants.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  createUndercityMobCallDefinition,
  UNDERCITY_MOB_CALL_ABILITY_ID,
  activateMobAbilityEncounter,
  clearMobAbility,
  disableMobAbilityEncounter,
  mobAbilitySourceId,
  mobAbilitySystem,
  registerMobAbility,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
  statusEffectSystem,
} from '../../../src/core/index.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import { enemyAISystem, weaponSystem } from '../../../src/game/index.js';
import { runCoreSimulationStep } from '../../../src/core/simulation-core-step.js';
import { SeededRandom } from '../../../src/shared/random.js';
import {
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../../src/labs/combat-arena-lab/arena-data.js';

const DELTA = GAME.DELTA_MS;
const FIRST_TELEGRAPH_FRAME = 660; // 11,000ms
const FIRST_RESOLUTION_FRAME = 750; // +1,500ms
const SECOND_RESOLUTION_FRAME = 1500;
const SQUICK_KEY = 'ratfolk-boss';
const EXPECTED_ANNOUNCEMENT = 'UNDERCITY MOB CALL — The guild always collects!';

type World = ReturnType<typeof createTestWorld>;

function buildHarness() {
  const world = createTestWorld();
  const player = spawnPlayer(world, 40, 40);
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const squick = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, squick, SQUICK_KEY);
  const def = createUndercityMobCallDefinition();
  return { world, squick, player, def };
}

function arm(world: World, casterEid: number) {
  setMobAbilitiesEnabled(world, true);
  registerMobAbility(world, casterEid, createUndercityMobCallDefinition());
  activateMobAbilityEncounter(world);
}

function step(world: World, frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += DELTA;
    statusEffectSystem(world);
    mobAbilitySystem(world);
  }
}

function instance(world: World, casterEid: number) {
  const inst = world.mobAbilities.byEntity.get(casterEid);
  if (!inst) throw new Error('expected runtime instance');
  return inst;
}

describe('Undercity Mob Call — typed definition', () => {
  it('derives the exact catalog contract', () => {
    const def = createUndercityMobCallDefinition();
    expect(def.abilityId).toBe(UNDERCITY_MOB_CALL_ABILITY_ID);
    expect(def.bossArchetypeKey).toBe(SQUICK_KEY);
    expect(def.firstEligibleAfterMs).toBe(11_000);
    expect(def.cooldownMs).toBe(11_000);
    expect(def.telegraphDurationMs).toBe(1_500);
    expect(def.dangerColor).toBe('hostile-red');
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
    expect(def.geometry).toEqual({
      kind: 'spawn-circles',
      count: 3,
      radiusFt: 4,
      distanceFromCasterFt: 8,
    });
  });
});

describe('Undercity Mob Call — cadence and locked circles', () => {
  it('records two resolved casts at the fixed 11s cadence', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    step(h.world, SECOND_RESOLUTION_FRAME);
    const inst = instance(h.world, h.squick);
    expect(inst.resolvedCasts).toBe(2);
    expect(h.world.announcements.filter((event) => event.kind === 'bossAbilityCast')).toHaveLength(2);
  });

  it('locks three spawn circles at telegraph start and does not track caster movement', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    step(h.world, FIRST_TELEGRAPH_FRAME);
    const inst = instance(h.world, h.squick);
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedGeometry?.kind).toBe('spawn-circles');
    const before = (inst.committedGeometry as { circles: Array<{ x: number; y: number }> }).circles.map(
      (circle) => ({ x: circle.x, y: circle.y }),
    );
    h.world.stores.position.x[h.squick] = 200;
    h.world.stores.position.y[h.squick] = 200;
    step(h.world, 5);
    const after = (instance(h.world, h.squick).committedGeometry as {
      circles: Array<{ x: number; y: number }>;
    }).circles.map((circle) => ({ x: circle.x, y: circle.y }));
    expect(after).toEqual(before);
  });
});

describe('Undercity Mob Call — summon and cap ownership', () => {
  it('summons exactly three plague rats into the committed circles at first resolution', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const inst = instance(h.world, h.squick);
    expect(inst.ownedEntityGenerations.size).toBe(3);
    const ownedEids = [...inst.ownedEntityGenerations.keys()];
    const positions = ownedEids.map((eid) => ({
      x: h.world.stores.position.x[eid] ?? 0,
      y: h.world.stores.position.y[eid] ?? 0,
      appearance: h.world.enemyAppearanceKeys.get(eid),
    }));
    expect(positions.every((entry) => entry.appearance === 'ratfolk-plague')).toBe(true);
    expect(
      h.world.announcements
        .filter((event) => event.kind === 'bossAbilityCast')
        .every((event) => event.text === EXPECTED_ANNOUNCEMENT),
    ).toBe(true);
  });

  it('enforces the six-minion cap at the second call and never counts unrelated rats', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    spawnBehaviorEnemy(h.world, 20, 20, 50, AI_TYPE.CHASE, 0.12, 25, 0);
    step(h.world, SECOND_RESOLUTION_FRAME);
    const inst = instance(h.world, h.squick);
    expect(inst.ownedEntityGenerations.size).toBe(6);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
  });

  it('summons only remaining slots when fewer than three cap slots remain', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const inst = instance(h.world, h.squick);
    const owned = [...inst.ownedEntityGenerations.keys()];
    // Make only one slot available.
    h.world.stores.health.current[owned[0]!] = 0;
    h.world.stores.health.current[owned[1]!] = 0;
    step(h.world, 1); // prune dead-owned entries
    expect(inst.ownedEntityGenerations.size).toBe(1);
    step(h.world, SECOND_RESOLUTION_FRAME - FIRST_RESOLUTION_FRAME - 1);
    expect(inst.ownedEntityGenerations.size).toBe(4);
  });

  it('releases ownership immediately when owned minions die or despawn', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const inst = instance(h.world, h.squick);
    const owned = [...inst.ownedEntityGenerations.keys()];
    h.world.stores.health.current[owned[0]!] = 0;
    removeEntity(h.world.ecs, owned[1]!);
    step(h.world, 1);
    expect(inst.ownedEntityGenerations.size).toBe(1);
  });
});

describe('Undercity Mob Call — cleanup contracts', () => {
  it('clears owned state and pending cast state when the caster is cleared', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const sourceId = mobAbilitySourceId(UNDERCITY_MOB_CALL_ABILITY_ID, h.squick);
    expect(instance(h.world, h.squick).ownedEntityGenerations.size).toBeGreaterThan(0);
    clearMobAbility(h.world, h.squick);
    expect(h.world.mobAbilities.byEntity.has(h.squick)).toBe(false);
    expect(h.world.announcements.some((a) => a.eventId?.startsWith(`${sourceId}:cast-`))).toBe(false);
  });

  it('tears down runtime state on encounter disable', () => {
    const h = buildHarness();
    arm(h.world, h.squick);
    step(h.world, FIRST_TELEGRAPH_FRAME + 2);
    disableMobAbilityEncounter(h.world);
    expect(h.world.mobAbilities.byEntity.size).toBe(0);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
    expect(h.world.mobAbilities.pendingBursts).toHaveLength(0);
  });
});

describe('Undercity Mob Call — canonical pipeline hard gate', () => {
  it('records two resolved casts in arena and zero casts in default normal-game config', () => {
    const arenaWorld = createTestWorld();
    const roomPreset = getRoomPreset('boss-arena');
    arenaWorld.floorMap = roomPreset.buildMap();
    const spawnWorld = arenaWorld.floorMap.tileToWorld(
      roomPreset.playerSpawnTile.x,
      roomPreset.playerSpawnTile.y,
    );
    const arenaPlayer = spawnPlayer(arenaWorld, spawnWorld.x, spawnWorld.y);
    arenaWorld.stores.health.current[arenaPlayer] = 100_000;
    arenaWorld.stores.health.max[arenaPlayer] = 100_000;
    const preset = getEnemyPreset('f2-squick');
    const rng = new SeededRandom(42);
    const cx = arenaWorld.floorMap.widthFt / 2;
    const cy = arenaWorld.floorMap.heightFt * 0.35;
    const spawned = spawnPresetAroundCenter(arenaWorld, arenaWorld.floorMap, preset, cx, cy, rng, 14);
    const squick = spawned[0];
    expect(squick).toBeDefined();
    const inputState = createInputState();
    const arenaResFrames: number[] = [];
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 20; i += 1) {
      arenaWorld.frameCount += 1;
      arenaWorld.elapsedMs += DELTA;
      runCoreSimulationStep(arenaWorld, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
      const inst = arenaWorld.mobAbilities.byEntity.get(squick!);
      if (inst && inst.resolvedCasts > prevResolved) {
        arenaResFrames.push(arenaWorld.frameCount);
        prevResolved = inst.resolvedCasts;
      }
    }
    expect(arenaResFrames).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    expect(instance(arenaWorld, squick!).ownedEntityGenerations.size).toBeLessThanOrEqual(6);

    const normalWorld = createTestWorld();
    const normalPlayer = spawnPlayer(normalWorld, 40, 40);
    normalWorld.stores.health.current[normalPlayer] = 100_000;
    normalWorld.stores.health.max[normalPlayer] = 100_000;
    const normalSquick = spawnBehaviorEnemy(normalWorld, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(normalWorld, normalSquick, SQUICK_KEY);
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 20; i += 1) {
      normalWorld.frameCount += 1;
      normalWorld.elapsedMs += DELTA;
      runCoreSimulationStep(normalWorld, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
    }
    expect(normalWorld.mobAbilities.enabled).toBe(false);
    expect(normalWorld.announcements.filter((event) => event.kind === 'bossAbilityCast')).toHaveLength(
      0,
    );
  });
});
