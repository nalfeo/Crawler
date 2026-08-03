import { describe, it, expect } from 'vitest';
import { addComponent } from 'bitecs';
import { SkillHolder } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import type { SkillState } from '../../src/game/skills/types.js';
import { pushFloaterEvent, type FloaterEvent } from '../../src/shared/floater-events.js';

function freshSkillState(): SkillState {
  return { level: 0, usage: 0, itemBonus: 0, triggeredMilestones: new Set() };
}

function setupPlayerWithSkill(x = 7, y = 11) {
  const world = createTestWorld();
  const player = spawnPlayer(world, x, y);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);

  const state = freshSkillState();
  world.playerSkills.set('swordsmanship', state);
  world.skillStatesByEntity.set(player, new Map([['swordsmanship', state]]));
  return { world, player, state };
}

describe('skill level-up floater', () => {
  it('emits a "+1 <skill>" floater at the player when a skill levels up', () => {
    const { world } = setupPlayerWithSkill();
    // swordsmanship threshold for level 1 is 15 hits
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 15 });
    skillSystem(world);

    expect(world.floaterEvents).toHaveLength(1);
    expect(world.floaterEvents[0]).toMatchObject({
      kind: 'skillLevelUp',
      label: '+1 Swordsmanship',
      x: 7,
      y: 11,
    });
  });

  it('emits one floater per level gained in a single frame', () => {
    const { world } = setupPlayerWithSkill();
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 260 });
    skillSystem(world);

    const state = world.playerSkills.get('swordsmanship')!;
    expect(state.level).toBe(5);
    expect(world.floaterEvents).toHaveLength(5);
  });

  it('emits no floater when usage does not cross a threshold', () => {
    const { world } = setupPlayerWithSkill();
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 1 });
    skillSystem(world);
    expect(world.floaterEvents).toHaveLength(0);
  });

  it('does not emit a floater for a non-player skill holder', () => {
    const { world } = setupPlayerWithSkill();
    const mob = spawnEnemy(world, 20, 20, 10);
    addComponent(world.ecs, mob, SkillHolder);
    world.skillStatesByEntity.set(mob, new Map([['swordsmanship', freshSkillState()]]));

    world.skillUsageEvents.push({
      holderEid: mob,
      skillId: 'swordsmanship',
      metric: 'hits_landed',
      amount: 15,
    });
    skillSystem(world);

    expect(world.skillStatesByEntity.get(mob)!.get('swordsmanship')!.level).toBe(1);
    expect(world.floaterEvents).toHaveLength(0);
  });

  it('caps the floater queue so an undrained headless run cannot grow unbounded', () => {
    const events: FloaterEvent[] = [];
    const cap = 128;
    for (let i = 0; i < cap + 10; i++) {
      pushFloaterEvent(events, { kind: 'skillLevelUp', x: 0, y: 0, label: `+1 ${i}` });
    }
    expect(events).toHaveLength(cap);
    expect(events[events.length - 1]!.label).toBe(`+1 ${cap + 9}`);
  });
});
