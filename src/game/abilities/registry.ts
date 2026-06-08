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
