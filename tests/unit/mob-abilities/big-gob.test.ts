import { describe, expect, it } from 'vitest';
import { removeEntity } from 'bitecs';
import { createTestWorld } from '../../helpers/world-factory.js';
import { GAME } from '../../../src/shared/constants.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  activateMobAbilityEncounter,
  clearMobAbility,
  createDonPacoBigGobDefinition,
  DON_PACO_BIG_GOB_ABILITY_ID,
  getStatusEffects,
  mobAbilitySystem,
  registerMobAbility,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
  statusEffectSystem,
  disableMobAbilityEncounter,
} from '../../../src/core/index.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import { enemyAISystem, weaponSystem } from '../../../src/game/index.js';
import { runCoreSimulationStep } from '../../../src/core/simulation-core-step.js';
import { SeededRandom } from '../../../src/shared/random.js';
import {
  ARENA_OBSERVER_PLAYER_HP,
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../../src/labs/combat-arena-lab/arena-data.js';

const DELTA = GAME.DELTA_MS;
const DON_PACO_KEY = 'llama-boss';
const EXPECTED_ANNOUNCEMENT = "THE BIG GOB — Don Paco's painting the whole block!";
const FIRST_TELEGRAPH_FRAME = 540;
const FIRST_RESOLUTION_FRAME = 624;
const FIRST_IMPACT_FRAME = 654;
const FIRST_EXPIRY_FRAME = 894;
const SECOND_TELEGRAPH_FRAME = 1164;
const SECOND_RESOLUTION_FRAME = 1248;
const SECOND_IMPACT_FRAME = 1278;

type World = ReturnType<typeof createTestWorld>;

interface Harness {
  world: World;
  player: number;
  don: number;
  def: ReturnType<typeof createDonPacoBigGobDefinition>;
}

function buildHarness(px = 40, py = 40, dx = 40, dy = 10): Harness {
  const world = createTestWorld();
  const player = spawnPlayer(world, px, py);
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const don = spawnBehaviorEnemy(world, dx, dy, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, don, DON_PACO_KEY);
  const def = createDonPacoBigGobDefinition();
  return { world, player, don, def };
}

function arm(h: Harness): void {
  setMobAbilitiesEnabled(h.world, true);
  registerMobAbility(h.world, h.don, h.def);
  activateMobAbilityEncounter(h.world);
}

function step(world: World, frames: number): void {
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
  const impacts: number[] = [];
  let prevAnnouncements = 0;
  let prevResolved = 0;
  let prevZones = 0;
  for (let i = 0; i < frames; i += 1) {
    h.world.frameCount += 1;
    h.world.elapsedMs += DELTA;
    statusEffectSystem(h.world);
    mobAbilitySystem(h.world);
    const inst = h.world.mobAbilities.byEntity.get(h.don);
    if (inst && inst.announcementsEmitted > prevAnnouncements) {
      telegraphs.push(h.world.frameCount);
      prevAnnouncements = inst.announcementsEmitted;
    }
    if (inst && inst.resolvedCasts > prevResolved) {
      resolutions.push(h.world.frameCount);
      prevResolved = inst.resolvedCasts;
    }
    if (h.world.mobAbilities.activeZones.length > prevZones) {
      impacts.push(h.world.frameCount);
      prevZones = h.world.mobAbilities.activeZones.length;
    }
    if (h.world.mobAbilities.activeZones.length === 0) {
      prevZones = 0;
    }
  }
  return { telegraphs, resolutions, impacts };
}

describe('THE BIG GOB — typed definition', () => {
  it('derives the exact Don Paco contract', () => {
    const def = createDonPacoBigGobDefinition();
    expect(def.abilityId).toBe(DON_PACO_BIG_GOB_ABILITY_ID);
    expect(def.bossArchetypeKey).toBe(DON_PACO_KEY);
    expect(def.firstEligibleAfterMs).toBe(9000);
    expect(def.cooldownMs).toBe(9000);
    expect(def.telegraphDurationMs).toBe(1400);
    expect(def.dangerColor).toBe('hostile-red');
    expect(def.targetingMode).toBe('player-direction');
    expect(def.geometry).toEqual({
      kind: 'projectile-fan',
      count: 5,
      coneAngleDeg: 70,
      rangeFt: 30,
      impactRadiusFt: 3,
    });
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
  });
});

describe('THE BIG GOB — timing gate', () => {
  it('records two fixed-cadence casts plus their impact windows', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs, resolutions, impacts } = recordTimeline(h, SECOND_IMPACT_FRAME + 5);
    expect(telegraphs).toEqual([FIRST_TELEGRAPH_FRAME, SECOND_TELEGRAPH_FRAME]);
    expect(resolutions).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    expect(impacts).toEqual([FIRST_IMPACT_FRAME, SECOND_IMPACT_FRAME]);
  });

  it('anchors the second cast after resolution instead of after impacts', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_IMPACT_FRAME);
    expect(h.world.mobAbilities.activeZones).toHaveLength(5);
    const inst = h.world.mobAbilities.byEntity.get(h.don)!;
    expect(inst.resolvedCasts).toBe(1);
    expect(inst.phase).toBe('cooldown');
    expect(inst.timerMs).toBeLessThan(9000 - DELTA * 25);
    expect(inst.timerMs).toBeGreaterThan(9000 - DELTA * 35);
    step(h.world, SECOND_TELEGRAPH_FRAME - FIRST_IMPACT_FRAME);
    expect(h.world.mobAbilities.cues).toHaveLength(1);
  });
});

