import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, Team } from '../../src/core/components.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { getActiveWeaponDef, setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { isEnemyHostileToPlayer } from '../../src/core/enemy-targeting.js';
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
    companionAISystem(world);
    expect(isEnemyHostileToPlayer(world, wild)).toBe(true);
    expect(world.stores.health.current[wild]).toBe(70);

    world.stores.position.x[player] = 2 + FLOOR3_WILD_AGGRO_RANGE_FT * 2 + 1;
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
