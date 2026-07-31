import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { LineDamage, MeleeSwing, Projectile, Trap } from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { applyStatusEffect, statusEffectSystem } from '../../src/core/index.js';
import {
  clearActiveWeapon,
  computeEffectiveAccuracy,
  getActiveWeapon,
  getActiveWeaponReadiness,
  setActiveWeapon,
  setPreferredWeaponTarget,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
import { WEAPON, type WeaponTypeValue } from '../../src/shared/constants.js';
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

  it('re-syncs generation as immediately ready with fractional effective cooldowns', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    getActiveWeaponReadiness(world); // init state, gen=0
    applyStatusEffect(world, player, {
      stat: 'attackSpeed',
      op: 'multiply',
      value: 0.75,
      durationMs: 4000,
      sourceType: 'ability',
      sourceId: 'mob-ability:queen-mab-verdigris-glamour:1',
      stackRule: { mode: 'replace' },
    });
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol); // gen → 1
    const result = getActiveWeaponReadiness(world); // re-sync with effective cooldown
    expect(result).not.toBeNull();
    expect(result!.cooldownMs).toBeCloseTo(pistol.cooldownMs / 0.75, 6);
    expect(result!.ready).toBe(true);
  });

  it('lengthens cooldown under attackSpeed debuff and returns to baseline after expiry', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);

    const baseline = getActiveWeaponReadiness(world);
    expect(baseline).not.toBeNull();
    expect(baseline!.cooldownMs).toBe(pistol.cooldownMs);

    applyStatusEffect(world, player, {
      stat: 'attackSpeed',
      op: 'multiply',
      value: 0.75,
      durationMs: 4000,
      sourceType: 'ability',
      sourceId: 'mob-ability:queen-mab-verdigris-glamour:1',
      stackRule: { mode: 'replace' },
    });
    const slowed = getActiveWeaponReadiness(world);
    expect(slowed).not.toBeNull();
    expect(slowed!.cooldownMs).toBeCloseTo(pistol.cooldownMs / 0.75, 6);

    // Expire effects deterministically and assert readiness returns to baseline.
    for (let i = 0; i < 245; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += 1000 / 60;
      statusEffectSystem(world);
    }
    const recovered = getActiveWeaponReadiness(world);
    expect(recovered).not.toBeNull();
    expect(recovered!.cooldownMs).toBeCloseTo(pistol.cooldownMs, 6);
  });

  it('keeps switched weapons disabled while attackSpeed is 0×', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 10, 0, 50);

    applyStatusEffect(world, player, {
      stat: 'attackSpeed',
      op: 'multiply',
      value: 0,
      durationMs: null,
      sourceType: 'ability',
      sourceId: 'test:zero-attack-speed',
      stackRule: { mode: 'replace' },
    });

    const pistol = getWeaponDef('pistol')!;
    const bow = getWeaponDef('bow')!;
    setActiveWeapon(world, pistol);

    const initial = getActiveWeaponReadiness(world);
    expect(initial).not.toBeNull();
    expect(initial!.cooldownMs).toBe(Infinity);
    expect(initial!.ready).toBe(false);

    world.elapsedMs += 10_000;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(0);

    // Regression: switching weapons while disabled used to set -Infinity
    // `lastFireMs`, letting the next weapon fire immediately.
    setActiveWeapon(world, bow);
    const switched = getActiveWeaponReadiness(world);
    expect(switched).not.toBeNull();
    expect(switched!.cooldownMs).toBe(Infinity);
    expect(switched!.ready).toBe(false);
    expect(switched!.remainingMs).toBe(Infinity);

    world.elapsedMs += 10_000;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(0);
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
