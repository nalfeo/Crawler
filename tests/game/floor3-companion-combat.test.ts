import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, Team } from '../../src/core/components.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { getActiveWeaponDef, setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import {
  companionAISystem,
  getCompanionAIDecision,
} from '../../src/game/systems/companionAISystem.js';
import { companionCombatSystem } from '../../src/game/systems/companionCombatSystem.js';
import { floor3WildTargetRedirectSystem } from '../../src/game/systems/floor3WildTargetRedirectSystem.js';
import { floor3NonCombatantSystem } from '../../src/game/systems/floor3NonCombatantSystem.js';
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

    expect(world.stores.health.current[trash]).toBeLessThan(100);
    expect(world.combatEvents).toContainEqual(
      expect.objectContaining({ type: 'hit', sourceEid: companion, targetEid: trash }),
    );
  });

  it('redirects trash mobs to the selected companion instead of the player', () => {
    const world = createTestWorld({ floor: 3 });
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
