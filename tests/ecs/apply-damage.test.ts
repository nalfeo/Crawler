import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Enemy, EffectiveStats, Health, Player } from '../../src/core/components.js';
import { applyDamage, DEFAULT_DAMAGE_OPTIONS } from '../../src/core/apply-damage.js';
import { createEntity } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';

/** Player-origin, unscaled (no typed-primary multiplier), crit-eligible — isolates crit/dodge from STR/INT scaling. */
const PLAYER_CRIT_OPTIONS = {
  origin: 'player' as const,
  affinity: 'unscaled' as const,
  scaleWithPrimary: false,
  canCrit: true,
};

describe('applyDamage', () => {
  it('reduces target HP by the requested amount', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 100, max: 100 }));

    const dealt = applyDamage(world, eid, 30, 10, 20, DEFAULT_DAMAGE_OPTIONS);

    expect(dealt).toBe(30);
    expect(world.stores.health.current[eid]).toBe(70);
  });
  it('clamps dealt damage to remaining HP (overkill)', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 15, max: 100 }));

    const dealt = applyDamage(world, eid, 50, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(dealt).toBe(15);
    expect(world.stores.health.current[eid]).toBe(0);
  });

  it('emits a CombatEvent with the actual dealt amount (not requested)', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 10, max: 100 }));

    applyDamage(world, eid, 25, 5, 7, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'hit',
      x: 5,
      y: 7,
      amount: 10, // clamped to remaining HP, not 25
      targetEid: eid,
    });
  });

  it('does not emit a CombatEvent when dealt damage is 0', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 0, max: 100 }));

    const dealt = applyDamage(world, eid, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(dealt).toBe(0);
    expect(world.combatEvents).toHaveLength(0);
  });

  it('sets targetType to "player" for Player entities', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, eid, Player);

    applyDamage(world, eid, 10, 1, 2, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents[0]!.targetType).toBe('player');
  });

  it('sets targetType to "enemy" for non-Player entities', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));

    applyDamage(world, eid, 10, 1, 2, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents[0]!.targetType).toBe('enemy');
  });

  it('includes timestamp from world.elapsedMs', () => {
    const world = createTestWorld();
    world.elapsedMs = 12345;
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));

    applyDamage(world, eid, 5, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents[0]!.timestamp).toBe(12345);
  });

  it('treats negative amount as a no-op', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));

    const dealt = applyDamage(world, eid, -10, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(dealt).toBe(0);
    expect(world.stores.health.current[eid]).toBe(50);
    expect(world.combatEvents).toHaveLength(0);
  });

  it('treats NaN amount as a no-op', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));

    const dealt = applyDamage(world, eid, NaN, 0, 0, DEFAULT_DAMAGE_OPTIONS);

    expect(dealt).toBe(0);
    expect(world.stores.health.current[eid]).toBe(50);
    expect(world.combatEvents).toHaveLength(0);
  });

  it('preserves sourceX/sourceY in the emitted CombatEvent', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));

    applyDamage(world, eid, 10, 5, 7, { ...DEFAULT_DAMAGE_OPTIONS, sourceX: 100, sourceY: 200 });

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      sourceX: 100,
      sourceY: 200,
    });
  });

  it('leaves sourceX/sourceY undefined when not provided', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));

    applyDamage(world, eid, 10, 5, 7, DEFAULT_DAMAGE_OPTIONS);

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]!.sourceX).toBeUndefined();
    expect(world.combatEvents[0]!.sourceY).toBeUndefined();
  });

  // --- Secondary-stat wiring (crit/dodge) gated on EffectiveStats ---

  it('lets a player with dodgeChance 1 fully avoid an incoming hit and emits a "dodge" event', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, EffectiveStats);
    world.stores.effectiveStats.dodgeChance[eid] = 1;

    const dealt = applyDamage(world, eid, 20, 3, 4, {
      origin: 'enemy',
      affinity: 'unscaled',
      scaleWithPrimary: false,
      canCrit: false,
    });

    expect(dealt).toBe(0);
    expect(world.stores.health.current[eid]).toBe(50); // unharmed
    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'dodge',
      targetType: 'player',
      amount: 0,
      targetEid: eid,
    });
  });

  it('scales player-sourced damage to an enemy by critMultiplier and flags isCrit when critChance is 1', () => {
    const world = createTestWorld();
    // The player singleton supplies the crit stats read by the choke point.
    const player = createEntity(world);
    addComponent(world.ecs, player, Player);
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.critChance[player] = 1;
    world.stores.effectiveStats.critMultiplier[player] = 2;
    // Enemy target takes the (crit-scaled) hit.
    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, enemy, Enemy);

    const dealt = applyDamage(world, enemy, 10, 1, 2, PLAYER_CRIT_OPTIONS);

    expect(dealt).toBe(20); // 10 * critMultiplier (2)
    expect(world.stores.health.current[enemy]).toBe(80);
    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'hit',
      targetType: 'enemy',
      amount: 20,
      isCrit: true,
    });
  });

  it('applies player flat and percent damage bonuses before crit resolution', () => {
    const world = createTestWorld();
    const player = createEntity(world);
    addComponent(world.ecs, player, Player);
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.damageBonus[player] = 2;
    world.stores.effectiveStats.damagePercent[player] = 0.5;
    world.stores.effectiveStats.critChance[player] = 1;
    world.stores.effectiveStats.critMultiplier[player] = 2;
    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Health, { current: 100, max: 100 }));
    addComponent(world.ecs, enemy, Enemy);

    const dealt = applyDamage(world, enemy, 10, 1, 2, PLAYER_CRIT_OPTIONS);

    expect(dealt).toBe(36); // ((10 + 2) * (1 + 0.5)) * 2
    expect(world.stores.health.current[enemy]).toBe(64);
    expect(world.combatEvents[0]).toMatchObject({ amount: 36, isCrit: true });
  });

  it('consumes no RNG when neither crit nor dodge applies (bare world without EffectiveStats)', () => {
    const control = createTestWorld();
    const world = createTestWorld(); // same default seed (42) as the control
    // Enemy target with no player/EffectiveStats in the world → crit branch skipped.
    const enemy = createEntity(world);
    addComponent(world.ecs, enemy, set(Health, { current: 50, max: 50 }));
    addComponent(world.ecs, enemy, Enemy);

    applyDamage(world, enemy, 10, 0, 0, PLAYER_CRIT_OPTIONS);

    // RNG stream untouched: the next roll matches a pristine world's first roll.
    expect(world.rng.next()).toBe(control.rng.next());
  });
});
