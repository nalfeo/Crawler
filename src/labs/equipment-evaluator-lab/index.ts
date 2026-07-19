/**
 * Equipment-evaluator lab — interactive inspector for the H1 ERV scoring system.
 *
 * Demonstrates:
 *   - Scoring a set of generated weapon/armor/accessory instances against each other
 *   - Per-component ERV breakdown display
 *   - AOE ratio and encounter-fraction sliders
 *   - Deterministic tie-breaking across reordered candidates
 */

import GUI from 'lil-gui';
import {
  rankEquipmentCandidates,
  scoreLoadout,
  DEFAULT_EVALUATOR_CONFIG,
  type LoadoutEvalContext,
  type CurrentLoadoutState,
  type EquippedLoadoutItem,
  type EncounterShape,
  type EvaluatorConfig,
} from '../../game/ai/equipment-evaluator.js';
import {
  createGeneratedEquipmentRegistry,
  createGeneratedEquipmentInstance,
  createActiveWeaponSnapshotInput,
} from '../../core/generated-equipment-registry.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
} from '../../shared/generated-equipment-types.js';
import { DEFAULT_BASE_STATS } from '../../shared/stats.js';
import { registerLab, type LabCategory } from '../registry.js';

const LAB_ID = 'equipment-evaluator' as const;
const LAB_CATEGORY: LabCategory = 'Items & Equipment';
const RUN_KEY = 'evaluator-lab';

interface LabSettings {
  aoeRatio: number;
  remainingFractionDiscount: number;
  defenseWeight: number;
  expectedEnemyHitDmg: number;
  abilitySlotWeight: number;
  aoeEncounterFitMultiplier: number;
  bodyWeightLb: number;
}

const DEFAULT_SETTINGS: LabSettings = {
  aoeRatio: 0.3,
  remainingFractionDiscount: 0.7,
  defenseWeight: DEFAULT_EVALUATOR_CONFIG.defenseWeight,
  expectedEnemyHitDmg: DEFAULT_EVALUATOR_CONFIG.expectedEnemyHitDmg,
  abilitySlotWeight: DEFAULT_EVALUATOR_CONFIG.abilitySlotWeight,
  aoeEncounterFitMultiplier: DEFAULT_EVALUATOR_CONFIG.aoeEncounterFitMultiplier,
  bodyWeightLb: DEFAULT_EVALUATOR_CONFIG.bodyWeightLb,
};

/**
 * Build a set of fixture instances for the lab:
 *   1. A pistol (ranged/physical, baseline)
 *   2. A flamethrower (magic/AOE, higher base damage, heavier)
 *   3. An iron breastplate (armor, no weapon)
 *
 * Returns both the instances and a "current loadout" that has the pistol equipped.
 */
function buildFixtureInstances() {
  const world = {
    generatedEquipmentRegistry: createGeneratedEquipmentRegistry({ runKey: RUN_KEY }),
  };

  // Pistol (ranged weapon, baseDamage scaled to 60 for level-3 rare equivalent)
  const pistolInstance = createGeneratedEquipmentInstance(world, {
    baseId: 'pistol-base',
    itemLevel: 3,
    rarity: 'rare',
    enhancementLevel: 2,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Plasma Pistol +2',
      artKey: 'plasma-pistol',
      slots: ['hand'],
      tags: ['weapon', 'ranged'],
      weightLb: 3,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: createActiveWeaponSnapshotInput('pistol', { baseDamage: 60 }),
    },
  });

  // Flamethrower (magic/AOE weapon, heavier)
  const flameInstance = createGeneratedEquipmentInstance(world, {
    baseId: 'flamethrower-base',
    itemLevel: 3,
    rarity: 'rare',
    enhancementLevel: 1,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Flamethrower +1',
      artKey: 'flamethrower',
      slots: ['hand'],
      tags: ['weapon', 'magic'],
      weightLb: 8,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: createActiveWeaponSnapshotInput('flamethrower', { baseDamage: 50 }),
    },
  });

  // Iron breastplate (armor, no weapon)
  const armorInstance = createGeneratedEquipmentInstance(world, {
    baseId: 'breastplate-base',
    itemLevel: 3,
    rarity: 'uncommon',
    enhancementLevel: 0,
    resolvedEffects: [
      {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: 'armor-bonus',
        effectOrdinal: 0,
        unitCost: 1,
        kind: 'stat',
        stat: 'armor',
        operation: 'add',
        value: 15,
      },
    ],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Iron Breastplate',
      artKey: 'iron-breastplate',
      slots: ['chest'],
      tags: ['armor'],
      weightLb: 20,
      statBonuses: { armor: 45 },
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  });

  // Current loadout: pistol equipped in hand slot
  const currentEquipped: EquippedLoadoutItem = {
    instance: pistolInstance,
    occupiedSlots: ['hand'],
  };

  const currentLoadout: CurrentLoadoutState = {
    equippedItems: [currentEquipped],
    activeWeaponSnapshot: pistolInstance.frozen.activeWeaponSnapshot as ReturnType<
      typeof pistolInstance.frozen.activeWeaponSnapshot extends null ? never : () => never
    >,
    configuredActiveAbilityIds: [],
    activePassiveAbilityIds: [],
  };

  return { pistolInstance, flameInstance, armorInstance, currentLoadout };
}

