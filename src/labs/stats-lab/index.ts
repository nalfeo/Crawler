import GUI from 'lil-gui';
import { addComponent } from 'bitecs';
import { SkillHolder } from '../../core/components.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/helpers.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { statSystem } from '../../core/systems/index.js';
import { spendPoints, addStatModifier } from '../../game/systems/statsSystem.js';
import { levelSystem } from '../../game/systems/levelSystem.js';
import { PRIMARY_STATS, SECONDARY_STATS, STAT_KEYS, type StatKey } from '../../shared/stats.js';
import { PRIMARY_STAT_DISPLAY, formatCoreStatGains } from '../../shared/stat-display.js';
import { createLogger } from '../../shared/logger.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
const logger = createLogger('labs:stats');

function createStatsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.cssText =
    'width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;';

  canvasHost.append(root);

  let world: GameWorld;
  let player: number;

  function reset() {
    world = createGameWorld({ seed: 1337 });
    player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    addComponent(world.ecs, player, SkillHolder);
    world.playerLevel.unspentPoints = 20;
    statSystem(world);
    render();
  }

  function render() {
    const pl = world.playerLevel;

    // Core stat rows — what you allocate level-up points to, and their
    // per-effective-point payoff (typed-primary rate for STR/INT, derived
    // secondary rates for the rest — see formatCoreStatGains).
    const coreRows = PRIMARY_STATS.map((stat) => {
      const pts = world.stores.coreStatPoints[stat][player] ?? 0;
      const effective = world.stores.effectiveStats[stat][player] ?? 0;
      const gainsText = formatCoreStatGains(stat);
      return `<tr>
        <td style="padding:4px 12px;color:#fcd34d">${PRIMARY_STAT_DISPLAY[stat].label}</td>
        <td style="padding:4px 12px;text-align:right;color:#aef">${pts}</td>
        <td style="padding:4px 12px;text-align:right;color:#4f8">${effective.toFixed(2)}</td>
        <td style="padding:4px 12px;color:#888;font-size:11px">${gainsText}</td>
      </tr>`;
    }).join('');

    // EffectiveStats rows — the sole runtime stat snapshot (no separate
    // computed "Stats" component anymore).
    const derivedRows = SECONDARY_STATS.map((key) => {
      const current = world.stores.effectiveStats[key][player] ?? 0;
      return `<tr>
        <td style="padding:4px 12px;color:#9ba">${key}</td>
        <td style="padding:4px 12px;text-align:right;color:#4f8">${current.toFixed(4)}</td>
      </tr>`;
    }).join('');

    root.innerHTML = `
      <h2 style="color:#cde;margin:0 0 8px">Stats Lab</h2>
      <p style="color:#888;margin:0 0 16px">Level ${pl.level} | XP: ${pl.xp} | Unspent: ${pl.unspentPoints} pts</p>

      <h3 style="color:#fcd34d;margin:0 0 4px;font-size:13px">Core Stats (level-up allocation)</h3>
      <table style="border-collapse:collapse;width:100%;max-width:800px;margin-bottom:16px">
        <thead><tr>
          <th style="text-align:left;padding:4px 12px;color:#aaa">Core Stat</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Points</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Effective</th>
          <th style="text-align:left;padding:4px 12px;color:#aaa">Per-point payoff</th>
        </tr></thead>
        <tbody>${coreRows}</tbody>
      </table>

      <h3 style="color:#9ba;margin:0 0 4px;font-size:13px">Effective Stats (secondary, derived every frame)</h3>
      <table style="border-collapse:collapse;width:100%;max-width:600px">
        <thead><tr>
          <th style="text-align:left;padding:4px 12px;color:#aaa">Stat</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Value</th>
        </tr></thead>
        <tbody>${derivedRows}</tbody>
      </table>
      <p style="color:#666;margin-top:16px;font-size:11px">Use the controls panel to spend core stat points, grant XP, or add temporary legacy modifiers (folded into EffectiveStats).</p>
    `;
  }

  const params = {
    targetCoreStat: 'constitution' as (typeof PRIMARY_STATS)[number],
    pointsToSpend: 1,
    targetModStat: 'damage' as StatKey,
    xpToGrant: 10,
    modifierValue: 5,
    reset,
  };

  gui.add(params, 'targetCoreStat', PRIMARY_STATS).name('Core Stat');
  gui.add(params, 'pointsToSpend', 1, 20, 1).name('Points');
  gui
    .add(
      {
        spendPoints: () => {
          try {
            spendPoints(world, { [params.targetCoreStat]: params.pointsToSpend });
            statSystem(world);
            render();
          } catch (e) {
            logger.warn('Cannot spend points in stats lab', { error: e });
          }
        },
      },
      'spendPoints',
    )
    .name('Spend Core Points');

  gui.add(params, 'xpToGrant', 1, 200, 1).name('XP to Grant');
  gui
    .add(
      {
        grantXp: () => {
          world.playerLevel.xp += params.xpToGrant;
          levelSystem(world);
          statSystem(world);
          render();
        },
      },
      'grantXp',
    )
    .name('Grant XP');

  gui.add(params, 'targetModStat', STAT_KEYS).name('Modifier Stat');
  gui.add(params, 'modifierValue', 1, 50, 1).name('Modifier Value');
  gui
    .add(
      {
        addMod: () => {
          addStatModifier(world, {
            sourceType: 'buff',
            sourceId: `lab-mod-${world.frameCount}`,
            stat: params.targetModStat,
            op: 'add',
            value: params.modifierValue,
          });
          statSystem(world);
          render();
        },
      },
      'addMod',
    )
    .name('Add Modifier');

  gui.add(params, 'reset').name('Reset World');

  reset();

  const hint = document.createElement('p');
  hint.textContent =
    'Allocate core stat points (Strength, Constitution, …) and see how they derive EffectiveStats. Add temporary legacy modifiers on top of the derived values.';
  hint.style.cssText = 'margin-top:16px;color:#fbcfe8;line-height:1.6;';
  controls.append(hint);

  return () => {
    hint.remove();
    root.remove();
  };
}

registerLab('stats-lab', {
  category: 'Progression' as LabCategory,
  name: 'Stats Lab',
  description: 'Inspect core stat allocation and derived EffectiveStats computation.',
  create: createStatsLab,
});
