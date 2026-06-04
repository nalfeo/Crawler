import GUI from 'lil-gui';
import { addComponent } from 'bitecs';
import { Stats, SkillHolder } from '../../core/components.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/helpers.js';
import { statsSystem, spendPoints, addStatModifier } from '../../game/systems/statsSystem.js';
import { levelSystem } from '../../game/systems/levelSystem.js';
import { STAT_KEYS, STAT_BASE } from '../../shared/stats.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createStatsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.cssText = 'width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;';

  canvasHost.append(root);

  let world: GameWorld;
  let player: number;

  function reset() {
    world = createGameWorld({ seed: 1337 });
    player = spawnPlayer(world, 0, 0);
    addComponent(world.ecs, player, Stats);
    addComponent(world.ecs, player, SkillHolder);
    world.playerLevel.unspentPoints = 20;
    statsSystem(world);
    render();
  }

  function render() {
    const pl = world.playerLevel;
    const rows = STAT_KEYS.map((stat) => {
      const base = STAT_BASE[stat];
      const current = world.stores.stats[stat][player] ?? 0;
      const pts = world.stores.statPoints[stat][player] ?? 0;
      return `<tr>
        <td style="padding:4px 12px;color:#9ba">${stat}</td>
        <td style="padding:4px 12px;text-align:right;color:#888">${base.toFixed(2)}</td>
        <td style="padding:4px 12px;text-align:right;color:#aef">${pts}</td>
        <td style="padding:4px 12px;text-align:right;color:#4f8">${current.toFixed(2)}</td>
      </tr>`;
    }).join('');

    root.innerHTML = `
      <h2 style="color:#cde;margin:0 0 8px">Stats Lab</h2>
      <p style="color:#888;margin:0 0 16px">Level ${pl.level} | XP: ${pl.xp} | Unspent: ${pl.unspentPoints} pts</p>
      <table style="border-collapse:collapse;width:100%;max-width:600px">
        <thead><tr>
          <th style="text-align:left;padding:4px 12px;color:#aaa">Stat</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Base</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Points</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Final</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#666;margin-top:16px;font-size:11px">Use the controls panel to spend points or grant XP.</p>
    `;
  }

  const params = {
    targetStat: 'damage',
    pointsToSpend: 1,
    xpToGrant: 10,
    modifierValue: 5,
    reset,
  };

  gui.add(params, 'targetStat', STAT_KEYS).name('Stat');
  gui.add(params, 'pointsToSpend', 1, 20, 1).name('Points');
  gui.add(
    {
      spendPoints: () => {
        try {
          spendPoints(world, { [params.targetStat]: params.pointsToSpend });
          statsSystem(world);
          render();
        } catch (e) {
          console.warn('Cannot spend points:', e);
        }
      },
    },
    'spendPoints',
  ).name('Spend Points');

  gui.add(params, 'xpToGrant', 1, 200, 1).name('XP to Grant');
  gui.add(
    {
      grantXp: () => {
        world.playerLevel.xp += params.xpToGrant;
        levelSystem(world);
        statsSystem(world);
        render();
      },
    },
    'grantXp',
  ).name('Grant XP');

  gui.add(params, 'modifierValue', 1, 50, 1).name('Modifier Value');
  gui.add(
    {
      addMod: () => {
        addStatModifier(world, {
          sourceType: 'buff',
          sourceId: `lab-mod-${Date.now()}`,
          stat: params.targetStat as typeof STAT_KEYS[number],
          op: 'add',
          value: params.modifierValue,
        });
        statsSystem(world);
        render();
      },
    },
    'addMod',
  ).name('Add Modifier');

  gui.add(params, 'reset').name('Reset World');

  reset();

  const hint = document.createElement('p');
  hint.textContent = 'Inspect how stat points and modifiers interact. Use the GUI to allocate points, grant XP, or add temporary modifiers.';
  hint.style.cssText = 'margin-top:16px;color:#fbcfe8;line-height:1.6;';
  controls.append(hint);

  return () => {
    hint.remove();
    root.remove();
  };
}

registerLab('stats-lab', {
  name: 'Stats Lab',
  description: 'Inspect stat computation: base values, point allocations, and modifier stacking.',
  create: createStatsLab,
});
