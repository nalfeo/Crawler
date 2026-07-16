import { addComponent, hasComponent, query, removeComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  EffectiveStats,
  Enemy,
  Health,
  Knockback,
  MeleeSwing,
  Position,
  Sprite,
} from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { spawnMeleeSwing } from '../../src/core/spawners/melee.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { clearMeleeSwingHits, meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { tagDamageMeta } from '../../src/core/damage-meta.js';
import { MeleeStyle } from '../../src/shared/constants.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Melee broad-phase determinism regression suite.
 *
 * `meleeSwingSystem` was converted from a full `[Health, Position]` scan to a
 * spatial-hash `queryRadius` broad-phase. Because `applyDamage` draws `world.rng`
 * once per qualifying hit (crit for enemy targets, dodge for player targets), the
 * ORDER in which targets are processed is determinism-observable — reordering hits
 * would change the RNG draw sequence and silently break the 90% Floor-1 seed
 * win-rate gate.
 *
 * The optimization is identical-by-construction: a superset query + the unchanged
 * narrow-phase + legacy iteration order preserved via a canonical rank map. This
 * PERMANENT suite is the deterministic gate that proves it (project rule #10):
 * the same production function is driven both ways — WITH a grid (broad-phase) and
 * WITHOUT one (the executable full-scan fallback, i.e. the legacy reference) — and
 * their outcomes must be byte-identical, including the exact RNG cursor.
 */

/**
 * Read the SeededRandom's internal xorshift cursor. `state` is `private` in
 * TypeScript but a real runtime field (TS `private` is not name-mangled), so a
 * test-only cast lets us assert the EXACT RNG position — not just the draw count —
 * matches between the two drivers each frame. If the field is ever renamed this
 * test fails loudly, which is the correct signal for a determinism-internals change.
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

const CENTER_X = 40;
const CENTER_Y = 40;

/**
 * Enemy offsets deliberately scrambled: consecutive spawn order (⇒ ascending eid,
 * the legacy iteration order) does NOT match spatial/grid-cell order. The 8ft grid
 * cells will return candidates in cell order, so if the rank-map sort were wrong
 * the crit draws would land on different enemies and this suite would diverge.
 */
const SCRAMBLED_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [5, -3],
  [-4, 6],
  [7, 2],
  [-6, -5],
  [2, 7],
  [-3, -7],
  [6, -6],
  [-7, 3],
  [3, 3],
  [-2, -2],
  [4, -7],
  [-5, 5],
];

interface CombatScene {
  world: GameWorld;
  playerSwing: number;
  enemySwing: number;
}

/**
 * Dense combat scene: a player with crit/dodge rolls, a cluster of enemies spread
 * across multiple grid cells within a wide swing, one persistent player swing
 * (hits enemies ⇒ crit draws) and one persistent enemy swing aimed back at the
 * player (⇒ dodge draws). Both swings use a full 360° arc and a large head radius
 * so every enemy sits inside the hit region each frame once the hit-set is cleared.
 */
function buildCombatScene(seed: number): CombatScene {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, CENTER_X, CENTER_Y);
  grantCombatRolls(world, player);

  const enemies: number[] = [];
  for (const [dx, dy] of SCRAMBLED_OFFSETS) {
    enemies.push(spawnEnemy(world, CENTER_X + dx, CENTER_Y + dy, 200));
  }

  const playerSwing = spawnMeleeSwing(
    world,
    CENTER_X,
    CENTER_Y,
    player,
    6, // damage
    2, // bladeLength
    1000, // durationMs
    1, // dirX
    0, // dirY
    360, // arcDeg
    0, // teamId (player)
    MeleeStyle.SLASH,
    10, // headRadius — covers the whole cluster
    1, // shaftDamageMult
    0, // knockback
  );
  // Player-sourced swings must be explicitly tagged for the generic
  // offense/crit branch to trigger — `spawnMeleeSwing` is a dumb ECS
  // constructor (the real game tags via weaponSystem.dispatchAttackInner's
  // single choke point after firing). Tag it here so this determinism suite
  // observes the SAME crit-eligible RNG draw sequence a real player weapon
  // swing would.
  tagDamageMeta(world, playerSwing, {
    origin: 'player',
    affinity: 'physical',
    scaleWithPrimary: true,
    canCrit: true,
  });

  const enemySwing = spawnMeleeSwing(
    world,
    CENTER_X,
    CENTER_Y,
    enemies[0]!,
    4, // damage
    2,
    1000,
    1,
    0,
    360,
    1, // teamId (enemy)
    MeleeStyle.SLASH,
    10,
    1,
    0,
  );

  return { world, playerSwing, enemySwing };
}