describe('THE BIG GOB — locked geometry', () => {
  it('locks five paths plus landing circles to the telegraph-start direction and origin', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME);
    const inst = h.world.mobAbilities.byEntity.get(h.don)!;
    expect(inst.committedGeometry?.kind).toBe('projectile-fan');
    if (inst.committedGeometry?.kind !== 'projectile-fan') {
      throw new Error('expected projectile-fan geometry');
    }
    expect(inst.committedGeometry.paths).toHaveLength(5);
    const before = inst.committedGeometry.paths.map((path) => ({
      startX: path.startX,
      startY: path.startY,
      endX: path.endX,
      endY: path.endY,
    }));
    h.world.stores.position.x[h.player] = 200;
    h.world.stores.position.y[h.player] = 200;
    h.world.stores.position.x[h.don] = 0;
    h.world.stores.position.y[h.don] = 0;
    step(h.world, 10);
    const after = h.world.mobAbilities.byEntity.get(h.don)!.committedGeometry;
    expect(after).toMatchObject({ kind: 'projectile-fan' });
    if (after?.kind !== 'projectile-fan') {
      throw new Error('expected projectile-fan geometry');
    }
    expect(
      after.paths.map((path) => ({
        startX: path.startX,
        startY: path.startY,
        endX: path.endX,
        endY: path.endY,
      })),
    ).toEqual(before);
  });
});

describe('THE BIG GOB — impacts and slicks', () => {
  it('launches five projectiles at resolution, then impacts into five slicks', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    expect(h.world.mobAbilities.activeProjectiles).toHaveLength(5);
    expect(h.world.mobAbilities.activeZones).toHaveLength(0);
    step(h.world, FIRST_IMPACT_FRAME - FIRST_RESOLUTION_FRAME);
    expect(h.world.mobAbilities.activeProjectiles).toHaveLength(0);
    expect(h.world.mobAbilities.activeZones).toHaveLength(5);
    expect(h.world.mobAbilities.pendingBursts).toHaveLength(5);
  });

  it('damages the player only inside the committed landing circle', () => {
    const hit = buildHarness();
    arm(hit);
    const hpBefore = hit.world.stores.health.current[hit.player]!;
    step(hit.world, FIRST_IMPACT_FRAME);
    expect(hit.world.stores.health.current[hit.player]!).toBeLessThan(hpBefore);

    const miss = buildHarness();
    arm(miss);
    step(miss.world, FIRST_TELEGRAPH_FRAME);
    miss.world.stores.position.x[miss.player] = 4;
    miss.world.stores.position.y[miss.player] = 4;
    const missBefore = miss.world.stores.health.current[miss.player]!;
    step(miss.world, FIRST_IMPACT_FRAME - FIRST_TELEGRAPH_FRAME);
    expect(miss.world.stores.health.current[miss.player]!).toBe(missBefore);
    expect(miss.world.mobAbilities.activeZones).toHaveLength(5);
  });

  it('applies slow only while inside a slick and expires after 4 seconds', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_IMPACT_FRAME);
    const firstZone = h.world.mobAbilities.activeZones[0]!;
    h.world.stores.position.x[h.player] = firstZone.circle.x;
    h.world.stores.position.y[h.player] = firstZone.circle.y;
    step(h.world, 1);
    expect(
      getStatusEffects(h.world, h.player).some((effect) => effect.sourceId.endsWith(':slick')),
    ).toBe(true);

    h.world.stores.position.x[h.player] = 0;
    h.world.stores.position.y[h.player] = 0;
    step(h.world, 1);
    expect(
      getStatusEffects(h.world, h.player).some((effect) => effect.sourceId.endsWith(':slick')),
    ).toBe(false);

    h.world.stores.position.x[h.player] = firstZone.circle.x;
    h.world.stores.position.y[h.player] = firstZone.circle.y;
    step(h.world, FIRST_EXPIRY_FRAME - FIRST_IMPACT_FRAME - 2);
    expect(h.world.mobAbilities.activeZones).toHaveLength(0);
  });
});

