import { describe, expect, it } from 'vitest';
import {
  BAND_BAR_COLORS,
  FAMILY_NAME_MAX_CHARS,
  bossDefeatedGoalFlag,
  displayNameForRow,
  familyRowFromRelation,
  parseHexColor,
  resolveFamilyRows,
  statusTagForBand,
} from '../../src/engine/family-relationships-state.js';
import { asFamilyId, type FamilyId } from '../../src/core/faction-relations.js';
import type { FamilyDef } from '../../src/shared/data/families.js';

function makeFamily(id: string, overrides: Partial<FamilyDef> = {}): FamilyDef {
  return {
    id,
    name: `The ${id[0]!.toUpperCase()}${id.slice(1)} Clan`,
    species: id,
    boss: { title: 'Chief', name: 'Karg', archetype: 'brute' },
    aiArchetype: 'melee',
    hudColor: '#4ea8ff',
    refinementStyle: 'stew',
    signature: 'stew',
    ...overrides,
  };
}

describe('statusTagForBand', () => {
  it('maps every band to its player-facing tag', () => {
    expect(statusTagForBand('hate')).toBe('At War');
    expect(statusTagForBand('hostile')).toBe('At War');
    expect(statusTagForBand('neutral')).toBe('Neutral');
    expect(statusTagForBand('friendly')).toBe('Allied');
  });
});

describe('parseHexColor', () => {
  it('parses valid #RRGGBB strings to 0xRRGGBB numbers', () => {
    expect(parseHexColor('#4ea8ff')).toBe(0x4ea8ff);
    expect(parseHexColor('#000000')).toBe(0x000000);
    expect(parseHexColor('#FFFFFF')).toBe(0xffffff);
  });

  it('returns the fallback for malformed input', () => {
    expect(parseHexColor('bogus', 0x123456)).toBe(0x123456);
    expect(parseHexColor('#123', 0x654321)).toBe(0x654321);
    expect(parseHexColor(null as unknown as string, 0xabcdef)).toBe(0xabcdef);
  });
});

describe('bossDefeatedGoalFlag', () => {
  it('builds the canonical Slice-4 goal-flag key', () => {
    const id = asFamilyId('goblins');
    expect(bossDefeatedGoalFlag(id)).toBe('floor2-family-goblins-boss-defeated');
  });
});

describe('familyRowFromRelation', () => {
  const fam = makeFamily('goblins', { name: 'Snaggle Cartel', hudColor: '#22c55e' });

  it('pins band boundaries per FR8', () => {
    expect(familyRowFromRelation(fam, 0, false).band).toBe('hate');
    expect(familyRowFromRelation(fam, 24, false).band).toBe('hate');
    expect(familyRowFromRelation(fam, 25, false).band).toBe('hostile');
    expect(familyRowFromRelation(fam, 49, false).band).toBe('hostile');
    expect(familyRowFromRelation(fam, 50, false).band).toBe('neutral');
    expect(familyRowFromRelation(fam, 75, false).band).toBe('neutral');
    expect(familyRowFromRelation(fam, 76, false).band).toBe('friendly');
    expect(familyRowFromRelation(fam, 100, false).band).toBe('friendly');
  });

  it('picks the band bar color for each band', () => {
    expect(familyRowFromRelation(fam, 10, false).barColor).toBe(BAND_BAR_COLORS.hate);
    expect(familyRowFromRelation(fam, 30, false).barColor).toBe(BAND_BAR_COLORS.hostile);
    expect(familyRowFromRelation(fam, 60, false).barColor).toBe(BAND_BAR_COLORS.neutral);
    expect(familyRowFromRelation(fam, 90, false).barColor).toBe(BAND_BAR_COLORS.friendly);
  });

  it('surfaces the boss-defeated flag and status tag', () => {
    const alive = familyRowFromRelation(fam, 80, false);
    expect(alive.bossDefeated).toBe(false);
    expect(alive.statusTag).toBe('Allied');

    const dead = familyRowFromRelation(fam, 10, true);
    expect(dead.bossDefeated).toBe(true);
    expect(dead.statusTag).toBe('At War');
  });

  it('parses the family hud color', () => {
    expect(familyRowFromRelation(fam, 50, false).hudColor).toBe(0x22c55e);
  });
});

