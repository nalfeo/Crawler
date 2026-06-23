import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AreaDamage,
  LineDamage,
  MeleeSwing,
  Owner,
  Projectile,
  Team,
  Trap,
  Weapon,
} from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer, spawnWeapon } from '../../src/core/helpers.js';
import {
  clearActiveWeapon,
  computeEffectiveAccuracy,
  getActiveWeapon,
  setActiveWeapon,
  weaponEntitySystem,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
import { WEAPON, WeaponType, TeamId, type WeaponTypeValue } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('weaponSystem coverage paths', () => {
  it('keeps cooldown when updating active weapon; clearing weapon silences auto-fire', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);

    const fireball = getWeaponDef('fireball')!;
    setActiveWeapon(world, fireball);
    world.elapsedMs = fireball.cooldownMs;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    // Same id should update the active def but not reset cooldown.
    setActiveWeapon(world, { ...fireball, baseDamage: fireball.baseDamage + 7 });
    world.elapsedMs += 1;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    // Clearing the weapon means no weapon fires, even after cooldown elapses.
    clearActiveWeapon(world);
    expect(getActiveWeapon(world)).toBeUndefined();
    world.elapsedMs += WEAPON.FIRE_RATE_MS;
    weaponSystem(world);
    // No new projectile spawned after clearing.
    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });

  it('returns early when no player exists', () => {
    const world = createTestWorld();
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('does not fire when no enemy is visible', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Give the player velocity (old behavior: fire in movement direction).
    // New behavior: weapon is silent when no visible enemy exists.
    world.stores.velocity.x[player] = 0;
    world.stores.velocity.y[player] = 4;
    const fireball = getWeaponDef('fireball')!;
    setActiveWeapon(world, fireball);
    world.elapsedMs = fireball.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('handles unknown active weapon types without spawning an attack', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const def = { ...getWeaponDef('fireball')!, weaponType: 255 as unknown as WeaponTypeValue };
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });
});

describe('weaponEntitySystem coverage paths', () => {
  it('skips firing when owner has no position', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 12, 100, 0, 300, TeamId.PLAYER);
    world.elapsedMs = 100;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(-100);
  });

  it('fires ranged weapon entities and respects cooldown gating', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 10, 20);
    spawnEnemy(world, 100, 20, 50);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 20, 50, 0, 200, TeamId.PLAYER);

    world.elapsedMs = 50;
    weaponEntitySystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(50);

    world.elapsedMs = 75;
    weaponEntitySystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(50);
  });

  it('uses owner team for melee attacks and falls back to player team', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    // Enemy at 50px is still reachable once melee gate includes enemy collision radius.
    spawnEnemy(world, 50, 0, 50);
    addComponent(world.ecs, owner, set(Team, { id: TeamId.ENEMY }));
    spawnWeapon(world, owner, WeaponType.MELEE, 15, 10, 33, 0, TeamId.PLAYER);
    world.elapsedMs = 10;

    weaponEntitySystem(world);

    const firstArea = query(world.ecs, [AreaDamage, Team])[0];
    expect(firstArea).toBeDefined();
    expect(world.stores.team.id[firstArea!]).toBe(TeamId.ENEMY);
    expect(world.stores.areaDamage.radius[firstArea!]).toBe(33);

    const owner2 = spawnPlayer(world, 5, 5);
    spawnEnemy(world, 25, 5, 50);
    spawnWeapon(world, owner2, WeaponType.MELEE, 10, 10, 20, 0, TeamId.PLAYER);
    world.elapsedMs = 20;
    weaponEntitySystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Owner, Team]));
    const owner2Area = areas.find((eid) => (world.stores.owner.eid[eid] ?? -1) === owner2);
    expect(owner2Area).toBeDefined();
    expect(world.stores.team.id[owner2Area!]).toBe(TeamId.PLAYER);
  });

  it('falls back to projectile spawn for unknown weapon type', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const weapon = createEntity(world);
    addComponent(
      world.ecs,
      weapon,
      set(Weapon, {
        weaponType: 255,
        baseDamage: 9,
        cooldownMs: 10,
        lastFireMs: 0,
        range: 0,
        projectileSpeed: 120,
      }),
    );
    addComponent(world.ecs, weapon, set(Owner, { eid: owner }));
    world.elapsedMs = 10;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(10);
  });

  it('skips firing when the owner has a position but no enemy is present', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 12, 50, 100, 300, TeamId.PLAYER);
    world.elapsedMs = 50;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(-50);
  });

  it('skips firing when the nearest enemy is beyond the weapon gate range', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    // Enemy is found (no FOV map) but sits far beyond the 10px gate range.
    spawnEnemy(world, 5000, 0, 50);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 12, 50, 10, 300, TeamId.PLAYER);
    world.elapsedMs = 50;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(-50);
  });
});

