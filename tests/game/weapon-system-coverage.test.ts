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
import { readDamageMeta } from '../../src/core/damage-meta.js';
import { createEntity, spawnEnemy, spawnPlayer, spawnWeapon } from '../../src/core/helpers.js';
import {
  clearActiveWeapon,
  computeEffectiveAccuracy,
  getActiveWeapon,
  getActiveWeaponReadiness,
  setActiveWeapon,
  setPreferredWeaponTarget,
  weaponEntitySystem,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
import { WEAPON, WeaponType, TeamId, type WeaponTypeValue } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeMapWithSafeRoom, makeOpenFloorMap } from '../helpers/map-fixtures.js';

describe('weaponSystem coverage paths', () => {
  it('keeps cooldown when updating active weapon; clearing weapon silences auto-fire', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 50);

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
    spawnEnemy(world, 12.5, 0, 50);
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
    const owner = spawnPlayer(world, 1.25, 2.5);
    spawnEnemy(world, 12.5, 2.5, 50);
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
    spawnEnemy(world, 6.25, 0, 50);
    addComponent(world.ecs, owner, set(Team, { id: TeamId.ENEMY }));
    spawnWeapon(world, owner, WeaponType.MELEE, 15, 10, 33, 0, TeamId.PLAYER);
    world.elapsedMs = 10;

    weaponEntitySystem(world);

    const firstArea = query(world.ecs, [AreaDamage, Team])[0];
    expect(firstArea).toBeDefined();
    expect(world.stores.team.id[firstArea!]).toBe(TeamId.ENEMY);
    expect(world.stores.areaDamage.radius[firstArea!]).toBe(33);

    const owner2 = spawnPlayer(world, 0.625, 0.625);
    spawnEnemy(world, 3.125, 0.625, 50);
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
    spawnEnemy(world, 12.5, 0, 50);
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
    spawnEnemy(world, 625, 0, 50);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 12, 50, 10, 300, TeamId.PLAYER);
    world.elapsedMs = 50;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(-50);
  });
});

describe('weaponEntitySystem DamageMeta tagging', () => {
  it('tags a RANGED-spawned projectile with player origin, physical affinity, scaleWithPrimary=true, canCrit=true', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 50);
    spawnWeapon(world, owner, WeaponType.RANGED, 10, 50, 0, 200, TeamId.PLAYER);
    world.elapsedMs = 50;

    weaponEntitySystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    expect(readDamageMeta(world, projectile!)).toEqual({
      origin: 'player',
      affinity: 'physical',
      scaleWithPrimary: true,
      canCrit: true,
    });
  });

  it('tags a MELEE-spawned area attack with player origin, physical affinity, scaleWithPrimary=true, canCrit=true', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 5, 0, 50);
    spawnWeapon(world, owner, WeaponType.MELEE, 10, 10, 33, 0, TeamId.PLAYER);
    world.elapsedMs = 10;

    weaponEntitySystem(world);

    const area = query(world.ecs, [AreaDamage])[0];
    expect(area).toBeDefined();
    expect(readDamageMeta(world, area!)).toEqual({
      origin: 'player',
      affinity: 'physical',
      scaleWithPrimary: true,
      canCrit: true,
    });
  });

  it('tags a MAGIC weapon entity (default-fallback projectile path) with magic affinity', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 50);
    // WeaponType.MAGIC falls through to the default projectile branch;
    // affinity must still be 'magic' because weaponType is snapshotted at creation.
    spawnWeapon(world, owner, WeaponType.MAGIC, 20, 50, 0, 200, TeamId.PLAYER);
    world.elapsedMs = 50;

    weaponEntitySystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    const meta = readDamageMeta(world, projectile!);
    expect(meta.affinity).toBe('magic');
    expect(meta.origin).toBe('player');
    expect(meta.scaleWithPrimary).toBe(true);
    expect(meta.canCrit).toBe(true);
  });

  it('metadata on the spawned attack entity is stable after mutating the weapon entity type', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 50);
    const weid = spawnWeapon(world, owner, WeaponType.RANGED, 10, 50, 0, 200, TeamId.PLAYER);
    world.elapsedMs = 50;

    weaponEntitySystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    // Metadata snapshotted at attack creation — physical for a RANGED weapon.
    const metaAtCreation = readDamageMeta(world, projectile!);
    expect(metaAtCreation.affinity).toBe('physical');

    // Mutate the weapon entity's stored type to MAGIC after the attack has already
    // been spawned.  The spawned attack entity must retain the physical metadata
    // that was written at creation time.
    world.stores.weapon.weaponType[weid] = WeaponType.MAGIC;

    const metaAfterMutation = readDamageMeta(world, projectile!);
    expect(metaAfterMutation).toEqual(metaAtCreation);
    expect(metaAfterMutation.affinity).toBe('physical');
  });
});