describe('displayNameForRow', () => {
  it('returns the full name when it fits within the column', () => {
    // "The Bamboo Triad" is 16 chars, "The Snaggle Cartel" is exactly 18.
    expect(displayNameForRow({ name: 'The Bamboo Triad', shortLabel: 'Pandas' })).toBe(
      'The Bamboo Triad',
    );
    expect(displayNameForRow({ name: 'The Snaggle Cartel', shortLabel: 'Goblins' })).toBe(
      'The Snaggle Cartel',
    );
  });

  it('falls back to the short species label when the full name is too wide', () => {
    // Real roster case: "The Thornbloom Growers" (22) → "Cactusfolk" (10).
    expect(displayNameForRow({ name: 'The Thornbloom Growers', shortLabel: 'Cactusfolk' })).toBe(
      'Cactusfolk',
    );
    expect(displayNameForRow({ name: 'The Trash Panda Family', shortLabel: 'Raccoons' })).toBe(
      'Raccoons',
    );
  });

  it('hard-truncates with an ellipsis when neither label fits', () => {
    const name = 'A'.repeat(25);
    const shortLabel = 'B'.repeat(20);
    // Short label is shorter than the name, so it wins the truncation base.
    const out = displayNameForRow({ name, shortLabel });
    expect(out).toBe('B'.repeat(FAMILY_NAME_MAX_CHARS - 1) + '…');
    expect(out.length).toBe(FAMILY_NAME_MAX_CHARS);
  });

  it('truncates the name when the short label is empty', () => {
    const name = 'The Extremely Long Family Name';
    expect(displayNameForRow({ name, shortLabel: '' })).toBe(
      name.slice(0, FAMILY_NAME_MAX_CHARS - 1) + '…',
    );
  });

  it('respects a custom maxChars', () => {
    expect(displayNameForRow({ name: 'abcdef', shortLabel: 'xy' }, 4)).toBe('xy');
  });
});

describe('resolveFamilyRows', () => {
  interface StubWorld {
    floorExtendedState: {
      familyState?: {
        presentFamilies: FamilyId[];
        contestedResource: string;
        betrayerFlag: boolean;
      };
    } | null;
    factionRelations: Map<FamilyId, number>;
    factionRelationEvents: never[];
    factionRelationDeltas: never[];
    goalFlags: Map<string, boolean>;
  }

  const goblins = makeFamily('goblins');
  const kobolds = makeFamily('kobolds', { hudColor: '#ea580c' });
  const orcs = makeFamily('orcs', { hudColor: '#991b1b' });

  it('returns an empty array on non-Floor-2 worlds', () => {
    const world: StubWorld = {
      floorExtendedState: null,
      factionRelations: new Map(),
      factionRelationEvents: [],
      factionRelationDeltas: [],
      goalFlags: new Map(),
    };
    expect(resolveFamilyRows(world as never, [goblins])).toEqual([]);
  });

  it('produces one row per present family in roster order', () => {
    const world: StubWorld = {
      floorExtendedState: {
        familyState: {
          presentFamilies: [asFamilyId('goblins'), asFamilyId('kobolds'), asFamilyId('orcs')],
          contestedResource: 'x' as never,
          betrayerFlag: false,
        },
      },
      factionRelations: new Map<FamilyId, number>([
        [asFamilyId('goblins'), 80],
        [asFamilyId('kobolds'), 10],
        [asFamilyId('orcs'), 60],
      ]),
      factionRelationEvents: [],
      factionRelationDeltas: [],
      goalFlags: new Map<string, boolean>([['floor2-family-kobolds-boss-defeated', true]]),
    };
    const rows = resolveFamilyRows(world as never, [goblins, kobolds, orcs]);
    expect(rows.map((r) => r.familyId)).toEqual(['goblins', 'kobolds', 'orcs']);
    expect(rows[0]!.statusTag).toBe('Allied');
    expect(rows[1]!.statusTag).toBe('At War');
    expect(rows[1]!.bossDefeated).toBe(true);
    expect(rows[2]!.statusTag).toBe('Neutral');
  });

  it('skips family ids that are not in the loaded roster', () => {
    const world: StubWorld = {
      floorExtendedState: {
        familyState: {
          presentFamilies: [asFamilyId('goblins'), asFamilyId('missing')],
          contestedResource: 'x' as never,
          betrayerFlag: false,
        },
      },
      factionRelations: new Map<FamilyId, number>([[asFamilyId('goblins'), 50]]),
      factionRelationEvents: [],
      factionRelationDeltas: [],
      goalFlags: new Map(),
    };
    const rows = resolveFamilyRows(world as never, [goblins]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.familyId).toBe('goblins');
  });
});
