import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Companion,
  EnemyProjectile,
  Projectile,
  ProjectileVisualKind,
  Team,
} from '../../src/core/components.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { getActiveWeaponDef, setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { isEnemyHostileToPlayer } from '../../src/core/enemy-targeting.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { resolveRenderKind } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import {
  companionAISystem,
  getCompanionAIDecision,
} from '../../src/game/systems/companionAISystem.js';
import { companionCombatSystem } from '../../src/game/systems/companionCombatSystem.js';
import { floor3WildTargetRedirectSystem } from '../../src/game/systems/floor3WildTargetRedirectSystem.js';
import { floor3NonCombatantSystem } from '../../src/game/systems/floor3NonCombatantSystem.js';
import { FLOOR3_WILD_AGGRO_RANGE_FT } from '../../src/game/systems/floor3WildHostility.js';
import { TeamId } from '../../src/shared/constants.js';
import { speciesTokenForId } from '../../src/shared/data/floor3/species.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('companionCombatSystem', () => {
  it('disarms a carried-over weapon before the Floor 3 weapon system runs', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    const sword = getWeaponDef('sword');
    if (sword === undefined) throw new Error('sword definition is required for this test');
    setActiveWeaponDef(world, sword);

    floor3NonCombatantSystem(world);

    expect(getActiveWeaponDef(world)).toBeUndefined();
  });

  it('damages a nearby opposing trash mob without involving the player', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    spawnPlayer(world, 20, 0);
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const trash = spawnBehaviorEnemy(world, 2, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, trash, set(Team, { id: TeamId.ENEMY }));

    companionAISystem(world);
    companionCombatSystem(world);

    expect(world.stores.health.current[trash]).toBe(70);
    expect(world.combatEvents).toContainEqual(
      expect.objectContaining({ type: 'hit', sourceEid: companion, targetEid: trash }),
    );
  });

  it('fires a visible projectile for ranged Floor 3 companions without applying instant damage', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    spawnPlayer(world, 20, 0);
    // `ember-slinger` (Sparktick) is the real shipped `aiType: "ranged"`
    // Floor 3 species (enemies.floor3.json) — using it here (rather than
    // fabricating ranged behavior on the melee `ember-charger` archetype)
    // keeps this unit test aligned with the production species wiring.
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.RANGED, 0.1, 48, 10);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-slinger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const trash = spawnBehaviorEnemy(world, 5, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, trash, set(Team, { id: TeamId.ENEMY }));

    companionAISystem(world);
    companionCombatSystem(world);

    const projectiles = query(world.ecs, [EnemyProjectile, Projectile]);
    expect(projectiles.length).toBe(1);
    const projectile = projectiles[0];
    expect(projectile).toBeDefined();
    expect(world.stores.health.current[trash]).toBe(100);
    expect(world.stores.projectileVisual.kind[projectile!]).toBe(ProjectileVisualKind.BULLET);
    // resolveRenderKind is the function the real PhaserBridge consults for
    // texture selection — asserting on it (rather than just the tag) proves
    // this projectile actually renders as a bullet, not the hostile
    // enemy-projectile asset.
    expect(resolveRenderKind(world, projectile!)).toBe('bullet');
  });

  it('applies the strong Temperament matchup multiplier through a ranged companion projectile hit', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    spawnPlayer(world, 20, 0);
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.RANGED, 0.1, 48, 10);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        // ember beats stone for 2x (AFFINITY_RING super-effective neighbor).
        speciesToken: speciesTokenForId('ember-slinger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const rival = spawnBehaviorEnemy(world, 3, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, rival, set(Team, { id: TeamId.ENEMY }));
    addComponent(
      world.ecs,
      rival,
      set(Companion, {
        speciesToken: speciesTokenForId('stone-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.ENEMY,
        knockedOut: 0,
      }),
    );

    companionAISystem(world);
    companionCombatSystem(world);

    for (let i = 0; i < 30 && world.stores.health.current[rival] === 100; i++) {
      movementSystem(world);
      const collision = collisionSystem(world);
      damageSystem(world, collision);
      world.elapsedMs += 16.67;
    }

    // BASE_DAMAGE(10) * medium(1) * playerCompanionDamageMultiplier(3) * 2x
    // strong-matchup Temperament multiplier.
    expect(world.stores.health.current[rival]).toBe(40);
  });

  it('applies the resisted Temperament matchup multiplier through a ranged companion projectile hit', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    spawnPlayer(world, 20, 0);
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.RANGED, 0.1, 48, 10);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        // ember is resisted (0.5x) by gloom (AFFINITY_RING previous neighbor).
        speciesToken: speciesTokenForId('ember-slinger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const rival = spawnBehaviorEnemy(world, 3, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, rival, set(Team, { id: TeamId.ENEMY }));
    addComponent(
      world.ecs,
      rival,
      set(Companion, {
        speciesToken: speciesTokenForId('gloom-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.ENEMY,
        knockedOut: 0,
      }),
    );

    companionAISystem(world);
    companionCombatSystem(world);

    for (let i = 0; i < 30 && world.stores.health.current[rival] === 100; i++) {
      movementSystem(world);
      const collision = collisionSystem(world);
      damageSystem(world, collision);
      world.elapsedMs += 16.67;
    }

    // BASE_DAMAGE(10) * medium(1) * playerCompanionDamageMultiplier(3) * 0.5x
    // resisted-matchup Temperament multiplier.
    expect(world.stores.health.current[rival]).toBe(85);
  });

  it('lands an instant hit instead of dropping the attack when a ranged companion is point-blank on its target', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    spawnPlayer(world, 20, 0);
    const companion = spawnBehaviorEnemy(world, 4, 4, 100, AI_TYPE.RANGED, 0.1, 48, 10);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-slinger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    // Zero-distance target: `normalize(0, 0)` has no direction to fire a
    // projectile along, so this must fall through to the instant melee-style
    // hit rather than silently consuming the cooldown with no effect.
    const trash = spawnBehaviorEnemy(world, 4, 4, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, trash, set(Team, { id: TeamId.ENEMY }));

    companionAISystem(world);
    companionCombatSystem(world);

    expect(query(world.ecs, [EnemyProjectile, Projectile]).length).toBe(0);
    expect(world.stores.health.current[trash]).toBeLessThan(100);
  });

  it('lets player companions engage Floor 3 wild mobs only while they are hostile', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    const player = spawnPlayer(world, 100, 0);
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const wild = spawnBehaviorEnemy(world, 2, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, wild, set(Team, { id: TeamId.ENEMY }));

    companionAISystem(world);
    companionCombatSystem(world);
    expect(isEnemyHostileToPlayer(world, wild)).toBe(false);
    expect(getCompanionAIDecision(world, companion)?.targetEid).not.toBe(wild);
    expect(world.stores.health.current[wild]).toBe(100);

    world.stores.position.x[player] = FLOOR3_WILD_AGGRO_RANGE_FT;
    world.frameCount += 1;
    companionAISystem(world);
    companionCombatSystem(world);
    expect(isEnemyHostileToPlayer(world, wild)).toBe(true);
    expect(getCompanionAIDecision(world, companion)?.targetEid).toBe(wild);
    expect(world.stores.health.current[wild]).toBe(70);
  });

  it('keeps wild mobs hostile through the disengage band, then heals them on disengage', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    const player = spawnPlayer(world, 0, 0);
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const wild = spawnBehaviorEnemy(world, 2, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, wild, set(Team, { id: TeamId.ENEMY }));

    companionAISystem(world);
    companionCombatSystem(world);
    expect(isEnemyHostileToPlayer(world, wild)).toBe(true);
    expect(world.stores.health.current[wild]).toBe(70);

    world.stores.position.x[player] = 2 + FLOOR3_WILD_AGGRO_RANGE_FT * 2 - 1;
    world.frameCount += 1;
    companionAISystem(world);
    expect(isEnemyHostileToPlayer(world, wild)).toBe(true);
    expect(world.stores.health.current[wild]).toBe(70);

    world.stores.position.x[player] = 2 + FLOOR3_WILD_AGGRO_RANGE_FT * 2 + 1;
    world.frameCount += 1;
    companionAISystem(world);
    expect(isEnemyHostileToPlayer(world, wild)).toBe(false);
    expect(world.stores.health.current[wild]).toBe(100);
  });

  it('does not apply the Floor 3 player-Companion buff on another floor', () => {
    const world = createTestWorld({ floor: 2 });
    world.floorId = 'floor2';
    spawnPlayer(world, 20, 0);
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const trash = spawnBehaviorEnemy(world, 2, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, trash, set(Team, { id: TeamId.ENEMY }));

    companionAISystem(world);
    companionCombatSystem(world);

    expect(world.stores.health.current[trash]).toBe(90);
  });

  it('redirects trash mobs to the selected companion instead of the player', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    spawnPlayer(world, 20, 0);
    const companion = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companion,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: 0,
      }),
    );
    const trash = spawnBehaviorEnemy(world, 10, 0, 100, AI_TYPE.CHASE, 0.1, 48, 0);
    addComponent(world.ecs, trash, set(Team, { id: TeamId.ENEMY }));

    companionAISystem(world);
    floor3WildTargetRedirectSystem(world);

    expect(getCompanionAIDecision(world, trash)?.targetEid).toBe(companion);
  });
});
