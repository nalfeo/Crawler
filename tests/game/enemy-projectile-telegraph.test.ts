/**
 * Enemy projectile telegraph — combat-contract tests.
 *
 * Covers the state machine in `enemyAISystem.ts`'s `tryFireEnemyProjectile()`
 * plus the shared resolver in `core/systems/enemyTelegraph.ts`:
 *  - 0ms (world default and per-mob) is byte-identical legacy behavior.
 *  - Nonzero delay locks the aim vector at telegraph start and holds it
 *    immutable through spawn, even if the player moves during the window.
 *  - Per-mob `telegraphMs` override beats the configured world/production
 *    default.
 *  - A telegraph is cancelled (never silently left dangling) when the enemy
 *    loses the player or falls out of attack range mid-telegraph.
 *  - Every subsequent shot (not just the first) telegraphs.
 */
import { query, removeEntity } from 'bitecs';
import { describe, expect, it, vi } from 'vitest';
import { EnemyProjectile, Position, Projectile } from '../../src/core/components.js';
import { spawnBehaviorEnemy, spawnPlayer } from '../../src/core/index.js';
import {
  TELEGRAPH_MS_UNSET,
  getEffectiveTelegraphMs,
  isEnemyProjectileTelegraphActive,
  startEnemyProjectileTelegraph,
} from '../../src/core/systems/enemyTelegraph.js';
import { AI_TYPE, enemyAISystem } from '../../src/game/index.js';
import { ENEMY_PROJECTILE } from '../../src/shared/constants.js';
import { DEFAULT_GENERATED_VISUAL_WIDTH_FT } from '../../src/shared/generated-assets.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('getEffectiveTelegraphMs resolver', () => {
  it('falls back to the ENEMY_PROJECTILE.TELEGRAPH_MS constant when nothing is configured', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = undefined;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150);
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(ENEMY_PROJECTILE.TELEGRAPH_MS);
  });

  it('uses the world-level override when set and no per-mob override exists', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 500;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150);
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(500);
  });

  it('per-mob override beats the configured world default', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 500;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: 75,
    });
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(75);
  });

  it('an explicit per-mob 0 overrides a nonzero world default (mob-level legacy parity)', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 500;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: 0,
    });
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(0);
  });

  it('spawnBehaviorEnemy re-asserts the unset sentinel on every spawn', () => {
    const world = createTestWorld();
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150);
    expect(world.stores.enemyBehavior.telegraphMs[enemy]).toBe(TELEGRAPH_MS_UNSET);
  });

  // Regression: copilot-pull-request-reviewer finding — a Float32-overflowing
  // world.enemyTelegraphMs (e.g. via a direct assignment, bypassing
  // headless-runner.ts's normalizeEnemyTelegraphMs config-time guard) used to
  // round to Infinity once stored in the Float32Array-backed
  // telegraphDelayMs, making isEnemyProjectileTelegraphReady's fire check
  // never trip. getEffectiveTelegraphMs is the single resolver both the
  // per-mob and world-level paths flow through, so it must clamp both.
  it('falls back to the default when the world-level override would overflow Float32', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 1e39;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150);
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(ENEMY_PROJECTILE.TELEGRAPH_MS);
  });

  it('falls through to the world-level default (not the hardcoded constant) when a per-mob override would overflow Float32', () => {
    // Regression: copilot-pull-request-reviewer finding — an invalid per-mob
    // override used to short-circuit straight to ENEMY_PROJECTILE.TELEGRAPH_MS,
    // skipping a validly-configured world.enemyTelegraphMs entirely and
    // silently breaking the documented `mob ?? world ?? constant` precedence.
    const world = createTestWorld();
    world.enemyTelegraphMs = 500;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: 1e39,
    });
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(500);
  });

  it('falls all the way back to the hardcoded constant when both a per-mob override overflows Float32 AND no world default is configured', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = undefined;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: 1e39,
    });
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(ENEMY_PROJECTILE.TELEGRAPH_MS);
  });

  it('falls back to the default for a non-finite world-level override (Infinity/NaN)', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = Number.POSITIVE_INFINITY;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150);
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(ENEMY_PROJECTILE.TELEGRAPH_MS);
  });

  // Regression: copilot-pull-request-reviewer finding — clampToFloat32SafeTelegraphMs
  // only rejected values that overflow Float32 on `Math.fround`, but a
  // negative finite value (e.g. `world.enemyTelegraphMs = -5`) survives
  // `Math.fround` unchanged and is NOT an overflow, so it used to pass
  // through untouched. isEnemyProjectileTelegraphReady's `elapsed >=
  // delayMs` check then trips immediately (elapsed starts at 0, and
  // `0 >= -5` is true), producing an effectively-instant fire with no
  // visible telegraph window — silently violating the "every hostile
  // projectile telegraphs" contract. A negative delay must fall back to
  // the default, same as a Float32-overflowing or non-finite one.
  it('falls back to the default for a negative world-level override', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = -5;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150);
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(ENEMY_PROJECTILE.TELEGRAPH_MS);
  });

  it('an explicit per-mob 0 still overrides a negative world default (0 stays legitimate legacy parity)', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = -5;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: 0,
    });
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(0);
  });

  it('a negative per-mob override (not the -1 unset sentinel) falls through to the world default, not the negative value', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 500;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: -7,
    });
    // isFloat32SafeNonNegativeTelegraphMs(-7) is false (negative), same
    // branch as the -1 unset sentinel, so this resolves the world-level
    // default rather than -7 or the constant.
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(500);
  });

  // Regression: copilot-pull-request-reviewer finding — a tiny nonzero delay
  // (e.g. `1e-50`) is finite and non-negative, so it used to survive the
  // overflow/negative guards unchanged, but `Math.fround(1e-50) === 0`: once
  // that value is written to the Float32Array-backed telegraphDelayMs store
  // it becomes byte-identical to an intentional, legitimate "legacy: no
  // telegraph" override. A world-level delay this small must fall back to
  // the default rather than silently degrading into immediate-fire.
  it('falls back to the default for a world-level override that would underflow to 0 in Float32', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 1e-50;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150);
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(ENEMY_PROJECTILE.TELEGRAPH_MS);
  });

  it('falls through to the world-level default (not 0) when a per-mob override would underflow to 0 in Float32', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 500;
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: 1e-50,
    });
    expect(getEffectiveTelegraphMs(world, enemy)).toBe(500);
  });

  it('spawnBehaviorEnemy stores the unset sentinel (not a rounded 0) for a per-mob override that would underflow Float32', () => {
    // Sanitizing must happen BEFORE the value ever reaches the
    // Float32Array-backed telegraphMs store — otherwise 1e-50 rounds to 0 on
    // assignment and becomes indistinguishable from an explicit, legitimate
    // `telegraphMs: 0` legacy override once stored.
    const world = createTestWorld();
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 1, 200, 150, {
      telegraphMs: 1e-50,
    });
    expect(world.stores.enemyBehavior.telegraphMs[enemy]).toBe(TELEGRAPH_MS_UNSET);
  });
});

