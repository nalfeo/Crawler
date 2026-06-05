import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { SkillHolder, Stats } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../../src/game/abilities/types.js';
import {
  abilitySystem,
  equipActiveAbility,
  getOrCreateAbilityState,
  grantPassiveAbility,
  memorizeSpell,
  queueAbilityTrigger,
  statsSystem,
} from '../../src/game/systems/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

function setupPlayer() {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  addComponent(world.ecs, player, Stats);
  addComponent(world.ecs, player, SkillHolder);
  statsSystem(world);
  getOrCreateAbilityState(world, player);
  return { world, player };
}

describe('abilitySystem', () => {
  it('enforces max 10 active abilities equipped', () => {
    const { world, player } = setupPlayer();
    const state = world.abilityStatesByEntity.get(player)!;
    // Pre-fill slots directly to verify cap enforcement independently of catalog size.
    state.equippedActiveAbilityIds = Array.from({ length: ACTIVE_ABILITY_SLOT_LIMIT }, (_, i) =>
      i < ACTIVE_ABILITY_SLOT_LIMIT - 1 ? `ability-${i}` : 'battle-focus',
    );

    expect(() => equipActiveAbility(world, player, 'arcane-bolt')).toThrow(/slot cap/i);
  });

  it('allows unlimited passive grants and applies them once through stat modifiers', () => {
    const { world, player } = setupPlayer();
    const state = world.abilityStatesByEntity.get(player)!;

    for (let i = 0; i < 12; i++) {
      state.passiveAbilityIds.push(`custom-passive-${i}`);
    }

    grantPassiveAbility(world, player, 'veteran-instinct');
    abilitySystem(world);

    const applied = world.statModifiers.filter((m) => m.sourceId.startsWith('veteran-instinct:passive'));
    expect(applied).toHaveLength(2);

    const before = world.statModifiers.length;
    abilitySystem(world);
    expect(world.statModifiers).toHaveLength(before);
  });

  it('memorized spells are active abilities', () => {
    const { world, player } = setupPlayer();
    memorizeSpell(world, player, 'arcane-bolt');

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.equippedActiveAbilityIds).toContain('arcane-bolt');
  });

  it('triggers active ability when conditions match and enforces cooldown', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });

    world.frameCount = 100;
    const beforeFirst = world.statModifiers.length;
    abilitySystem(world);
    const afterFirst = world.statModifiers.filter((m) => m.sourceId === `battle-focus:active:${player}`);
    expect(world.statModifiers.length).toBe(beforeFirst + 1);
    expect(afterFirst).toHaveLength(1);

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });
    world.frameCount = 101;
    const beforeSecond = world.statModifiers.length;
    abilitySystem(world);
    const afterSecond = world.statModifiers.filter((m) => m.sourceId === `battle-focus:active:${player}`);
    expect(world.statModifiers.length).toBe(beforeSecond);
    expect(afterSecond).toHaveLength(1);

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });
    world.frameCount = 131;
    const beforeThird = world.statModifiers.length;
    abilitySystem(world);
    const afterThird = world.statModifiers.filter((m) => m.sourceId === `battle-focus:active:${player}`);
    expect(world.statModifiers.length).toBe(beforeThird);
    expect(afterThird).toHaveLength(1);
  });

  it('clears ability trigger events after processing', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });

    abilitySystem(world);
    expect(world.abilityTriggerEvents).toHaveLength(0);
  });
});