describe('meleeSwingSystem broad-phase determinism', () => {
  it('grid broad-phase is byte-identical to the full-scan reference across many seeds', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i * 1013 + 7);
    let sawCrit = false;
    let sawDodge = false;
    let sawHit = false;

    for (const seed of seeds) {
      const gridScene = buildCombatScene(seed);
      const refScene = buildCombatScene(seed);

      // Sanity: identical construction ⇒ identical starting RNG cursor.
      expect(rngCursor(gridScene.world)).toBe(rngCursor(refScene.world));

      for (let frame = 0; frame < 12; frame += 1) {
        // Clear per-swing hit tracking so both persistent swings re-hit every
        // frame, generating a fresh multi-target RNG draw sequence each frame.
        clearMeleeSwingHits(gridScene.world, gridScene.playerSwing);
        clearMeleeSwingHits(gridScene.world, gridScene.enemySwing);
        clearMeleeSwingHits(refScene.world, refScene.playerSwing);
        clearMeleeSwingHits(refScene.world, refScene.enemySwing);

        gridScene.world.elapsedMs += 16;
        refScene.world.elapsedMs += 16;

        // Broad-phase invariant guards (rule the once-per-frame rank map depends
        // on): every [Health, Position] combat target is also in the grid
        // ([Position, Sprite]) ⇒ the grid path is actually exercised (not silently
        // falling back), and the set is STABLE across the melee invocation
        // (apply-damage never adds/removes Health), so a future on-hit component
        // mutation that would break rank-map stability trips here.
        const targetsBefore = Array.from(query(gridScene.world.ecs, [Health, Position]));
        for (const target of targetsBefore) {
          expect(hasComponent(gridScene.world.ecs, target, Sprite)).toBe(true);
        }

        // Grid driver: broad-phase (grid threaded in, same as areaDamageSystem).
        const collision = collisionSystem(gridScene.world);
        meleeSwingSystem(gridScene.world, collision);

        // Reference driver: no grid ⇒ the executable full-scan fallback = legacy.
        meleeSwingSystem(refScene.world);

        expect(query(gridScene.world.ecs, [Health, Position]).length).toBe(targetsBefore.length);
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

interface KnockbackScene {
  world: GameWorld;
  swings: readonly [number, number];
}

/**
 * Combat scene that exercises the one place `meleeSwingSystem` mutates the ECS
 * component set mid-invocation: the hit branch runs
 * `addComponent(target, set(Knockback, …))` for a knockback weapon. TWO player
 * swings both cover the shared enemy cluster; the lower-eid swing runs first in the
 * `[MeleeSwing, Position]` query and adds `Knockback` to every enemy BEFORE the
 * second swing re-evaluates its candidates.
 *
 * This is the exact stress on the once-per-frame rank-map invariant: the grid path
 * ranks candidates by the frame-start `[Health, Position]` order, while the legacy
 * fallback re-queries `[Health, Position]` per swing. If adding an unrelated
 * component reordered that query, the second swing's crit draws would land on
 * different enemies and this suite would diverge. Real weapons (mace/hammer) carry
 * knockback, so this path runs in normal play — the base differential suite only
 * spawns `knockback: 0` swings, leaving it uncovered until now.
 */
function buildKnockbackCombatScene(seed: number): KnockbackScene {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, CENTER_X, CENTER_Y);
  grantCombatRolls(world, player);

  for (const [dx, dy] of SCRAMBLED_OFFSETS) {
    spawnEnemy(world, CENTER_X + dx, CENTER_Y + dy, 200);
  }

  const mkSwing = (damage: number): number => {
    const swingEid = spawnMeleeSwing(
      world,
      CENTER_X,
      CENTER_Y,
      player,
      damage,
      2, // bladeLength
      1000, // durationMs
      1, // dirX
      0, // dirY
      360, // arcDeg — full circle covers the whole cluster
      0, // teamId (player)
      MeleeStyle.SLASH,
      10, // headRadius — covers the whole cluster
      1, // shaftDamageMult
      6, // knockback > 0 ⇒ addComponent(Knockback) in the hit branch
    );
    // Player-sourced swings must be explicitly tagged for the generic
    // offense/crit branch to trigger — see the matching comment in
    // buildCombatScene above.
    tagDamageMeta(world, swingEid, {
      origin: 'player',
      affinity: 'physical',
      scaleWithPrimary: true,
      canCrit: true,
    });
    return swingEid;
  };

  // Two simultaneous player swings sharing targets; the lower-eid swing runs first
  // and seeds Knockback on every enemy before the second swing re-scans.
  return { world, swings: [mkSwing(6), mkSwing(5)] };
}

describe('meleeSwingSystem broad-phase determinism — mid-frame Knockback component add', () => {
  it('stays byte-identical when an early swing adds Knockback before a later swing re-scans', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i * 1013 + 7);
    let sawHit = false;
    let sawCrit = false;
    let sawKnockbackAdded = false;

    for (const seed of seeds) {
      const gridScene = buildKnockbackCombatScene(seed);
      const refScene = buildKnockbackCombatScene(seed);

      expect(rngCursor(gridScene.world)).toBe(rngCursor(refScene.world));
      expect(query(gridScene.world.ecs, [MeleeSwing, Position]).length).toBeGreaterThanOrEqual(2);

      for (let frame = 0; frame < 12; frame += 1) {
        // Re-arm the addComponent path every frame: strip Knockback from all enemies
        // in BOTH worlds identically (a symmetric mutation before the grid/rank-map
        // is built, so it cannot itself cause divergence), so the earlier swing
        // re-adds it via the component-set-mutating `addComponent` branch before the
        // later swing re-queries — exercising the ordering risk on every frame.
        for (const scene of [gridScene, refScene]) {
          for (const enemyEid of query(scene.world.ecs, [Enemy])) {
            if (hasComponent(scene.world.ecs, enemyEid, Knockback)) {
              removeComponent(scene.world.ecs, enemyEid, Knockback);
            }
          }
          for (const swingEid of scene.swings) clearMeleeSwingHits(scene.world, swingEid);
        }

        gridScene.world.elapsedMs += 16;
        refScene.world.elapsedMs += 16;

        const targetsBefore = Array.from(query(gridScene.world.ecs, [Health, Position]));
        for (const target of targetsBefore) {
          expect(hasComponent(gridScene.world.ecs, target, Sprite)).toBe(true);
        }
        // Precondition each frame: the addComponent (not setComponent) branch fires,
        // i.e. no enemy carries Knockback before the swings run.
        for (const enemyEid of query(gridScene.world.ecs, [Enemy])) {
          expect(hasComponent(gridScene.world.ecs, enemyEid, Knockback)).toBe(false);
        }

        // Grid driver: broad-phase (grid threaded in, same as areaDamageSystem).
        const collision = collisionSystem(gridScene.world);
        meleeSwingSystem(gridScene.world, collision);

        // Reference driver: no grid ⇒ the executable full-scan fallback = legacy,
        // which re-queries [Health, Position] per swing (after the mid-frame add).
        meleeSwingSystem(refScene.world);

        // Confirm the mutation path actually fired: at least one enemy now carries
        // Knockback that an earlier swing added this frame.
        for (const enemyEid of query(gridScene.world.ecs, [Enemy])) {
          if (hasComponent(gridScene.world.ecs, enemyEid, Knockback)) sawKnockbackAdded = true;
        }

        // Adding Knockback must not change the [Health, Position] membership (the
        // rank map's domain) — only the component set of already-tracked targets.
        expect(query(gridScene.world.ecs, [Health, Position]).length).toBe(targetsBefore.length);
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
        }
      }
    }

    // The scene must genuinely exercise the order-sensitive crit path and the
    // mid-frame Knockback add, or the differential would be vacuously green.
    expect(sawHit).toBe(true);
    expect(sawCrit).toBe(true);
    expect(sawKnockbackAdded).toBe(true);
  });
});

