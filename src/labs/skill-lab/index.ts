import GUI from 'lil-gui';
import { addComponent } from 'bitecs';
import { SkillHolder } from '../../core/components.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/helpers.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { statSystem } from '../../core/systems/index.js';
import { getAllAbilityDefinitions } from '../../game/abilities/registry.js';
import { getAllSkillDefinitions } from '../../game/skills/registry.js';
import { SKILL_HARD_CAP, SKILL_NATURAL_CAP, type SkillState } from '../../game/skills/types.js';
import {
  abilitySystem,
  equipActiveAbility,
  getOrCreateAbilityState,
  grantPassiveAbility,
  memorizeSpell,
  queueAbilityTrigger,
  skillSystem,
  weaponPrerequisiteMet,
} from '../../game/systems/index.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createSkillLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.cssText =
    'width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;';
  canvasHost.append(root);

  const allSkills = getAllSkillDefinitions();
  const allAbilities = getAllAbilityDefinitions();
  const activeOrSpell = allAbilities.filter((a) => a.kind !== 'passive');
  const passives = allAbilities.filter((a) => a.kind === 'passive');
  let world: GameWorld;
  let player = -1;

  function reset() {
    world = createGameWorld({ seed: 777 });
    player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    addComponent(world.ecs, player, SkillHolder);
    statSystem(world);

    const skillStateById = new Map<string, SkillState>();
    for (const skill of allSkills) {
      const state: SkillState = {
        level: 0,
        usage: 0,
        itemBonus: 0,
        triggeredMilestones: new Set(),
      };
      world.playerSkills.set(skill.id, state);
      skillStateById.set(skill.id, state);
    }
    world.skillStatesByEntity.set(player, skillStateById);
    world.abilityStatesByEntity.set(player, getOrCreateAbilityState(world, player));

    render();
  }

  function render() {
    const abilityState = world.abilityStatesByEntity.get(player);
    const activeIds = abilityState?.equippedActiveAbilityIds ?? [];
    const passiveIds = abilityState?.passiveAbilityIds ?? [];

    const skillRows = allSkills
      .map((skill) => {
        const state = world.playerSkills.get(skill.id);
        if (!state) return '';
        const effectiveCap = Math.min(SKILL_NATURAL_CAP + state.itemBonus, SKILL_HARD_CAP);
        const nextThreshold =
          state.level < effectiveCap ? (skill.usageThresholds[state.level] ?? '—') : 'Maxed';
        const milestones = skill.milestones
          .map((m) => {
            const done = state.triggeredMilestones.has(m.level);
            return `<span style="color:${done ? '#4f8' : '#555'};margin-right:4px">${m.level}${done ? '✓' : '○'}</span>`;
          })
          .join('');

        // Show the level-5 ability grant (if any) and its prerequisite status.
        const abilityGrantId = skill.milestones.find((m) => m.level === 5)?.abilityId;
        const abilityGrantCell = abilityGrantId
          ? (() => {
              const abilityDef = allAbilities.find((a) => a.id === abilityGrantId);
              if (!abilityDef || abilityDef.kind !== 'passive') return '—';
              const granted = passiveIds.includes(abilityGrantId);
              const prereqMet = granted
                ? weaponPrerequisiteMet(world, player, abilityGrantId)
                : false;
              const prereq = abilityDef.weaponPrerequisite;
              const statusColor = !granted ? '#555' : prereqMet ? '#4f8' : '#fa0';
              const statusText = !granted ? '—' : prereqMet ? '✓ active' : `⚠ needs ${prereq}`;
              return `<span title="${abilityDef.description}" style="color:${statusColor}">${abilityDef.name} (${statusText})</span>`;
            })()
          : '—';

        return `
        <tr>
          <td style="padding:5px 10px;color:#9ba">${skill.name}</td>
          <td style="padding:5px 10px;text-align:center;color:#aef">${state.level}/${effectiveCap}</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${state.usage}</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${nextThreshold}</td>
          <td style="padding:5px 10px">${milestones}</td>
          <td style="padding:5px 10px;font-size:11px">${abilityGrantCell}</td>
        </tr>`;
      })
      .join('');

    const abilityRows = allAbilities
      .map((ability) => {
        const isActiveEquipped = activeIds.includes(ability.id);
        const isPassiveGranted = passiveIds.includes(ability.id);
        const cooldown = abilityState?.cooldownByAbilityId.get(ability.id);
        const remaining =
          cooldown === undefined || ability.kind === 'passive'
            ? undefined
            : Math.max(0, ability.cooldownFrames - (world.frameCount - cooldown));
        const cooldownText = remaining === undefined ? '—' : `${remaining}`;

        return `
        <tr>
          <td style="padding:5px 10px;color:#9ba">${ability.name}</td>
          <td style="padding:5px 10px;color:#8ab">${ability.kind}</td>
          <td style="padding:5px 10px;color:${isActiveEquipped || isPassiveGranted ? '#4f8' : '#666'}">${
            isActiveEquipped || isPassiveGranted ? 'yes' : 'no'
          }</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${cooldownText}</td>
        </tr>`;
      })
      .join('');

    root.innerHTML = `
      <h2 style="color:#cde;margin:0 0 8px">Skill + Ability Lab</h2>
      <p style="margin:0 0 12px;color:#89a">Active slots: ${activeIds.length}/10 • Passive grants: ${passiveIds.length}</p>
      <h3 style="margin:10px 0 6px;color:#bcd">Skill Catalog</h3>
      <p style="margin:0 0 8px;color:#678;font-size:11px">Lv5 Ability column: ✓ active = weapon equipped &amp; ability applied. ⚠ = ability unlocked but weapon not equipped.</p>
      <table style="border-collapse:collapse;width:100%;max-width:1000px;margin-bottom:14px">
        <thead><tr>
          <th style="text-align:left;padding:5px 10px;color:#aaa">Skill</th>
          <th style="padding:5px 10px;color:#aaa">Level</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Usage</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Next Threshold</th>
          <th style="padding:5px 10px;color:#aaa">Milestones</th>
          <th style="padding:5px 10px;color:#c9a;text-align:left">Lv5 Ability</th>
        </tr></thead>
        <tbody>${skillRows}</tbody>
      </table>
      <h3 style="margin:10px 0 6px;color:#bcd">Ability Catalog</h3>
      <table style="border-collapse:collapse;width:100%;max-width:860px">
        <thead><tr>
          <th style="text-align:left;padding:5px 10px;color:#aaa">Ability</th>
          <th style="padding:5px 10px;color:#aaa">Kind</th>
          <th style="padding:5px 10px;color:#aaa">Enabled</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Cooldown</th>
        </tr></thead>
        <tbody>${abilityRows}</tbody>
      </table>
    `;
  }

  const params = {
    selectedSkill: allSkills[0]!.id,
    metric: allSkills[0]!.usageMetric,
    usageAmount: 10,
    itemBonus: 0,
    selectedActiveAbility: activeOrSpell[0]?.id ?? '',
    selectedPassiveAbility: passives[0]?.id ?? '',
    selectedTriggerKind: 'skill_usage' as const,
    reset,
  };

  gui
    .add(
      params,
      'selectedSkill',
      allSkills.map((s) => s.id),
    )
    .name('Skill')
    .onChange((id: string) => {
      const def = allSkills.find((s) => s.id === id);
      params.metric = def?.usageMetric ?? 'hits_landed';
      render();
    });

  gui.add(params, 'usageAmount', 1, 500, 1).name('Usage Amount');

  gui
    .add(
      {
        fireUsage: () => {
          world.skillUsageEvents.push({
            holderEid: player,
            skillId: params.selectedSkill,
            metric: params.metric,
            amount: params.usageAmount,
          });
          world.frameCount += 1;
          skillSystem(world);
          abilitySystem(world);
          statSystem(world);
          render();
        },
      },
      'fireUsage',
    )
    .name('Fire Usage Event');

  gui
    .add(params, 'itemBonus', 0, 5, 1)
    .name('Item Bonus')
    .onChange((v: number) => {
      const state = world.playerSkills.get(params.selectedSkill);
      if (state) state.itemBonus = v;
      render();
    });

  if (activeOrSpell.length > 0) {
    gui
      .add(
        params,
        'selectedActiveAbility',
        activeOrSpell.map((a) => a.id),
      )
      .name('Active/Spell');

    gui
      .add(
        {
          equipActive: () => {
            const def = allAbilities.find((a) => a.id === params.selectedActiveAbility);
            if (!def) return;
            if (def.kind === 'spell') {
              memorizeSpell(world, player, def.id);
            } else {
              equipActiveAbility(world, player, def.id);
            }
            render();
          },
        },
        'equipActive',
      )
      .name('Equip Active/Spell');
  }

  if (passives.length > 0) {
    gui
      .add(
        params,
        'selectedPassiveAbility',
        passives.map((a) => a.id),
      )
      .name('Passive');

    gui
      .add(
        {
          grantPassive: () => {
            grantPassiveAbility(world, player, params.selectedPassiveAbility);
            abilitySystem(world);
            statSystem(world);
            render();
          },
        },
        'grantPassive',
      )
      .name('Grant Passive');
  }

  gui.add(params, 'selectedTriggerKind', ['skill_usage']).name('Trigger Kind');

  gui
    .add(
      {
        fireTrigger: () => {
          queueAbilityTrigger(world, {
            holderEid: player,
            kind: params.selectedTriggerKind,
            metric: params.metric,
            skillId: params.selectedSkill,
            amount: params.usageAmount,
          });
          world.frameCount += 1;
          abilitySystem(world);
          statSystem(world);
          render();
        },
      },
      'fireTrigger',
    )
    .name('Fire Ability Trigger');

  gui.add(params, 'reset').name('Reset World');

  reset();

  const hint = document.createElement('p');
  hint.textContent =
    'Catalog sandbox for skills and abilities — test usage progression, active slot limits, passive grants, and trigger cooldowns.';
  hint.style.cssText =
    'padding:8px 16px;color:#fbcfe8;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    root.remove();
    hint.remove();
  };
}

registerLab('skill-lab', {
  category: 'Progression' as LabCategory,
  name: 'Skill Lab',
  description:
    'Browse the skill and ability catalogs, simulate usage events, and inspect active/passive/cooldown behavior.',
  create: createSkillLab,
});
