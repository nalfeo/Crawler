import { describe, expect, it } from 'vitest';
import {
  BOSS_DEN_OUTLINE,
  RESOURCE_HEART_TINT,
  SETTLEMENT_TINT,
  TERRITORY_NEUTRAL_TINT,
  territoryTintsForTile,
  familyColorForEnemy,
  familyTintForRoom,
  isFamilyBossDefeated,
  resolveFamilyByIndex,
  toGrayscale,
} from '../../src/engine/minimap-family-tint.js';
import { RoomRole, type TerritoryZone } from '../../src/shared/map-types.js';
import { asFamilyId, type FamilyId } from '../../src/core/faction-relations.js';
import type { FamilyDef } from '../../src/shared/data/families.js';

function makeFamily(id: string, hudColor = '#4ea8ff'): FamilyDef {
  return {
    id,
    name: `The ${id} Clan`,
    species: id,
    boss: { title: 'Chief', name: 'Karg', archetype: 'brute' },
    aiArchetype: 'melee',
    hudColor,
    refinementStyle: 'stew',
    signature: 'stew',
  };
}

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

function stubWorld(present: string[] = ['goblins'], defeated: string[] = []): StubWorld {
  return {
    floorExtendedState: {
      familyState: {
        presentFamilies: present.map(asFamilyId),
        contestedResource: 'x' as never,
        betrayerFlag: false,
      },
    },
    factionRelations: new Map(),
    factionRelationEvents: [],
    factionRelationDeltas: [],
    goalFlags: new Map(defeated.map((d) => [`floor2-family-${d}-boss-defeated`, true])),
  };
}

describe('toGrayscale', () => {
  it('returns 0 for pure black and 255-luma-white for pure white', () => {
    expect(toGrayscale(0x000000)).toBe(0x000000);
    expect(toGrayscale(0xffffff)).toBe(0xffffff);
  });

  it('collapses R/G/B to a single luma value', () => {
    const gray = toGrayscale(0xff0000);
    const r = (gray >> 16) & 0xff;
    const g = (gray >> 8) & 0xff;
    const b = gray & 0xff;
    expect(r).toBe(g);
    expect(g).toBe(b);
  });
});

describe('resolveFamilyByIndex', () => {
  const goblins = makeFamily('goblins', '#22c55e');

  it('returns null for a non-Floor-2 world', () => {
    const world: StubWorld = {
      floorExtendedState: null,
      factionRelations: new Map(),
      factionRelationEvents: [],
      factionRelationDeltas: [],
      goalFlags: new Map(),
    };
    expect(resolveFamilyByIndex(world as never, [goblins], 0)).toBeNull();
  });

  it('returns null when the index is out of range', () => {
    const world = stubWorld(['goblins']);
    expect(resolveFamilyByIndex(world as never, [goblins], 5)).toBeNull();
    expect(resolveFamilyByIndex(world as never, [goblins], -1)).toBeNull();
    expect(resolveFamilyByIndex(world as never, [goblins], undefined)).toBeNull();
  });

  it('resolves the def when the index is valid', () => {
    const world = stubWorld(['goblins']);
    const got = resolveFamilyByIndex(world as never, [goblins], 0);
    expect(got?.id).toBe('goblins');
    expect(got?.def.hudColor).toBe('#22c55e');
  });
});

describe('isFamilyBossDefeated', () => {
  it('reads the goal flag', () => {
    const world = stubWorld(['goblins'], ['goblins']);
    expect(isFamilyBossDefeated(world as never, asFamilyId('goblins'))).toBe(true);
    expect(isFamilyBossDefeated(world as never, asFamilyId('kobolds'))).toBe(false);
  });
});

