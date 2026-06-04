import GUI from 'lil-gui';
import { addEntity } from 'bitecs';
import { createGameWorld, type GameWorld } from '../../core/index.js';
import {
  initializeBaseStats,
  equip,
  unequip,
  canEquip,
  getEffectiveStats,
  getEquipmentState,
  setEntityTags,
  registerCustomRequirement,
  clearEquipmentState,
} from '../../core/systems/equipmentSystem.js';
import { SLOT_REGISTRY } from '../../shared/equipment-slots.js';
import { PRIMARY_STATS, SECONDARY_STATS, DEFAULT_BASE_STATS, type StatId } from '../../shared/stats.js';
import type { EquipmentItemDef, ItemRarity } from '../../shared/equipment-types.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_SEED = 42;

// Sample items for interactive testing
const SAMPLE_ITEMS: EquipmentItemDef[] = [
  {
    id: 'iron-helm',
    name: 'Iron Helm',
    slots: ['head'],
    rarity: 'common',
    statBonuses: { armor: 3, constitution: 2 },
  },
  {
    id: 'gold-amulet',
    name: 'Gold Amulet',
    slots: ['neck'],
    rarity: 'uncommon',
    statBonuses: { intelligence: 2, cooldownReduction: 0.05 },
  },
  {
    id: 'plate-armor',
    name: 'Plate Armor',
    slots: ['chest'],
    rarity: 'rare',
    statBonuses: { armor: 10, constitution: 5, moveSpeed: -0.5 },
  },
  {
    id: 'leather-bracers',
    name: 'Leather Bracers',
    slots: ['wrists'],
    rarity: 'common',
    statBonuses: { dexterity: 1, armor: 1 },
  },
  {
    id: 'greatsword',
    name: 'Greatsword',
    slots: ['mainHand', 'offHand'],
    rarity: 'epic',
    statBonuses: { strength: 5, attackSpeed: -0.1, damageBonus: 15 },
    tags: ['two-handed', 'weapon'],
  },
  {
    id: 'short-sword',
    name: 'Short Sword',
    slots: ['mainHand'],
    rarity: 'common',
    statBonuses: { strength: 2, damageBonus: 5, attackSpeed: 0.1 },
    tags: ['one-handed', 'weapon'],
  },
  {
    id: 'buckler',
    name: 'Buckler',
    slots: ['offHand'],
    rarity: 'common',
    statBonuses: { armor: 4, dodgeChance: 0.1 },
    tags: ['shield'],
  },
  {
    id: 'ruby-ring',
    name: 'Ruby Ring',
    slots: ['ringLeft'],
    rarity: 'uncommon',
    statBonuses: { strength: 3, critChance: 0.02 },
  },
  {
    id: 'sapphire-ring',
    name: 'Sapphire Ring',
    slots: ['ringRight'],
    rarity: 'uncommon',
    statBonuses: { intelligence: 3, cooldownReduction: 0.03 },
  },
  {
    id: 'cloak-of-shadows',
    name: 'Cloak of Shadows',
    slots: ['back'],
    rarity: 'epic',
    statBonuses: { dexterity: 4, dodgeChance: 0.1, moveSpeed: 0.3 },
  },
  {
    id: 'iron-gauntlets',
    name: 'Iron Gauntlets',
    slots: ['hands'],
    rarity: 'common',
    statBonuses: { strength: 1, armor: 2 },
  },
  {
    id: 'enchanted-belt',
    name: 'Enchanted Belt',
    slots: ['waist'],
    rarity: 'rare',
    statBonuses: { constitution: 3, hpRegen: 2 },
  },
  {
    id: 'greaves-of-haste',
    name: 'Greaves of Haste',
    slots: ['legs'],
    rarity: 'rare',
    statBonuses: { dexterity: 2, moveSpeed: 0.5, armor: 3 },
  },
  {
    id: 'boots-of-speed',
    name: 'Boots of Speed',
    slots: ['feet'],
    rarity: 'uncommon',
    statBonuses: { moveSpeed: 1.0, dexterity: 1 },
  },
  {
    id: 'cursed-crown',
    name: 'Cursed Crown',
    slots: ['head'],
    rarity: 'legendary',
    statBonuses: { intelligence: 8, strength: -3, critMultiplier: 0.5 },
    requirements: [{ type: 'minStat', stat: 'intelligence' as StatId, value: 5 }],
  },
];

