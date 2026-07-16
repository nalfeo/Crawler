import { addComponent, hasComponent, query, removeComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  EffectiveStats,
  Enemy,
  Health,
  Knockback,
  Position,
  Sprite,
} from '../../src/core/components.js';
import { spawnBeam, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { beamSystem } from '../../src/core/systems/beamSystem.js';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { tagDamageMeta } from '../../src/core/damage-meta.js';
import { TeamId } from '../../src/shared/constants.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Beam broad-phase determinism regression suite.
 *
 * `beamSystem` was converted from a full `[Health, Position]` scan to a
 * spatial-hash `queryRadius` broad-phase. Because `applyDamage` draws `world.rng`
 * once per qualifying hit (crit for enemy targets, dodge for player targets), the
 * ORDER in which targets are processed is determinism-observable — reordering hits
 * would change the RNG draw sequence and silently break the 90% Floor-1 seed
 * win-rate gate.
 *
 * The optimization is identical-by-construction: a superset query + the unchanged
 * narrow-phase + legacy iteration order preserved via a canonical rank map. Unlike
 * melee, the grid is STALE for beams (knockbackSystem moves entities after the grid
 * is built), so the broad-phase radius is inflated by `world.maxKnockbackStepThisFrame`
 * to stay a guaranteed superset. This PERMANENT suite is the deterministic gate that
 * proves it (project rule #10): the same production function is driven both ways —
 * WITH a grid (broad-phase) and WITHOUT one (the executable full-scan fallback, i.e.
 * the legacy reference) — and their outcomes must be byte-identical, including the
 * exact RNG cursor.
 */

/**
 * Read the SeededRandom's internal xorshift cursor. `state` is `private` in
 * TypeScript but a real runtime field (TS `private` is not name-mangled), so a
 * test-only cast lets us assert the EXACT RNG position — not just the draw count —
 * matches between the two drivers each frame.
 */
function rngCursor(world: GameWorld): number {
  return (world.rng as unknown as { state: number }).state;
}

function healthSnapshot(world: GameWorld): number[] {
  return Array.from(
    query(world.ecs, [Health]),
    (eid) => world.stores.health.current[eid] ?? Number.NaN,
  );
}

function positionSnapshot(world: GameWorld): number[] {
  const out: number[] = [];
  for (const eid of query(world.ecs, [Position])) {
    out.push(world.stores.position.x[eid] ?? Number.NaN);
    out.push(world.stores.position.y[eid] ?? Number.NaN);
  }
  return out;
}

/** Give the player computed stats so `applyDamage` actually draws crit/dodge rolls. */
function grantCombatRolls(world: GameWorld, player: number): void {
  addComponent(world.ecs, player, EffectiveStats);
  world.stores.effectiveStats.critChance[player] = 0.5;
  world.stores.effectiveStats.critMultiplier[player] = 2;
  world.stores.effectiveStats.dodgeChance[player] = 0.5;
}

const ORIGIN_X = 0;
const ORIGIN_Y = 0;
const BEAM_LENGTH = 24;

/**
 * Enemy offsets deliberately scrambled: consecutive spawn order (⇒ ascending eid,
 * the legacy iteration order) does NOT match spatial/grid-cell order. Enemies lie
 * within the beam's 1ft half-width (|dy| ≤ 0.9) but their x spans multiple 8ft grid
 * cells in a scrambled sequence, so if the rank-map sort were wrong the crit draws
 * would land on different enemies and this suite would diverge.
 */
const SCRAMBLED_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [10, 0.4],
  [4, -0.5],
  [17, 0.3],
  [7, -0.8],
  [19, 0.6],
  [3, -0.3],
  [13, 0.7],
  [6, -0.6],
  [16, -0.2],
  [9, 0.5],
];

interface BeamScene {
  world: GameWorld;
  enemies: number[];
}

/**
 * Dense beam combat scene: a player with crit/dodge rolls at the origin, a cluster
 * of enemies strung along the beam line across multiple grid cells, one persistent
 * player-owned beam firing +x (hits enemies ⇒ crit draws) and one persistent
 * enemy-owned beam firing back at the player (⇒ dodge draws). `tickMs = 0` so both
 * beams re-hit every frame, generating a fresh multi-target RNG draw sequence.
 */
function buildBeamScene(seed: number): BeamScene {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
  grantCombatRolls(world, player);
  // Keep the player alive across all frames so it keeps drawing dodge rolls.
  world.stores.health.current[player] = 100_000;
  world.stores.health.max[player] = 100_000;

  const enemies: number[] = [];
  for (const [dx, dy] of SCRAMBLED_OFFSETS) {
    // Large HP so friendly-fire from the enemy beam never kills them mid-run;
    // dead-or-alive both drivers stay identical, but survival keeps crit draws live.
    enemies.push(spawnEnemy(world, ORIGIN_X + dx, ORIGIN_Y + dy, 100_000));
  }

  // Player beam: origin → +x, covers the whole cluster. tickMs 0 ⇒ hits every frame.
  const playerBeam = spawnBeam(
    world,
    ORIGIN_X,
    ORIGIN_Y,
    1,
    0,
    BEAM_LENGTH,
    3,
    1_000_000,
    0,
    player,
    TeamId.PLAYER,
  );
  // Player-sourced beams must be explicitly tagged for the generic
  // offense/crit branch to trigger — `spawnBeam` is a dumb ECS constructor
  // (the real game tags via weaponSystem.dispatchAttackInner's single choke
  // point after firing). Tag it here so this determinism suite observes the
  // SAME crit-eligible RNG draw sequence a real player beam weapon would.
  tagDamageMeta(world, playerBeam, {
    origin: 'player',
    affinity: 'physical',
    scaleWithPrimary: true,
    canCrit: true,
  });
  // Enemy beam: fires from beyond the cluster back toward the player, drawing dodge.
  spawnBeam(
    world,
    ORIGIN_X + BEAM_LENGTH,
    ORIGIN_Y,
    -1,
    0,
    BEAM_LENGTH,
    2,
    1_000_000,
    0,
    enemies[0]!,
    TeamId.ENEMY,
  );

  return { world, enemies };
}

describe('beamSystem broad-phase determinism', () => {
  it('grid broad-phase is byte-identical to the full-scan reference across many seeds', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i * 1013 + 7);
    let sawCrit = false;
    let sawDodge = false;
    let sawHit = false;

    for (const seed of seeds) {
      const gridScene = buildBeamScene(seed);
      const refScene = buildBeamScene(seed);

      // Sanity: identical construction ⇒ identical starting RNG cursor.
      expect(rngCursor(gridScene.world)).toBe(rngCursor(refScene.world));

      for (let frame = 0; frame < 12; frame += 1) {
        gridScene.world.elapsedMs += 16;
        refScene.world.elapsedMs += 16;

        // Broad-phase invariant guards (rule the once-per-frame rank map depends on):
        // every [Health, Position] combat target is also in the grid ([Position,
        // Sprite]) ⇒ beam-entry set ⊆ grid-build set ⇒ the grid path is actually
        // exercised (not silently falling back), and the set is STABLE across the
        // beam invocation (apply-damage never adds/removes Health), so a future
        // on-hit component mutation that would break rank-map stability trips here.
        const targetsBefore = Array.from(query(gridScene.world.ecs, [Health, Position]));
        for (const target of targetsBefore) {
          expect(hasComponent(gridScene.world.ecs, target, Sprite)).toBe(true);
        }

        // Grid driver: broad-phase (grid threaded in, same as areaDamageSystem).
        const collision = collisionSystem(gridScene.world);
        beamSystem(gridScene.world, collision);

        // Reference driver: no grid ⇒ the executable full-scan fallback = legacy.
        beamSystem(refScene.world);

        const targetsAfter = query(gridScene.world.ecs, [Health, Position]);
        expect(targetsAfter.length).toBe(targetsBefore.length);

        expect(rngCursor(gridScene.world)).toBe(rngCursor(refScene.world));
        expect(healthSnapshot(gridScene.world)).toEqual(healthSnapshot(refScene.world));
        expect(positionSnapshot(gridScene.world)).toEqual(positionSnapshot(refScene.world));
        expect(gridScene.world.combatEvents).toEqual(refScene.world.combatEvents);
        expect(gridScene.world.skillUsageEvents).toEqual(refScene.world.skillUsageEvents);
      }

      for (const event of gridScene.world.combatEvents) {
        if (event.type === 'hit') {
          sawHit = true;
          if (event.isCrit === true) sawCrit = true;
        } else if (event.type === 'dodge') {
          sawDodge = true;
        }
      }
    }

    // Guard against a degenerate scene that never exercises the order-sensitive
    // RNG paths — the whole point is that ordering matters.
    expect(sawHit).toBe(true);
    expect(sawCrit).toBe(true);
    expect(sawDodge).toBe(true);
  });
});