describe('familyTintForRoom', () => {
  const goblins = makeFamily('goblins', '#22c55e');
  const kobolds = makeFamily('kobolds', '#ea580c');
  const families = [goblins, kobolds];

  it('returns null for classic Floor-1 roles', () => {
    const world = stubWorld(['goblins']);
    expect(
      familyTintForRoom(world as never, families, { role: RoomRole.SAFE, familyIndex: undefined }),
    ).toBeNull();
    expect(
      familyTintForRoom(world as never, families, { role: RoomRole.SPAWN, familyIndex: undefined }),
    ).toBeNull();
    expect(
      familyTintForRoom(world as never, families, {
        role: RoomRole.BOSS_STAIR,
        familyIndex: undefined,
      }),
    ).toBeNull();
    expect(
      familyTintForRoom(world as never, families, {
        role: RoomRole.NORMAL,
        familyIndex: undefined,
      }),
    ).toBeNull();
  });

  it('returns the fixed accent tints for settlement + resource-heart', () => {
    const world = stubWorld(['goblins']);
    expect(
      familyTintForRoom(world as never, families, {
        role: RoomRole.SETTLEMENT,
        familyIndex: undefined,
      }),
    ).toBe(SETTLEMENT_TINT);
    expect(
      familyTintForRoom(world as never, families, {
        role: RoomRole.RESOURCE_HEART,
        familyIndex: undefined,
      }),
    ).toBe(RESOURCE_HEART_TINT);
  });

  it('picks the family hud color for TERRITORY rooms', () => {
    const world = stubWorld(['goblins', 'kobolds']);
    expect(
      familyTintForRoom(world as never, families, { role: RoomRole.TERRITORY, familyIndex: 0 }),
    ).toBe(0x22c55e);
    expect(
      familyTintForRoom(world as never, families, { role: RoomRole.TERRITORY, familyIndex: 1 }),
    ).toBe(0xea580c);
  });

  it('grays out TERRITORY tiles once the family boss is defeated', () => {
    const world = stubWorld(['goblins'], ['goblins']);
    const tint = familyTintForRoom(world as never, families, {
      role: RoomRole.TERRITORY,
      familyIndex: 0,
    });
    expect(tint).toBe(toGrayscale(0x22c55e));
  });

  it('falls back to a neutral tint (not null) for a TERRITORY room with no/invalid family index', () => {
    const world = stubWorld(['goblins', 'kobolds']);
    // familyIndex is optional on RoomData; a territory with no index must still
    // draw its marker rather than vanish from the minimap.
    expect(
      familyTintForRoom(world as never, families, {
        role: RoomRole.TERRITORY,
        familyIndex: undefined,
      }),
    ).toBe(TERRITORY_NEUTRAL_TINT);
    expect(
      familyTintForRoom(world as never, families, { role: RoomRole.TERRITORY, familyIndex: 99 }),
    ).toBe(TERRITORY_NEUTRAL_TINT);
  });

  it('falls back to the classic red outline for BOSS_DEN without a family', () => {
    const world = stubWorld([]);
    expect(
      familyTintForRoom(world as never, families, {
        role: RoomRole.BOSS_DEN,
        familyIndex: undefined,
      }),
    ).toBe(BOSS_DEN_OUTLINE);
  });
});

describe('familyColorForEnemy', () => {
  const goblins = makeFamily('goblins', '#22c55e');

  it('returns null when the world is not on Floor 2', () => {
    const world: StubWorld = {
      floorExtendedState: null,
      factionRelations: new Map(),
      factionRelationEvents: [],
      factionRelationDeltas: [],
      goalFlags: new Map(),
    };
    expect(familyColorForEnemy(world as never, [goblins], 0)).toBeNull();
  });

  describe('territoryTintsForTile', () => {
    const goblins = makeFamily('goblins', '#22c55e');
    const kobolds = makeFamily('kobolds', '#ea580c');
    const families = [goblins, kobolds];
    const zones: TerritoryZone[] = [
      { familyIndex: 1, centerX: 7, centerY: 5, radius: 3 },
      { familyIndex: 0, centerX: 5, centerY: 5, radius: 3 },
      { familyIndex: 99, centerX: 6, centerY: 5, radius: 3 },
    ];

    it('returns every overlapping family in stable family-index order', () => {
      const world = stubWorld(['goblins', 'kobolds']);
      expect(territoryTintsForTile(world as never, families, zones, 6, 5)).toEqual([
        0x22c55e, 0xea580c,
      ]);
    });

    it('includes the circular boundary and excludes tiles outside it', () => {
      const world = stubWorld(['goblins', 'kobolds']);
      expect(territoryTintsForTile(world as never, families, zones, 2, 5)).toEqual([0x22c55e]);
      expect(territoryTintsForTile(world as never, families, zones, 1, 5)).toEqual([]);
    });

    it('grays a defeated family band without changing the other overlap band', () => {
      const world = stubWorld(['goblins', 'kobolds'], ['goblins']);
      expect(territoryTintsForTile(world as never, families, zones, 6, 5)).toEqual([
        toGrayscale(0x22c55e),
        0xea580c,
      ]);
    });
  });

  it('returns the family hud color for a valid index', () => {
    const world = stubWorld(['goblins']);
    expect(familyColorForEnemy(world as never, [goblins], 0)).toBe(0x22c55e);
  });

  it('returns null for an out-of-range or undefined index', () => {
    const world = stubWorld(['goblins']);
    expect(familyColorForEnemy(world as never, [goblins], 5)).toBeNull();
    expect(familyColorForEnemy(world as never, [goblins], undefined)).toBeNull();
  });
});
