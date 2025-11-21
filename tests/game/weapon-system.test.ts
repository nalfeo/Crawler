import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Damage,
  DeathTimer,
  EffectiveStats,
  FamilyMembership,
  MeleeSwing,
  Position,
  Projectile,
  Velocity,
} from '../../src/core/components.js';
import { asFamilyId } from '../../src/core/faction-relations.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { applyStatusEffect } from '../../src/core/status-effects.js';
import { denUnlockGoalId } from '../../src/game/floor2Scenario.js';
import {
  setActiveWeapon,
  getActiveWeaponReadiness,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
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

  it('does not add an extra millisecond for float32 near-integer cooldown products', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 8, 8);
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.cooldownReduction[player] = 0.01;
    spawnEnemy(world, 25, 8, 10);
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);
    world.elapsedMs = pistol.cooldownMs;

    weaponSystem(world);
    world.elapsedMs += 494;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    world.elapsedMs += 1;
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

  it('skips a Floor 2 family boss before den unlock, after den unlock but encounter inactive, and targets it once the encounter starts', () => {
    // Shared setup: player at origin, live boss below, live trash enemy to the
    // right.  The boss has FamilyMembership.isBoss=1 so isEnemyCombatEligible
    // gates it; the trash enemy (no FamilyMembership) is always eligible and
    // stands at +X so a correct skip fires +X.
    const familyId = asFamilyId('imps');

    function makeWorld(): ReturnType<typeof createTestWorld> {
      const w = createTestWorld({ floor: 2 });
      spawnPlayer(w, 0, 0);
      const trashEid = spawnEnemy(w, 3.75, 0, 10); // to the right (+X)
      void trashEid;

      const bossEid = spawnEnemy(w, 0, 5, 100); // below (+Y)
      addComponent(w.ecs, bossEid, FamilyMembership);
      w.stores.familyMembership.familyId[bossEid] = 0; // presentFamilies[0]
      w.stores.familyMembership.isBoss[bossEid] = 1;

      w.floorExtendedState = {
        familyState: {
          presentFamilies: [familyId],
          contestedResource: 'gold-veins' as never,
          betrayerFlag: false,
          reputationSystemActive: true,
          trashKillsByFamily: new Map([[familyId, 0]]),
          bossEncounters: new Map([
            [
              familyId,
              {
                familyId,
                roomId: -1,
                doorEids: [],
                activeGoalId: 'floor2-den-imps-boss-active',
                started: false,
                bossEid,
                defeated: false,
                displayName: 'Imp Boss',
                lootTableId: 'boss',
              },
            ],
          ]),
        },
      };

      const pistol = getWeaponDef('pistol')!;
      setActiveWeapon(w, pistol);
      w.elapsedMs = pistol.cooldownMs;
      return w;
    }

    // Case 1: den locked — boss is ineligible, weapon fires at trash (+X).
    const lockedWorld = makeWorld();
    weaponSystem(lockedWorld);
    const lockedProjectile = query(lockedWorld.ecs, [Projectile])[0];
    expect(lockedProjectile).toBeDefined();
    expect(lockedWorld.stores.velocity.x[lockedProjectile!]).toBeGreaterThan(0);
    expect(lockedWorld.stores.velocity.y[lockedProjectile!]).toBeCloseTo(0, 1);

    // Case 2: den unlocked but encounter not started — boss still ineligible.
    const unlockedWorld = makeWorld();
    unlockedWorld.goalFlags.set(denUnlockGoalId(familyId), true);
    weaponSystem(unlockedWorld);
    const unlockedProjectile = query(unlockedWorld.ecs, [Projectile])[0];
    expect(unlockedProjectile).toBeDefined();
    expect(unlockedWorld.stores.velocity.x[unlockedProjectile!]).toBeGreaterThan(0);
    expect(unlockedWorld.stores.velocity.y[unlockedProjectile!]).toBeCloseTo(0, 1);

    // Case 3: den unlocked AND encounter started — boss becomes the nearer
    // target (+Y direction, boss at distance 5 vs trash at distance 3.75).
    // The boss is farther, so the pistol should still prefer the closer trash
    // for getNearestEnemyTarget — but the boss IS now eligible.  Confirm
    // eligibility by verifying the projectile fires +Y when trash is removed.
    const activeWorld = makeWorld();
    activeWorld.goalFlags.set(denUnlockGoalId(familyId), true);
    const activeBossEncounter =
      activeWorld.floorExtendedState!.familyState!.bossEncounters!.get(familyId)!;
    activeBossEncounter.started = true;
    // Remove the trash enemy so the boss is the only target.
    const trashEids = query(activeWorld.ecs, [Position]);
    for (const eid of trashEids) {
      if (
        (activeWorld.stores.position.x[eid] ?? 0) > 0 &&
        (activeWorld.stores.familyMembership.isBoss[eid] ?? 0) === 0
      ) {
        activeWorld.stores.health.current[eid] = 0;
      }
    }
    weaponSystem(activeWorld);
    const activeProjectile = query(activeWorld.ecs, [Projectile])[0];
    expect(activeProjectile).toBeDefined();
    // Boss is below (+Y), so the projectile must have a +Y component.
    expect(activeWorld.stores.velocity.y[activeProjectile!]).toBeGreaterThan(0);
  });

  it('Tarnished attackSpeed status multiplier extends weapon fire cadence through weaponSystem', () => {
    // Regression guard for the attackSpeed status channel folded into
    // getEffectiveCooldownMs at weaponSystem.ts line 211-215. A 0.75× multiplier
    // means "attacks 25% slower", which LENGTHENS the cooldown: 500ms / 0.75 ≈ 667ms.
    const world = createTestWorld();
    const player = spawnPlayer(world, 8, 8);
    spawnEnemy(world, 25, 8, 10); // target enemy
    const pistol = getWeaponDef('pistol')!;
    setActiveWeapon(world, pistol);

    // Apply 0.75× attackSpeed multiplier (Queen Mab Tarnished debuff).
    applyStatusEffect(world, player, {
      stat: 'attackSpeed',
      op: 'multiply',
      value: 0.75,
      durationMs: 99_999,
      sourceType: 'ability',
      sourceId: 'test:tarnished',
      stackRule: { mode: 'replace' },
    });

    // First fire: at the base cooldown mark (weapon already primed by setActiveWeapon).
    world.elapsedMs = pistol.cooldownMs; // 500ms
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    // 550ms after first fire: > base cooldown (500ms) but < effective cooldown
    // (~667ms), so the weapon must NOT fire again yet.
    world.elapsedMs += 550;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    // Another 120ms (670ms total since first fire): now >= effective cooldown — fires.
    world.elapsedMs += 120;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(2);
  });

  it('setActiveWeapon immediate-fire guarantee holds under Tarnished attackSpeed debuff', () => {
    // Regression guard: if the player is Tarnished (0.75× attackSpeed → ~667ms
    // effective cooldown) when they swap weapons, the fresh weapon must still be
    // ready to fire at the swap instant — i.e. getActiveWeaponReadiness().ready
    // must return true immediately after setActiveWeapon.
    const world = createTestWorld();
    const player = spawnPlayer(world, 8, 8);
    spawnEnemy(world, 25, 8, 10);
    const pistol = getWeaponDef('pistol')!; // cooldownMs = 500

    // Apply Tarnished BEFORE equipping the weapon.
    applyStatusEffect(world, player, {
      stat: 'attackSpeed',
      op: 'multiply',
      value: 0.75,
      durationMs: 99_999,
      sourceType: 'ability',
      sourceId: 'test:tarnished',
      stackRule: { mode: 'replace' },
    });

    // Equip at a non-zero timestamp so the lastFireMs arithmetic is non-trivial.
    world.elapsedMs = 10_000;
    setActiveWeapon(world, pistol);

    // The weapon should be ready to fire immediately — not delayed by ~167ms.
    const readiness = getActiveWeaponReadiness(world);
    expect(readiness).not.toBeNull();
    expect(readiness!.ready).toBe(true);
    expect(readiness!.remainingMs).toBe(0);
  });
});