/**
 * Run one melee frame over a scene, either through the grid broad-phase or the
 * full-scan fallback, and return the world for inspection.
 */
function runMeleeFrame(setup: (world: GameWorld) => void, useGrid: boolean): GameWorld {
  const world = createTestWorld({ seed: 7 });
  setup(world);
  if (useGrid) {
    const collision = collisionSystem(world);
    meleeSwingSystem(world, collision);
  } else {
    meleeSwingSystem(world);
  }
  return world;
}

/** Assert the grid path and the full-scan fallback produce identical results for a scene. */
function assertParity(setup: (world: GameWorld) => void): GameWorld {
  const grid = runMeleeFrame(setup, true);
  const ref = runMeleeFrame(setup, false);
  expect(healthSnapshot(grid)).toEqual(healthSnapshot(ref));
  expect(positionSnapshot(grid)).toEqual(positionSnapshot(ref));
  expect(grid.combatEvents).toEqual(ref.combatEvents);
  expect(grid.skillUsageEvents).toEqual(ref.skillUsageEvents);
  expect(rngCursor(grid)).toBe(rngCursor(ref));
  return grid;
}

/** Spawn a fixed STAB swing pointing +x and advance to mid-swing (max reach). */
function spawnStabAtMaxReach(
  world: GameWorld,
  player: number,
  bladeLength: number,
  headRadius: number,
): void {
  spawnMeleeSwing(
    world,
    CENTER_X,
    CENTER_Y,
    player,
    6, // damage
    bladeLength,
    1000, // durationMs
    1, // dirX
    0, // dirY
    30, // arcDeg
    0, // teamId
    MeleeStyle.STAB,
    headRadius,
    1,
    0,
  );
  // progress 0.5 ⇒ STAB reach == bladeLength ⇒ tip at (CENTER_X + bladeLength, CENTER_Y).
  world.elapsedMs += 500;
}

