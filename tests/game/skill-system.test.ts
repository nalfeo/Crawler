import { describe, it, expect } from 'vitest';
import { addComponent } from 'bitecs';
import { SkillHolder } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import type { SkillState } from '../../src/game/skills/types.js';

function setupPlayerWithSkill() {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);

  // Register 'swordsmanship' skill state
  const state: SkillState = {
    level: 0,
    usage: 0,
    itemBonus: 0,
    triggeredMilestones: new Set(),
  };
  world.playerSkills.set('swordsmanship', state);
  world.skillStatesByEntity.set(player, new Map([['swordsmanship', state]]));
  return { world, player };
}

function setupPlayerWithSkillState(skillId: string) {
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
  world.playerSkills.set(skillId, state);
  world.skillStatesByEntity.set(player, new Map([[skillId, state]]));
  return { world, player };
}

describe('skillSystem', () => {
  it('does nothing when no usage events', () => {
    const { world } = setupPlayerWithSkill();
    expect(() => skillSystem(world)).not.toThrow();
    expect(world.playerSkills.get('swordsmanship')!.level).toBe(0);
  });

  it('clears usage events each frame', () => {
    const { world } = setupPlayerWithSkill();
    const eventsRef = world.skillUsageEvents;
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 5 });
    skillSystem(world);
    expect(world.skillUsageEvents).toHaveLength(0);
    expect(world.skillUsageEvents).toBe(eventsRef);
  });

  it('ignores events for unknown skills', () => {
    const { world } = setupPlayerWithSkill();
    world.skillUsageEvents.push({ skillId: 'unknown-skill', metric: 'hits_landed', amount: 100 });
    expect(() => skillSystem(world)).not.toThrow();
  });

  it('ignores events when skill state exists but skill definition is missing', () => {
    const { world } = setupPlayerWithSkillState('missing-definition');
    const state = world.playerSkills.get('missing-definition')!;
    world.skillUsageEvents.push({
      skillId: 'missing-definition',
      metric: 'hits_landed',
      amount: 100,
    });
    skillSystem(world);
    expect(state.level).toBe(0);
    expect(state.usage).toBe(0);
  });

  it('ignores events when usage metric does not match skill definition', () => {
    const { world } = setupPlayerWithSkill();
    const state = world.playerSkills.get('swordsmanship')!;
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'damage_dealt', amount: 100 });
    skillSystem(world);
    expect(state.level).toBe(0);
    expect(state.usage).toBe(0);
  });

  it('accumulates usage and levels up when threshold crossed', () => {
    const { world } = setupPlayerWithSkill();
    // swordsmanship threshold for level 1 is 15 hits
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 15 });
    skillSystem(world);
    expect(world.playerSkills.get('swordsmanship')!.level).toBe(1);
  });

  it('adds per-level modifier on level-up', () => {
    const { world } = setupPlayerWithSkill();
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 15 });
    skillSystem(world);
    // swordsmanship perLevelBonus is { damage: 1 }
    const damageModifiers = world.statModifiers.filter(
      (m) => m.stat === 'damage' && m.sourceId.startsWith('swordsmanship:level:'),
    );
    expect(damageModifiers.length).toBeGreaterThan(0);
    expect(damageModifiers[0]!.value).toBe(1);
  });

  it('does not exceed naturalCap (15) without itemBonus', () => {
    const { world } = setupPlayerWithSkill();
    const state = world.playerSkills.get('swordsmanship')!;
    // Set usage to way beyond max threshold
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 99999 });
    skillSystem(world);
    expect(state.level).toBeLessThanOrEqual(15);
  });

  it('can exceed naturalCap up to hardCap with itemBonus', () => {
    const { world } = setupPlayerWithSkill();
    const state = world.playerSkills.get('swordsmanship')!;
    state.itemBonus = 5; // allows up to level 20
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 99999 });
    skillSystem(world);
    expect(state.level).toBeLessThanOrEqual(20);
    expect(state.level).toBeGreaterThan(15);
  });

  it('fires milestone at level 5 exactly once', () => {
    const { world, player } = setupPlayerWithSkill();
    const state = world.playerSkills.get('swordsmanship')!;
    // Enough to hit level 5 (threshold[4] = 260)
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 260 });
    skillSystem(world);
    expect(state.triggeredMilestones.has(5)).toBe(true);

    // swordsmanship L5 grants 'combat-flow' ability
    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState?.passiveAbilityIds).toContain('combat-flow');

    // Running again should not add another copy
    const countBefore = abilityState!.passiveAbilityIds.filter((id) => id === 'combat-flow').length;
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 1 });
    skillSystem(world);
    const countAfter = world.abilityStatesByEntity
      .get(player)!
      .passiveAbilityIds.filter((id) => id === 'combat-flow').length;
    expect(countAfter).toBe(countBefore);
  });

  it('grants passive ability at iron-skin level 5 milestone', () => {
    const { world, player } = setupPlayerWithSkillState('iron-skin');
    world.skillUsageEvents.push({ skillId: 'iron-skin', metric: 'damage_dealt', amount: 920 });
    skillSystem(world);

    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState).toBeDefined();
    expect(abilityState!.passiveAbilityIds).toContain('stalwart-resolve');
  });

  it('grants placeholder ability at iron-skin level 20 milestone', () => {
    const { world, player } = setupPlayerWithSkillState('iron-skin');
    const state = world.playerSkills.get('iron-skin')!;
    state.itemBonus = 5;

    world.skillUsageEvents.push({ skillId: 'iron-skin', metric: 'damage_dealt', amount: 16970 });
    skillSystem(world);

    expect(state.level).toBe(20);
    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState).toBeDefined();
    expect(abilityState!.passiveAbilityIds).toContain('placeholder-generic-l20');
  });

  it('uses per-entity skill states when holder eid is provided', () => {
    const { world, player } = setupPlayerWithSkill();
    const state = world.playerSkills.get('swordsmanship')!;
    state.level = 0;
    state.usage = 0;

    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'swordsmanship',
      metric: 'hits_landed',
      amount: 15,
    });
    skillSystem(world);
    expect(state.level).toBe(1);
    expect(world.statModifiers.some((m) => m.sourceId === `swordsmanship:level:1:${player}`)).toBe(
      true,
    );
  });

  it('keys milestone ability grants by holder eid', () => {
    const { world, player } = setupPlayerWithSkill();
    const state = world.playerSkills.get('swordsmanship')!;
    state.level = 0;
    state.usage = 0;

    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'swordsmanship',
      metric: 'hits_landed',
      amount: 260,
    });
    skillSystem(world);

    // swordsmanship L5 grants 'combat-flow' to the holder entity's ability state
    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState).toBeDefined();
    expect(abilityState!.passiveAbilityIds).toContain('combat-flow');
  });

  it('grants level-5 passive owned by skillAbilityGrantSourceId and is idempotent', () => {
    const { world, player } = setupPlayerWithSkillState('iron-skin');
    // iron-skin level 5 grants 'stalwart-resolve' passive via the L5 abilityId milestone
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'iron-skin',
      metric: 'damage_dealt',
      amount: 920, // enough to reach level 5
    });
    skillSystem(world);

    const abilityState = world.abilityStatesByEntity.get(player);
    expect(abilityState).toBeDefined();
    const ownership = abilityState!.grantOwnership;
    expect(ownership).toBeDefined();

    // The passive should be owned by the canonical skill-source ID.
    const expectedSourceId = `skill:iron-skin:5`;
    expect(ownership!.passiveSourcesByAbilityId.get('stalwart-resolve')).toEqual(
      new Set([expectedSourceId]),
    );
    expect(abilityState!.passiveAbilityIds).toContain('stalwart-resolve');

    // Running again must not add a second source entry (idempotent).
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'iron-skin',
      metric: 'damage_dealt',
      amount: 1,
    });
    skillSystem(world);

    expect(ownership!.passiveSourcesByAbilityId.get('stalwart-resolve')).toEqual(
      new Set([expectedSourceId]),
    );
  });
});
