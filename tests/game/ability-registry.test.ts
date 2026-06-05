import { describe, expect, it } from 'vitest';
import { getAllAbilityDefinitions, getAbilityDefinition, parseAbilityCatalog } from '../../src/game/abilities/registry.js';

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
          description: 'desc',
          category: 'combat',
          kind: 'passive',
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
        {
          id: 'dup',
          name: 'Two',
          description: 'desc',
          category: 'combat',
          kind: 'passive',
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('rejects non-manual spell triggers', () => {
    expect(() =>
      parseAbilityCatalog([
        {
          id: 'spell-bad',
          name: 'Bad',
          description: 'desc',
          category: 'combat',
          kind: 'spell',
          cooldownFrames: 10,
          trigger: { kind: 'skill_usage', metric: 'hits_landed' },
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
      ]),
    ).toThrow(/manual trigger/i);
  });
});