/**
 * Run one beam frame over a scene, either through the grid broad-phase or the
 * full-scan fallback, and return the world for inspection.
 */
function runBeamFrame(setup: (world: GameWorld) => void, useGrid: boolean): GameWorld {
  const world = createTestWorld({ seed: 7 });
  setup(world);
  if (useGrid) {
    const collision = collisionSystem(world);
    beamSystem(world, collision);
  } else {
    beamSystem(world);
  }
  return world;
}

/** Assert the grid path and the full-scan fallback produce identical results for a scene. */
function assertParity(setup: (world: GameWorld) => void): GameWorld {
  const grid = runBeamFrame(setup, true);
  const ref = runBeamFrame(setup, false);
  expect(healthSnapshot(grid)).toEqual(healthSnapshot(ref));
  expect(positionSnapshot(grid)).toEqual(positionSnapshot(ref));
  expect(grid.combatEvents).toEqual(ref.combatEvents);
  expect(grid.skillUsageEvents).toEqual(ref.skillUsageEvents);
  expect(rngCursor(grid)).toBe(rngCursor(ref));
  return grid;
}

/** Spawn a player-owned beam from the origin firing +x with the given length. */
function spawnPlayerBeam(world: GameWorld, player: number, length: number): void {
  spawnBeam(world, ORIGIN_X, ORIGIN_Y, 1, 0, length, 6, 1_000_000, 0, player, TeamId.PLAYER);
}

