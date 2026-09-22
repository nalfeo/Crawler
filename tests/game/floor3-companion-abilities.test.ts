import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, EnemyProjectile, Team } from '../../src/core/components.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { setCompanionAIDecision } from '../../src/game/systems/companionAISystem.js';
import {
  companionCombatSystem,
  _getCompanionAttackState,
} from '../../src/game/systems/companionCombatSystem.js';
import { TeamId } from '../../src/shared/constants.js';
import { speciesTokenForId } from '../../src/shared/data/floor3/species.js';
import { createTestWorld } from '../helpers/world-factory.js';

function encounter(level = 1, ranged = false) {
  const world = createTestWorld({ floor: 3 });
  world.floorId = 'floor3';
  spawnPlayer(world, 20, 0);
  const companion = spawnBehaviorEnemy(
    world,
    0,
    0,
    100,
    ranged ? AI_TYPE.RANGED : AI_TYPE.CHASE,
    0.1,
    48,
    ranged ? 10 : 0,
  );
  addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
  addComponent(
    world.ecs,
    companion,
    set(Companion, {
      speciesToken: speciesTokenForId(ranged ? 'ember-slinger' : 'ember-charger'),
      form: level >= 25 ? 2 : level >= 10 ? 1 : 0,
      level,
      xp: 0,
      ownerTeam: TeamId.PLAYER,
      knockedOut: 0,
    }),
  );
  const target = spawnBehaviorEnemy(world, 2, 0, 10000, AI_TYPE.CHASE, 0.1, 48, 0);
  addComponent(world.ecs, target, set(Team, { id: TeamId.ENEMY }));
  setCompanionAIDecision(world, companion, {
    x: 2,
    y: 0,
    kind: 'rival-primary',
    targetEid: target,
    bypassPlayerDetection: true,
  });
  return { world, companion, target };
}

describe('Floor 3 automatic companion techniques', () => {
  it('unlocks a real automatic attack without input and preserves the preceding recovery', () => {
    const { world, companion, target } = encounter();
    companionCombatSystem(world);
    expect(world.stores.health.current[target]).toBe(9970);
    world.stores.companion.level[companion] = 8;
    world.elapsedMs = 624;
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)?.successfulAttacks).toBe(1);
    world.elapsedMs = 625;
    companionCombatSystem(world);
    expect(world.stores.health.current[target]).toBe(9937);
    expect(_getCompanionAttackState(world, companion)).toMatchObject({
      lastAbilityId: 'f3.ember-charger.l8',
      successfulAttacks: 2,
      cooldownMs: 562.5,
    });
    world.elapsedMs += 562.5;
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)?.lastAbilityId).toBe('f3.ember-charger.l1');
  });

  it('replays every learned technique and its actual damage deterministically', () => {
    function replay() {
      const { world, companion, target } = encounter(34);
      const result: Array<{ ability: string | undefined; damage: number; cooldown: number }> = [];
      for (let i = 0; i < 10; i++) {
        const health = world.stores.health.current[target]!;
        companionCombatSystem(world);
        const attack = _getCompanionAttackState(world, companion)!;
        result.push({
          ability: attack.lastAbilityId,
          damage: health - world.stores.health.current[target]!,
          cooldown: attack.cooldownMs,
        });
        world.elapsedMs += attack.cooldownMs;
      }
      return result;
    }
    const first = replay();
    expect(replay()).toEqual(first);
    expect(first.slice(0, 5).map((attack) => attack.ability)).toEqual(
      [1, 8, 16, 25, 34].map((level) => `f3.ember-charger.l${level}`),
    );
    expect(first.slice(5)).toEqual(first.slice(0, 5));
    expect(first[0]!.damage).toBeCloseTo(72, 2);
    expect(first[4]!.damage).toBeCloseTo(129.6, 2);
  });

  it('does not consume a technique or cooldown while out of range, dead, or knocked out', () => {
    const { world, companion, target } = encounter(25);
    world.stores.position.x[target] = 20;
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)).toBeUndefined();
    world.stores.position.x[target] = 2;
    world.stores.health.current[companion] = 0;
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)).toBeUndefined();
    world.stores.health.current[companion] = 1;
    world.stores.companion.knockedOut[companion] = 1;
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)).toBeUndefined();
    world.stores.companion.knockedOut[companion] = 0;
    world.stores.health.current[target] = 0;
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)).toBeUndefined();
    world.stores.health.current[target] = 10000;
    addComponent(
      world.ecs,
      target,
      set(Companion, {
        speciesToken: speciesTokenForId('stone-charger'),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.ENEMY,
        knockedOut: 1,
      }),
    );
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)).toBeUndefined();
    world.stores.companion.knockedOut[target] = 0;
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)).toMatchObject({
      successfulAttacks: 1,
      lastAbilityId: 'f3.ember-charger.l1',
    });
  });

  it('scales melee reach on evolution without turning melee companions into projectile attackers', () => {
    const { world, companion, target } = encounter();
    world.stores.position.x[target] = 4;
    companionCombatSystem(world);
    expect(world.stores.health.current[target]).toBe(10000);
    world.stores.companion.level[companion] = 25;
    world.stores.companion.form[companion] = 2;
    companionCombatSystem(world);
    expect(world.stores.health.current[target]).toBe(9928);
    expect(world.stores.enemyBehavior.attackRange[companion]).toBe(0);
    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
  });

  it('puts evolved and learned attack damage into the actual ranged projectile', () => {
    const { world, companion, target } = encounter(25, true);
    companionCombatSystem(world);
    world.elapsedMs += _getCompanionAttackState(world, companion)!.cooldownMs;
    companionCombatSystem(world);
    const shots = query(world.ecs, [EnemyProjectile]);
    expect(shots).toHaveLength(2);
    expect(world.stores.damage.amount[shots[0]!]).toBeCloseTo(72);
    expect(world.stores.damage.amount[shots[1]!]).toBeCloseTo(79.2);
    expect(world.stores.health.current[target]).toBe(10000);
  });

  it('does not let a recycled entity generation inherit its previous attack rotation or recovery', () => {
    const { world, companion } = encounter(34);
    companionCombatSystem(world);
    world.entityRenderGeneration[companion] = (world.entityRenderGeneration[companion] ?? 0) + 1;
    expect(_getCompanionAttackState(world, companion)).toBeUndefined();
    companionCombatSystem(world);
    expect(_getCompanionAttackState(world, companion)).toMatchObject({
      successfulAttacks: 1,
      lastAbilityId: 'f3.ember-charger.l1',
    });
  });

  it('keeps adult Floor 4 companions on their existing damage and cadence', () => {
    const { world, companion, target } = encounter(34);
    world.floorId = 'floor4';
    for (let i = 0; i < 5; i++) {
      companionCombatSystem(world);
      expect(_getCompanionAttackState(world, companion)).toMatchObject({
        cooldownMs: 625,
        lastAbilityId: undefined,
      });
      world.elapsedMs += 625;
    }
    expect(world.stores.health.current[target]).toBe(9950);
  });
});