const RARITY_COLORS: Record<ItemRarity, string> = {
  common: '#9ca3af',
  uncommon: '#22c55e',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#f59e0b',
};

function createEquipmentLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  let world: GameWorld = createGameWorld({ seed: LAB_SEED });
  world.state = 'safe_room';
  let entity = addEntity(world.ecs);
  initializeBaseStats(world, entity);

  // Container for the paper doll display
  const root = document.createElement('div');
  root.style.cssText =
    'display:grid; grid-template-columns:1fr 1fr; gap:24px; padding:24px; height:100%; overflow:auto; color:#f8fafc; font-family:monospace;';

  const slotsPanel = document.createElement('div');
  const statsPanel = document.createElement('div');

  root.append(slotsPanel, statsPanel);
  canvasHost.append(root);

  // Log panel
  const logPanel = document.createElement('div');
  logPanel.style.cssText =
    'margin-top:12px; padding:12px; background:rgba(0,0,0,0.3); border-radius:8px; font-size:12px; max-height:200px; overflow-y:auto;';
  const logLines: string[] = [];
  function log(msg: string): void {
    logLines.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (logLines.length > 50) logLines.pop();
    logPanel.innerHTML = logLines.map((l) => `<div>${l}</div>`).join('');
  }

  function renderSlots(): void {
    slotsPanel.innerHTML = '';
    const title = document.createElement('h2');
    title.textContent = '⚔️ Equipment Slots';
    title.style.marginBottom = '12px';
    slotsPanel.append(title);

    const state = getEquipmentState(world, entity);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:8px;';

    for (const slot of SLOT_REGISTRY) {
      const instId = state?.equipped[slot.id] ?? null;
      const instance = instId !== null ? state?.instances.get(instId) : null;
      const box = document.createElement('div');
      box.style.cssText = `padding:10px; border-radius:8px; border:2px solid ${
        instance ? RARITY_COLORS[instance.def.rarity ?? 'common'] : 'rgba(255,255,255,0.1)'
      }; background:${instance ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.2)'}; cursor:pointer;`;

      const slotName = document.createElement('div');
      slotName.style.cssText = 'font-size:11px; color:#7ee0ff; text-transform:uppercase;';
      slotName.textContent = slot.label;

      const itemName = document.createElement('div');
      itemName.style.cssText = `font-size:13px; margin-top:4px; color:${
        instance ? RARITY_COLORS[instance.def.rarity ?? 'common'] : '#666'
      };`;
      itemName.textContent = instance ? instance.def.name : '(empty)';

      box.append(slotName, itemName);
      grid.append(box);

      if (instance) {
        box.addEventListener('click', () => {
          const result = unequip(world, entity, slot.id);
          if (result.ok) {
            log(`Unequipped ${instance.def.name} from ${slot.label}`);
          } else {
            log(`Failed: ${result.reason}`);
          }
          render();
        });
        box.title = `Click to unequip. Stats: ${Object.entries(instance.def.statBonuses)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ')}`;
      }
    }

    slotsPanel.append(grid, logPanel);
  }

  function renderStats(): void {
    statsPanel.innerHTML = '';
    const title = document.createElement('h2');
    title.textContent = '📊 Effective Stats';
    title.style.marginBottom = '12px';
    statsPanel.append(title);

    const stats = getEffectiveStats(world, entity);

    const makeStat = (label: string, value: number, changed: boolean): HTMLDivElement => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex; justify-content:space-between; padding:4px 8px; border-radius:4px; background:${
        changed ? 'rgba(34,197,94,0.1)' : 'transparent'
      };`;
      const nameEl = document.createElement('span');
      nameEl.textContent = label;
      nameEl.style.color = '#c9d4ff';
      const valEl = document.createElement('span');
      valEl.textContent = Number.isInteger(value) ? String(value) : value.toFixed(3);
      valEl.style.color = changed ? '#22c55e' : '#f8fafc';
      valEl.style.fontWeight = changed ? 'bold' : 'normal';
      row.append(nameEl, valEl);
      return row;
    };

    const primarySec = document.createElement('div');
    primarySec.innerHTML = '<h3 style="color:#7ee0ff;margin:8px 0">Primary</h3>';
    for (const s of PRIMARY_STATS) {
      const val = stats[s];
      const base = DEFAULT_BASE_STATS[s];
      primarySec.append(makeStat(s, val, val !== base));
    }
    statsPanel.append(primarySec);

    const secondarySec = document.createElement('div');
    secondarySec.innerHTML = '<h3 style="color:#7ee0ff;margin:12px 0 8px">Secondary</h3>';
    for (const s of SECONDARY_STATS) {
      const val = stats[s];
      const base = DEFAULT_BASE_STATS[s];
      secondarySec.append(makeStat(s, val, val !== base));
    }
    statsPanel.append(secondarySec);
  }

  function render(): void {
    renderSlots();
    renderStats();
  }

  // GUI: equip items
  const equipFolder = gui.addFolder('Equip Items');
  for (const item of SAMPLE_ITEMS) {
    const color = RARITY_COLORS[item.rarity ?? 'common'];
    const controller = equipFolder
      .add({ equip: () => equipItem(item) }, 'equip')
      .name(`${item.name} [${item.slots.join('+')}]`);
    const el = controller.domElement?.closest('.controller');
    if (el instanceof HTMLElement) {
      el.style.borderLeft = `3px solid ${color}`;
    }
  }

  function equipItem(item: EquipmentItemDef): void {
    const check = canEquip(world, entity, item);
    if (!check.allowed) {
      log(`Cannot equip ${item.name}: ${check.reasons.join(', ')}`);
      render();
      return;
    }
    const result = equip(world, entity, item);
    if (result.ok) {
      log(`Equipped ${item.name} → ${item.slots.join(', ')}`);
    } else {
      log(`Failed: ${result.reasons.join(', ')}`);
    }
    render();
  }

  // GUI: actions
  const actionsFolder = gui.addFolder('Actions');
  actionsFolder
    .add(
      {
        clearAll: () => {
          clearEquipmentState(world, entity);
          initializeBaseStats(world, entity);
          log('Cleared all equipment');
          render();
        },
      },
      'clearAll',
    )
    .name('Clear All Equipment');

  actionsFolder
    .add(
      {
        reset: () => {
          world = createGameWorld({ seed: LAB_SEED });
          world.state = 'safe_room';
          entity = addEntity(world.ecs);
          initializeBaseStats(world, entity);
          logLines.length = 0;
          log('World reset');
          render();
        },
      },
      'reset',
    )
    .name('Reset World');

  actionsFolder
    .add(
      {
        addTag: () => {
          setEntityTags(world, entity, ['vampire', 'undead']);
          log('Added tags: vampire, undead');
        },
      },
      'addTag',
    )
    .name('Add Entity Tags');

  actionsFolder
    .add(
      {
        registerReq: () => {
          registerCustomRequirement(world, 'isVampire', (_w, eid) => {
            const tags = (
              _w as unknown as { entityTags: Map<number, Set<string>> }
            ).entityTags?.get(eid);
            return tags?.has('vampire') ?? false;
          });
          log('Registered custom requirement: isVampire');
        },
      },
      'registerReq',
    )
    .name('Register Custom Req');

  // Hint
  const hint = document.createElement('p');
  hint.textContent = 'Use the controls to equip/unequip items. Click equipped slots to unequip.';
  hint.style.cssText = 'margin-top:16px; color:#fbcfe8; line-height:1.6;';
  controls.append(hint);

  // Initial render
  render();

  return () => {
    root.remove();
    hint.remove();
  };
}

registerLab('equipment-lab', {
  name: 'Equipment Lab',
  description:
    'Interactive paper doll for testing equip/unequip operations, stat aggregation, requirements, and multi-slot items.',
  create: createEquipmentLab,
});