describe('beamSystem broad-phase boundary + fallback', () => {
  it('matches the reference and hits nothing when there are no targets', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 20);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('hits a target within the beam half-width (identical to the reference)', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 20);
      // 0.9ft off the beam line (< 1ft half-width) ⇒ hit.
      spawnEnemy(world, ORIGIN_X + 10, ORIGIN_Y + 0.9, 100);
    });
    expect(grid.combatEvents.some((event) => event.type === 'hit')).toBe(true);
  });

  it('rejects a target inside the broad-phase radius but outside the hit region (superset correctness)', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 20);
      // 3ft off the beam line: well inside the midpoint bounding circle (radius
      // ≈ 10 + 1 + eps) so it IS queried, but 3ft > 1ft half-width from the
      // segment ⇒ the unchanged narrow-phase correctly rejects it.
      spawnEnemy(world, ORIGIN_X + 10, ORIGIN_Y + 3, 100);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('does not hit a target far outside the broad-phase radius', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 20);
      spawnEnemy(world, ORIGIN_X + 10, ORIGIN_Y + 60, 100);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('matches the reference at a Float32-quantized boundary coordinate', () => {
    // A coordinate not exactly representable in Float32; queryRadius reads Float32
    // centers while the narrow-phase reads live Float64 positions. The eps padding
    // must keep the grid path from dropping a candidate the narrow-phase accepts.
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 20);
      // 0.9999ft off the line — just inside the 1ft half-width after Float32 rounding.
      spawnEnemy(world, ORIGIN_X + 12.3456789, ORIGIN_Y + 0.9999, 100);
    });
    expect(grid.combatEvents.some((event) => event.type === 'hit')).toBe(true);
  });

  it('hits nothing for a zero-length beam with no coincident target', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 0);
      spawnEnemy(world, ORIGIN_X + 3, ORIGIN_Y, 100);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('falls back to the full scan and still hits a spriteless Health target', () => {
    // A [Health, Position] target WITHOUT Sprite is invisible to the spatial grid,
    // so buildBeamRankMap reports the broad-phase unsafe and the system must fall
    // back to the full scan. Proves the fallback is executable, not just a comment.
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 20);
      const enemy = spawnEnemy(world, ORIGIN_X + 10, ORIGIN_Y, 100);
      removeComponent(world.ecs, enemy, Sprite);
    });
    expect(grid.combatEvents.some((event) => event.type === 'hit')).toBe(true);
  });

  it('ignores non-combat grid entities that lack Health', () => {
    // A bare [Position, Sprite] prop sits in the grid but has no Health, so the
    // rank map ranks it -1 and gatherBeamCandidates drops it — exactly the entities
    // the legacy [Health, Position] query never saw.
    assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnPlayerBeam(world, player, 20);
      spawnEnemy(world, ORIGIN_X + 10, ORIGIN_Y, 100);
      const prop = spawnEnemy(world, ORIGIN_X + 11, ORIGIN_Y, 100);
      removeComponent(world.ecs, prop, Health);
      removeComponent(world.ecs, prop, Enemy);
    });
  });

  it('is a no-op on an idle frame with no active beams', () => {
    // With no beams present the lazy rank-map build is never triggered, so the grid
    // path adds zero [Health, Position] scans. Behaviorally this must be a no-op
    // identical to the fallback (no damage, no events).
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      spawnEnemy(world, ORIGIN_X + 10, ORIGIN_Y, 100);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });
});

