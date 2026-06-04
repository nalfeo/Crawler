import GUI from 'lil-gui';
import { addComponent } from 'bitecs';
import { Stats, SkillHolder } from '../../core/components.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/helpers.js';
import { statsSystem } from '../../game/systems/statsSystem.js';
import { skillSystem } from '../../game/systems/skillSystem.js';
import { getAllSkillDefinitions } from '../../game/skills/registry.js';
import type { SkillState } from '../../game/skills/types.js';
import { SKILL_NATURAL_CAP, SKILL_HARD_CAP } from '../../game/skills/types.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createSkillLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.cssText = 'width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;';
  canvasHost.append(root);

  const allSkills = getAllSkillDefinitions();
  let world: GameWorld;
  let player: number;

  function reset() {
    world = createGameWorld({ seed: 777 });
    player = spawnPlayer(world, 0, 0);
    addComponent(world.ecs, player, Stats);
    addComponent(world.ecs, player, SkillHolder);
    statsSystem(world);

    for (const skill of allSkills) {
      const state: SkillState = {
        level: 0,
        usage: 0,
        itemBonus: 0,
        triggeredMilestones: new Set(),
      };
      world.playerSkills.set(skill.id, state);
    }

    render();
  }

  function render() {
    const modsBySkill: Record<string, number> = {};
    for (const m of world.statModifiers) {
      if (m.sourceId.startsWith('swordsmanship:') || m.sourceId.startsWith('iron-skin:') || m.sourceId.startsWith('sprint:')) {
        const key = m.sourceId.split(':')[0] ?? 'unknown';
        modsBySkill[key] = (modsBySkill[key] ?? 0) + 1;
      }
    }

    const rows = allSkills.map((skill) => {
      const state = world.playerSkills.get(skill.id);
      if (!state) return '';
      const effectiveCap = Math.min(SKILL_NATURAL_CAP + state.itemBonus, SKILL_HARD_CAP);
      const nextThreshold = state.level < effectiveCap ? (skill.usageThresholds[state.level] ?? '—') : 'Maxed';
      const milestones = skill.milestones.map((m) => {
        const done = state.triggeredMilestones.has(m.level);
        return `<span style="color:${done ? '#4f8' : '#555'};margin-right:4px">${m.level}${done ? '✓' : '○'}</span>`;
      }).join('');
      return `
        <tr>
          <td style="padding:5px 10px;color:#9ba">${skill.name}</td>
          <td style="padding:5px 10px;text-align:center;color:#aef">${state.level}/${effectiveCap}</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${state.usage}</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${nextThreshold}</td>
          <td style="padding:5px 10px">${milestones}</td>
          <td style="padding:5px 10px;text-align:right;color:#f8a">${modsBySkill[skill.id] ?? 0}</td>
        </tr>`;
    }).join('');

    root.innerHTML = `
      <h2 style="color:#cde;margin:0 0 8px">Skill Lab</h2>
      <table style="border-collapse:collapse;width:100%;max-width:800px">
        <thead><tr>
          <th style="text-align:left;padding:5px 10px;color:#aaa">Skill</th>
          <th style="padding:5px 10px;color:#aaa">Level</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Usage</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Next Threshold</th>
          <th style="padding:5px 10px;color:#aaa">Milestones</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Active Mods</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  const params = {
    selectedSkill: allSkills[0]!.id,
    metric: allSkills[0]!.usageMetric,
    usageAmount: 10,
    itemBonus: 0,
    reset,
  };

  gui.add(params, 'selectedSkill', allSkills.map((s) => s.id)).name('Skill').onChange((id: string) => {
    const def = allSkills.find((s) => s.id === id);
    params.metric = def?.usageMetric ?? 'hits_landed';
  });

  gui.add(params, 'usageAmount', 1, 500, 1).name('Usage Amount');

  gui.add(
    {
      fireUsage: () => {
        world.skillUsageEvents.push({
          skillId: params.selectedSkill,
          metric: params.metric as 'hits_landed' | 'damage_dealt' | 'distance_dodged_near_threat',
          amount: params.usageAmount,
        });
        skillSystem(world);
        statsSystem(world);
        render();
      },
    },
    'fireUsage',
  ).name('Fire Usage Event');

  gui.add(params, 'itemBonus', 0, 5, 1).name('Item Bonus').onChange((v: number) => {
    const state = world.playerSkills.get(params.selectedSkill);
    if (state) state.itemBonus = v;
    render();
  });

  gui.add(params, 'reset').name('Reset World');

  reset();

  const hint = document.createElement('p');
  hint.textContent = 'Skill progression sandbox — fire usage events to watch skills level up, trigger milestones, and apply stat modifiers.';
  hint.style.cssText = 'padding:8px 16px;color:#fbcfe8;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    root.remove();
    hint.remove();
  };
}

registerLab('skill-lab', {
  name: 'Skill Lab',
  description: 'Simulate skill usage events, watch skills level up through milestones, and inspect resulting stat modifiers.',
  create: createSkillLab,
});