describe('enemy projectile telegraph — 0ms legacy parity', () => {
  it('fires immediately with world.enemyTelegraphMs = 0, identical to pre-telegraph behavior', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 0;
    world.elapsedMs = 100;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    const projectiles = query(world.ecs, [EnemyProjectile, Projectile, Position]);
    expect(projectiles.length).toBe(1);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(false);
  });

  it('an explicit per-mob telegraphMs: 0 also fires immediately even with a nonzero world default', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150, { telegraphMs: 0 });

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile]).length).toBe(1);
  });

  it('consumes exactly the same single RNG draw as the legacy path (no extra draws for telegraph bookkeeping)', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 0;
    world.elapsedMs = 100;
    const nextSpy = vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    expect(nextSpy).toHaveBeenCalledTimes(1);
  });
});

describe('enemy projectile telegraph — nonzero delay lifecycle', () => {
  it('does not fire before the resolved delay elapses, and locks telegraphActive', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;

    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);
    expect(world.stores.enemyBehavior.telegraphDelayMs[enemy]).toBe(250);
    // Locked direction: enemy is due west of the player-relative aim (enemy at x=100, player at x=0 → aim points -x).
    expect(world.stores.enemyBehavior.telegraphDirX[enemy]).toBeLessThan(0);

    // Still within the window — one frame later, not yet ready.
    world.elapsedMs = 300;
    enemyAISystem(world);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);
  });

  it('freezes velocity on the SAME frame a telegraph starts, not one frame later (regression: copilot-pull-request-reviewer finding)', () => {
    // Before this fix, `isTelegraphing` was computed once at the top of the
    // per-enemy loop — before tryFireEnemyProjectile() could start a NEW
    // telegraph this frame — so the legacy-ranged tangent-strafe movement
    // branch still ran and set a nonzero velocity for this frame. The origin
    // is locked to the enemy's CURRENT position in that same call, so without
    // re-freezing, the enemy would take one more step after the locked origin
    // was captured: a visible one-frame drift off the "stop and aim" cue.
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;

    spawnPlayer(world, 0, 0);
    // Distance 100 sits strictly between the attack range's retreat band
    // (150 * 0.5 = 75) and the attack range (150), so applyLegacyRanged's
    // tangent-strafe branch — not the "hold still" retreat/approach branches —
    // is what would otherwise leave a nonzero velocity this frame.
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);
    expect(world.stores.velocity.x[enemy] ?? 0).toBe(0);
    expect(world.stores.velocity.y[enemy] ?? 0).toBe(0);
    expect(world.stores.enemyBehavior.stuckFrames[enemy] ?? 0).toBe(0);
  });

  it('fires once the resolved delay has elapsed, clearing telegraphActive', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world); // starts telegraph at t=100
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);

    world.elapsedMs = 351; // 251ms later, past the 250ms delay
    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile]).length).toBe(1);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(false);
  });

  it('fires using the LOCKED aim vector even if the player moves during the telegraph window', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    const player = spawnPlayer(world, 0, 0);
    // Enemy directly east of the player (aim should lock pointing -x, back toward the player).
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world); // locks aim at (-1, 0)
    const lockedDirX = world.stores.enemyBehavior.telegraphDirX[enemy]!;
    const lockedDirY = world.stores.enemyBehavior.telegraphDirY[enemy]!;

    // Player teleports to be due NORTH of the enemy instead (still within the
    // 150 attack range, so the outer fire-gate still calls into the
    // telegraph rather than cancelling it) — a live re-aim would now point
    // almost straight north, but the locked aim must not change.
    world.stores.position.x[player] = 100;
    world.stores.position.y[player] = -140;

    world.elapsedMs = 351;
    enemyAISystem(world);

    const projectiles = query(world.ecs, [EnemyProjectile, Projectile]);
    expect(projectiles.length).toBe(1);
    const proj = projectiles[0] as number;
    // Locked aim was due west (dirX < 0, dirY ~= 0). A live re-aim toward the
    // player's new northern position would fire predominantly in -y instead —
    // assert the fired projectile is still predominantly horizontal (west),
    // proving the ORIGINALLY locked direction was used, not a live re-aim.
    expect(lockedDirX).toBeLessThan(0);
    expect(Math.abs(lockedDirY)).toBeLessThan(0.01);
    const projVx = world.stores.velocity.x[proj] ?? 0;
    const projVy = world.stores.velocity.y[proj] ?? 0;
    expect(projVx).toBeLessThan(0);
    expect(Math.abs(projVy)).toBeLessThan(Math.abs(projVx) * 0.1);
  });

  it('cancels the telegraph (no fire) when the player leaves detection mid-telegraph', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;

    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);

    // Move the player far outside detection/aggro range.
    world.stores.position.x[player] = 100_000;
    world.stores.position.y[player] = 100_000;

    world.elapsedMs = 351;
    enemyAISystem(world);

    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(false);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);
  });

  it('cancels the telegraph (no fire) when the enemy falls out of attack range mid-telegraph', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;

    const player = spawnPlayer(world, 0, 0);
    // Attack range 150, aggro range large enough to still detect the player after it retreats.
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 5000, 150);

    enemyAISystem(world);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);

    // Player retreats beyond the 150 attack range but stays within aggro/detection range.
    world.stores.position.x[player] = 400;

    world.elapsedMs = 351;
    enemyAISystem(world);

    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(false);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);
  });

  it('cancels the telegraph (no fire) when the player entity disappears mid-telegraph (regression: gpt-5.3-codex finding)', () => {
    // Every other early-exit branch in enemyAISystem() cancels an in-progress
    // telegraph before returning. The `playerEid === undefined` branch was
    // the one exception until this fix — if the player entity ever vanishes
    // mid-telegraph (e.g. despawn, floor transition edge case), the telegraph
    // would otherwise survive with a stale locked origin/direction forever.
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;

    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);

    // The player entity itself disappears (not just moves out of range).
    removeEntity(world.ecs, player);

    world.elapsedMs = 351;
    enemyAISystem(world);

    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(false);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);
  });

  it('telegraphs every subsequent shot, not just the first', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    // First shot: telegraph then fire.
    enemyAISystem(world);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);
    world.elapsedMs = 351;
    enemyAISystem(world);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(1);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(false);

    // Advance past fire cooldown so a second shot can begin; it must ALSO telegraph.
    world.elapsedMs = 351 + ENEMY_PROJECTILE.FIRE_COOLDOWN_MS + 1;
    enemyAISystem(world);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(1); // still just the first — second is telegraphing
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);

    world.elapsedMs = 351 + ENEMY_PROJECTILE.FIRE_COOLDOWN_MS + 1 + 251;
    enemyAISystem(world);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(2);
  });

  it('gives every subsequent shot its OWN independently locked aim vector, not a stale copy of the previous shot', () => {
    const world = createTestWorld();
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 100;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    // First shot: telegraph locks aim pointing west (toward the player at the origin).
    enemyAISystem(world);
    const firstDirX = world.stores.enemyBehavior.telegraphDirX[enemy]!;
    const firstDirY = world.stores.enemyBehavior.telegraphDirY[enemy]!;
    expect(firstDirX).toBeLessThan(-0.9);
    expect(Math.abs(firstDirY)).toBeLessThan(0.01);

    world.elapsedMs = 351;
    enemyAISystem(world); // first shot fires using the west lock
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(1);

    // Move the player to a very different angle (due north of the enemy,
    // still within the 150 attack range) before the second telegraph begins.
    world.stores.position.x[player] = 100;
    world.stores.position.y[player] = -140;

    world.elapsedMs = 351 + ENEMY_PROJECTILE.FIRE_COOLDOWN_MS + 1;
    enemyAISystem(world); // second telegraph starts — must lock a FRESH aim
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);
    const secondDirX = world.stores.enemyBehavior.telegraphDirX[enemy]!;
    const secondDirY = world.stores.enemyBehavior.telegraphDirY[enemy]!;

    // The second lock points north (toward the player's new position),
    // proving it was independently recomputed at this shot's telegraph start
    // rather than carrying over the first shot's westward lock.
    expect(Math.abs(secondDirX)).toBeLessThan(0.01);
    expect(secondDirY).toBeLessThan(-0.9);

    world.elapsedMs = 351 + ENEMY_PROJECTILE.FIRE_COOLDOWN_MS + 1 + 251;
    enemyAISystem(world);
    const projectiles = query(world.ecs, [EnemyProjectile, Projectile]);
    expect(projectiles.length).toBe(2);
    const secondProj = projectiles[1] as number;
    const vx = world.stores.velocity.x[secondProj] ?? 0;
    const vy = world.stores.velocity.y[secondProj] ?? 0;
    // Fired using the second (northward) lock, not the first (westward) one.
    expect(Math.abs(vx)).toBeLessThan(Math.abs(vy) * 0.1);
    expect(vy).toBeLessThan(0);
  });
});

