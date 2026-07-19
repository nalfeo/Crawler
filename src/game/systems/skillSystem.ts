import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import type { StatKey } from '../../shared/stats.js';
import { SKILL_HARD_CAP, SKILL_NATURAL_CAP } from '../skills/types.js';
import { getSkillDefinition } from '../skills/registry.js';
import { addStatModifier } from './statsSystem.js';
import { applyCatalogEffect } from './progressionEffects.js';
import { grantPassiveAbility, queueAbilityTrigger } from './abilitySystem.js';
import { SKILL_LEVEL5_ABILITY_GRANTS } from '../abilities/registry.js';

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
    events.length = 0;
    return;
  }

  for (const event of events) {
    // v2 path: holder-scoped skills (players/mobs). v1 compatibility: playerSkills fallback.
    const holderSkills =
      event.holderEid !== undefined ? world.skillStatesByEntity.get(event.holderEid) : undefined;
    const state = holderSkills?.get(event.skillId) ?? world.playerSkills.get(event.skillId);
    if (state === undefined) continue;

    const def = getSkillDefinition(event.skillId);
    if (def === undefined) continue;

    if (event.metric !== def.usageMetric) continue;

    state.usage += event.amount;

    // Forward skill usage to ability system so abilities with skill_usage triggers fire
    queueAbilityTrigger(world, {
      holderEid: event.holderEid,
      kind: 'skill_usage',
      metric: event.metric,
      skillId: event.skillId,
      amount: event.amount,
    });

    const effectiveCap = Math.min(SKILL_NATURAL_CAP + state.itemBonus, SKILL_HARD_CAP);

    while (state.level < effectiveCap) {
      const nextLevel = state.level + 1;
      const threshold = def.usageThresholds[nextLevel - 1];
      if (threshold === undefined || state.usage < threshold) break;

      state.level = nextLevel;
      const sourceId =
        event.holderEid === undefined
          ? `${def.id}:level:${nextLevel}`
          : `${def.id}:level:${nextLevel}:${event.holderEid}`;

      for (const [statKey, bonus] of Object.entries(def.perLevelBonus)) {
        if (bonus === undefined || bonus === 0) continue;
        addStatModifier(world, {
          sourceType: 'skill',
          sourceId,
          stat: statKey as StatKey,
          op: 'add',
          value: bonus,
        });
      }

      if (
        (state.level === 5 || state.level === 10 || state.level === 15 || state.level === 20) &&
        !state.triggeredMilestones.has(state.level)
      ) {
        state.triggeredMilestones.add(state.level);
        applyMilestone(world, def.id, state.level, event.holderEid);

        // At level 5, also grant the corresponding passive ability (if any).
        // Uses holderEid from v2 holder-scoped events directly. For v1-style
        // events (no holderEid), falls back to the player entity so the milestone
        // is never consumed without the ability being granted. The fallback can be
        // removed once all skill-usage events are holder-scoped (v2 path only).
        if (state.level === 5) {
          const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get(def.id);
          if (abilityId !== undefined) {
            const targetEid = event.holderEid ?? query(world.ecs, [Player])[0];
            if (targetEid !== undefined) {
              grantPassiveAbility(world, targetEid, abilityId);
            }
          }
        }
      }
    }
  }

  events.length = 0;
}

function applyMilestone(
  world: GameWorld,
  skillId: string,
  level: number,
  holderEid?: number,
): void {
  const def = getSkillDefinition(skillId);
  if (def === undefined) return;

  const milestone = def.milestones.find((m) => m.level === level);
  if (milestone === undefined) return;

  applyCatalogEffect(world, {
    sourceType: 'skill',
    sourceId:
      holderEid === undefined
        ? `${skillId}:milestone:${level}`
        : `${skillId}:milestone:${level}:${holderEid}`,
    effect: milestone.effect,
  });
}
