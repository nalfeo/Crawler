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
