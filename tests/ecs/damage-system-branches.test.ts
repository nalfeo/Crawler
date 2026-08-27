import { addComponent, entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { EffectiveStats } from '../../src/core/components.js';
import {
  spawnEnemy,
  spawnEnemyProjectile,
  spawnPlayer,
  spawnProjectile,
} from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { WEAPON_DEFS } from '../../src/shared/weaponDefs.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('damageSystem enemy-projectile and safe-space branches', () => {
  it('damages the player and destroys an enemy projectile on hit', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const projectile = spawnEnemyProjectile(world, 0.5, 0, 0, 0, 7);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBeLessThan(100);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('destroys an enemy projectile without damage when the player is in a safe space', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom({
      widthTiles: 12,
      heightTiles: 12,
      tileSizeFt: 4,
      maxRooms: 2,
      spawn: { x: 2, y: 2 },
    });
    // Tile (2,2) centre -> inside the safe room.
    const player = spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    const projectile = spawnEnemyProjectile(world, 2 * 4 + 2.25, 2 * 4 + 2, 0, 0, 7);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('blocks an enemy projectile during the invincibility window', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemyProjectile(world, 0.5, 0, 0, 0, 7);

    damageSystem(world, collisionSystem(world));
    const healthAfterFirst = world.stores.health.current[player]!;
    world.combatEvents.length = 0;

    // Second projectile within the invincibility window is blocked.
    spawnEnemyProjectile(world, 0.5, 0, 0, 0, 7);
    world.elapsedMs += 50;
    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(healthAfterFirst);
    expect(world.combatEvents.some((e) => e.type === 'blocked')).toBe(true);
  });

  it('does not damage the player from enemy contact while in a safe space', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom({
      widthTiles: 12,
      heightTiles: 12,
      tileSizeFt: 4,
      maxRooms: 2,
      spawn: { x: 2, y: 2 },
    });
    const player = spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    spawnEnemy(world, 2 * 4 + 2.25, 2 * 4 + 2, 25);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
  });

  it('reduces contact damage by the player armor stat (min 1)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // EffectiveStats gates armor mitigation; the armor value lives in the effectiveStats store.
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.armor[player] = 100;
    spawnEnemy(world, 1, 0, 25);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(99);
  });
});

describe('damageSystem hit-gated weapon-skill XP', () => {
  it('emits weapon_fired events for both skills when a player-owned projectile hits an enemy', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 100, 0, 50);
    // Mirror a successful weapon dispatch registering the active weapon's skills.
    world.attackerWeaponSkills.set(player, { classSkillId: 'slashing', typeSkillId: 'sword' });
    // Player-owned projectile overlapping the enemy so the collision lands.
    spawnProjectile(world, 100, 0, 0, 0, 10, 0, 0, 1, player);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    const fired = world.skillUsageEvents.filter((e) => e.metric === 'weapon_fired');
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.skillId).sort()).toEqual(['slashing', 'sword']);
    expect(fired.every((e) => e.holderEid === player)).toBe(true);
  });

  it('emits no skill events when an owner-less projectile hits an enemy (-1 guard)', () => {
    const world = createTestWorld();
    const enemy = spawnEnemy(world, 100, 0, 50);
    // No Owner component → ownerEid resolves to -1 and the emission is skipped.
    spawnProjectile(world, 100, 0, 0, 0, 10);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    expect(world.skillUsageEvents).toHaveLength(0);
  });

  it('emits no skill events when the owner has no registered weapon skills', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 100, 0, 50);
    // Owner present but attackerWeaponSkills not populated (no prior dispatch).
    spawnProjectile(world, 100, 0, 0, 0, 10, 0, 0, 1, player);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    expect(world.skillUsageEvents).toHaveLength(0);
  });

  it('attributes XP to the original weapon after a mid-flight switch', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const bowDef = WEAPON_DEFS.get('bow')!;
    const pistolDef = WEAPON_DEFS.get('pistol')!;
    world.rng.next = () => 0;
    const bowTarget = spawnEnemy(world, 50, 0, 50);

    setActiveWeapon(world, bowDef);
    world.elapsedMs = bowDef.cooldownMs;
    weaponSystem(world);

    const bowEntry = [...world.attackWeaponSkillsByEntity.entries()].find(
      ([, skills]) => skills?.typeSkillId === bowDef.weaponTypeSkillId,
    );
    expect(bowEntry).toBeDefined();
    const [bowProjectile] = bowEntry!;

    const pistolTarget = spawnEnemy(world, 4, 0, 50);
    setActiveWeapon(world, pistolDef);
    weaponSystem(world);

    const pistolEntry = [...world.attackWeaponSkillsByEntity.entries()].find(
      ([eid, skills]) =>
        eid !== bowProjectile && skills?.typeSkillId === pistolDef.weaponTypeSkillId,
    );
    expect(pistolEntry).toBeDefined();
    const [pistolProjectile] = pistolEntry!;

    world.stores.position.x[pistolProjectile] = world.stores.position.x[pistolTarget] ?? 0;
    world.stores.position.y[pistolProjectile] = world.stores.position.y[pistolTarget] ?? 0;
    world.stores.velocity.x[pistolProjectile] = 0;
    world.stores.velocity.y[pistolProjectile] = 0;
    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[pistolTarget]).toBeLessThan(50);
    world.skillUsageEvents.length = 0;

    world.stores.position.x[bowProjectile] = world.stores.position.x[bowTarget] ?? 0;
    world.stores.position.y[bowProjectile] = world.stores.position.y[bowTarget] ?? 0;
    world.stores.velocity.x[bowProjectile] = 0;
    world.stores.velocity.y[bowProjectile] = 0;
    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[bowTarget]).toBeLessThan(50);
    const fired = world.skillUsageEvents.filter((event) => event.metric === 'weapon_fired');
    expect(fired).toHaveLength(2);
    expect(fired.map((event) => event.skillId).sort()).toEqual(
      [bowDef.weaponClassSkillId, bowDef.weaponTypeSkillId].sort(),
    );
  });
});

describe('damageSystem archetype-key EID-recycling safety', () => {
  it('attributes a projectile hit to the original shooter archetype even after the shooter EID is recycled', () => {
    const world = createTestWorld();
    // Spawn a player as the projectile target (EID not needed explicitly).
    spawnPlayer(world, 0, 0);

    // Spawn an enemy far away (no contact damage), then label it 'bat'.
    const ownerEid = spawnEnemy(world, 100, 100, 10);
    world.enemyAppearanceKeys.set(ownerEid, 'bat');

    // Spawn an enemy projectile with that owner — snapshot captures 'bat'.
    const projectile = spawnEnemyProjectile(world, 0.5, 0, 0, 0, 7, ownerEid);
    expect(world.enemyProjectileArchetypeKeys.get(projectile)).toBe('bat');

    // Simulate owner death + EID recycled by a different archetype ('orc').
    // clearEntityStores would delete enemyAppearanceKeys[ownerEid]; replicate
    // that here, then overwrite to mimic reuse of the same slot by another mob.
    world.enemyAppearanceKeys.delete(ownerEid);
    world.enemyAppearanceKeys.set(ownerEid, 'orc');

    damageSystem(world, collisionSystem(world));

    const hit = world.combatEvents.find((e) => e.type === 'hit' && e.targetType === 'player');
    expect(hit).toBeDefined();
    // Must use the snapshot 'bat', NOT the recycled EID's new archetype 'orc'.
    expect(hit!.sourceArchetypeKey).toBe('bat');
  });
});