describe('meleeSwingSystem broad-phase boundary + fallback', () => {
  it('matches the reference and hits nothing when there are no targets', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, CENTER_X, CENTER_Y);
      grantCombatRolls(world, player);
      spawnStabAtMaxReach(world, player, 4, 3);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('hits a target inside the head radius (identical to the reference)', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, CENTER_X, CENTER_Y);
      grantCombatRolls(world, player);
      spawnStabAtMaxReach(world, player, 4, 3);
      // Tip at (44,40); enemy at (46.9,40) is 2.9ft away < headRadius 3 ⇒ hit.
      spawnEnemy(world, CENTER_X + 6.9, CENTER_Y, 100);
    });
    expect(grid.combatEvents.some((event) => event.type === 'hit')).toBe(true);
  });

  it('rejects a target inside the broad-phase radius but outside the hit region (superset correctness)', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, CENTER_X, CENTER_Y);
      grantCombatRolls(world, player);
      spawnStabAtMaxReach(world, player, 4, 3);
      // Perpendicular at (40,44): 4ft from the attacker (< broad-phase radius
      // 4 + 3 + eps) so it IS queried, but 4ft from the blade segment (> 1.5) and
      // 5.66ft from the tip (> headRadius 3) ⇒ narrow-phase correctly rejects it.
      spawnEnemy(world, CENTER_X, CENTER_Y + 4, 100);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('does not hit a target far outside the broad-phase radius', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, CENTER_X, CENTER_Y);
      grantCombatRolls(world, player);
      spawnStabAtMaxReach(world, player, 4, 3);
      spawnEnemy(world, CENTER_X + 50, CENTER_Y, 100);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('hits nothing for a zero-reach swing', () => {
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, CENTER_X, CENTER_Y);
      grantCombatRolls(world, player);
      spawnStabAtMaxReach(world, player, 0, 0);
      spawnEnemy(world, CENTER_X + 3, CENTER_Y, 100);
    });
    expect(grid.combatEvents).toHaveLength(0);
  });

  it('falls back to the full scan and still hits a spriteless Health target', () => {
    // A [Health, Position] target WITHOUT Sprite is invisible to the spatial grid,
    // so buildMeleeRankMap reports the broad-phase unsafe and the system must fall
    // back to the full scan. Proves the fallback is executable, not just a comment.
    const grid = assertParity((world) => {
      const player = spawnPlayer(world, CENTER_X, CENTER_Y);
      grantCombatRolls(world, player);
      spawnMeleeSwing(
        world,
        CENTER_X,
        CENTER_Y,
        player,
        6,
        2,
        1000,
        1,
        0,
        360,
        0,
        MeleeStyle.SLASH,
        10,
        1,
        0,
      );
      world.elapsedMs += 500;
      const enemy = spawnEnemy(world, CENTER_X + 2, CENTER_Y, 100);
      removeComponent(world.ecs, enemy, Sprite);
    });
    expect(grid.combatEvents.some((event) => event.type === 'hit')).toBe(true);
  });

  it('ignores non-combat grid entities that lack Health', () => {
    // A bare [Position, Sprite] prop sits in the grid but has no Health, so the
    // rank map ranks it -1 and gatherMeleeCandidates drops it — exactly the
    // entities the legacy [Health, Position] query never saw.
    assertParity((world) => {
      const player = spawnPlayer(world, CENTER_X, CENTER_Y);
      grantCombatRolls(world, player);
      spawnMeleeSwing(
        world,
        CENTER_X,
        CENTER_Y,
        player,
        6,
        2,
        1000,
        1,
        0,
        360,
        0,
        MeleeStyle.SLASH,
        10,
        1,
        0,
      );
      world.elapsedMs += 500;
      spawnEnemy(world, CENTER_X + 2, CENTER_Y, 100);
      // A prop: Position + Sprite only (no Health) sitting right on the cluster.
      const prop = spawnEnemy(world, CENTER_X + 1, CENTER_Y + 1, 100);
      removeComponent(world.ecs, prop, Health);
      removeComponent(world.ecs, prop, Enemy);
    });
  });
});
