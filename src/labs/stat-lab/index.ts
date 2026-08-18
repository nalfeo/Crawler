import GUI from 'lil-gui';
import { addEntity } from 'bitecs';
import { createGameWorld, type GameWorld } from '../../core/index.js';
import {
  initializeBaseStats,
  equip,
  getEffectiveStats,
} from '../../core/systems/equipmentSystem.js';
import { statSystem } from '../../core/systems/statSystem.js';
import { PRIMARY_STATS, SECONDARY_STATS, DEFAULT_BASE_STATS } from '../../shared/stats.js';
import type { EquipmentItemDef } from '../../shared/equipment-types.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_SEED = 42;

const TEST_ITEM: EquipmentItemDef = {
  id: 'stat-test-ring',
  name: 'Stat Test Ring',
  slots: ['ring1'],
  rarity: 'uncommon',
  statBonuses: { strength: 5, armor: 3, critChance: 0.1 },
  weightLb: 0.25,
};

function createStatLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  let world: GameWorld = createGameWorld({ seed: LAB_SEED });
  world.state = 'safe_room';
  let entity = addEntity(world.ecs);
  initializeBaseStats(world, entity);

  const root = document.createElement('div');
  root.style.cssText = 'padding:24px; color:#f8fafc; font-family:monospace; overflow:auto;';

  const title = document.createElement('h2');
  title.textContent = '📊 Stat System Lab';

  const output = document.createElement('pre');
  output.style.cssText =
    'background:rgba(0,0,0,0.3); padding:16px; border-radius:8px; white-space:pre-wrap;';

  root.append(title, output);
  canvasHost.append(root);

  function render(): void {
    statSystem(world);
    const stats = getEffectiveStats(world, entity);
    const lines: string[] = ['=== Effective Stats (after statSystem tick) ===', ''];
    lines.push('PRIMARY:');
    for (const s of PRIMARY_STATS) {
      const base = DEFAULT_BASE_STATS[s];
      const eff = stats[s];
      const delta = eff - base;
      lines.push(
        `  ${s.padEnd(14)} ${eff.toFixed(2)}${delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta.toFixed(2)})` : ''}`,
      );
    }
    lines.push('', 'SECONDARY:');
    for (const s of SECONDARY_STATS) {
      const base = DEFAULT_BASE_STATS[s];
      const eff = stats[s];
      const delta = eff - base;
      lines.push(
        `  ${s.padEnd(18)} ${eff.toFixed(3)}${delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta.toFixed(3)})` : ''}`,
      );
    }
    const allocated = PRIMARY_STATS.filter(
      (s) => (world.stores.coreStatPoints[s][entity] ?? 0) > 0,
    );
    lines.push('', 'ALLOCATED CORE POINTS (level-up):');
    if (allocated.length === 0) {
      lines.push('  (none)');
    } else {
      for (const s of allocated) {
        lines.push(`  ${s.padEnd(14)} +${world.stores.coreStatPoints[s][entity]}`);
      }
    }
    output.textContent = lines.join('\n');
  }

  gui
    .add(
      {
        equipTestItem: () => {
          equip(world, entity, TEST_ITEM, { force: true });
          render();
        },
      },
      'equipTestItem',
    )
    .name('Equip Test Item');

  // ITEM 5 bridge: allocating level-up core-stat points raises the derived
  // secondaries (Luck → critChance, Dexterity → dodgeChance) through statSystem,
  // which is exactly what the combat damage path reads.
  gui
    .add(
      {
        allocLuck: () => {
          const c = world.stores.coreStatPoints.luck;
          c[entity] = (c[entity] ?? 0) + 1;
          render();
        },
      },
      'allocLuck',
    )
    .name('Allocate +1 Luck → Crit');

  gui
    .add(
      {
        allocDex: () => {
          const c = world.stores.coreStatPoints.dexterity;
          c[entity] = (c[entity] ?? 0) + 1;
          render();
        },
      },
      'allocDex',
    )
    .name('Allocate +1 Dex → Dodge');

  gui
    .add(
      {
        runTick: () => {
          statSystem(world);
          render();
        },
      },
      'runTick',
    )
    .name('Run statSystem Tick');

  gui
    .add(
      {
        reset: () => {
          world = createGameWorld({ seed: LAB_SEED });
          world.state = 'safe_room';
          entity = addEntity(world.ecs);
          initializeBaseStats(world, entity);
          render();
        },
      },
      'reset',
    )
    .name('Reset');

  const hint = document.createElement('p');
  hint.textContent =
    'Equip items and run statSystem ticks to verify stat aggregation. Allocate Luck/Dexterity points to watch critChance/dodgeChance rise — the same EffectiveStats the combat damage path reads. The statSystem recomputes effective = base + core points + equipment + derived secondaries each frame.';
  hint.style.cssText = 'margin-top:16px; color:#fbcfe8; line-height:1.6;';
  controls.append(hint);

  render();

  return () => {
    root.remove();
    hint.remove();
  };
}

registerLab('stat-lab', {
  category: 'Progression' as LabCategory,
  name: 'Stat System Lab',
  description: 'Verify per-frame stat aggregation: base stats + equipment bonuses with clamping.',
  create: createStatLab,
});
