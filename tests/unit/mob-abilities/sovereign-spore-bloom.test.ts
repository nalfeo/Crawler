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
import { createEntity } from '../../../src/core/spawners/entity-core.js';
import type { MobAbilityCircleGeometry } from '../../../src/core/mob-abilities/types.js';
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
  it('applies impact and cloud damage in each exclusive per-circle zone, outside target is safe', () => {
    // Step to telegraph start to read committed geometry, then place one target
    // in an exclusive portion of each circle (inside that circle, outside the other two),
    // plus one target outside all circles. This proves all three circles are individually
    // checked for damage — not just the first or the centroid.
    const h = buildHarness(); // player at (40, 40) to anchor triangle
    arm(h);
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME);
    const cue = h.world.mobAbilities.cues[0];
    expect(cue?.geometry.kind).toBe('multi-circle');
    if (cue?.geometry.kind !== 'multi-circle') return;
    const circles = cue.geometry.circles as [
      MobAbilityCircleGeometry,
      MobAbilityCircleGeometry,
      MobAbilityCircleGeometry,
    ];

    // For each circle, compute an exclusive point 7 ft from center in the direction away
    // from the other two circles' centroid (radius = 8, so still safely inside).
    function exclusivePoint(
      c: MobAbilityCircleGeometry,
      others: readonly MobAbilityCircleGeometry[],
    ) {
      const cx = others.reduce((s, o) => s + o.x, 0) / others.length;
      const cy = others.reduce((s, o) => s + o.y, 0) / others.length;
      const dx = c.x - cx;
      const dy = c.y - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: c.x + (dx / len) * 7, y: c.y + (dy / len) * 7 };
    }

    const [c0, c1, c2] = circles;
    const p0 = exclusivePoint(c0, [c1, c2]);
    const p1 = exclusivePoint(c1, [c0, c2]);
    const p2 = exclusivePoint(c2, [c0, c1]);
    const outside = { x: 200, y: 200 };

    const t0 = spawnPlayer(h.world, p0.x, p0.y);
    const t1 = spawnPlayer(h.world, p1.x, p1.y);
    const t2 = spawnPlayer(h.world, p2.x, p2.y);
    const tOut = spawnPlayer(h.world, outside.x, outside.y);
    for (const t of [t0, t1, t2, tOut]) {
      h.world.stores.health.current[t] = 100_000;
      h.world.stores.health.max[t] = 100_000;
    }

    // Advance to resolution.
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME - FIRST_TELEGRAPH_FRAME);

    // All three exclusive-zone targets receive impact damage; outside target is untouched.
    expect(h.world.stores.health.current[t0]).toBeLessThan(100_000);
    expect(h.world.stores.health.current[t1]).toBeLessThan(100_000);
    expect(h.world.stores.health.current[t2]).toBeLessThan(100_000);
    expect(h.world.stores.health.current[tOut]).toBe(100_000);

    const afterImpact0 = h.world.stores.health.current[t0] ?? 0;
    const afterImpact1 = h.world.stores.health.current[t1] ?? 0;
    const afterImpact2 = h.world.stores.health.current[t2] ?? 0;

    // One cloud tick: all three inside targets take repeated damage; outside remains safe.
    stepRuntime(h.world, CLOUD_TICK_FRAMES);
    expect(h.world.stores.health.current[t0]).toBeLessThan(afterImpact0);
    expect(h.world.stores.health.current[t1]).toBeLessThan(afterImpact1);
    expect(h.world.stores.health.current[t2]).toBeLessThan(afterImpact2);
    expect(h.world.stores.health.current[tOut]).toBe(100_000);
  });

  it('skips resolution and registers no zone when the locked target is invalid at resolution time', () => {
    // Telegraph commits the player's position, then the player dies before resolution.
    // isTargetValid returns false → resolveCast does not fire → no zone created.
    const h = buildHarness();
    arm(h);
    // Advance to telegraph start (target committed).
    stepRuntime(h.world, FIRST_TELEGRAPH_FRAME);
    expect(h.world.mobAbilities.cues[0]).toBeDefined();

    // Kill the player during the telegraph window.
    h.world.stores.health.current[h.player] = 0;
    const inst = h.world.mobAbilities.byEntity.get(h.sovereign);
    const resolvedBefore = inst?.resolvedCasts ?? 0;

    // Advance to resolution.
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME - FIRST_TELEGRAPH_FRAME);

    // No zone registered, no resolvedCasts increment, geometry cleared.
    expect(h.world.mobAbilities.ownedZones).toHaveLength(0);
    const instAfter = h.world.mobAbilities.byEntity.get(h.sovereign);
    expect(instAfter?.resolvedCasts).toBe(resolvedBefore);
    expect(instAfter?.committedGeometry).toBeNull();
  });

  it('clears zones immediately when the caster EID is recycled while a zone is active', () => {
    // After resolution a zone is active. The caster entity is removed and its EID
    // reused by a new entity (simulating ID recycling). On the next system tick,
    // isCasterValid detects the token/archetype mismatch and clears all owned zones.
    const h = buildHarness();
    arm(h);
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME);
    expect(h.world.mobAbilities.ownedZones.length).toBeGreaterThan(0);

    // Remove the caster entity and allocate a new entity that recycles the same EID.
    removeEntity(h.world.ecs, h.sovereign);
    createEntity(h.world); // increments generation on the recycled slot → token invalidated

    // One system step: isCasterValid catches the mismatch, clears mob-ability state.
    stepRuntime(h.world, 1);
    expect(h.world.mobAbilities.ownedZones).toHaveLength(0);
    expect(h.world.mobAbilities.byEntity.has(h.sovereign)).toBe(false);
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

  it('does not apply a post-death cloud tick at the next tick boundary', () => {
    const h = buildHarness();
    arm(h);
    stepRuntime(h.world, FIRST_RESOLUTION_FRAME);
    const hpAfterResolve = h.world.stores.health.current[h.player] ?? 0;
    stepRuntime(h.world, CLOUD_TICK_FRAMES - 1);
    h.world.stores.health.current[h.sovereign] = 0;
    stepRuntime(h.world, 1);
    expect(h.world.mobAbilities.ownedZones).toHaveLength(0);
    expect(h.world.stores.health.current[h.player]).toBe(hpAfterResolve);
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
