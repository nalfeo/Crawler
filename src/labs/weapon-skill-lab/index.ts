/**
 * Weapon Skill Lab — visualises weapon class/type skill progression and accuracy.
 *
 * Shows for each weapon def:
 *  - weaponClassSkillId + level
 *  - weaponTypeSkillId + level
 *  - baseAccuracy + computed effective accuracy at current stat
 *
 * Controls let you simulate weapon fires and watch skills level up.
 */
import GUI from 'lil-gui';
import { addComponent } from 'bitecs';
import { SkillHolder } from '../../core/components.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/helpers.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { statSystem } from '../../core/systems/index.js';
import { WEAPON_DEFS } from '../../shared/weaponDefs.js';
import {
  WEAPON_CLASS_SKILL_IDS,
  WEAPON_TYPE_SKILL_IDS,
  CLASS_SKILL_THRESHOLDS,
  TYPE_SKILL_THRESHOLDS,
} from '../../shared/weapon-skills.js';
import { getAllSkillDefinitions } from '../../game/skills/registry.js';
import { SKILL_HARD_CAP, SKILL_NATURAL_CAP, type SkillState } from '../../game/skills/types.js';
import { emitWeaponSkillEvents, computeEffectiveAccuracy } from '../../game/weaponSystem.js';
import { skillSystem } from '../../game/systems/index.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createWeaponSkillLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.cssText =
    'width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;';
  canvasHost.append(root);

  const allDefs = Array.from(WEAPON_DEFS.values());
  const allSkills = getAllSkillDefinitions();

  let world: GameWorld;
  let player = -1;
  let selectedWeaponId = allDefs[0]?.id ?? 'sword';
  let simulatedFireCount = 0;

  function reset(): void {
    world = createGameWorld({ seed: 42 });
    player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    addComponent(world.ecs, player, SkillHolder);
    statSystem(world);

    const skillMap = new Map<string, SkillState>();
    for (const skill of allSkills) {
      skillMap.set(skill.id, {
        level: 0,
        usage: 0,
        itemBonus: 0,
        triggeredMilestones: new Set(),
      });
    }
    world.playerSkills = skillMap;
    world.skillStatesByEntity.set(player, skillMap);

    simulatedFireCount = 0;
    render();
  }

  function simulateFires(n: number): void {
    const def = WEAPON_DEFS.get(selectedWeaponId);
    if (!def) return;
    for (let i = 0; i < n; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
      statSystem(world);
    }
    simulatedFireCount += n;
    render();
  }

  function render(): void {
    const def = WEAPON_DEFS.get(selectedWeaponId);
    if (!def) return;

    const classState = world.playerSkills.get(def.weaponClassSkillId);
    const typeState = world.playerSkills.get(def.weaponTypeSkillId);
    const effectiveAccuracy = computeEffectiveAccuracy(world, player, def);

    const classLevelCap = Math.min(
      SKILL_NATURAL_CAP + (classState?.itemBonus ?? 0),
      SKILL_HARD_CAP,
    );
    const typeLevelCap = Math.min(SKILL_NATURAL_CAP + (typeState?.itemBonus ?? 0), SKILL_HARD_CAP);

    const classNextThreshold =
      (classState?.level ?? 0) < classLevelCap
        ? (CLASS_SKILL_THRESHOLDS[classState?.level ?? 0] ?? '—')
        : 'Maxed';
    const typeNextThreshold =
      (typeState?.level ?? 0) < typeLevelCap
        ? (TYPE_SKILL_THRESHOLDS[typeState?.level ?? 0] ?? '—')
        : 'Maxed';

    // Build accuracy table for all weapons
    const accuracyRows = allDefs
      .map((d) => {
        const eff = computeEffectiveAccuracy(world, player, d);
        const highlight = d.id === selectedWeaponId ? 'color:#aef' : 'color:#888';
        return `<tr>
          <td style="padding:3px 8px;${highlight}">${d.name}</td>
          <td style="padding:3px 8px;text-align:center;${highlight}">${(d.baseAccuracy * 100).toFixed(0)}%</td>
          <td style="padding:3px 8px;text-align:center;${highlight}">${(eff * 100).toFixed(1)}%</td>
          <td style="padding:3px 8px;color:#888">${d.weaponClassSkillId}</td>
          <td style="padding:3px 8px;color:#888">${d.weaponTypeSkillId}</td>
        </tr>`;
      })
      .join('');

    root.innerHTML = `
      <h2 style="color:#f0a;margin-bottom:12px">Weapon Skill Lab</h2>

      <div style="background:#1a1a28;border-radius:6px;padding:16px;margin-bottom:16px">
        <div style="font-size:14px;color:#aaa;margin-bottom:8px">
          Simulated fires: <strong style="color:#fff">${simulatedFireCount}</strong>
          &nbsp;|&nbsp; Weapon: <strong style="color:#aef">${def.name}</strong>
          &nbsp;|&nbsp; Effective accuracy: <strong style="color:${effectiveAccuracy >= 0.9 ? '#4f8' : '#fa4'}">${(effectiveAccuracy * 100).toFixed(1)}%</strong>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px">
          <div>
            <div style="color:#f80;font-weight:bold;margin-bottom:6px">CLASS SKILL</div>
            <div style="color:#fff;font-size:16px">${def.weaponClassSkillId.toUpperCase()}</div>
            <div style="color:#aaa">Level <strong style="color:#aef">${classState?.level ?? 0}</strong> / ${classLevelCap}</div>
            <div style="color:#666;margin-top:4px">Usage: ${classState?.usage ?? 0} / ${classNextThreshold}</div>
            <div style="color:#4f8;margin-top:2px">+2 damage/level</div>
            <div style="background:#111;border-radius:4px;padding:8px;margin-top:8px">
              <div style="background:#333;border-radius:2px;overflow:hidden;height:6px">
                <div style="background:#f80;height:100%;width:${Math.min(100, ((classState?.usage ?? 0) / (typeof classNextThreshold === 'number' ? classNextThreshold : 1)) * 100)}%"></div>
              </div>
            </div>
          </div>
          <div>
            <div style="color:#08f;font-weight:bold;margin-bottom:6px">TYPE SKILL</div>
            <div style="color:#fff;font-size:16px">${def.weaponTypeSkillId.toUpperCase()}</div>
            <div style="color:#aaa">Level <strong style="color:#aef">${typeState?.level ?? 0}</strong> / ${typeLevelCap}</div>
            <div style="color:#666;margin-top:4px">Usage: ${typeState?.usage ?? 0} / ${typeNextThreshold}</div>
            <div style="color:#4f8;margin-top:2px">+3% accuracy/level</div>
            <div style="background:#111;border-radius:4px;padding:8px;margin-top:8px">
              <div style="background:#333;border-radius:2px;overflow:hidden;height:6px">
                <div style="background:#08f;height:100%;width:${Math.min(100, ((typeState?.usage ?? 0) / (typeof typeNextThreshold === 'number' ? typeNextThreshold : 1)) * 100)}%"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style="background:#1a1a28;border-radius:6px;padding:12px;margin-bottom:16px">
        <div style="font-size:13px;color:#aaa;margin-bottom:8px">
          All Weapons — Accuracy Overview
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="color:#666;font-size:11px">
              <th style="text-align:left;padding:3px 8px">Weapon</th>
              <th style="text-align:center;padding:3px 8px">Base</th>
              <th style="text-align:center;padding:3px 8px">Effective</th>
              <th style="text-align:left;padding:3px 8px">Class</th>
              <th style="text-align:left;padding:3px 8px">Type</th>
            </tr>
          </thead>
          <tbody>${accuracyRows}</tbody>
        </table>
      </div>

      <div style="background:#1a1a28;border-radius:6px;padding:12px">
        <div style="font-size:13px;color:#aaa;margin-bottom:8px">Skill State Summary</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <div style="color:#f80;margin-bottom:4px">Class Skills</div>
            ${WEAPON_CLASS_SKILL_IDS.map((id) => {
              const s = world.playerSkills.get(id);
              return `<div style="color:${(s?.level ?? 0) > 0 ? '#fff' : '#555'};padding:2px 0">
                ${id}: <strong>Lv${s?.level ?? 0}</strong>
                <span style="color:#555">(${s?.usage ?? 0})</span>
              </div>`;
            }).join('')}
          </div>
          <div>
            <div style="color:#08f;margin-bottom:4px">Type Skills</div>
            ${WEAPON_TYPE_SKILL_IDS.map((id) => {
              const s = world.playerSkills.get(id);
              return `<div style="color:${(s?.level ?? 0) > 0 ? '#fff' : '#555'};padding:2px 0">
                ${id}: <strong>Lv${s?.level ?? 0}</strong>
                <span style="color:#555">(${s?.usage ?? 0})</span>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // GUI controls
  const params = {
    weapon: selectedWeaponId,
    fire1: () => simulateFires(1),
    fire10: () => simulateFires(10),
    fire100: () => simulateFires(100),
    floorSim: () => simulateFires(200),
    reset: () => reset(),
  };

  const weaponOptions = Object.fromEntries(allDefs.map((d) => [d.name, d.id]));
  gui
    .add(params, 'weapon', weaponOptions)
    .name('Weapon')
    .onChange((v: string) => {
      selectedWeaponId = v;
      render();
    });
  gui.add(params, 'fire1').name('Fire ×1');
  gui.add(params, 'fire10').name('Fire ×10');
  gui.add(params, 'fire100').name('Fire ×100');
  gui.add(params, 'floorSim').name('Simulate Floor 1 (~200)');
  gui.add(params, 'reset').name('Reset');

  reset();

  return () => {
    root.remove();
  };
}

registerLab('weapon-skill-lab', {
  name: 'Weapon Skills',
  description: 'Visualises weapon class/type skill progression and accuracy system.',
  category: 'Progression',
  create: createWeaponSkillLab,
});