function buildContext(settings: LabSettings): LoadoutEvalContext {
  const encounterShape: EncounterShape = {
    aoeRatio: settings.aoeRatio,
    remainingFractionDiscount: settings.remainingFractionDiscount,
  };
  const config: EvaluatorConfig = {
    expectedEnemyHitDmg: settings.expectedEnemyHitDmg,
    defenseWeight: settings.defenseWeight,
    bodyWeightLb: settings.bodyWeightLb,
    abilitySlotWeight: settings.abilitySlotWeight,
    aoeEncounterFitMultiplier: settings.aoeEncounterFitMultiplier,
  };
  return {
    baseStats: DEFAULT_BASE_STATS,
    coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
    nonEquipmentModifiers: [],
    encounterShape,
    config,
  };
}

function formatBreakdown(name: string, breakdown: ReturnType<typeof scoreLoadout>): string {
  return [
    `${name}:`,
    `  DPS: ${breakdown.dps.toFixed(2)}`,
    `  Defense: ${breakdown.defense.toFixed(2)}`,
    `  Ability Access: ${breakdown.abilityAccess.toFixed(2)}`,
    `  Encumbrance Mult: ${breakdown.encumbranceMultiplier.toFixed(3)}`,
    `  Total: ${breakdown.total.toFixed(2)}`,
  ].join('\n');
}

function renderResults(output: HTMLElement, settings: LabSettings): void {
  const { pistolInstance, flameInstance, armorInstance, currentLoadout } = buildFixtureInstances();
  const ctx = buildContext(settings);

  // Current loadout score
  const currentScore = scoreLoadout(
    ctx,
    currentLoadout.equippedItems,
    currentLoadout.activeWeaponSnapshot,
    currentLoadout.configuredActiveAbilityIds,
  );

  // Rank candidates
  const ranked = rankEquipmentCandidates(ctx, currentLoadout, [
    pistolInstance,
    flameInstance,
    armorInstance,
  ]);

  const lines: string[] = [];
  lines.push('=== Current Loadout ===');
  lines.push(formatBreakdown('Pistol (equipped)', currentScore));
  lines.push('');
  lines.push('=== Candidate Rankings (sorted by ERV) ===');
  for (const { candidate, breakdown } of ranked) {
    const label = candidate.frozen.displayName;
    lines.push(`--- ${label} ---`);
    lines.push(`  ERV: ${breakdown.totalERV.toFixed(4)}`);
    lines.push(`  DPS Δ: ${breakdown.dpsDelta.toFixed(4)}`);
    lines.push(`  Defense Δ: ${breakdown.defenseDelta.toFixed(4)}`);
    lines.push(`  Ability Δ: ${breakdown.abilityAccessDelta.toFixed(4)}`);
    lines.push(`  Legal: ${breakdown.isLegalTransition}`);
    lines.push(`  Sort key: ${breakdown.sortKey}`);
    lines.push(formatBreakdown('  Hypothetical', breakdown.hypothetical));
    lines.push('');
  }

  output.textContent = lines.join('\n');
}

registerLab(LAB_ID, {
  name: 'Equipment Evaluator (H1 ERV)',
  description:
    'Inspect deterministic equipment-evaluator scoring across sample generated weapons and armor.',
  category: LAB_CATEGORY,
  create(canvas: HTMLElement, controls: HTMLElement) {
    const settings: LabSettings = { ...DEFAULT_SETTINGS };

    const output = document.createElement('pre');
    output.style.cssText =
      'font-size:12px;line-height:1.5;white-space:pre-wrap;padding:8px;background:#111;color:#eee;border-radius:4px;max-height:70vh;overflow-y:auto';
    canvas.appendChild(output);

    function refresh() {
      try {
        renderResults(output, settings);
      } catch (err) {
        output.textContent = String(err);
      }
    }

    const gui = new GUI({ container: controls, autoPlace: false });
    const encounterFolder = gui.addFolder('Encounter Shape');
    encounterFolder.add(settings, 'aoeRatio', 0, 1, 0.05).name('AOE Ratio').onChange(refresh);
    encounterFolder
      .add(settings, 'remainingFractionDiscount', 0, 1, 0.05)
      .name('Remaining Fraction')
      .onChange(refresh);

    const configFolder = gui.addFolder('Config');
    configFolder
      .add(settings, 'expectedEnemyHitDmg', 1, 100, 1)
      .name('Enemy Hit Dmg')
      .onChange(refresh);
    configFolder
      .add(settings, 'defenseWeight', 0, 2, 0.05)
      .name('Defense Weight')
      .onChange(refresh);
    configFolder
      .add(settings, 'abilitySlotWeight', 0, 20, 0.5)
      .name('Ability Slot Weight')
      .onChange(refresh);
    configFolder
      .add(settings, 'aoeEncounterFitMultiplier', 1, 3, 0.1)
      .name('AOE Fit Mult')
      .onChange(refresh);
    configFolder
      .add(settings, 'bodyWeightLb', 100, 250, 5)
      .name('Body Weight (lb)')
      .onChange(refresh);

    refresh();

    return () => {
      gui.destroy();
    };
  },
});
