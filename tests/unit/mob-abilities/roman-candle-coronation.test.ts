/**
 * Deterministic coverage for King Skritt's ROMAN-CANDLE CORONATION typed
 * mob-ability runtime.
 *
 * Hard success gate (issue #1955): a deterministic canonical combat-arena run
 * records exactly two fully resolved casts at the expected fixed cadence and
 * proves the second twelve-spoke pattern is offset exactly 15 degrees from the
 * first. The default normal-game configuration records zero casts/events over
 * the same duration.
 *
 * All timing assertions use fixed simulation steps (`GAME.DELTA_MS`); no
 * `Math.random()`, no wall-clock time.
 */
import { describe, expect, it } from 'vitest';
import { query, removeEntity } from 'bitecs';
import { GAME, ENEMY_PROJECTILE } from '../../../src/shared/constants.js';
import {
  createRomanCandleCoronationDefinition,
  ROMAN_CANDLE_CORONATION_ABILITY_ID,
  activateMobAbilityEncounter,
  clearMobAbility,
  disableMobAbilityEncounter,
  mobAbilitySystem,
  registerMobAbility,
  setEnemyAppearanceKey,
  setMobAbilitiesEnabled,
  spawnBehaviorEnemy,
  spawnPlayer,
  statusEffectSystem,
  Projectile,
  EnemyProjectile,
  type MobAbilityRuntimeDefinition,
} from '../../../src/core/index.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { AI_TYPE } from '../../../src/game/enemyAISystem.js';
import { SeededRandom } from '../../../src/shared/random.js';
import {
  getEnemyPreset,
  getRoomPreset,
  spawnPresetAroundCenter,
} from '../../../src/labs/combat-arena-lab/arena-data.js';

const DELTA = GAME.DELTA_MS;

// ── Deterministic frame boundaries from the catalog cadence ──────────────────
// firstEligibleAfterMs = 8,000ms, telegraphDurationMs = 1,300ms, cooldownMs = 8,000ms
// DELTA = 1000/60 ms ⟹ exact frame counts:
const FIRST_TELEGRAPH_FRAME = 480; // 8,000ms = 480 × DELTA
const FIRST_RESOLUTION_FRAME = 558; // 9,300ms = 558 × DELTA
const SECOND_TELEGRAPH_FRAME = 1038; // 17,300ms = 1038 × DELTA
const SECOND_RESOLUTION_FRAME = 1116; // 18,600ms = 1116 × DELTA

const KING_KEY = 'kobold-boss';
const EXPECTED_ANNOUNCEMENT = 'ROMAN-CANDLE CORONATION — All hail the Unburnt!';

type World = ReturnType<typeof createTestWorld>;

interface Harness {
  world: World;
  player: number;
  king: number;
  def: MobAbilityRuntimeDefinition;
}

function buildHarness(px = 40, py = 40, kx = 40, ky = 10): Harness {
  const world = createTestWorld();
  const player = spawnPlayer(world, px, py);
  world.stores.health.current[player] = 1_000_000;
  world.stores.health.max[player] = 1_000_000;
  const king = spawnBehaviorEnemy(world, kx, ky, 500, AI_TYPE.CHASE, 0.13, 55, 0);
  setEnemyAppearanceKey(world, king, KING_KEY);
  const def = createRomanCandleCoronationDefinition();
  return { world, player, king, def };
}