describe('telegraphWasActiveThisFrame sticky render-frame flag', () => {
  it('is set to 1 by startEnemyProjectileTelegraph() and remains set when telegraphActive is cleared', () => {
    // This is the key invariant that lets PhaserBridge.sync() render the
    // telegraph cue for one frame even when the shot fires entirely within a
    // multi-step catch-up batch (16× AI-runner lab playback).
    const world = createTestWorld();
    const enemy = spawnBehaviorEnemy(world, 0, 0, 10, AI_TYPE.RANGED, 0, 20, 20);

    expect(world.stores.enemyBehavior.telegraphWasActiveThisFrame[enemy]).toBe(0);

    startEnemyProjectileTelegraph(world, enemy, 1, 0);
    expect(world.stores.enemyBehavior.telegraphActive[enemy]).toBe(1);
    expect(world.stores.enemyBehavior.telegraphWasActiveThisFrame[enemy]).toBe(1);

    // Simulate the shot firing within the same batch: telegraphActive cleared.
    world.stores.enemyBehavior.telegraphActive[enemy] = 0;

    // Sticky flag must still be 1 — PhaserBridge.sync() hasn't run yet.
    expect(world.stores.enemyBehavior.telegraphWasActiveThisFrame[enemy]).toBe(1);
  });

  it('is 0 by default on a freshly spawned enemy (no residual from previous entities)', () => {
    const world = createTestWorld();
    const enemy = spawnBehaviorEnemy(world, 0, 0, 10, AI_TYPE.RANGED, 0, 20, 20);
    expect(world.stores.enemyBehavior.telegraphWasActiveThisFrame[enemy]).toBe(0);
  });
});

