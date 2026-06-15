import { abilityCatalogSchema, type AbilityDefinition } from './types.js';

const ABILITY_DEFINITIONS_RAW: AbilityDefinition[] = [
  {
    id: 'battle-focus',
    name: 'Battle Focus',
    description: 'Land enough hits to convert momentum into damage.',
    category: 'combat',
    kind: 'active',
    cooldownFrames: 30,
    trigger: { kind: 'skill_usage', metric: 'hits_landed', minAmount: 10 },
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'arcane-bolt',
    name: 'Arcane Bolt',
    description: 'A memorized spell that amplifies your next attack cadence.',
    category: 'combat',
    kind: 'spell',
    cooldownFrames: 45,
    trigger: { kind: 'manual' },
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.2 }],
  },
  {
    id: 'veteran-instinct',
    name: 'Veteran Instinct',
    description: 'Constant battlefield awareness improves your armor and pickup range.',
    category: 'defense',
    kind: 'passive',
    effects: [
      { type: 'stat_add', stat: 'armor', value: 2 },
      { type: 'stat_add', stat: 'pickupRange', value: 6 },
    ],
  },
  {
    id: 'fireball',
    name: 'Fireball',
    description: 'Hurl a ball of fire that explodes in an area, burning enemies.',
    category: 'combat',
    kind: 'spell',
    cooldownFrames: 60,
    trigger: { kind: 'manual' },
    effects: [{ type: 'spell_fireball', damagePercent: 1.5, radiusTiles: 3 }],
  },
  {
    id: 'heal',
    name: 'Heal',
    description: 'Mend your wounds with restorative magic.',
    category: 'defense',
    kind: 'spell',
    cooldownFrames: 90,
    trigger: { kind: 'manual' },
    effects: [{ type: 'spell_heal', baseHeal: 30 }],
  },
  {
    id: 'pulse-shield',
    name: 'Pulse Shield',
    description: 'Release a shockwave of protective force that knocks back nearby enemies.',
    category: 'defense',
    kind: 'spell',
    cooldownFrames: 75,
    trigger: { kind: 'manual' },
    effects: [{ type: 'spell_pulse_shield', knockbackForce: 8, radiusTiles: 4 }],
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
