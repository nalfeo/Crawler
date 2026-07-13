import { abilityCatalogSchema, type AbilityDefinition } from './types.js';

const ABILITY_DEFINITIONS_RAW: AbilityDefinition[] = [
  {
    id: 'battle-focus',
    name: 'Battle Focus',
    description: 'Land enough hits to convert momentum into damage.',
    category: 'combat',
    kind: 'active',
    mpCost: 0,
    cooldownFrames: 30,
    trigger: { kind: 'skill_usage', metric: 'hits_landed', minAmount: 10 },
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'veteran-instinct',
    name: 'Veteran Instinct',
    description: 'Constant battlefield awareness improves your armor and pickup range.',
    category: 'defense',
    kind: 'passive',
    effects: [
      { type: 'stat_add', stat: 'armor', value: 2 },
      { type: 'stat_add', stat: 'pickupRange', value: 0.75 },
    ],
  },
  {
    id: 'fireball',
    name: 'Fireball',
    description: 'Hurl a ball of fire that explodes in an area, burning enemies.',
    category: 'combat',
    kind: 'spell',
    mpCost: 5,
    cooldownFrames: 300,
    trigger: { kind: 'enemy_cluster', minEnemies: 1, withinFeet: 6 },
    effects: [{ type: 'spell_fireball', damagePercent: 1.5, radiusTiles: 3 }],
  },
  {
    id: 'heal',
    name: 'Heal',
    description: 'Mend your wounds with restorative magic.',
    category: 'defense',
    kind: 'spell',
    mpCost: 10,
    cooldownFrames: 1800,
    trigger: { kind: 'health_deficit_at_least', deficitAmount: 30 },
    effects: [{ type: 'spell_heal', baseHeal: 30 }],
  },
  {
    id: 'pulse-shield',
    name: 'Pulse Shield',
    description: 'Release a shockwave of protective force that knocks back nearby enemies.',
    category: 'defense',
    kind: 'spell',
    mpCost: 10,
    cooldownFrames: 1200,
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
    description: 'Call down a brief blessing that sharpens your strikes and footwork.',
    category: 'utility',
    kind: 'spell',
    mpCost: 8,
    cooldownFrames: 1_200,
    trigger: { kind: 'skill_usage', metric: 'hits_landed', minAmount: 12 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: 900,
        vfxColor: 0xfef3c7,
        modifiers: [
          { stat: 'damage', op: 'add', value: 4 },
          { stat: 'attackSpeed', op: 'multiply', value: 0.2 },
          { stat: 'moveSpeed', op: 'add', value: 0.05 },
        ],
      },
    ],
  },
  {
    id: 'stoneskin',
    name: 'Stoneskin',
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
    description: 'Flood your limbs with quicksilver speed after a strong damage spike.',
    category: 'utility',
    kind: 'spell',
    mpCost: 7,
    cooldownFrames: 1_080,
    trigger: { kind: 'skill_usage', metric: 'damage_dealt', minAmount: 40 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: 780,
        vfxColor: 0x67e8f9,
        modifiers: [
          { stat: 'moveSpeed', op: 'add', value: 0.125 },
          { stat: 'attackSpeed', op: 'multiply', value: 0.25 },
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