describe('weaponSystem range-gating paths', () => {
  it('does not fire when no weapon is equipped (weapon cleared)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Enemy is nearby and in combat radius, but no active weapon is set.
    spawnEnemy(world, 100, 0, 50);
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('does not swing a melee weapon when the only in-combat enemy overlaps the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Enemy at the player's exact position: inside the combat radius (so the
    // player counts as in-combat) but skipped by nearest-target selection
    // because distanceSq is ~0, leaving no target to swing at.
    spawnEnemy(world, 0, 0, 50);
    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [MeleeSwing]).length).toBe(0);
  });

  it('does not fire a ranged weapon when the only enemy is beyond the gate range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Enemy far beyond any ranged gate range.
    spawnEnemy(world, 10000, 0, 50);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('does not fire a melee weapon when not in combat', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Enemy far outside combat radius (COMBAT_RADIUS_PX = 1200).
    spawnEnemy(world, 5000, 0, 50);
    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [MeleeSwing]).length).toBe(0);
  });
});

describe('weaponSystem miss events', () => {
  it('emits a miss CombatEvent when the accuracy roll fails', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    // Force a miss: baseAccuracy = 0 so effectiveAccuracy = 0; rng.next() > 0 always misses.
    const pistol = { ...getWeaponDef('pistol')!, baseAccuracy: 0 };
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;
    // Override RNG to always return 0.5 (> 0 = miss)
    world.rng.next = () => 0.5;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
    const missEvent = world.combatEvents.find((e) => e.type === 'miss');
    expect(missEvent).toBeDefined();
    expect(missEvent?.amount).toBe(0);
    expect(missEvent?.targetType).toBe('enemy');
  });

  it('does not emit a miss event when the accuracy roll succeeds', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const pistol = { ...getWeaponDef('pistol')!, baseAccuracy: 1 };
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;
    // Override RNG to always return 0 (≤ 1.0 = hit, no miss)
    world.rng.next = () => 0;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
    expect(world.combatEvents.find((e) => e.type === 'miss')).toBeUndefined();
  });
});

describe('weaponSystem weapon type paths', () => {
  it('fires a beam weapon (laser) and creates a LineDamage entity', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const laser = getWeaponDef('laser')!;
    setActiveWeapon(world, laser);
    world.elapsedMs = laser.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    expect(query(world.ecs, [LineDamage]).length).toBeGreaterThan(0);
  });

  it('fires a trap weapon (landmine) and creates a Trap entity without needing an enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const landmine = getWeaponDef('landmine')!;
    setActiveWeapon(world, landmine);
    world.elapsedMs = landmine.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Trap]).length).toBeGreaterThan(0);
  });

  it('does not re-fire a trap weapon before cooldown elapses', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const landmine = getWeaponDef('landmine')!;
    setActiveWeapon(world, landmine);
    world.elapsedMs = landmine.cooldownMs;
    weaponSystem(world);
    expect(query(world.ecs, [Trap]).length).toBe(1);

    // Advance only half the cooldown — should not fire again.
    world.elapsedMs += landmine.cooldownMs / 2;
    weaponSystem(world);
    expect(query(world.ecs, [Trap]).length).toBe(1);
  });

  it('fires a THROWN returning projectile (boomerang) and creates a Projectile entity', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const boomerang = getWeaponDef('boomerang')!;
    setActiveWeapon(world, boomerang);
    world.elapsedMs = boomerang.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });

  it('fires a THROWN bouncing projectile (throwing-knife) and creates a Projectile entity', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const throwingKnife = getWeaponDef('throwing-knife')!;
    setActiveWeapon(world, throwingKnife);
    world.elapsedMs = throwingKnife.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });

  it('fires a THROWN plain projectile (custom def) and creates a Projectile entity', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    // A thrown weapon with neither return nor bounce → plain spawnProjectile path
    const plain = {
      ...getWeaponDef('boomerang')!,
      id: 'plain-thrown-test',
      returnSpeed: 0,
      maxRange: 0,
      bounceCount: 0,
    };
    setActiveWeapon(world, plain);
    world.elapsedMs = plain.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });
});

describe('computeEffectiveAccuracy', () => {
  it('returns 1.0 for TRAP weapons regardless of base accuracy', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const landmine = getWeaponDef('landmine')!;

    expect(computeEffectiveAccuracy(world, player, landmine)).toBe(1.0);
  });

  it('uses 0 accuracy bonus when player has no Stats component', () => {
    const world = createTestWorld();
    const player = createEntity(world);
    // Player entity without Stats component — bonus should be 0.
    const pistol = getWeaponDef('pistol')!;

    const result = computeEffectiveAccuracy(world, player, pistol);

    expect(result).toBe(Math.min(1.0, Math.max(0, pistol.baseAccuracy)));
  });
});

describe('weaponSystem boss priority targeting', () => {
  it('targets a boss over the nearest non-boss enemy for melee', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Regular enemy closer to player
    spawnEnemy(world, 30, 0, 50);
    // Boss enemy slightly farther but still in range
    const boss = spawnEnemy(world, 60, 0, 50);
    world.stores.enemyBehavior.aggroedPermanently[boss] = 1;

    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    // A melee swing should have been spawned (boss is within gate range).
    expect(query(world.ecs, [MeleeSwing]).length).toBe(1);
  });

  it('falls back to nearest enemy when boss is beyond gate range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Regular enemy in reach
    spawnEnemy(world, 30, 0, 50);
    // Boss far out of range
    const boss = spawnEnemy(world, 9000, 0, 50);
    world.stores.enemyBehavior.aggroedPermanently[boss] = 1;

    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    // Swing should still fire, targeting the close enemy.
    expect(query(world.ecs, [MeleeSwing]).length).toBe(1);
  });
});