describe('THE BIG GOB — announcements and cleanup', () => {
  it('emits one announcement per cast with no catch-up duplicates', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, SECOND_RESOLUTION_FRAME + 20);
    const casts = h.world.announcements.filter((event) => event.kind === 'bossAbilityCast');
    expect(casts).toHaveLength(2);
    expect(casts.every((event) => event.text === EXPECTED_ANNOUNCEMENT)).toBe(true);
  });

  it('cleans projectiles and slicks on clear, death, despawn, disable, and invalid target', () => {
    const cleared = buildHarness();
    arm(cleared);
    step(cleared.world, FIRST_RESOLUTION_FRAME);
    expect(cleared.world.mobAbilities.activeProjectiles).toHaveLength(5);
    clearMobAbility(cleared.world, cleared.don);
    expect(cleared.world.mobAbilities.activeProjectiles).toHaveLength(0);
    expect(cleared.world.mobAbilities.activeZones).toHaveLength(0);

    const dead = buildHarness();
    arm(dead);
    step(dead.world, FIRST_RESOLUTION_FRAME);
    dead.world.stores.health.current[dead.don] = 0;
    step(dead.world, 1);
    expect(dead.world.mobAbilities.activeProjectiles).toHaveLength(0);

    const despawned = buildHarness();
    arm(despawned);
    step(despawned.world, FIRST_IMPACT_FRAME);
    removeEntity(despawned.world.ecs, despawned.don);
    step(despawned.world, 1);
    expect(despawned.world.mobAbilities.activeZones).toHaveLength(0);

    const disabled = buildHarness();
    arm(disabled);
    step(disabled.world, FIRST_IMPACT_FRAME);
    disableMobAbilityEncounter(disabled.world);
    expect(disabled.world.mobAbilities.byEntity.size).toBe(0);
    expect(disabled.world.mobAbilities.activeProjectiles).toHaveLength(0);
    expect(disabled.world.mobAbilities.activeZones).toHaveLength(0);

    const invalidTarget = buildHarness();
    arm(invalidTarget);
    step(invalidTarget.world, FIRST_TELEGRAPH_FRAME);
    invalidTarget.world.stores.health.current[invalidTarget.player] = 0;
    step(invalidTarget.world, FIRST_RESOLUTION_FRAME - FIRST_TELEGRAPH_FRAME);
    expect(invalidTarget.world.mobAbilities.activeProjectiles).toHaveLength(0);
    expect(invalidTarget.world.mobAbilities.activeZones).toHaveLength(0);
    expect(
      invalidTarget.world.mobAbilities.byEntity.get(invalidTarget.don)?.resolvedCasts ?? 0,
    ).toBe(0);
  });

  it('does not fire onImpact for projectiles owned by a caster that dies on the final travel frame', () => {
    // Death-ordering regression: validate casters before ticking projectiles so a
    // boss killed on frame N-1 cannot trigger onImpact (damage + zone spawn) on
    // frame N when the projectile reaches its travel limit.
    const h = buildHarness();
    arm(h);
    // Advance to one frame before impact (projectiles in-flight, caster still alive).
    step(h.world, FIRST_IMPACT_FRAME - 1);
    expect(h.world.mobAbilities.activeProjectiles).toHaveLength(5);
    expect(h.world.mobAbilities.activeZones).toHaveLength(0);
    // Kill the caster on this frame.
    h.world.stores.health.current[h.don] = 0;
    // Step one more frame: the caster must be cleared BEFORE projectiles are ticked,
    // so onImpact is never called and no zones are spawned.
    step(h.world, 1);
    expect(h.world.mobAbilities.activeProjectiles).toHaveLength(0);
    expect(h.world.mobAbilities.activeZones).toHaveLength(0);
  });
});

