import { abilityCatalogSchema, type AbilityDefinition } from './types.js';
import { ABILITY_PRESENTATION_BY_ID } from '../../shared/ability-presentation.js';

const ABILITY_DEFINITIONS_RAW: AbilityDefinition[] = [
  {
    ...ABILITY_PRESENTATION_BY_ID['battle-focus'],
    trigger: { kind: 'skill_usage', metric: 'hits_landed', minAmount: 10 },
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['veteran-instinct'],
    effects: [
      { type: 'stat_add', stat: 'armor', value: 2 },
      { type: 'stat_add', stat: 'pickupRange', value: 0.75 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.fireball,
    trigger: { kind: 'enemy_cluster', minEnemies: 1, withinFeet: 6 },
    effects: [{ type: 'spell_fireball', damagePercent: 1.5, radiusTiles: 3 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.heal,
    trigger: { kind: 'health_deficit_at_least', deficitAmount: 30 },
    effects: [{ type: 'spell_heal', baseHeal: 30 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['pulse-shield'],
    trigger: {
      kind: 'low_health_crowded',
      healthBelowRatio: 0.5,
      minEnemies: 3,
      withinFeet: 5,
    },
    effects: [{ type: 'spell_pulse_shield', knockbackForce: 1.0, radiusTiles: 4 }],
  },
  {
    id: 'magic-missile',
    name: 'Magic Missile',
    shortLabel: 'MISSILE',
    description: 'Launch a precise arcane bolt into the nearest enemy.',
    category: 'combat',
    kind: 'spell',
    mpCost: 4,
    cooldownFrames: 180,
    trigger: { kind: 'enemy_cluster', minEnemies: 1, withinFeet: 10 },
    effects: [{ type: 'spell_magic_missile', damagePercent: 1.1, rangeTiles: 4 }],
  },
  {
    id: 'frost-nova',
    name: 'Frost Nova',
    shortLabel: 'FROST',
    description: 'Burst freezing magic around you, damaging and slowing nearby foes.',
    category: 'combat',
    kind: 'spell',
    mpCost: 12,
    cooldownFrames: 900,
    trigger: { kind: 'enemy_cluster', minEnemies: 3, withinFeet: 5 },
    effects: [
      {
        type: 'spell_frost_nova',
        damagePercent: 1.0,
        radiusTiles: 3,
        slowMultiplier: 0.55,
        slowDurationMs: 3_000,
      },
    ],
  },
  {
    id: 'bless',
    name: 'Bless',
    shortLabel: 'BLESS',
    description: 'Call down a brief blessing that sharpens your strikes and footwork.',
    category: 'utility',
    kind: 'spell',
    mpCost: 8,
    cooldownFrames: 1_200,
    trigger: { kind: 'skill_usage', metric: 'weapon_fired', minAmount: 1 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: 900,
        vfxColor: 0xfef3c7,
        modifiers: [
          { stat: 'damage', op: 'add', value: 4 },
          { stat: 'accuracy', op: 'add', value: 0.1 },
          { stat: 'moveSpeed', op: 'add', value: 0.05 },
        ],
      },
    ],
  },
  {
    id: 'stoneskin',
    name: 'Stoneskin',
    shortLabel: 'STONE',
    description: 'Harden your flesh into living granite for a few desperate moments.',
    category: 'defense',
    kind: 'spell',
    mpCost: 10,
    cooldownFrames: 1_500,
    trigger: { kind: 'low_health', healthBelowRatio: 0.75 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: 1_200,
        vfxColor: 0x94a3b8,
        modifiers: [{ stat: 'armor', op: 'add', value: 4 }],
      },
    ],
  },
  {
    id: 'curse',
    name: 'Curse',
    shortLabel: 'CURSE',
    description: 'Blight a cluster of enemies, dragging their movement into a crawl.',
    category: 'utility',
    kind: 'spell',
    mpCost: 9,
    cooldownFrames: 840,
    trigger: { kind: 'enemy_cluster', minEnemies: 4, withinFeet: 8 },
    effects: [
      {
        type: 'spell_enemy_slow_burst',
        radiusTiles: 4,
        slowMultiplier: 0.4,
        slowDurationMs: 3_600,
        vfxColor: 0xa855f7,
      },
    ],
  },
  {
    id: 'vampiric-touch',
    name: 'Vampiric Touch',
    shortLabel: 'VAMP',
    description: 'Rip vitality from the nearest foe and pour it back into yourself.',
    category: 'combat',
    kind: 'spell',
    mpCost: 10,
    cooldownFrames: 720,
    trigger: {
      kind: 'low_health_crowded',
      healthBelowRatio: 0.7,
      minEnemies: 1,
      withinFeet: 5,
    },
    effects: [{ type: 'spell_life_drain', damagePercent: 1.2, rangeTiles: 3, healPercent: 0.75 }],
  },
  {
    id: 'haste',
    name: 'Haste',
    shortLabel: 'HASTE',
    description: 'Flood your limbs with quicksilver speed after a strong damage spike.',
    category: 'utility',
    kind: 'spell',
    mpCost: 7,
    cooldownFrames: 1_080,
    trigger: { kind: 'skill_usage', metric: 'weapon_fired', minAmount: 1 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: 780,
        vfxColor: 0x67e8f9,
        modifiers: [
          { stat: 'moveSpeed', op: 'add', value: 0.125 },
          { stat: 'projectileSpeed', op: 'add', value: 50 },
        ],
      },
    ],
  },
];

export function parseAbilityCatalog(raw: unknown): AbilityDefinition[] {
  return abilityCatalogSchema.parse(raw);
}

const parsed = parseAbilityCatalog(ABILITY_DEFINITIONS_RAW);
const ABILITY_DEFINITIONS = Object.freeze(parsed.map((def) => Object.freeze({ ...def })));
const registry = new Map<string, AbilityDefinition>();
for (const ability of ABILITY_DEFINITIONS) {
  registry.set(ability.id, ability);
}

export function getAbilityDefinition(id: string): AbilityDefinition | undefined {
  return registry.get(id);
}

export function getAllAbilityDefinitions(): readonly AbilityDefinition[] {
  return ABILITY_DEFINITIONS;
}
