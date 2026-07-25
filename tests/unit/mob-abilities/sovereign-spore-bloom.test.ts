import { describe, expect, it } from 'vitest';
import { removeEntity } from 'bitecs';
import { GAME } from '../../../src/shared/constants.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  activateMobAbilityEncounter,
  createSovereignSporeBloomDefinition,
  disableMobAbilityEncounter,
  mobAbilitySystem,
  registerMobAbility,
  statusEffectSystem,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
} from '../../../src/core/index.js';
import { createTestWorld } from '../../helpers/world-factory.js';
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
const SOVEREIGN_KEY = 'myconid-boss';
const EXPECTED_ANNOUNCEMENT = 'SOVEREIGN SPORE BLOOM — The colony claims this ground!';

const FIRST_TELEGRAPH_FRAME = 540; // 9,000ms
const FIRST_RESOLUTION_FRAME = 636; // +1,600ms
const FIRST_CLOUD_EXPIRE_FRAME = 876; // +4,000ms
const SECOND_TELEGRAPH_FRAME = 1176;
const SECOND_RESOLUTION_FRAME = 1272;
const CLOUD_TICK_FRAMES = 30; // 500ms

type World = ReturnType<typeof createTestWorld>;

interface Harness {
  world: World;
  player: number;
  sovereign: number;
}

function buildHarness(px = 40, py = 40, sx = 40, sy = 10): Harness {
  const world = createTestWorld();
  const player = spawnPlayer(world, px, py);
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;
  const sovereign = spawnBehaviorEnemy(world, sx, sy, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, sovereign, SOVEREIGN_KEY);
  return { world, player, sovereign };
}

function arm(h: Harness): void {
  setMobAbilitiesEnabled(h.world, true);
  registerMobAbility(h.world, h.sovereign, createSovereignSporeBloomDefinition());
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
    const inst = h.world.mobAbilities.byEntity.get(h.sovereign);
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

describe('Sovereign Spore Bloom definition', () => {
  it('matches the catalog contract exactly', () => {
    const def = createSovereignSporeBloomDefinition();
    expect(def.abilityId).toBe('sovereign-cap-spore-bloom');
    expect(def.bossArchetypeKey).toBe(SOVEREIGN_KEY);
    expect(def.firstEligibleAfterMs).toBe(9000);
    expect(def.cooldownMs).toBe(9000);
    expect(def.telegraphDurationMs).toBe(1600);
    expect(def.dangerColor).toBe('hostile-red');
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
    expect(def.geometry).toEqual({ kind: 'circle', radiusFt: 8 });
  });
});

describe('Sovereign Spore Bloom cadence and lock geometry', () => {
  it('records exactly two recurring casts on fixed cadence', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs, resolutions } = recordTimeline(h, SECOND_RESOLUTION_FRAME + 10);
    expect(telegraphs).toEqual([FIRST_TELEGRAPH_FRAME, SECOND_TELEGRAPH_FRAME]);
    expect(resolutions).toEqual([FIRST_RESOLUTION_FRAME, SECOND_RESOLUTION_FRAME]);
    expect(h.world.announcements.filter((a) => a.kind === 'bossAbilityCast')).toHaveLength(2);
  });

  it('locks a three-circle triangle at telegraph start and keeps it through impact and clouds', () => {
    const h = buildHarness();
    arm(h);
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME);
    const cue = h.world.mobAbilities.cues[0];
    expect(cue).toBeDefined();
    expect(cue?.geometry.kind).toBe('multi-circle');
    const lockedGeometry =
      cue?.geometry.kind === 'multi-circle'
        ? {
            kind: 'multi-circle' as const,
            circles: cue.geometry.circles.map((circle) => ({ ...circle })),
          }
        : undefined;
    expect(lockedGeometry?.circles).toHaveLength(3);

    h.world.stores.position.x[h.player] = 160;
    h.world.stores.position.y[h.player] = 160;
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME - FIRST_TELEGRAPH_FRAME);

    const zone = h.world.mobAbilities.ownedZones[0];
    expect(zone).toBeDefined();
    expect(zone?.geometry).toEqual(lockedGeometry);
  });
});