describe('weaponSystem range-gating paths', () => {
  it('does not fire when no weapon is equipped (weapon cleared)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Enemy is nearby and in combat radius, but no active weapon is set.
    spawnEnemy(world, 12.5, 0, 50);
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
    spawnEnemy(world, 1250, 0, 50);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('does not fire a melee weapon when not in combat', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Enemy far outside combat radius (COMBAT_RADIUS_FT = 150).
    spawnEnemy(world, 625, 0, 50);
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
    spawnEnemy(world, 12.5, 0, 50);
    // Force a miss: baseAccuracy = 0 so effectiveAccuracy = 0; rng.next() > 0 always misses.
    const pistol = { ...getWeaponDef('pistol')!, baseAccuracy: 0 };
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;
    // Override RNG to always return 0.5 (> 0 = miss)
    world.rng.next = () => 0.5;

    weaponSystem(world);

    // Miss now fires a cosmetic wide-shot projectile (0 damage)
    const projectiles = Array.from(query(world.ecs, [Projectile]));
    expect(projectiles).toHaveLength(1);
    expect(world.stores.damage.amount[projectiles[0]!]).toBe(0);
    const missEvent = world.combatEvents.find((e) => e.type === 'miss');
    expect(missEvent).toBeDefined();
    expect(missEvent?.amount).toBe(0);
    expect(missEvent?.targetType).toBe('enemy');
    // The miss VFX is projected forward along the aim direction (toward the enemy
    // on the +x axis) and capped at MAX_MISS_VFX_REACH_FT = 8 ft, so it lands at
    // min(aoeRadius || range, 8) ft on x and stays on the y axis.
    const expectedReachFt = Math.min(pistol.aoeRadius || pistol.range, 8);
    expect(expectedReachFt).toBe(8);
    expect(missEvent?.x).toBeCloseTo(expectedReachFt);
    expect(missEvent?.y).toBeCloseTo(0);
  });

  it('does not emit a miss event when the accuracy roll succeeds', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 50);
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
    spawnEnemy(world, 12.5, 0, 50);
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
    spawnEnemy(world, 12.5, 0, 50);
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
    spawnEnemy(world, 12.5, 0, 50);
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
    spawnEnemy(world, 12.5, 0, 50);
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
    spawnEnemy(world, 3.75, 0, 50);
    // Boss enemy slightly farther but still in range
    const boss = spawnEnemy(world, 7.5, 0, 50);
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
    spawnEnemy(world, 3.75, 0, 50);
    // Boss far out of range
    const boss = spawnEnemy(world, 1125, 0, 50);
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

describe('weaponSystem line-of-sight gating', () => {
  const TILE = 4;
  // Center point of a tile (feet), matching FloorMap.tileToWorld.
  const cx = (tx: number): number => tx * TILE + TILE / 2;
  const cy = (ty: number): number => ty * TILE + TILE / 2;

  it('does not fire a bow at an enemy in the next room behind a wall', () => {
    const world = createTestWorld();
    // Vertical wall column at tile x=5 separates the player from the enemy.
    world.floorMap = makeOpenFloorMap(5);
    spawnPlayer(world, cx(2), cy(5));
    // Enemy is 24 ft away (well inside the bow's 44 ft gate range) and inside
    // the combat radius, but the wall blocks line of sight — so it must not fire.
    spawnEnemy(world, cx(8), cy(5), 50);
    const bow = getWeaponDef('bow')!;
    setActiveWeapon(world, bow);
    world.elapsedMs = bow.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('fires a bow at an enemy in the same room with a clear line of sight', () => {
    const world = createTestWorld();
    world.floorMap = makeOpenFloorMap(); // no walls
    spawnPlayer(world, cx(2), cy(5));
    spawnEnemy(world, cx(8), cy(5), 50);
    const bow = getWeaponDef('bow')!;
    setActiveWeapon(world, bow);
    world.elapsedMs = bow.cooldownMs;
    world.rng.next = () => 0; // force a hit (a miss would still spawn a shot)

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });

  it('fires when the enemy tile is FOV-visible even if the strict line clips a wall', () => {
    const world = createTestWorld();
    const floor = makeOpenFloorMap(5); // wall column blocks the strict center line
    world.floorMap = floor;
    spawnPlayer(world, cx(2), cy(5));
    spawnEnemy(world, cx(8), cy(5), 50);
    // Mark the enemy tile visible at sub-tile resolution (tileSizeFt=4, halfTile=2).
    // Tile (8,5) TL sub-tile: hx=8*2=16, hy=5*2=10.
    floor.setVisible(16, 10);
    const bow = getWeaponDef('bow')!;
    setActiveWeapon(world, bow);
    world.elapsedMs = bow.cooldownMs;
    world.rng.next = () => 0;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });

  it('does not swing a melee weapon at an enemy through a wall', () => {
    const world = createTestWorld();
    // Wall column at tile x=3 (12–16 ft) sits between the player and enemy.
    world.floorMap = makeOpenFloorMap(3);
    spawnPlayer(world, cx(2), cy(5)); // (10, 22) ft
    // Enemy 6.25 ft to the right — within the sword's 7.5 ft melee gate, but the wall
    // strictly blocks the straight line, so the swing must not auto-aim at it.
    spawnEnemy(world, cx(2) + 6.25, cy(5), 50); // (16.25, 22) ft, tile (4,5)
    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;
    world.rng.next = () => 0;

    weaponSystem(world);

    expect(query(world.ecs, [MeleeSwing]).length).toBe(0);
  });

  it('swings a melee weapon at an enemy with a clear line of sight', () => {
    const world = createTestWorld();
    world.floorMap = makeOpenFloorMap(); // no walls
    spawnPlayer(world, cx(2), cy(5));
    spawnEnemy(world, cx(2) + 6.25, cy(5), 50);
    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;
    world.rng.next = () => 0;

    weaponSystem(world);

    expect(query(world.ecs, [MeleeSwing]).length).toBe(1);
  });

  it('does not fire at a boss through a wall, hitting the visible enemy instead', () => {
    const world = createTestWorld();
    // Wall column at tile x=5 hides the boss to the right; the path upward is clear.
    world.floorMap = makeOpenFloorMap(5);
    spawnPlayer(world, cx(2), cy(5)); // (80, 176)
    // A regular enemy directly above with a clear line of sight — the only
    // legitimate target, which makes getNearestEnemyTarget return non-null.
    spawnEnemy(world, cx(2), cy(2), 50); // (80, 80)
    // A boss to the right behind the wall: within bow gate range but not visible.
    // Without the findBossTargetInRange sight gate, boss-priority aim would fire
    // straight through the wall at it.
    const boss = spawnEnemy(world, cx(8), cy(5), 50); // (272, 176)
    world.stores.enemyBehavior.aggroedPermanently[boss] = 1;

    const bow = getWeaponDef('bow')!;
    setActiveWeapon(world, bow);
    world.elapsedMs = bow.cooldownMs;
    world.rng.next = () => 0;

    weaponSystem(world);

    const projectiles = query(world.ecs, [Projectile]);
    expect(projectiles.length).toBe(1);
    const proj = projectiles[0]!;
    const vx = world.stores.velocity.x[proj]!;
    const vy = world.stores.velocity.y[proj]!;
    // Fired UP at the visible enemy, not RIGHT through the wall at the boss.
    expect(vy).toBeLessThan(0);
    expect(Math.abs(vy)).toBeGreaterThan(Math.abs(vx));
  });
});

describe('getActiveWeaponReadiness paths', () => {
  it('returns null when no weapon is equipped', () => {
    // No weapon → def === undefined → Branch 77[0] (return null path)
    const world = createTestWorld();
    const result = getActiveWeaponReadiness(world);
    expect(result).toBeNull();
  });

  it('uses def.cooldownMs directly when no player entity exists', () => {
    // No player → player === undefined → Branch 78[0] (ternary true branch)
    const world = createTestWorld();
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    const result = getActiveWeaponReadiness(world);
    expect(result).not.toBeNull();
    expect(result!.cooldownMs).toBe(pistol.cooldownMs);
  });

  it('re-syncs generation when weapon is set after readiness was first polled (no player)', () => {
    // First call initialises WeaponState with gen=0; setting a weapon bumps gen to 1.
    // Second call: gen=1 ≠ lastActive=0 → syncActiveWeaponGeneration runs
    // (Branches 2[1], 3[1], 4[0]) — all with no player, so def.cooldownMs is used.
    const world = createTestWorld();
    getActiveWeaponReadiness(world); // init state, gen=0
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol); // gen → 1
    const result = getActiveWeaponReadiness(world); // gen=1 ≠ 0 → re-sync
    expect(result!.cooldownMs).toBe(pistol.cooldownMs);
    // syncActiveWeaponGeneration resets lastFireMs = elapsedMs - cooldownMs so
    // the freshly-equipped weapon can fire immediately: ready === true.
    expect(result!.ready).toBe(true);
  });
});

describe('weaponSystem sync and safe-space paths', () => {
  it('clears fire state when active weapon is removed mid-run (Branch 2[1] + 3[0])', () => {
    // After the weapon is cleared, weaponSystem re-syncs (gen mismatch) and resets
    // lastFireMs because def is now undefined.
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;
    weaponSystem(world); // init WeaponState with gen=1; no enemy → no fire

    clearActiveWeapon(world); // gen → 2, def = undefined
    world.elapsedMs += pistol.cooldownMs;
    weaponSystem(world); // gen=2 ≠ 1 (Branch 2[1]) → def=undefined (Branch 3[0]) → reset

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('returns early without firing when player is in a safe room', () => {
    // isEntityInSafeSpace → Branch 80[0]: return before any weapon fires.
    // Safe room covers tiles (1,1)–(4,4) with 32 ft/tile; player at (64,64) = tile (2,2).
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    spawnPlayer(world, 64, 64); // inside safe room
    spawnEnemy(world, 128, 64, 50);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('weaponEntitySystem: skips a player-owned weapon entity when player is in a safe room', () => {
    // Branch 101[0]: Player + isEntityInSafeSpace → continue (no fire).
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    const owner = spawnPlayer(world, 64, 64); // inside safe room
    spawnEnemy(world, 128, 64, 50);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 20, 50, 0, 300, TeamId.PLAYER);
    world.elapsedMs = 50;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(-50); // not updated
  });
});

describe('weaponSystem preferred-target routing', () => {
  it('fires at the preferred target when it is within melee gate range', () => {
    // setPreferredWeaponTarget makes getPreferredEnemyTarget return a valid target.
    // With the preferred entity at 3.75 ft and a 7.5 ft melee gate, the
    // preferredInRange ternary is true (Branch 90[0]) and the binary-expr
    // reaches its second operand (Branch 91[1]).
    // Also covers getPreferredEnemyTarget body: Branches 32[1], 34[1], 37[1].
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const preferred = spawnEnemy(world, 3.75, 0, 50);
    setPreferredWeaponTarget(world, preferred);

    const sword = getWeaponDef('sword')!;
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    expect(query(world.ecs, [MeleeSwing]).length).toBe(1);
  });

  it('fires at the preferred target when it is within ranged gate range', () => {
    // Same preferred-target routing but for the ranged/magic/thrown path
    // (Branch 96[0] true, Branch 97[1] second operand reached).
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const preferred = spawnEnemy(world, 12.5, 0, 50);
    setPreferredWeaponTarget(world, preferred);

    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;
    world.rng.next = () => 0; // force hit

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });
});
