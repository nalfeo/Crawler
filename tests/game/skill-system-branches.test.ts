/**
 * skillSystem — additional branch coverage.
 *
 * The existing tests cover the holder-scoped (v2) level-up path, level-5
 * milestones, and bonus=0 guard at the source.  These tests fill gaps:
 *
 *  1. v1 fallback path (no holderEid on event): level-5 ability grant uses the
 *     first player entity as the target.
 *  2. v1 fallback when no player entity exists: grant is silently skipped.
 *  3. Milestone fires at level 10 (Double Strike: extra_projectile effect).
 *  4. Milestone fires at level 15 (Bladestorm: stat_multiply effect).
 */
import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { SkillHolder } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import type { SkillState } from '../../src/game/skills/types.js';
import { createTestWorld } from '../helpers/world-factory.js';

function setupPlayerWithIronSkin() {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);

  const state: SkillState = {
    level: 0,
    usage: 0,
    itemBonus: 0,
    triggeredMilestones: new Set(),
  };
  world.playerSkills.set('iron-skin', state);
  world.skillStatesByEntity.set(player, new Map([['iron-skin', state]]));
  return { world, player, state };
}

function setupPlayerWithSwordsmanship() {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);

  const state: SkillState = {
    level: 0,
    usage: 0,
    itemBonus: 0,
    triggeredMilestones: new Set(),
  };
  world.playerSkills.set('swordsmanship', state);
  world.skillStatesByEntity.set(player, new Map([['swordsmanship', state]]));
  return { world, player, state };
}

describe('skillSystem — v1 fallback path (no holderEid on event)', () => {
  it('grants level-5 passive ability via v1 fallback using the world player entity', () => {
    const { world, player, state } = setupPlayerWithIronSkin();

    // Omit holderEid → v1 path. threshold[4] = 920 for iron-skin.
    world.skillUsageEvents.push({
      skillId: 'iron-skin',
      metric: 'damage_dealt',
      amount: 920,
    });
    skillSystem(world);

    expect(state.level).toBe(5);

    // Ability should have been granted to the player via v1 fallback.
    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState).toBeDefined();
    expect(abilityState!.passiveAbilityIds).toContain('stalwart-resolve');
  });

  it('uses v1 sourceId format (no entity suffix) for the per-level stat modifier', () => {
    const { world, state } = setupPlayerWithIronSkin();

    world.skillUsageEvents.push({
      skillId: 'iron-skin',
      metric: 'damage_dealt',
      amount: 50, // level 1 only (threshold[0] = 50)
    });
    skillSystem(world);

    expect(state.level).toBe(1);
    // v1 sourceId has no entity suffix.
    const mod = world.statModifiers.find((m) => m.sourceId === 'iron-skin:level:1');
    expect(mod).toBeDefined();
  });

  it('safely skips the ability grant when no player entity exists', () => {
    // Build a world with a skill state but no player entity.
    const world = createTestWorld();
    const state: SkillState = {
      level: 0,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set(),
    };
    world.playerSkills.set('iron-skin', state);

    // threshold[4] = 920 for iron-skin level 5
    world.skillUsageEvents.push({
      skillId: 'iron-skin',
      metric: 'damage_dealt',
      amount: 920,
    });

    expect(() => skillSystem(world)).not.toThrow();
    expect(state.level).toBe(5);
    // No ability states should have been created.
    expect(world.abilityStatesByEntity.size).toBe(0);
  });
});

describe('skillSystem — milestone fires at levels 10 and 15', () => {
  it('fires the level-10 milestone (grants placeholder-generic-l10 ability) once', () => {
    const { world, player, state } = setupPlayerWithSwordsmanship();
    state.itemBonus = 5; // unlock levels up to 20

    // threshold[9] = 1060 for swordsmanship level 10.
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'swordsmanship',
      metric: 'hits_landed',
      amount: 1060,
    });
    skillSystem(world);

    expect(state.level).toBe(10);
    expect(state.triggeredMilestones.has(10)).toBe(true);

    // The L10 milestone grants 'placeholder-generic-l10' passive ability.
    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState).toBeDefined();
    expect(abilityState!.passiveAbilityIds).toContain('placeholder-generic-l10');
  });

  it('fires the level-15 milestone (grants placeholder-generic-l15, revokes L5 ability) once', () => {
    const { world, player, state } = setupPlayerWithSwordsmanship();
    state.itemBonus = 5;

    // threshold[14] = 2360 for swordsmanship level 15.
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'swordsmanship',
      metric: 'hits_landed',
      amount: 2360,
    });
    skillSystem(world);

    expect(state.level).toBe(15);
    expect(state.triggeredMilestones.has(15)).toBe(true);

    // The L15 milestone grants 'placeholder-generic-l15' and revokes the L5 'combat-flow'.
    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState).toBeDefined();
    expect(abilityState!.passiveAbilityIds).toContain('placeholder-generic-l15');
    expect(abilityState!.passiveAbilityIds).not.toContain('combat-flow');
  });

  it('does not fire a milestone twice even when the same event crosses the threshold again', () => {
    const { world, player, state } = setupPlayerWithSwordsmanship();
    state.itemBonus = 5;

    // Reach level 10 on the first frame.
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'swordsmanship',
      metric: 'hits_landed',
      amount: 1060,
    });
    skillSystem(world);

    const abilityStateAfterFirst = world.abilityStatesByEntity.get(player);
    const countAfterFirst =
      abilityStateAfterFirst?.passiveAbilityIds.filter((id) => id === 'placeholder-generic-l10')
        .length ?? 0;
    expect(countAfterFirst).toBe(1);

    // Manually rewind the level so the while-loop will try to re-enter level 10,
    // while keeping triggeredMilestones={10} and usage >= threshold.
    // This exercises the triggeredMilestones.has(level) === true branch directly.
    state.level = 9;

    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'swordsmanship',
      metric: 'hits_landed',
      amount: 1,
    });
    skillSystem(world);

    // The guard should have blocked the re-fire; still exactly 1 passive entry.
    const abilityStateAfterSecond = world.abilityStatesByEntity.get(player);
    const countAfterSecond =
      abilityStateAfterSecond?.passiveAbilityIds.filter((id) => id === 'placeholder-generic-l10')
        .length ?? 0;
    expect(countAfterSecond).toBe(1);
  });
});