describe('Sovereign Spore Bloom damage and zone lifecycle', () => {
  it('applies impact at resolution then repeated cloud damage inside while outside stays safe', () => {
    const h = buildHarness();
    const outsider = spawnPlayer(h.world, 200, 200);
    h.world.stores.health.current[outsider] = 100_000;
    const playerStart = h.world.stores.health.current[h.player] ?? 0;
    const outsiderStart = h.world.stores.health.current[outsider] ?? 0;
    arm(h);
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME);
    const afterImpact = h.world.stores.health.current[h.player] ?? 0;
    expect(afterImpact).toBeLessThan(playerStart);
    expect(h.world.stores.health.current[outsider]).toBe(outsiderStart);

    stepRuntime(h.world, CLOUD_TICK_FRAMES);
    const afterTick = h.world.stores.health.current[h.player] ?? 0;
    expect(afterTick).toBeLessThan(afterImpact);
    expect(h.world.stores.health.current[outsider]).toBe(outsiderStart);
  });

  it('expires clouds exactly after 4 seconds and cleans up on death/despawn/encounter disable', () => {
    const h = buildHarness();
    arm(h);
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME);
    expect(h.world.mobAbilities.ownedZones.length).toBeGreaterThan(0);
    stepRuntime(h.world, FIRST_CLOUD_EXPIRE_FRAME - FIRST_RESOLUTION_FRAME);
    expect(h.world.mobAbilities.ownedZones).toHaveLength(0);

    const dead = buildHarness();
    arm(dead);
    stepRuntime(dead.world, FIRST_RESOLUTION_FRAME);
    expect(dead.world.mobAbilities.ownedZones.length).toBeGreaterThan(0);
    dead.world.stores.health.current[dead.sovereign] = 0;
    stepRuntime(dead.world, 1);
    expect(dead.world.mobAbilities.ownedZones).toHaveLength(0);

    const despawned = buildHarness();
    arm(despawned);
    stepRuntime(despawned.world, FIRST_RESOLUTION_FRAME);
    removeEntity(despawned.world.ecs, despawned.sovereign);
    stepRuntime(despawned.world, 1);
    expect(despawned.world.mobAbilities.ownedZones).toHaveLength(0);

    const disabled = buildHarness();
    arm(disabled);
    stepRuntime(disabled.world, FIRST_RESOLUTION_FRAME);
    disableMobAbilityEncounter(disabled.world);
    expect(disabled.world.mobAbilities.ownedZones).toHaveLength(0);
    expect(disabled.world.mobAbilities.byEntity.size).toBe(0);
  });
});

describe('Sovereign Spore Bloom canonical combat arena', () => {
  it('default normal-game configuration records zero casts over the same duration', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 100_000;
    const sovereign = spawnBehaviorEnemy(world, 40, 10, 200, AI_TYPE.CHASE, 0.17, 60, 0);
    setEnemyAppearanceKey(world, sovereign, SOVEREIGN_KEY);
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

  it('arena preset f2-sovereign-cap records exactly two resolved casts', () => {
    const world = createTestWorld();
    const roomPreset = getRoomPreset('boss-arena');
    world.floorMap = roomPreset.buildMap();
    const spawnWorld = world.floorMap.tileToWorld(
      roomPreset.playerSpawnTile.x,
      roomPreset.playerSpawnTile.y,
    );
    const player = spawnPlayer(world, spawnWorld.x, spawnWorld.y);
    world.stores.health.current[player] = ARENA_OBSERVER_PLAYER_HP;
    world.stores.health.max[player] = ARENA_OBSERVER_PLAYER_HP;
    const preset = getEnemyPreset('f2-sovereign-cap');
    const rng = new SeededRandom(42);
    const cx = world.floorMap.widthFt / 2;
    const cy = world.floorMap.heightFt * 0.35;
    const spawned = spawnPresetAroundCenter(world, world.floorMap, preset, cx, cy, rng, 14);
    const sovereign = spawned[0];
    expect(sovereign).toBeDefined();
    const inputState = createInputState();

    const resolutionFrames: number[] = [];
    let prevResolved = 0;
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });
      const inst = world.mobAbilities.byEntity.get(sovereign!);
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