describe('weapon anchor — telegraph origin consumers', () => {
  // NormalizedWeaponAnchor relX/relY are dimensionless fractions multiplied by
  // DEFAULT_GENERATED_VISUAL_WIDTH_FT (3.2 ft for 64px @ 0.4 scale) in consumers.

  it('startEnemyProjectileTelegraph uses weapon anchor origin when anchor is present (facing right)', () => {
    const world = createTestWorld();
    const enemy = spawnBehaviorEnemy(world, 5, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
    // Velocity rightward so facing is right.
    world.stores.velocity.x[enemy] = 1;
    // Inject a normalized weapon anchor: relX=0.1, relY=-0.05, right-art.
    world.entityWeaponAnchors.set(enemy, { relX: 0.1, relY: -0.05, artFacing: 'right' });

    startEnemyProjectileTelegraph(world, enemy, 1, 0);

    // facing right, art=right → needsMirror=false → originX = 5 + 0.1 * 3.2 = 5.32
    // originY = 10 + (-0.05) * 3.2 = 9.84
    expect(world.stores.enemyBehavior.telegraphOriginX[enemy]).toBeCloseTo(
      5 + 0.1 * DEFAULT_GENERATED_VISUAL_WIDTH_FT,
    );
    expect(world.stores.enemyBehavior.telegraphOriginY[enemy]).toBeCloseTo(
      10 + -0.05 * DEFAULT_GENERATED_VISUAL_WIDTH_FT,
    );
  });

  it('startEnemyProjectileTelegraph mirrors X when right-art entity faces left', () => {
    const world = createTestWorld();
    const enemy = spawnBehaviorEnemy(world, 5, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
    // Velocity leftward so facing is left.
    world.stores.velocity.x[enemy] = -1;
    // Right-art anchor: relX=0.1 → mirrored to -0.1 → originX = 5 + (-0.1) * 3.2 = 4.68
    world.entityWeaponAnchors.set(enemy, { relX: 0.1, relY: -0.05, artFacing: 'right' });

    startEnemyProjectileTelegraph(world, enemy, 1, 0);

    expect(world.stores.enemyBehavior.telegraphOriginX[enemy]).toBeCloseTo(
      5 + -0.1 * DEFAULT_GENERATED_VISUAL_WIDTH_FT,
    );
    expect(world.stores.enemyBehavior.telegraphOriginY[enemy]).toBeCloseTo(
      10 + -0.05 * DEFAULT_GENERATED_VISUAL_WIDTH_FT,
    );
  });

  it('startEnemyProjectileTelegraph falls back to entity pivot when no weapon anchor present', () => {
    const world = createTestWorld();
    const enemy = spawnBehaviorEnemy(world, 5, 10, 10, AI_TYPE.RANGED, 0, 20, 20);
    world.stores.velocity.x[enemy] = 1;
    // No entry in entityWeaponAnchors and no generatedSpriteRegistry.

    startEnemyProjectileTelegraph(world, enemy, 1, 0);

    // Falls back to entity pivot.
    expect(world.stores.enemyBehavior.telegraphOriginX[enemy]).toBeCloseTo(5);
    expect(world.stores.enemyBehavior.telegraphOriginY[enemy]).toBeCloseTo(10);
  });
});
