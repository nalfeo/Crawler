import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Damage,
  DeathTimer,
  EffectiveStats,
  MeleeSwing,
  Position,
  Projectile,
  Velocity,
} from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { WEAPON } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('weaponSystem', () => {
  it('spawns a projectile when the cooldown has elapsed', () => {
    const world = createTestWorld();
    spawnPlayer(world, 12.5, 15);
    spawnEnemy(world, 25, 15, 10); // target enemy (no floorMap = always visible)
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile, Position, Velocity, Damage]));
    expect(projectiles).toHaveLength(1);

    const projectile = projectiles[0];
    expect(projectile).toBeDefined();
    expect(world.stores.position.x[projectile!]).toBe(12.5);
    expect(world.stores.position.y[projectile!]).toBe(15);
    expect(world.stores.damage.amount[projectile!]).toBe(WEAPON.BASE_DAMAGE);
  });

  it('does not fire when there are no enemies', () => {
    const world = createTestWorld();
    spawnPlayer(world, 12.5, 15);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('aims projectiles at the nearest enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 3.75, 0, 20);
    spawnEnemy(world, 0, 5, 20);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();

    const velocityX = world.stores.velocity.x[projectile!];
    const velocityY = world.stores.velocity.y[projectile!];

    expect(velocityX).toBeCloseTo(WEAPON.PROJECTILE_SPEED, 5);
    expect(velocityY).toBeCloseTo(0, 5);
  });

  it('does not spawn a projectile while the weapon is on cooldown', () => {
    const world = createTestWorld();
    spawnPlayer(world, 8, 8);
    spawnEnemy(world, 25, 8, 10); // target enemy
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);
    world.elapsedMs += pistol.cooldownMs / 2;
    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });

  it('applies cooldown reduction to weapon fire cadence', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 8, 8);
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.cooldownReduction[player] = 0.5;
    spawnEnemy(world, 25, 8, 10);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);
    world.elapsedMs += pistol.cooldownMs * 0.6; // > reduced cooldown, < base cooldown
    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(2);
  });

  it('skips corpses when picking a target — a dead enemy must not be shot at', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Nearer "corpse": Enemy + Position but 0 HP and a DeathTimer (still in the
    // death-linger window). The player must shoot the live enemy instead.
    const corpse = spawnEnemy(world, 3.75, 0, 10);
    world.stores.health.current[corpse] = 0;
    addComponent(world.ecs, corpse, set(DeathTimer, { remainingMs: 500 }));
    // Live enemy off the corpse's axis: a correct (corpse-skipping) shot fires
    // +Y at it, while wrongly targeting the nearer corpse would fire +X. This
    // makes the assertions fail if the corpse skip is reverted.
    spawnEnemy(world, 0, 10, 10);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    expect(world.stores.velocity.y[projectile!]).toBeCloseTo(WEAPON.PROJECTILE_SPEED, 5);
    expect(world.stores.velocity.x[projectile!]).toBeCloseTo(0, 5);
  });

  it('skips corpses for melee target acquisition', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const corpse = spawnEnemy(world, 1.25, 0, 10);
    world.stores.health.current[corpse] = 0;
    addComponent(world.ecs, corpse, set(DeathTimer, { remainingMs: 500 }));
    // No live enemy: with only a corpse in range, melee auto-fire must NOT
    // spawn a swing. Before the fix, the corpse was treated as a target.
    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [MeleeSwing]).length).toBe(0);
  });

  it('skips a 0-HP enemy that has no DeathTimer yet (Health-only corpse guard)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Nearer "corpse": 0 HP but NOT yet flagged with a DeathTimer. This exercises
    // the Health-only skip in getNearestEnemyTarget independently of the
    // DeathTimer guard (which would otherwise short-circuit first).
    const corpse = spawnEnemy(world, 2.5, 0, 10);
    world.stores.health.current[corpse] = 0;
    // Live enemy off to the side: a correct (corpse-skipping) shot fires +Y,
    // while wrongly targeting the nearer dead enemy would fire +X.
    spawnEnemy(world, 0, 6.25, 10);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    expect(world.stores.velocity.y[projectile!]).toBeCloseTo(WEAPON.PROJECTILE_SPEED, 5);
    expect(world.stores.velocity.x[projectile!]).toBeCloseTo(0, 5);
  });

  it('skips a permanently-aggroed boss corpse with a DeathTimer, firing at the live enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Live regular enemy to the right — the legitimate fallback target.
    spawnEnemy(world, 3.75, 0, 10);
    // Boss/elite below the player, flagged for boss-priority aim, but in its
    // death-linger window: still has positive HP yet carries a DeathTimer, so
    // only the DeathTimer guard in findBossTargetInRange protects it.
    const boss = spawnEnemy(world, 0, 5, 10);
    world.stores.enemyBehavior.aggroedPermanently[boss] = 1;
    addComponent(world.ecs, boss, set(DeathTimer, { remainingMs: 500 }));
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    // Boss corpse skipped → fall back to the live enemy → fire +X, not +Y.
    expect(world.stores.velocity.x[projectile!]).toBeCloseTo(WEAPON.PROJECTILE_SPEED, 5);
    expect(world.stores.velocity.y[projectile!]).toBeCloseTo(0, 5);
  });

  it('skips a permanently-aggroed boss corpse with 0 HP and no DeathTimer, firing at the live enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 3.75, 0, 10);
    // Dead boss with no DeathTimer yet, so only the Health guard in
    // findBossTargetInRange keeps boss-priority aim off the corpse.
    const boss = spawnEnemy(world, 0, 5, 10);
    world.stores.enemyBehavior.aggroedPermanently[boss] = 1;
    world.stores.health.current[boss] = 0;
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    expect(world.stores.velocity.x[projectile!]).toBeCloseTo(WEAPON.PROJECTILE_SPEED, 5);
    expect(world.stores.velocity.y[projectile!]).toBeCloseTo(0, 5);
  });
});
