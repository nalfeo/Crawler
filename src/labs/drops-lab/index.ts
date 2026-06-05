import { query, setComponent } from 'bitecs';
import { registerLab, type LabCategory } from '../registry.js';
import { createGameWorld } from '../../core/world.js';
import { spawnEnemy } from '../../core/helpers.js';
import { dropSystem } from '../../core/systems/dropSystem.js';
import { Enemy, Gold, Health, Position, XpGem, DroppedItem } from '../../core/components.js';

interface DropsLabSettings {
  enemyHp: number;
  overkillDamage: number;
  spawnCount: number;
}

const DEFAULT_SETTINGS: DropsLabSettings = {
  enemyHp: 10,
  overkillDamage: 5,
  spawnCount: 1,
};

interface LabGuiController {
  name(label: string): LabGuiController;
  onChange?(handler: () => void): LabGuiController;
  updateDisplay?(): void;
}

interface LabGuiLike {
  add(...args: unknown[]): LabGuiController;
  addFolder?(title: string): LabGuiLike;
  open?(): void;
  destroy?(): void;
}

type ControlsWithGui = HTMLElement & { __labGui?: LabGuiLike };

function createDropsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: DropsLabSettings = { ...DEFAULT_SETTINGS };

  const root = document.createElement('div');
  root.style.padding = '24px';
  root.style.color = '#f8fafc';
  root.style.fontFamily = 'Inter, system-ui, sans-serif';

  const title = document.createElement('h2');
  title.textContent = 'Drops System Lab';
  title.style.marginBottom = '8px';

  const description = document.createElement('p');
  description.textContent =
    'Spawn enemies, kill them, and see what drops. Adjust loot parameters with the controls.';
  description.style.color = '#cbd5e1';
  description.style.marginBottom = '16px';

  const output = document.createElement('pre');
  output.style.background = 'rgba(15, 23, 42, 0.9)';
  output.style.border = '1px solid rgba(148, 163, 184, 0.2)';
  output.style.borderRadius = '12px';
  output.style.padding = '16px';
  output.style.fontSize = '13px';
  output.style.lineHeight = '1.6';
  output.style.minHeight = '200px';
  output.style.whiteSpace = 'pre-wrap';
  output.textContent = 'Click "Kill Enemies" to see drops.';

  const killButton = document.createElement('button');
  killButton.textContent = 'Kill Enemies';
  killButton.style.cssText =
    'padding: 10px 20px; border: 1px solid rgba(148,163,184,0.25); border-radius: 12px; background: rgba(30,41,59,0.96); color: #f8fafc; font-size: 14px; font-weight: 600; cursor: pointer; margin-bottom: 16px;';

  killButton.addEventListener('click', () => {
    const world = createGameWorld({ seed: Math.floor(Math.random() * 100000) });

    // Spawn enemies
    for (let i = 0; i < settings.spawnCount; i++) {
      const x = 100 + i * 60;
      const y = 200;
      spawnEnemy(world, x, y, settings.enemyHp);
    }

    // Kill them all
    const enemies = query(world.ecs, [Enemy]);
    for (const eid of Array.from(enemies)) {
      setComponent(world.ecs, eid, Health, {
        current: -settings.overkillDamage,
        max: settings.enemyHp,
      });
    }

    // Run drop system
    dropSystem(world);

    // Count results
    const gems = query(world.ecs, [XpGem, Position]);
    const golds = query(world.ecs, [Gold, Position]);
    const items = query(world.ecs, [DroppedItem, Position]);
    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');

    const lines: string[] = [
      `=== Kill Result (${settings.spawnCount} enemies, ${settings.enemyHp} HP, ${settings.overkillDamage} overkill) ===`,
      ``,
      `XP Gems spawned: ${gems.length}`,
      `Gold spawned: ${golds.length}`,
      `Items spawned: ${items.length}`,
      `Death events: ${deathEvents.length}`,
      ``,
    ];

    for (const eid of Array.from(golds)) {
      lines.push(
        `  Gold at (${world.stores.position.x[eid]?.toFixed(0)}, ${world.stores.position.y[eid]?.toFixed(0)}) value=${world.stores.gold.value[eid]}`,
      );
    }
    for (const eid of Array.from(gems)) {
      lines.push(
        `  XP at (${world.stores.position.x[eid]?.toFixed(0)}, ${world.stores.position.y[eid]?.toFixed(0)}) value=${world.stores.xpGem.value[eid]}`,
      );
    }
    for (const eid of Array.from(items)) {
      lines.push(
        `  Item at (${world.stores.position.x[eid]?.toFixed(0)}, ${world.stores.position.y[eid]?.toFixed(0)}) index=${world.stores.droppedItem.itemIndex[eid]}`,
      );
    }

    for (const evt of deathEvents) {
      lines.push(
        `  Death @ (${evt.x.toFixed(0)}, ${evt.y.toFixed(0)}) overkill=${evt.overkill}`,
      );
    }

    output.textContent = lines.join('\n');
  });

  root.append(title, description, killButton, output);
  canvasHost.append(root);

  // GUI controls
  const guiGroup = typeof gui.addFolder === 'function' ? gui.addFolder('Drops Lab') : gui;
  guiGroup.add(settings, 'enemyHp', 1, 100, 1).name('Enemy HP');
  guiGroup.add(settings, 'overkillDamage', 0, 50, 1).name('Overkill Damage');
  guiGroup.add(settings, 'spawnCount', 1, 20, 1).name('Enemy Count');
  guiGroup.open?.();

  return () => {
    if (guiGroup !== gui) guiGroup.destroy?.();
    root.remove();
  };
}

registerLab('drops-lab', {
  category: 'Items & Equipment' as LabCategory,
  name: 'Drops Lab',
  description: 'Test loot table rolls and drop spawning on enemy death.',
  create: createDropsLab,
});