describe('THE BIG GOB — canonical pipeline hard gate', () => {
  it('records two casts in arena and zero casts in default normal-game config', () => {
    const arenaWorld = createTestWorld();
    const roomPreset = getRoomPreset('boss-arena');
    arenaWorld.floorMap = roomPreset.buildMap();
    const spawnWorld = arenaWorld.floorMap.tileToWorld(
      roomPreset.playerSpawnTile.x,
      roomPreset.playerSpawnTile.y,
    );
    const arenaPlayer = spawnPlayer(arenaWorld, spawnWorld.x, spawnWorld.y);
    arenaWorld.stores.health.current[arenaPlayer] = ARENA_OBSERVER_PLAYER_HP;
    arenaWorld.stores.health.max[arenaPlayer] = ARENA_OBSERVER_PLAYER_HP;
    const preset = getEnemyPreset('f2-don-paco');
    const spawned = spawnPresetAroundCenter(
      arenaWorld,
      arenaWorld.floorMap,
      preset,
      arenaWorld.floorMap.widthFt / 2,
      arenaWorld.floorMap.heightFt * 0.35,
      new SeededRandom(42),
      14,
    );
    const don = spawned[0]!;
    const input = createInputState();
    const arenaResolutions: number[] = [];
    const arenaImpacts: number[] = [];
    let prevResolved = 0;
    let prevZoneCount = 0;
    for (let i = 0; i < SECOND_IMPACT_FRAME + 20; i += 1) {
      arenaWorld.frameCount += 1;
      arenaWorld.elapsedMs += DELTA;
      runCoreSimulationStep(arenaWorld, input, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
      const inst = arenaWorld.mobAbilities.byEntity.get(don);
      if (inst && inst.resolvedCasts > prevResolved) {
        arenaResolutions.push(arenaWorld.frameCount);
        prevResolved = inst.resolvedCasts;
      }
      if (arenaWorld.mobAbilities.activeZones.length > prevZoneCount) {
        arenaImpacts.push(arenaWorld.frameCount);
        prevZoneCount = arenaWorld.mobAbilities.activeZones.length;
      }
      if (arenaWorld.mobAbilities.activeZones.length === 0) {
        prevZoneCount = 0;
      }
    }
    expect(arenaResolutions).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    expect(arenaImpacts).toEqual([FIRST_IMPACT_FRAME, SECOND_IMPACT_FRAME]);
    expect(
      arenaWorld.announcements.filter(
        (event) => event.kind === 'bossAbilityCast' && event.text === EXPECTED_ANNOUNCEMENT,
      ),
    ).toHaveLength(2);

    const normalWorld = createTestWorld();
    const normalPlayer = spawnPlayer(normalWorld, 40, 40);
    normalWorld.stores.health.current[normalPlayer] = ARENA_OBSERVER_PLAYER_HP;
    normalWorld.stores.health.max[normalPlayer] = ARENA_OBSERVER_PLAYER_HP;
    const normalDon = spawnBehaviorEnemy(normalWorld, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(normalWorld, normalDon, DON_PACO_KEY);
    for (let i = 0; i < SECOND_IMPACT_FRAME + 20; i += 1) {
      normalWorld.frameCount += 1;
      normalWorld.elapsedMs += DELTA;
      runCoreSimulationStep(normalWorld, input, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
    }
    expect(normalWorld.mobAbilities.enabled).toBe(false);
    expect(
      normalWorld.announcements.filter((event) => event.kind === 'bossAbilityCast'),
    ).toHaveLength(0);
    expect(normalWorld.mobAbilities.activeProjectiles).toHaveLength(0);
    expect(normalWorld.mobAbilities.activeZones).toHaveLength(0);
  });
});