describe('beamSystem broad-phase — knockback stale-grid witness', () => {
  it('still hits a target knocked into the beam after the grid was built', () => {
    // The grid is built by collisionSystem, THEN knockbackSystem moves entities,
    // THEN beamSystem queries the (now stale) grid. An enemy knocked from outside
    // the bare broad-phase radius INTO the beam must still be found — the radius is
    // inflated by world.maxKnockbackStepThisFrame to remain a guaranteed superset.
    // Without that inflation the grid path would drop the hit and diverge from the
    // full-scan fallback (which always finds the live position).
    const setup = (world: GameWorld): number => {
      const player = spawnPlayer(world, ORIGIN_X, ORIGIN_Y);
      grantCombatRolls(world, player);
      world.elapsedMs = 1000;
      // Beam origin → +x, length 20 ⇒ midpoint (10,0), bare radius ≈ 11ft.
      spawnPlayerBeam(world, player, 20);
      // Enemy starts at (10,13): 13ft above the midpoint, OUTSIDE the ~11ft bare
      // radius, so a non-inflated grid query would never return it.
      const enemy = spawnEnemy(world, ORIGIN_X + 10, ORIGIN_Y + 13, 100);
      // Pin weight to the 120 lb knockback baseline so the sizeScale
      // jitter in `initializeEnemyAppearance` doesn't perturb this
      // bit-parity assertion (Slice 2 / ADR 0044: knockbackSystem now
      // scales displacement by 120/weight).
      world.stores.weight.value[enemy] = 120;
      // Knock it straight down 13ft → lands at (10,0) ON the beam this frame.
      addComponent(
        world.ecs,
        enemy,
        set(Knockback, { dirX: 0, dirY: -1, remaining: 13, speed: 13 }),
      );
      return enemy;
    };

    const gridWorld = createTestWorld({ seed: 7 });
    const gridEnemy = setup(gridWorld);
    const collision = collisionSystem(gridWorld); // grid indexes the enemy at (10,13)
    knockbackSystem(gridWorld); // moves it to (10,0); sets maxKnockbackStepThisFrame
    expect(gridWorld.maxKnockbackStepThisFrame).toBeCloseTo(13, 5);
    beamSystem(gridWorld, collision);

    const refWorld = createTestWorld({ seed: 7 });
    const refEnemy = setup(refWorld);
    collisionSystem(refWorld);
    knockbackSystem(refWorld);
    beamSystem(refWorld); // full-scan fallback

    // The knocked-back enemy took beam damage on the grid path...
    expect(gridWorld.stores.health.current[gridEnemy]).toBeLessThan(100);
    // ...identical to the full-scan reference.
    expect(gridWorld.stores.health.current[gridEnemy]).toBe(
      refWorld.stores.health.current[refEnemy],
    );
    expect(healthSnapshot(gridWorld)).toEqual(healthSnapshot(refWorld));
    expect(gridWorld.combatEvents).toEqual(refWorld.combatEvents);
    expect(rngCursor(gridWorld)).toBe(rngCursor(refWorld));
  });
});
