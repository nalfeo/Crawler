import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { SkillHolder } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import { getSkillDefinition } from '../../src/game/skills/registry.js';
import type { SkillState } from '../../src/game/skills/types.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import {
  getWeaponSwingVfxSpec,
  weaponSwingVfxKindForPreset,
} from '../../src/shared/weapon-swing-vfx.js';
import { createTestWorld } from '../helpers/world-factory.js';

const WEAPON_SWING_SKILL_IDS = [
  'sword',
  'dagger',
  'hammer',
  'bow',
  'crossbow',
  'pistol',
  'throwing-weapons',
  'unarmed',
  'sports-equipment',
] as const;

function createSkillState(): SkillState {
  return {
    level: 0,
    usage: 0,
    itemBonus: 0,
    triggeredMilestones: new Set(),
  };
}

describe('weapon swing milestone VFX placeholders', () => {
  it('emits mapped placeholder VFX for every weapon-swing milestone ability', () => {
    for (const skillId of WEAPON_SWING_SKILL_IDS) {
      const skill = getSkillDefinition(skillId);
      expect(skill, `missing skill definition for ${skillId}`).toBeDefined();
      if (skill === undefined) continue;

      for (const milestone of skill.milestones) {
        const abilityId = milestone.abilityId;
        expect(
          abilityId,
          `missing abilityId for ${skillId} level ${milestone.level}`,
        ).toBeDefined();
        if (abilityId === undefined) continue;

        const spec = getWeaponSwingVfxSpec(abilityId);
        expect(spec, `missing weapon-swing VFX mapping for ${abilityId}`).toBeDefined();
        if (spec === undefined) continue;

        const world = createTestWorld();
        const player = spawnPlayer(world, 0, 0);
        initializeBaseStats(world, player);
        addComponent(world.ecs, player, SkillHolder);
        statSystem(world);

        const state = createSkillState();
        state.itemBonus = 5;
        world.playerSkills.set(skillId, state);
        world.skillStatesByEntity.set(player, new Map([[skillId, state]]));

        world.skillUsageEvents.push({
          holderEid: player,
          skillId,
          metric: skill.usageMetric,
          amount: skill.usageThresholds[milestone.level - 1] ?? 0,
        });
        skillSystem(world);

        const expectedKind = weaponSwingVfxKindForPreset(spec.preset);
        expect(
          world.vfxEvents.some(
            (event) => event.kind === expectedKind && event.color === spec.color,
          ),
          `expected ${expectedKind} event for ${abilityId}`,
        ).toBe(true);
      }
    }
  });
});
