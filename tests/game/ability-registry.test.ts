import { describe, expect, it } from 'vitest';
import {
  getAllAbilityDefinitions,
  getAbilityDefinition,
  parseAbilityCatalog,
} from '../../src/game/abilities/registry.js';
import {
  FLOOR1_BOSS_REWARD_SPELL_IDS,
  FLOOR1_BOSS_REWARD_SPELL_OFFER_COUNT,
} from '../../src/shared/abilities.js';
import { ABILITY_PRESENTATION_BY_ID } from '../../src/shared/ability-presentation.js';

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

  it('exposes a 10-spell floor1 reward pool and every reward id resolves to a spell definition', () => {
    expect(FLOOR1_BOSS_REWARD_SPELL_IDS).toHaveLength(10);
    expect(FLOOR1_BOSS_REWARD_SPELL_OFFER_COUNT).toBe(3);
    for (const spellId of FLOOR1_BOSS_REWARD_SPELL_IDS) {
      expect(getAbilityDefinition(spellId)?.kind).toBe('spell');
    }
  });

  it('keeps icon-batch ability metadata aligned with shared ability presentation', () => {
    const iconBatchAbilityIds = [
      'battle-focus',
      'veteran-instinct',
      'magic-missile',
      'frost-nova',
      'bless',
      'stoneskin',
      'curse',
      'vampiric-touch',
      'haste',
      'combat-flow',
      'stalwart-resolve',
      'ever-vigilant',
      'blade-mastery',
      'vital-targeting',
      'brute-force',
      'marksmans-eye',
    ] as const;

    for (const id of iconBatchAbilityIds) {
      const ability = getAbilityDefinition(id);
      const presentation = ABILITY_PRESENTATION_BY_ID[id];
      expect(ability, `missing ability definition for "${id}"`).toBeDefined();
      expect(ability?.name).toBe(presentation.name);
      expect(ability?.shortLabel).toBe(presentation.shortLabel);
      expect(ability?.description).toBe(presentation.description);
      expect(ability?.category).toBe(presentation.category);
      expect(ability?.kind).toBe(presentation.kind);
      expect(ability?.iconBriefId).toBe(presentation.iconBriefId);
    }
  });

  it("keeps curse's trigger ring consistent with its own burst radius", () => {
    const curse = getAbilityDefinition('curse');
    expect(curse?.kind).toBe('spell');
    if (curse === undefined || curse.kind === 'passive') throw new Error('curse is not a spell');
    expect(curse.trigger).toEqual({ kind: 'enemy_cluster', minEnemies: 2, withinFeet: 16 });
    expect(curse.cooldownFrames).toBe(960);
    const burst = curse.effects.find((effect) => effect.type === 'spell_enemy_slow_burst');
    expect(burst).toBeDefined();
    // 4 tiles × the 4ft default tile size = 16ft, i.e. every enemy that can
    // complete the trigger cluster is inside the burst it triggers.
    if (burst?.type === 'spell_enemy_slow_burst') {
      expect(burst.radiusTiles.base * 4).toBeGreaterThanOrEqual(16);
    }
  });

  it('labels the fireball spell ability as "Fireball"', () => {
    expect(ABILITY_PRESENTATION_BY_ID.fireball.name).toBe('Fireball');
    expect(getAbilityDefinition('fireball')?.name).toBe('Fireball');
  });

  it('describes the Spellcraft Bolt passive and matches its applied accuracy bonus', () => {
    expect(ABILITY_PRESENTATION_BY_ID['spellcraft-bolt-base']).toMatchObject({
      description: 'Gain accuracy while wielding a spellcraft weapon.',
      passiveEffectSummary: 'Accuracy +0.1',
      passiveRequirementSummary: 'a spellcraft weapon',
    });
    expect(getAbilityDefinition('spellcraft-bolt-base')).toMatchObject({
      ...ABILITY_PRESENTATION_BY_ID['spellcraft-bolt-base'],
      weaponPrerequisite: 'spellcraft',
      effects: [{ type: 'stat_add', stat: 'accuracy', value: 0.1 }],
    });
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

  it('rejects the removed mpCost field on spell definitions (mana fully removed)', () => {
    expect(() =>
      parseAbilityCatalog([
        {
          id: 'spell-bad',
          name: 'Bad',
          shortLabel: 'BAD',
          description: 'desc',
          category: 'combat',
          kind: 'spell',
          mpCost: 5,
          cooldownFrames: 10,
          trigger: { kind: 'enemy_cluster', minEnemies: 2, withinFeet: 5 },
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
      ]),
    ).toThrow(/mpCost/i);
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
          cooldownFrames: 10,
          trigger: { kind: 'manual' },
          effects: [{ type: 'stat_add', stat: 'damage', value: 1 }],
        },
      ]),
    ).toThrow();
  });

  describe('shortLabel validation', () => {
    const basePassive = {
      id: 'test-ability',
      name: 'Test',
      description: 'desc',
      category: 'combat' as const,
      kind: 'passive' as const,
      effects: [{ type: 'stat_add' as const, stat: 'damage' as const, value: 1 }],
    };

    it('rejects a blank shortLabel', () => {
      expect(() => parseAbilityCatalog([{ ...basePassive, shortLabel: '' }])).toThrow();
    });

    it('rejects a whitespace-only shortLabel', () => {
      expect(() => parseAbilityCatalog([{ ...basePassive, shortLabel: '   ' }])).toThrow();
    });

    it('rejects a shortLabel longer than 8 characters', () => {
      expect(() => parseAbilityCatalog([{ ...basePassive, shortLabel: 'TOOLONGXX' }])).toThrow();
    });

    it('accepts a shortLabel at the 8-character boundary', () => {
      expect(() => parseAbilityCatalog([{ ...basePassive, shortLabel: 'EXACTLY8' }])).not.toThrow();
    });

    it('accepts a valid optional iconBriefId', () => {
      expect(() =>
        parseAbilityCatalog([
          { ...basePassive, shortLabel: 'OK', iconBriefId: 'ability-icon-fireball' },
        ]),
      ).not.toThrow();
    });

    it('accepts optional passive presentation summaries for passive abilities', () => {
      expect(() =>
        parseAbilityCatalog([
          {
            ...basePassive,
            shortLabel: 'OK',
            passiveEffectSummary: 'Damage +10%',
            passiveRequirementSummary: 'a sword',
          },
        ]),
      ).not.toThrow();
    });

    it('rejects a blank iconBriefId when provided', () => {
      expect(() =>
        parseAbilityCatalog([{ ...basePassive, shortLabel: 'OK', iconBriefId: '' }]),
      ).toThrow();
    });
  });
});
