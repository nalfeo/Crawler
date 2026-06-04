import type { GameWorld } from '../../core/world.js';
import { SKILL_HARD_CAP, SKILL_NATURAL_CAP } from '../skills/types.js';
import { getSkillDefinition } from '../skills/registry.js';
import { addStatModifier } from './statsSystem.js';

/**
 * Processes skill usage events each frame.
 * - Clears skillUsageEvents at the end of processing (events are single-frame)
 * - Levels up skills when cumulative usage crosses thresholds
 * - Fires milestones once (tracked in triggeredMilestones)
 * - Pushes permanent modifiers for per-level bonuses and milestones
 */
export function skillSystem(world: GameWorld): void {
  const events = world.skillUsageEvents;
  if (events.length === 0) {
    world.skillUsageEvents = [];
    return;
  }

  for (const event of events) {
    const state = world.playerSkills.get(event.skillId);
    if (state === undefined) continue;

    const def = getSkillDefinition(event.skillId);
    if (def === undefined) continue;

    state.usage += event.amount;

    const effectiveCap = Math.min(SKILL_NATURAL_CAP + state.itemBonus, SKILL_HARD_CAP);

    // Level up while thresholds are crossed and we haven't hit the cap
    while (state.level < effectiveCap) {
      const nextLevel = state.level + 1;
      const threshold = def.usageThresholds[nextLevel - 1];
      if (threshold === undefined || state.usage < threshold) break;

      state.level = nextLevel;
      world.statsDirty = true;

      // Apply per-level stat bonuses as permanent add modifiers
      for (const [statKey, bonus] of Object.entries(def.perLevelBonus)) {
        if (bonus === undefined || bonus === 0) continue;
        addStatModifier(world, {
          sourceType: 'skill',
          sourceId: `${def.id}:level:${nextLevel}`,
          stat: statKey as import('../../shared/stats.js').StatKey,
          op: 'add',
          value: bonus,
        });
      }

      // Fire milestones at levels 5, 10, 15, 20 — once only
      if (
        (state.level === 5 || state.level === 10 || state.level === 15 || state.level === 20) &&
        !state.triggeredMilestones.has(state.level)
      ) {
        state.triggeredMilestones.add(state.level);
        applyMilestone(world, def.id, state.level);
      }
    }
  }

  world.skillUsageEvents = [];
}

function applyMilestone(world: GameWorld, skillId: string, level: number): void {
  const def = getSkillDefinition(skillId);
  if (def === undefined) return;

  const milestone = def.milestones.find((m) => m.level === level);
  if (milestone === undefined) return;

  const effect = milestone.effect;
  const sourceId = `${skillId}:milestone:${level}`;

  switch (effect.type) {
    case 'stat_add':
      addStatModifier(world, {
        sourceType: 'skill',
        sourceId,
        stat: effect.stat,
        op: 'add',
        value: effect.value,
      });
      break;

    case 'stat_multiply':
      addStatModifier(world, {
        sourceType: 'skill',
        sourceId,
        stat: effect.stat,
        op: 'multiply',
        value: effect.value,
      });
      break;

    case 'extra_projectile':
      addStatModifier(world, {
        sourceType: 'skill',
        sourceId,
        stat: 'projectileCount',
        op: 'add',
        value: effect.count,
      });
      break;

    case 'aura':
      // Aura effect is stored as metadata — actual aura system reads modifiers later (v2)
      // For now, record it as a placeholder modifier so tests can verify it fired
      addStatModifier(world, {
        sourceType: 'skill',
        sourceId,
        stat: 'damage',
        op: 'add',
        value: 0,
      });
      break;
  }
}
