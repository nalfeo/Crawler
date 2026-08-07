import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { SkillHolder } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import {
  abilitySystem,
  equipActiveAbility,
  getOrCreateAbilityState,
  memorizeSpell,
  queueAbilityTrigger,
} from '../../src/game/systems/index.js';
import { forceActivateAbility } from '../../src/game/systems/abilitySystem.js';
import { pushAbilityActivationEvent } from '../../src/shared/ability-activation-events.js';
import type { AbilityActivationEvent } from '../../src/shared/ability-activation-events.js';
import { createTestWorld } from '../helpers/world-factory.js';

function setupPlayer(x = 0, y = 0) {
  const world = createTestWorld();
  const player = spawnPlayer(world, x, y);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);
  getOrCreateAbilityState(world, player);
  return { world, player };
}

function hitsLanded(world: ReturnType<typeof setupPlayer>['world'], player: number): void {
  queueAbilityTrigger(world, {
    holderEid: player,
    kind: 'skill_usage',
    metric: 'hits_landed',
    amount: 10,
    skillId: 'swordsmanship',
  });
}

describe('ability-activation announcements', () => {
  it('announces a player active ability at the player position when it fires', () => {
    const { world, player } = setupPlayer(3, -2);
    equipActiveAbility(world, player, 'battle-focus');
    world.elapsedMs = 1234;
    world.frameCount = 100;

    hitsLanded(world, player);
    abilitySystem(world);

    expect(world.abilityActivations).toHaveLength(1);
    const event = world.abilityActivations[0]!;
    expect(event.abilityId).toBe('battle-focus');
    expect(event.label).toBe('Battle Focus');
    expect(event.kind).toBe('active');
    expect(event.holderEid).toBe(player);
    expect(event.x).toBeCloseTo(3);
    expect(event.y).toBeCloseTo(-2);
    expect(event.elapsedMs).toBe(1234);
  });

  it('does not announce when the activation is blocked by cooldown', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');

    world.frameCount = 100;
    hitsLanded(world, player);
    abilitySystem(world);
    expect(world.abilityActivations).toHaveLength(1);

    world.abilityActivations.length = 0;
    world.frameCount = 101;
    hitsLanded(world, player);
    abilitySystem(world);

    expect(world.abilityActivations).toHaveLength(0);
  });

  it('does not announce when a spell is blocked by the spells feature gate', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'fireball');
    world.featureUnlocks.spells = false;

    expect(forceActivateAbility(world, player, 'fireball')).toBe(false);
    expect(world.abilityActivations).toHaveLength(0);
  });

  it('announces force-fired abilities (lab hotbar path)', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'bless');

    expect(forceActivateAbility(world, player, 'bless')).toBe(true);
    expect(world.abilityActivations.map((e) => e.abilityId)).toEqual(['bless']);
    expect(world.abilityActivations[0]!.kind).toBe('spell');
  });

  it('stays player-only — a non-player holder never announces', () => {
    const { world } = setupPlayer();
    const enemy = spawnEnemy(world, 5, 5, 100);
    getOrCreateAbilityState(world, enemy);
    equipActiveAbility(world, enemy, 'battle-focus');

    expect(forceActivateAbility(world, enemy, 'battle-focus')).toBe(true);
    expect(world.abilityActivations).toHaveLength(0);
  });

  it('caps the queue so an unconsumed (headless) run cannot grow it without bound', () => {
    const events: AbilityActivationEvent[] = [];
    for (let i = 0; i < 100; i++) {
      pushAbilityActivationEvent(events, {
        abilityId: `ability-${i}`,
        label: `Ability ${i}`,
        kind: 'active',
        category: 'combat',
        holderEid: 1,
        x: 0,
        y: 0,
        elapsedMs: i,
      });
    }

    expect(events).toHaveLength(32);
    // Oldest dropped, newest retained.
    expect(events[events.length - 1]!.abilityId).toBe('ability-99');
  });
});