function arm(h: Harness): void {
  setMobAbilitiesEnabled(h.world, true);
  registerMobAbility(h.world, h.king, h.def);
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

function instance(world: World, eid: number) {
  const inst = world.mobAbilities.byEntity.get(eid);
  if (!inst) throw new Error('expected runtime instance');
  return inst;
}

/** Observes telegraph-start and resolution events across N frames. */
function recordTimeline(h: Harness, frames: number) {
  const telegraphs: Array<{ frame: number; elapsedMs: number; offsetDeg: number }> = [];
  const resolutions: Array<{ frame: number; elapsedMs: number }> = [];
  let prevAnnounce = 0;
  let prevResolved = 0;
  for (let i = 0; i < frames; i += 1) {
    h.world.frameCount += 1;
    h.world.elapsedMs += DELTA;
    statusEffectSystem(h.world);
    mobAbilitySystem(h.world);
    const inst = h.world.mobAbilities.byEntity.get(h.king);
    if (inst === undefined) continue;
    if (inst.announcementsEmitted > prevAnnounce) {
      const geom = inst.committedGeometry;
      const offsetDeg =
        geom?.kind === 'radial-projectiles' ? geom.offsetDeg : Number.NaN;
      telegraphs.push({ frame: h.world.frameCount, elapsedMs: h.world.elapsedMs, offsetDeg });
      prevAnnounce = inst.announcementsEmitted;
    }
    if (inst.resolvedCasts > prevResolved) {
      resolutions.push({ frame: h.world.frameCount, elapsedMs: h.world.elapsedMs });
      prevResolved = inst.resolvedCasts;
    }
  }
  return { telegraphs, resolutions };
}

/** Returns angles (degrees, normalised 0–360) for projectiles spawned between beforeCount and after. */
function captureAnglesDeg(world: World, beforeCount: number): number[] {
  const eids = Array.from(query(world.ecs, [Projectile, EnemyProjectile]));
  return eids.slice(beforeCount).map((eid) => {
    const vx = world.stores.velocity.x[eid] ?? 0;
    const vy = world.stores.velocity.y[eid] ?? 0;
    const angleDeg = (Math.atan2(vy, vx) * 180) / Math.PI;
    return ((angleDeg % 360) + 360) % 360;
  });
}

function enemyProjectileCount(world: World): number {
  return query(world.ecs, [Projectile, EnemyProjectile]).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed definition contract
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — typed definition', () => {
  it('derives the exact catalog contract from the approved floor2 entry', () => {
    const def = createRomanCandleCoronationDefinition();
    expect(def.abilityId).toBe(ROMAN_CANDLE_CORONATION_ABILITY_ID);
    expect(def.bossArchetypeKey).toBe(KING_KEY);
    expect(def.firstEligibleAfterMs).toBe(8_000);
    expect(def.cooldownMs).toBe(8_000);
    expect(def.telegraphDurationMs).toBe(1_300);
    expect(def.dangerColor).toBe('hostile-red');
    expect(def.announcementText).toBe(EXPECTED_ANNOUNCEMENT);
    expect(def.geometry).toMatchObject({
      kind: 'radial-projectiles',
      count: 12,
      alternateOffsetDeg: 15,
    });
    expect((def.geometry as { spokeLengthFt: number }).spokeLengthFt).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cadence (hard success gate)
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — cadence', () => {
  it('first eligibility at 8,000ms and first resolution at 9,300ms', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs, resolutions } = recordTimeline(h, FIRST_RESOLUTION_FRAME + 5);
    expect(telegraphs[0]?.frame).toBe(FIRST_TELEGRAPH_FRAME);
    expect(resolutions[0]?.frame).toBe(FIRST_RESOLUTION_FRAME);
    expect(Math.abs(telegraphs[0]!.elapsedMs - 8_000)).toBeLessThan(DELTA);
    expect(Math.abs(resolutions[0]!.elapsedMs - 9_300)).toBeLessThan(DELTA);
    // Telegraph window spans exactly telegraphDurationMs.
    expect(resolutions[0]!.elapsedMs - telegraphs[0]!.elapsedMs).toBeCloseTo(1_300, 6);
  });

  it('records exactly two fully resolved casts at the expected fixed cadence', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs, resolutions } = recordTimeline(h, SECOND_RESOLUTION_FRAME + 5);
    expect(telegraphs.map((t) => t.frame)).toEqual([
      FIRST_TELEGRAPH_FRAME,
      SECOND_TELEGRAPH_FRAME,
    ]);
    expect(resolutions.map((r) => r.frame)).toEqual([
      FIRST_RESOLUTION_FRAME,
      SECOND_RESOLUTION_FRAME,
    ]);
    expect(Math.abs(telegraphs[1]!.elapsedMs - 17_300)).toBeLessThan(DELTA);
    expect(Math.abs(resolutions[1]!.elapsedMs - 18_600)).toBeLessThan(DELTA);
    expect(instance(h.world, h.king).resolvedCasts).toBe(2);
  });

  it('anchors the cooldown after resolution, not at telegraph start', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const inst = instance(h.world, h.king);
    expect(inst.phase).toBe('cooldown');
    expect(inst.resolvedCasts).toBe(1);
    // Cooldown timer must be ≤ cooldownMs and close to it (just ticked down one step).
    expect(inst.timerMs).toBeGreaterThan(8_000 - DELTA * 1.5);
    expect(inst.timerMs).toBeLessThanOrEqual(8_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Twelve-spoke geometry and committed pattern
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — twelve-spoke geometry', () => {
  it('commits radial-projectiles geometry with exactly 12 spokes at telegraph start', () => {
    const h = buildHarness(40, 40, 40, 10);
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME);
    const inst = instance(h.world, h.king);
    expect(inst.phase).toBe('telegraph');
    const geom = inst.committedGeometry;
    expect(geom?.kind).toBe('radial-projectiles');
    if (geom?.kind !== 'radial-projectiles') return;
    expect(geom.count).toBe(12);
    expect(geom.casterX).toBeCloseTo(40, 5);
    expect(geom.casterY).toBeCloseTo(10, 5);
  });

  it('locks the caster position at telegraph start — does not track after lock', () => {
    const h = buildHarness(40, 40, 40, 10);
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME);
    const geomLocked = instance(h.world, h.king).committedGeometry;
    if (geomLocked?.kind !== 'radial-projectiles') throw new Error();
    const { casterX, casterY } = geomLocked;

    // Move the caster far away mid-telegraph.
    h.world.stores.position.x[h.king] = 200;
    h.world.stores.position.y[h.king] = 200;
    step(h.world, 5);

    const geomAfter = instance(h.world, h.king).committedGeometry;
    if (geomAfter?.kind !== 'radial-projectiles') throw new Error();
    expect(geomAfter.casterX).toBe(casterX);
    expect(geomAfter.casterY).toBe(casterY);
  });

  it('publishes a radial-projectiles cue during the telegraph phase', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    const cues = h.world.mobAbilities.cues;
    expect(cues).toHaveLength(1);
    expect(cues[0]!.geometry.kind).toBe('radial-projectiles');
    expect(cues[0]!.casterEid).toBe(h.king);
    expect(cues[0]!.dangerColor).toBe('hostile-red');
    expect(cues[0]!.telegraphProgress).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exact 15-degree alternation (hard success gate)
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — 15-degree alternation', () => {
  it('first cast uses 0° offset, second cast uses 15° offset', () => {
    const h = buildHarness();
    arm(h);
    const { telegraphs } = recordTimeline(h, SECOND_RESOLUTION_FRAME + 5);
    expect(telegraphs).toHaveLength(2);
    // Cast 1 (resolvedCasts=0 at telegraph start) → even ordinal → 0°.
    expect(telegraphs[0]!.offsetDeg).toBe(0);
    // Cast 2 (resolvedCasts=1 at telegraph start) → odd ordinal → 15°.
    expect(telegraphs[1]!.offsetDeg).toBe(15);
  });

  it('alternates deterministically for a third cast: 0°→15°→0°', () => {
    const h = buildHarness();
    arm(h);
    // 3rd telegraph at: first_resolution(9300ms) + cooldown(8000ms) = 17300ms;
    // 2nd resolution(18600ms) + cooldown(8000ms) + telegraph starts at 26600ms = 1596 frames.
    const THIRD_TELEGRAPH_FRAME = 1596;
    const { telegraphs } = recordTimeline(h, THIRD_TELEGRAPH_FRAME + 5);
    expect(telegraphs.length).toBeGreaterThanOrEqual(3);
    expect(telegraphs[0]!.offsetDeg).toBe(0);
    expect(telegraphs[1]!.offsetDeg).toBe(15);
    expect(telegraphs[2]!.offsetDeg).toBe(0);
  });

  it('re-registration resets resolvedCasts so the next cast uses 0° (no wall-clock dependency)', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME); // complete 1st cast (resolvedCasts=1)
    // Force re-registration: resets resolvedCasts to 0.
    registerMobAbility(h.world, h.king, h.def);
    expect(instance(h.world, h.king).resolvedCasts).toBe(0);

    // The next telegraph must use 0° offset (even ordinal after reset).
    step(h.world, FIRST_TELEGRAPH_FRAME);
    const geom = instance(h.world, h.king).committedGeometry;
    if (geom?.kind !== 'radial-projectiles') throw new Error();
    expect(geom.offsetDeg).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Simultaneous launch of exactly 12 projectiles
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — simultaneous launch', () => {
  it('spawns exactly 12 enemy projectiles at the resolution frame', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME - 1);
    const beforeCount = query(h.world.ecs, [Projectile, EnemyProjectile]).length;
    step(h.world, 1);
    const afterCount = query(h.world.ecs, [Projectile, EnemyProjectile]).length;
    expect(afterCount - beforeCount).toBe(12);
  });

  it('all 12 projectiles are launched from the locked caster position', () => {
    const h = buildHarness(40, 40, 40, 10);
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME);
    const geom = instance(h.world, h.king).committedGeometry;
    if (geom?.kind !== 'radial-projectiles') throw new Error();
    const { casterX, casterY } = geom;

    const beforeCount = query(h.world.ecs, [Projectile, EnemyProjectile]).length;
    step(h.world, FIRST_RESOLUTION_FRAME - FIRST_TELEGRAPH_FRAME);
    const eids = Array.from(query(h.world.ecs, [Projectile, EnemyProjectile]));
    const launched = eids.slice(beforeCount);
    expect(launched).toHaveLength(12);
    for (const eid of launched) {
      expect(h.world.stores.position.x[eid]).toBeCloseTo(casterX, 2);
      expect(h.world.stores.position.y[eid]).toBeCloseTo(casterY, 2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-homing travel (straight projectiles)
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — non-homing travel', () => {
  it('projectile velocity is constant across frames (no homing)', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME - 1);
    const beforeCount = query(h.world.ecs, [Projectile, EnemyProjectile]).length;
    step(h.world, 1);
    const eids = Array.from(query(h.world.ecs, [Projectile, EnemyProjectile]));
    const launched = eids.slice(beforeCount);
    expect(launched).toHaveLength(12);

    // Snapshot velocities immediately after launch.
    const snapshot = launched.map((eid) => ({
      vx: h.world.stores.velocity.x[eid] ?? 0,
      vy: h.world.stores.velocity.y[eid] ?? 0,
    }));

    // After 10 more steps, velocity must be unchanged (no homing correction).
    step(h.world, 10);
    for (let i = 0; i < launched.length; i += 1) {
      const eid = launched[i]!;
      expect(h.world.stores.velocity.x[eid]).toBeCloseTo(snapshot[i]!.vx, 8);
      expect(h.world.stores.velocity.y[eid]).toBeCloseTo(snapshot[i]!.vy, 8);
    }
  });

  it('first-cast spoke velocities cover all 12 evenly-spaced directions at canonical speed', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME - 1);
    const beforeCount = query(h.world.ecs, [Projectile, EnemyProjectile]).length;
    step(h.world, 1);
    const eids = Array.from(query(h.world.ecs, [Projectile, EnemyProjectile]));
    const launched = eids.slice(beforeCount);
    expect(launched).toHaveLength(12);

    const angles = launched
      .map((eid) => {
        const vx = h.world.stores.velocity.x[eid] ?? 0;
        const vy = h.world.stores.velocity.y[eid] ?? 0;
        return ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
      })
      .sort((a, b) => a - b);

    // Each projectile travels at the canonical enemy speed.
    for (const eid of launched) {
      const vx = h.world.stores.velocity.x[eid] ?? 0;
      const vy = h.world.stores.velocity.y[eid] ?? 0;
      expect(Math.hypot(vx, vy)).toBeCloseTo(ENEMY_PROJECTILE.SPEED, 6);
    }

    // With 0° offset, the 12 spokes must hit every 30° of the circle.
    for (let i = 0; i < 12; i += 1) {
      const expected = (i / 12) * 360; // 0°, 30°, 60°, …, 330°
      const found = angles.some((a) => Math.abs(((a - expected + 180) % 360) - 180) < 0.02);
      expect(found, `spoke at ~${expected}° not found in angles [${angles.join(', ')}]`).toBe(
        true,
      );
    }
  });

  it('second-cast angles are exactly 15° offset from first-cast angles', () => {
    const h = buildHarness();
    arm(h);

    // Capture first cast.
    step(h.world, FIRST_RESOLUTION_FRAME - 1);
    const beforeFirst = query(h.world.ecs, [Projectile, EnemyProjectile]).length;
    step(h.world, 1);
    const firstAngles = captureAnglesDeg(h.world, beforeFirst).sort((a, b) => a - b);

    // Capture second cast.
    step(h.world, SECOND_RESOLUTION_FRAME - FIRST_RESOLUTION_FRAME - 1);
    const beforeSecond = query(h.world.ecs, [Projectile, EnemyProjectile]).length;
    step(h.world, 1);
    const secondAngles = captureAnglesDeg(h.world, beforeSecond).sort((a, b) => a - b);

    expect(firstAngles).toHaveLength(12);
    expect(secondAngles).toHaveLength(12);
    // Every second-cast angle must be exactly 15° more than the matching first-cast angle (mod 360).
    for (let i = 0; i < 12; i += 1) {
      const diff = ((secondAngles[i]! - firstAngles[i]! + 360) % 360);
      expect(diff).toBeCloseTo(15, 2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Announcement deduplication
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — announcement deduplication', () => {
  it('emits exactly one announcement per cast (two total for two casts)', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, SECOND_RESOLUTION_FRAME + 5);
    const bossAbilityAnnouncements = h.world.announcements.filter(
      (event) => event.kind === 'bossAbilityCast',
    );
    expect(bossAbilityAnnouncements).toHaveLength(2);
    for (const a of bossAbilityAnnouncements) {
      expect(a.text).toBe(EXPECTED_ANNOUNCEMENT);
    }
    const inst = instance(h.world, h.king);
    expect(inst.announcementsEmitted).toBe(2);
    expect(inst.resolvedCasts).toBe(2);
  });

  it('after first resolution: announcementsEmitted=1, resolvedCasts=1 (no double-emit)', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    const inst = instance(h.world, h.king);
    expect(inst.announcementsEmitted).toBe(1);
    expect(inst.resolvedCasts).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: death, disable, re-registration, despawn
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — cleanup', () => {
  it('clears cues and instance when the caster dies mid-telegraph', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 10); // mid-telegraph
    expect(h.world.mobAbilities.cues.filter((c) => c.casterEid === h.king)).toHaveLength(1);

    // Kill the caster (health system runs in healthSystem, wired by world).
    h.world.stores.health.current[h.king] = 0;
    step(h.world, 1);

    expect(h.world.mobAbilities.byEntity.has(h.king)).toBe(false);
    expect(h.world.mobAbilities.cues.filter((c) => c.casterEid === h.king)).toHaveLength(0);
  });

  it('clears all state when the encounter is disabled mid-telegraph', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    disableMobAbilityEncounter(h.world);
    expect(h.world.mobAbilities.cues).toHaveLength(0);
    expect(h.world.mobAbilities.byEntity.size).toBe(0);
    expect(h.world.mobAbilities.pendingBursts).toHaveLength(0);
  });

  it('clears state when clearMobAbility is called explicitly', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 5);
    clearMobAbility(h.world, h.king);
    expect(h.world.mobAbilities.byEntity.has(h.king)).toBe(false);
    expect(h.world.mobAbilities.cues.filter((c) => c.casterEid === h.king)).toHaveLength(0);
  });

  it('retires in-flight coronation projectiles across every cleanup path', () => {
    const byClear = buildHarness();
    arm(byClear);
    step(byClear.world, FIRST_RESOLUTION_FRAME);
    expect(enemyProjectileCount(byClear.world)).toBe(12);
    clearMobAbility(byClear.world, byClear.king);
    expect(enemyProjectileCount(byClear.world)).toBe(0);

    const byDisable = buildHarness();
    arm(byDisable);
    step(byDisable.world, FIRST_RESOLUTION_FRAME);
    expect(enemyProjectileCount(byDisable.world)).toBe(12);
    disableMobAbilityEncounter(byDisable.world);
    expect(enemyProjectileCount(byDisable.world)).toBe(0);

    const byDeath = buildHarness();
    arm(byDeath);
    step(byDeath.world, FIRST_RESOLUTION_FRAME);
    expect(enemyProjectileCount(byDeath.world)).toBe(12);
    byDeath.world.stores.health.current[byDeath.king] = 0;
    step(byDeath.world, 1);
    expect(enemyProjectileCount(byDeath.world)).toBe(0);

    const byDespawn = buildHarness();
    arm(byDespawn);
    step(byDespawn.world, FIRST_RESOLUTION_FRAME);
    expect(enemyProjectileCount(byDespawn.world)).toBe(12);
    removeEntity(byDespawn.world.ecs, byDespawn.king);
    step(byDespawn.world, 1);
    expect(enemyProjectileCount(byDespawn.world)).toBe(0);
  });

  it('re-registration resets resolvedCasts and restarts the cooldown clock', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_RESOLUTION_FRAME);
    expect(instance(h.world, h.king).resolvedCasts).toBe(1);

    registerMobAbility(h.world, h.king, h.def);
    const after = instance(h.world, h.king);
    expect(after.resolvedCasts).toBe(0);
    expect(after.phase).toBe('cooldown');
  });

  it('despawn (removeEntity) during telegraph does not leave stale cues', () => {
    const h = buildHarness();
    arm(h);
    step(h.world, FIRST_TELEGRAPH_FRAME + 3);
    removeEntity(h.world.ecs, h.king);
    step(h.world, 1);
    expect(h.world.mobAbilities.cues.filter((c) => c.casterEid === h.king)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zero casts in default (ability not registered) configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — default production config', () => {
  it('records zero casts when the ability is NOT registered (default game state)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 40, 40);
    spawnBehaviorEnemy(world, 40, 10, 500, AI_TYPE.CHASE, 0.13, 55, 0);
    // Deliberately do NOT enable or register the ability — this is production default.
    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 20; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      mobAbilitySystem(world);
    }
    expect(world.mobAbilities.byEntity.size).toBe(0);
    expect(world.mobAbilities.cues).toHaveLength(0);
    expect(world.announcements.filter((e) => e.kind === 'bossAbilityCast')).toHaveLength(0);
  });

  it('records zero casts when enabled but encounter is NOT activated', () => {
    const h = buildHarness();
    setMobAbilitiesEnabled(h.world, true);
    registerMobAbility(h.world, h.king, h.def);
    // Deliberately do NOT call activateMobAbilityEncounter.
    step(h.world, FIRST_RESOLUTION_FRAME + 10);
    const inst = instance(h.world, h.king);
    expect(inst.resolvedCasts).toBe(0);
    expect(inst.announcementsEmitted).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical arena preset integration
// ─────────────────────────────────────────────────────────────────────────────

describe('Roman Candle Coronation — canonical arena preset', () => {
  it('f2-king-skritt preset is registered and configured correctly', () => {
    const preset = getEnemyPreset('f2-king-skritt');
    expect(preset.id).toBe('f2-king-skritt');
    expect(preset.floor).toBe('floor2');
    expect(preset.customSpawnFn).toBeDefined();
  });

  it('spawning the f2-king-skritt preset arms the runtime with the coronation ability', () => {
    const world = createTestWorld();
    spawnPlayer(world, 40, 40);
    const room = getRoomPreset('boss-arena');
    const map = room.buildMap();
    const rng = new SeededRandom(42);
    spawnPresetAroundCenter(world, map, getEnemyPreset('f2-king-skritt'), 40, 40, rng);

    expect(world.mobAbilities.enabled).toBe(true);
    expect(world.mobAbilities.encounterActive).toBe(true);
    expect(world.mobAbilities.byEntity.size).toBe(1);
    const inst = [...world.mobAbilities.byEntity.values()][0]!;
    expect(inst.definition.abilityId).toBe(ROMAN_CANDLE_CORONATION_ABILITY_ID);
  });

  it('arena run records exactly two resolved casts at the fixed cadence', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 40, 40);
    world.stores.health.current[player] = 1_000_000;
    world.stores.health.max[player] = 1_000_000;
    const room = getRoomPreset('boss-arena');
    const map = room.buildMap();
    const rng = new SeededRandom(99);
    spawnPresetAroundCenter(world, map, getEnemyPreset('f2-king-skritt'), 40, 40, rng);

    for (let i = 0; i < SECOND_RESOLUTION_FRAME + 5; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += DELTA;
      statusEffectSystem(world);
      mobAbilitySystem(world);
    }

    const kingEid = [...world.mobAbilities.byEntity.keys()][0]!;
    const inst = world.mobAbilities.byEntity.get(kingEid)!;
    expect(inst.resolvedCasts).toBe(2);
    expect(inst.announcementsEmitted).toBe(2);
  });
});
