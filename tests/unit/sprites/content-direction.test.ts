import { describe, expect, it } from 'vitest';

import { floor2EnemyPack } from '../../../src/shared/enemy-packs.js';
import { loadFamilies } from '../../../src/shared/data/families.js';
import {
  CRAWLER_DESIGN_LANGUAGE,
  contentDirectionBlock,
  floorContextBlock,
} from '../../../scripts/sprites/content-direction.js';
import {
  FAMILY_DESIGN_LANGUAGE,
  FLOOR_DESIGN_LANGUAGE,
  resolveDesignLanguageAddenda,
} from '../../../scripts/sprites/design-language-addenda.js';

describe('contentDirectionBlock', () => {
  it('preserves the legacy output when neither optional addendum is supplied', () => {
    expect(contentDirectionBlock(1)).toBe(
      [CRAWLER_DESIGN_LANGUAGE, '', floorContextBlock(1)].join('\n'),
    );
  });

  it.each([
    {
      label: 'floor only',
      addenda: { floor: 'FLOOR_ADDENDUM' },
      present: ['FLOOR_ADDENDUM'],
      absent: ['THEME_ADDENDUM'],
    },
    {
      label: 'theme only',
      addenda: { theme: 'THEME_ADDENDUM' },
      present: ['THEME_ADDENDUM'],
      absent: ['FLOOR_ADDENDUM'],
    },
    {
      label: 'floor and theme',
      addenda: { floor: 'FLOOR_ADDENDUM', theme: 'THEME_ADDENDUM' },
      present: ['FLOOR_ADDENDUM', 'THEME_ADDENDUM'],
      absent: [],
    },
  ])('composes $label independently', ({ addenda, present, absent }) => {
    const block = contentDirectionBlock(1, addenda);
    for (const text of present) expect(block).toContain(text);
    for (const text of absent) expect(block).not.toContain(text);
  });

  it('omits the design language priority hierarchy when no addendum is supplied', () => {
    expect(contentDirectionBlock(1)).not.toContain('## Design language priority');
  });

  it.each([
    { label: 'floor only', addenda: { floor: 'FLOOR_ADDENDUM' } },
    { label: 'theme only', addenda: { theme: 'THEME_ADDENDUM' } },
    { label: 'floor and theme', addenda: { floor: 'FLOOR_ADDENDUM', theme: 'THEME_ADDENDUM' } },
  ])(
    'states theme > floor > Crawler design language priority when any addendum is present ($label)',
    ({ addenda }) => {
      const block = contentDirectionBlock(1, addenda);
      expect(block).toContain('## Design language priority');
      expect(block).toContain(
        'theme design language > floor design language > general Crawler design language',
      );
      // The priority statement must precede any addendum section it governs.
      const priorityIdx = block.indexOf('## Design language priority');
      if (addenda.floor)
        expect(block.indexOf('## Floor design language')).toBeGreaterThan(priorityIdx);
      if (addenda.theme)
        expect(block.indexOf('## Theme design language')).toBeGreaterThan(priorityIdx);
    },
  );
});

describe('resolveDesignLanguageAddenda', () => {
  it('authors a Floor 2 addendum and exactly one blurb for every current family', () => {
    expect(FLOOR_DESIGN_LANGUAGE[2]).toContain('Family Matters');
    expect(Object.keys(FAMILY_DESIGN_LANGUAGE).sort()).toEqual(
      loadFamilies()
        .map((family) => family.id)
        .sort(),
    );
  });

  it('applies the family blurb to every family mob and boss', () => {
    for (const archetype of floor2EnemyPack.archetypes) {
      if (archetype.familyId === undefined) continue;
      const addenda = resolveDesignLanguageAddenda(archetype.id, 2);
      expect(addenda.floor).toBe(FLOOR_DESIGN_LANGUAGE[2]);
      expect(addenda.theme).toBe(
        FAMILY_DESIGN_LANGUAGE[archetype.familyId as keyof typeof FAMILY_DESIGN_LANGUAGE],
      );
    }
  });

  it('keeps Floor 2 neutral enemies floor-specific but family-neutral', () => {
    const neutral = floor2EnemyPack.archetypes.filter(
      (archetype) => archetype.familyId === undefined,
    );
    expect(neutral.length).toBeGreaterThan(0);
    for (const archetype of neutral) {
      expect(resolveDesignLanguageAddenda(archetype.id, 2)).toEqual({
        floor: FLOOR_DESIGN_LANGUAGE[2],
      });
    }
  });

  it('leaves non-Floor-2 sprites unchanged', () => {
    expect(resolveDesignLanguageAddenda('goblin-grunt', 1)).toEqual({});
  });

  it('resolves synthesized version suffixes to the canonical family sprite', () => {
    expect(resolveDesignLanguageAddenda('faerie-boss-v1', 2).theme).toBe(
      FAMILY_DESIGN_LANGUAGE.faeries,
    );
  });

  describe('cactusfolk-boss Abuela Saguaro grandmother cues', () => {
    it('includes concrete grandmother visual cues in the cactusfolk family blurb', () => {
      const blurb = FAMILY_DESIGN_LANGUAGE.cactusfolk;
      expect(blurb).toContain('wire-rimmed spectacles');
      expect(blurb).toContain('wrinkled');
      expect(blurb).toContain('rebozo');
    });

    it('resolved cactusfolk-boss addendum at floor 2 carries the grandmother cues', () => {
      const addenda = resolveDesignLanguageAddenda('cactusfolk-boss', 2);
      expect(addenda.theme).toContain('wire-rimmed spectacles');
      expect(addenda.theme).toContain('wrinkled');
      expect(addenda.theme).toContain('rebozo');
    });

    it('composed contentDirectionBlock for cactusfolk-boss at floor 2 carries the grandmother cues', () => {
      const addenda = resolveDesignLanguageAddenda('cactusfolk-boss', 2);
      const block = contentDirectionBlock(2, addenda);
      expect(block).toContain('wire-rimmed spectacles');
      expect(block).toContain('wrinkled');
      expect(block).toContain('rebozo');
    });
  });
});
