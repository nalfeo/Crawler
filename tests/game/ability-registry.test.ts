import { describe, expect, it } from 'vitest';
import {
  getAllAbilityDefinitions,
  getAbilityDefinition,
  parseAbilityCatalog,
} from '../../src/game/abilities/registry.js';

describe('ability registry', () => {
  it('returns undefined for unknown ability id', () => {
    expect(getAbilityDefinition('missing')).toBeUndefined();
  });

  it('contains active, passive, and spell entries', () => {
    const kinds = new Set(getAllAbilityDefinitions().map((ability) => ability.kind));
    expect(kinds.has('active')).toBe(true);
    expect(kinds.has('passive')).toBe(true);
    expect(kinds.has('spell')).toBe(true);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      parseAbilityCatalog([
        {
          id: 'dup',
          name: 'One',
          shortLabel: 'ONE',
          description: 'desc',
          category: 'combat',
          kind: 'passive',
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
        {
          id: 'dup',
          name: 'Two',
          shortLabel: 'TWO',
          description: 'desc',
          category: 'combat',
          kind: 'passive',
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('rejects spells without positive MP costs', () => {
    expect(() =>
      parseAbilityCatalog([
        {
          id: 'spell-bad',
          name: 'Bad',
          shortLabel: 'BAD',
          description: 'desc',
          category: 'combat',
          kind: 'spell',
          mpCost: 0,
          cooldownFrames: 10,
          trigger: { kind: 'enemy_cluster', minEnemies: 2, withinFeet: 5 },
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
      ]),
    ).toThrow(/positive mpcost/i);
  });

  it('rejects removed manual trigger kind', () => {
    expect(() =>
      parseAbilityCatalog([
        {
          id: 'spell-manual',
          name: 'Manual',
          shortLabel: 'MANUAL',
          description: 'desc',
          category: 'combat',
          kind: 'spell',
          mpCost: 5,
          cooldownFrames: 10,
          trigger: { kind: 'manual' },
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
      ]),
    ).toThrow();
  });
});
