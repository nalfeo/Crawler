import { hasComponent, query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import type { StatKey } from '../../shared/stats.js';
import { SKILL_HARD_CAP, SKILL_NATURAL_CAP } from '../skills/types.js';
import { getSkillDefinition } from '../skills/registry.js';
import { addStatModifier } from './statsSystem.js';
import { grantAbilitySources, queueAbilityTrigger, revokeAbilitySources } from './abilitySystem.js';
import { getAbilityDefinition } from '../abilities/registry.js';
import { skillAbilityGrantSourceId, type AbilityGrantSourceId } from '../../shared/abilities.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';
import { pushAnnouncement } from '../../shared/announcement-events.js';
import { getAbilityPresentation } from '../../shared/ability-presentation.js';
import {
  getWeaponSwingVfxSpec,
  weaponSwingVfxKindForPreset,
} from '../../shared/weapon-swing-vfx.js';

/** How long the level-5 passive-unlock banner is shown, in milliseconds. */
const SKILL_PASSIVE_UNLOCK_ANNOUNCEMENT_MS = 2600;

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

  // Grant the ability defined on this milestone
  if (milestone.abilityId !== undefined) {
    const targetEid = holderEid ?? query(world.ecs, [Player])[0];
    if (targetEid !== undefined) {
      const sourceId = skillAbilityGrantSourceId(skillId, level);

      // Handle upgrade logic: L15 replaces L5, L20 replaces L10
      const revokeRequests: Array<{
        kind: 'passive';
        abilityId: string;
        sourceId: AbilityGrantSourceId;
      }> = [];
      if (level === 15) {
        const oldSourceId = skillAbilityGrantSourceId(skillId, 5);
        const oldMilestone = def.milestones.find((m) => m.level === 5);
        if (oldMilestone?.abilityId !== undefined) {
          revokeRequests.push({
            kind: 'passive',
            abilityId: oldMilestone.abilityId,
            sourceId: oldSourceId,
          });
        }
      } else if (level === 20) {
        const oldSourceId = skillAbilityGrantSourceId(skillId, 10);
        const oldMilestone = def.milestones.find((m) => m.level === 10);
        if (oldMilestone?.abilityId !== undefined) {
          revokeRequests.push({
            kind: 'passive',
            abilityId: oldMilestone.abilityId,
            sourceId: oldSourceId,
          });
        }
      }

      // Revoke the old ability(ies) first
      if (revokeRequests.length > 0) {
        revokeAbilitySources(world, targetEid, revokeRequests);
      }

      // Grant the new ability
      grantAbilitySources(world, targetEid, [
        {
          kind: 'passive',
          abilityId: milestone.abilityId,
          sourceId,
        },
      ]);

      // Player-only, one-time unlock feedback.
      if (hasComponent(world.ecs, targetEid, Player)) {
        const px = world.stores.position.x[targetEid] ?? 0;
        const py = world.stores.position.y[targetEid] ?? 0;
        const swingVfx = getWeaponSwingVfxSpec(milestone.abilityId);
        if (swingVfx !== undefined) {
          pushVfxEvent(world.vfxEvents, {
            kind: weaponSwingVfxKindForPreset(swingVfx.preset),
            x: px,
            y: py,
            color: swingVfx.color,
            intensity: swingVfx.intensity,
          });
        }

        const abilityDef = getAbilityDefinition(milestone.abilityId);
        const isGeneralPassive =
          abilityDef !== undefined &&
          abilityDef.kind === 'passive' &&
          abilityDef.weaponPrerequisite === undefined;

        if (isGeneralPassive && swingVfx === undefined) {
          pushVfxEvent(world.vfxEvents, { kind: 'abilityActivateFlash', x: px, y: py });
        }

        const presentation = getAbilityPresentation(milestone.abilityId);
        pushAnnouncement(world.announcements, {
          kind: 'skillPassiveUnlocked',
          archetypeIndex: -1,
          text: `Passive Unlocked: ${presentation?.name ?? milestone.abilityId}`,
          durationMs: SKILL_PASSIVE_UNLOCK_ANNOUNCEMENT_MS,
          elapsedMs: world.elapsedMs,
        });
      }
    }
  }
}
