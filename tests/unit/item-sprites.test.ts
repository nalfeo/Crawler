import { describe, expect, it } from 'vitest';

import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import {
  _isPlaceholderEntry,
  itemSpriteConcepts,
  resolveItemSprite,
} from '../../src/shared/item-sprites.js';
import { themedArtConceptsFor } from '../../src/shared/data/equipment-theme-sets.js';
import { FLOOR2_BASIC_LEATHER_STABLE_IDS } from '../../src/shared/data/floor2-basic-leather-bases.js';

interface EntryOpts {
  readonly sourceRun?: string;
  readonly variantIndex?: number;
  /** `undefined` → a real `{x,y,source}` anchor; `null` → null anchor (anchorIsDefault). */
  readonly anchor?: { readonly x: number; readonly y: number; readonly source: 'brief' } | null;
  readonly assetPath?: string;
  readonly type?: string;
}

/** Build a registry from `[manifestKey, briefId, opts?]` tuples. */
function makeRegistry(entries: ReadonlyArray<readonly [string, string, EntryOpts?]>) {
  const record: Record<string, unknown> = {};
  for (const [key, briefId, opts] of entries) {
    record[key] = {
      briefId,
      spriteName: key,
      assetPath: opts?.assetPath ?? `assets/generated/${key}.png`,
      approvedAt: '2026-07-08T00:00:00.000Z',
      sourceRun: opts?.sourceRun ?? 'run-real',
      variantIndex: opts?.variantIndex ?? 0,
      anchor: opts?.anchor === undefined ? { x: 8, y: 8, source: 'brief' } : opts.anchor,
      sensorScore: '8/8',
      judgeScore: '2',
      ...(opts?.type === undefined ? {} : { type: opts.type }),
    };
  }
  return buildGeneratedSpriteRegistry({ version: 1, entries: record });
}

/** A placeholder entry (detected via `sourceRun === 'placeholder'`). */
function placeholder(
  key: string,
  briefId: string,
  opts: EntryOpts = {},
): readonly [string, string, EntryOpts] {
  return [key, briefId, { ...opts, sourceRun: 'placeholder' }];
}

const SEED = 42;

describe('itemSpriteConcepts', () => {
  it('resolves a plain item to just its id', () => {
    expect(itemSpriteConcepts('iron-ore')).toEqual(['iron-ore']);
  });

  it('adds the weaponId alias for the bat plus the Floor 2 runtimeKey for baseball-bat (bone-club → baseball-bat → equipment/weapon/baseball-bat)', () => {
    expect(itemSpriteConcepts('bone-club')).toEqual([
      'bone-club',
      'baseball-bat',
      'equipment/weapon/baseball-bat',
    ]);
  });

  it('adds the Floor 2 runtimeKey for a Wave A equipment item via its production stableId', () => {
    // Wave A: stableId = 'weapon.iron-cleaver'. No equipment def registered in
    // getEquipmentDefForItem for Wave A (only Wave B is in WEAPON_EQUIPMENT_DEFS),
    // so base = ['weapon.iron-cleaver']. The stableId index provides the runtimeKey;
    // the bare slug is also added so legacy versioned entries (iron-cleaver-v1) are found.
    expect(itemSpriteConcepts('weapon.iron-cleaver')).toEqual([
      'weapon.iron-cleaver',
      'iron-cleaver',
      'equipment/weapon/iron-cleaver',
    ]);
  });

  it('adds the Floor 2 runtimeKey for a Wave B weapon item via its production stableId', () => {
    // Wave B: id = 'weapon.moon-scythe', weaponId = 'weapon.moon-scythe' (same as id).
    // The stableId index provides the runtimeKey; the bare slug is added for legacy art.
    expect(itemSpriteConcepts('weapon.moon-scythe')).toEqual([
      'weapon.moon-scythe',
      'moon-scythe',
      'equipment/weapon/moon-scythe',
    ]);
  });

  it('adds the Floor 2 runtimeKey for a non-weapon Floor 2 item via its production stableId', () => {
    // Non-weapon: id = 'torso.chain-hauberk', no weaponId.
    // The stableId index provides the runtimeKey; the bare slug covers legacy art.
    expect(itemSpriteConcepts('torso.chain-hauberk')).toEqual([
      'torso.chain-hauberk',
      'chain-hauberk',
      'equipment/torso/chain-hauberk',
    ]);
  });
});

describe('_isPlaceholderEntry', () => {
  it('flags entries whose sourceRun is placeholder', () => {
    const registry = makeRegistry([placeholder('iron-ore-placeholder', 'iron-ore')]);
    expect(_isPlaceholderEntry(registry.entries()[0]!)).toBe(true);
  });

  it('flags entries whose assetPath ends with -placeholder.png even if sourceRun differs', () => {
    const registry = makeRegistry([
      [
        'iron-ore-placeholder',
        'iron-ore',
        { assetPath: 'assets/generated/iron-ore-placeholder.png' },
      ],
    ]);
    expect(_isPlaceholderEntry(registry.entries()[0]!)).toBe(true);
  });

  it('does not flag real approved art', () => {
    const registry = makeRegistry([['iron-ore-var-0', 'iron-ore']]);
    expect(_isPlaceholderEntry(registry.entries()[0]!)).toBe(false);
  });
});

describe('resolveItemSprite', () => {
  it('returns null when neither the item id nor its weaponId has any art', () => {
    const registry = makeRegistry([['copper-ore-var-0', 'copper-ore']]);
    expect(resolveItemSprite(registry, 'nonexistent-thing', SEED)).toBeNull();
  });

  it('prefers real versioned art over the placeholder (pre-migration state)', () => {
    // Real art carries the version in its briefId (`iron-ore-v1`); the
    // placeholder keeps the bare briefId. A bare-id lookup would wrongly match
    // the placeholder — the resolver must still pick the real art.
    const registry = makeRegistry([
      ['iron-ore-v1-var-0', 'iron-ore-v1'],
      placeholder('iron-ore-placeholder', 'iron-ore'),
    ]);
    const result = resolveItemSprite(registry, 'iron-ore', SEED);
    expect(result?.textureKey).toBe('iron-ore-v1-var-0');
    expect(_isPlaceholderEntry(result!)).toBe(false);
  });

  it('prefers bare real art over the placeholder (post-migration state)', () => {
    const registry = makeRegistry([
      ['iron-ore-var-0', 'iron-ore'],
      placeholder('iron-ore-placeholder', 'iron-ore'),
    ]);
    expect(resolveItemSprite(registry, 'iron-ore', SEED)?.textureKey).toBe('iron-ore-var-0');
  });

  it('prefers a bare briefId over a versioned one when both are real', () => {
    const registry = makeRegistry([
      ['iron-ore-v1-var-0', 'iron-ore-v1'],
      ['iron-ore-var-0', 'iron-ore'],
    ]);
    expect(resolveItemSprite(registry, 'iron-ore', SEED)?.textureKey).toBe('iron-ore-var-0');
  });

  it('falls back to the placeholder only when a concept has no real art', () => {
    const registry = makeRegistry([placeholder('pebble-placeholder', 'pebble')]);
    const result = resolveItemSprite(registry, 'pebble', SEED);
    expect(result?.textureKey).toBe('pebble-placeholder');
    expect(_isPlaceholderEntry(result!)).toBe(true);
  });

  describe('cross-concept (weaponId) resolution — bone-club → baseball-bat', () => {
    it('crosses to the weaponId real art instead of the item-concept placeholder', () => {
      const registry = makeRegistry([
        placeholder('bone-club-placeholder', 'bone-club'),
        ['baseball-bat-v1-var-0', 'baseball-bat-v1'],
      ]);
      const result = resolveItemSprite(registry, 'bone-club', SEED);
      expect(result?.textureKey).toBe('baseball-bat-v1-var-0');
      expect(_isPlaceholderEntry(result!)).toBe(false);
    });

    it('a real weaponId match beats an item-concept placeholder GLOBALLY (not per-concept)', () => {
      // Order the placeholder first so a naive per-concept scan would return it.
      const registry = makeRegistry([
        placeholder('bone-club-placeholder', 'bone-club'),
        ['baseball-bat-v3-var-6', 'baseball-bat-v3', { anchor: null }],
        ['baseball-bat-v1-var-0', 'baseball-bat-v1'],
      ]);
      const result = resolveItemSprite(registry, 'bone-club', SEED);
      // v1 has a real anchor; v3 has a null anchor → v1 wins, never the placeholder.
      expect(result?.textureKey).toBe('baseball-bat-v1-var-0');
    });

    it("prefers the item's own bare real art over the weaponId's versioned art", () => {
      const registry = makeRegistry([
        ['bone-club-var-0', 'bone-club'],
        ['baseball-bat-v1-var-0', 'baseball-bat-v1'],
      ]);
      expect(resolveItemSprite(registry, 'bone-club', SEED)?.textureKey).toBe('bone-club-var-0');
    });
  });

  describe('deterministic tiebreaks', () => {
    it('a real anchor beats a null anchor even when the null-anchor version is lower', () => {
      const registry = makeRegistry([
        ['baseball-bat-v1-var-0', 'baseball-bat-v1', { anchor: null }],
        ['baseball-bat-v2-var-0', 'baseball-bat-v2'],
      ]);
      expect(resolveItemSprite(registry, 'bone-club', SEED)?.textureKey).toBe(
        'baseball-bat-v2-var-0',
      );
    });

    it('prefers the lower version within the same tier when anchors match', () => {
      const registry = makeRegistry([
        ['baseball-bat-v3-var-0', 'baseball-bat-v3'],
        ['baseball-bat-v2-var-0', 'baseball-bat-v2'],
      ]);
      expect(resolveItemSprite(registry, 'bone-club', SEED)?.textureKey).toBe(
        'baseball-bat-v2-var-0',
      );
    });
  });

  describe('SeededRandom determinism across interchangeable variants', () => {
    const variants: ReadonlyArray<readonly [string, string, EntryOpts?]> = [
      ['iron-ore-var-0', 'iron-ore', { variantIndex: 0 }],
      ['iron-ore-var-1', 'iron-ore', { variantIndex: 1 }],
      ['iron-ore-var-2', 'iron-ore', { variantIndex: 2 }],
    ];

    it('returns the same variant for the same seed', () => {
      const registry = makeRegistry(variants);
      const first = resolveItemSprite(registry, 'iron-ore', SEED)?.textureKey;
      const second = resolveItemSprite(registry, 'iron-ore', SEED)?.textureKey;
      expect(first).toBeDefined();
      expect(second).toBe(first);
    });

    it('is independent of manifest insertion order', () => {
      const forward = makeRegistry(variants);
      const reversed = makeRegistry([...variants].reverse());
      expect(resolveItemSprite(forward, 'iron-ore', SEED)?.textureKey).toBe(
        resolveItemSprite(reversed, 'iron-ore', SEED)?.textureKey,
      );
    });

    it('varies the chosen variant across seeds', () => {
      const registry = makeRegistry(variants);
      const picked = new Set<string>();
      for (let seed = 0; seed < 100; seed++) {
        const key = resolveItemSprite(registry, 'iron-ore', seed)?.textureKey;
        if (key !== undefined) {
          picked.add(key);
        }
      }
      expect(picked.size).toBeGreaterThan(1);
    });
  });

  describe('Floor 2 wiring entries (briefId = equipment/{category}/{slug})', () => {
    it('resolves a wiring-format entry for a Wave B weapon via its production stableId', () => {
      // In production, the inventory item id for a Wave B weapon is its stableId
      // (e.g. `weapon.moon-scythe`), not the bare slug. This test verifies that
      // the stableId-indexed lookup finds the runtimeKey and matches the wiring entry.
      const registry = makeRegistry([
        ['equipment/weapon/moon-scythe', 'equipment/weapon/moon-scythe'],
      ]);
      const result = resolveItemSprite(registry, 'weapon.moon-scythe', SEED);
      expect(result?.textureKey).toBe('equipment/weapon/moon-scythe');
      expect(_isPlaceholderEntry(result!)).toBe(false);
    });

    it('prefers a wiring entry (TIER_BARE_REAL) over an old-style versioned entry via production stableId', () => {
      // Items that have BOTH wiring and legacy entries should prefer the wiring entry.
      // Use the production stableId `weapon.iron-cleaver` (Wave A; weaponId = `iron-cleaver`).
      const registry = makeRegistry([
        ['equipment/weapon/iron-cleaver', 'equipment/weapon/iron-cleaver'],
        ['iron-cleaver-v1-var-0', 'iron-cleaver-v1'],
      ]);
      expect(resolveItemSprite(registry, 'weapon.iron-cleaver', SEED)?.textureKey).toBe(
        'equipment/weapon/iron-cleaver',
      );
    });

    it('falls back to slug-keyed versioned entry when no wiring entry exists', () => {
      // When no wiring entry exists, a legacy versioned entry keyed by the bare slug
      // (e.g. `iron-cleaver-v1`) is found via the slug concept derived from the stableId.
      const registry = makeRegistry([['iron-cleaver-v1-var-0', 'iron-cleaver-v1']]);
      expect(resolveItemSprite(registry, 'weapon.iron-cleaver', SEED)?.textureKey).toBe(
        'iron-cleaver-v1-var-0',
      );
    });

    it('resolves a wiring entry via the weaponId runtimeKey (bone-club → baseball-bat wiring)', () => {
      const registry = makeRegistry([
        ['equipment/weapon/baseball-bat', 'equipment/weapon/baseball-bat'],
      ]);
      const result = resolveItemSprite(registry, 'bone-club', SEED);
      expect(result?.textureKey).toBe('equipment/weapon/baseball-bat');
      expect(_isPlaceholderEntry(result!)).toBe(false);
    });
  });
});

describe('themed equipment art (theme-set registry)', () => {
  // The Classic Fantasy [Basic Leather] wave keys its manifest entries by THEME
  // (`classic-fantasy-basic-leather-wooden-bow`), not by item. Before the
  // shared theme-set registry existed, that art was invisible to the resolver
  // and was force-aliased by a hardcoded helper in the ENGINE layer
  // (`resolveBasicLeatherAliasEntry` in generatedAssets/preload.ts). These tests
  // pin the shared-layer behaviour that replaced it.

  it('emits the themed concept for a themed piece addressed by stable ID', () => {
    expect(itemSpriteConcepts('weapon.wooden-bow')).toContain(
      'classic-fantasy-basic-leather-wooden-bow',
    );
  });

  it('emits the themed concept for a themed piece addressed by its runtimeKey', () => {
    // A generated-equipment instance's frozen artKey IS the runtimeKey, and the
    // panels pass it straight back into resolveItemSprite when no texture is
    // preloaded under that literal key.
    expect(itemSpriteConcepts('equipment/weapon/wooden-bow')).toContain(
      'classic-fantasy-basic-leather-wooden-bow',
    );
  });

  it('emits the themed concept for a legacy catalog item whose slug matches a themed piece', () => {
    // `leather-boots` is a legacy catalog item; `feet.leather-boots` is the
    // themed piece. Sharing the slug is what lets the legacy item pick up the
    // themed art rather than staying on its fetched-icon placeholder.
    expect(itemSpriteConcepts('leather-boots')).toContain(
      'classic-fantasy-basic-leather-leather-boots',
    );
  });

  it('emits NO themed concept for an item outside every theme set', () => {
    expect(itemSpriteConcepts('iron-ore')).toEqual(['iron-ore']);
    expect(
      itemSpriteConcepts('weapon.moon-scythe').some((concept) =>
        concept.startsWith('classic-fantasy-basic-leather-'),
      ),
    ).toBe(false);
  });

  it('orders themed concepts LAST so an item-id match always wins the tie', () => {
    const concepts = itemSpriteConcepts('weapon.wooden-bow');
    const themedIndex = concepts.indexOf('classic-fantasy-basic-leather-wooden-bow');
    expect(themedIndex).toBe(concepts.length - 1);
    expect(concepts[0]).toBe('weapon.wooden-bow');
  });

  it('never emits duplicate concepts', () => {
    const concepts = itemSpriteConcepts('weapon.wooden-bow');
    expect(new Set(concepts).size).toBe(concepts.length);
  });

  it('resolves themed art in preference to a placeholder', () => {
    const registry = makeRegistry([
      placeholder('wooden-bow-placeholder', 'wooden-bow', {
        assetPath: 'generated/wooden-bow-placeholder.png',
      }),
      [
        'classic-fantasy-basic-leather-wooden-bow-var-0',
        'classic-fantasy-basic-leather-wooden-bow',
      ],
    ]);
    const result = resolveItemSprite(registry, 'weapon.wooden-bow', SEED);
    expect(result?.briefId).toBe('classic-fantasy-basic-leather-wooden-bow');
    expect(_isPlaceholderEntry(result!)).toBe(false);
  });

  it("prefers the item's own bare-real art over themed art", () => {
    const registry = makeRegistry([
      [
        'classic-fantasy-basic-leather-wooden-bow-var-0',
        'classic-fantasy-basic-leather-wooden-bow',
      ],
      ['wooden-bow-var-0', 'wooden-bow'],
    ]);
    const result = resolveItemSprite(registry, 'weapon.wooden-bow', SEED);
    expect(result?.briefId).toBe('wooden-bow');
  });

  it("prefers the item's own VERSIONED art over BARE themed art", () => {
    // Provenance must be ranked BEFORE quality tier. If tier came first, a bare
    // themed entry (TIER_BARE_REAL) would outrank the item's own versioned art
    // (TIER_VERSIONED_REAL) and a theme's generic piece would silently replace
    // item-specific art.
    const registry = makeRegistry([
      [
        'classic-fantasy-basic-leather-wooden-bow-var-0',
        'classic-fantasy-basic-leather-wooden-bow',
      ],
      ['wooden-bow-v3-var-0', 'wooden-bow-v3'],
    ]);
    const result = resolveItemSprite(registry, 'weapon.wooden-bow', SEED);
    expect(result?.briefId).toBe('wooden-bow-v3');
  });

  it("prefers themed real art over the item's own placeholder", () => {
    // The other side of the same rank: a placeholder is never coverage, so
    // themed real art must win even though the placeholder matches an earlier
    // concept.
    const registry = makeRegistry([
      placeholder('wooden-bow-placeholder', 'wooden-bow', {
        assetPath: 'generated/wooden-bow-placeholder.png',
      }),
      [
        'classic-fantasy-basic-leather-wooden-bow-var-0',
        'classic-fantasy-basic-leather-wooden-bow',
      ],
    ]);
    const result = resolveItemSprite(registry, 'weapon.wooden-bow', SEED);
    expect(result?.briefId).toBe('classic-fantasy-basic-leather-wooden-bow');
  });

  it('resolves the same themed variant for a given seed across repeated calls and registries', () => {
    const build = () =>
      makeRegistry([
        [
          'classic-fantasy-basic-leather-wooden-bow-var-0',
          'classic-fantasy-basic-leather-wooden-bow',
          { variantIndex: 0 },
        ],
        [
          'classic-fantasy-basic-leather-wooden-bow-var-1',
          'classic-fantasy-basic-leather-wooden-bow',
          { variantIndex: 1 },
        ],
        [
          'classic-fantasy-basic-leather-wooden-bow-var-2',
          'classic-fantasy-basic-leather-wooden-bow',
          { variantIndex: 2 },
        ],
      ]);
    const first = resolveItemSprite(build(), 'weapon.wooden-bow', SEED);
    const second = resolveItemSprite(build(), 'weapon.wooden-bow', SEED);
    expect(first?.textureKey).toBe(second?.textureKey);
    // A different seed is still allowed to pick a different variant, but must
    // itself be stable.
    const other = resolveItemSprite(build(), 'weapon.wooden-bow', SEED + 1);
    expect(other?.textureKey).toBe(
      resolveItemSprite(build(), 'weapon.wooden-bow', SEED + 1)?.textureKey,
    );
  });
});

describe('themedArtConceptsFor', () => {
  it('returns the themed concept for every member of a theme set', () => {
    for (const stableId of FLOOR2_BASIC_LEATHER_STABLE_IDS) {
      const slug = stableId.slice(stableId.indexOf('.') + 1);
      expect(themedArtConceptsFor(stableId)).toContain(`classic-fantasy-basic-leather-${slug}`);
    }
  });

  it('returns an empty list for an unknown key', () => {
    expect(themedArtConceptsFor('definitely-not-a-themed-piece')).toEqual([]);
  });
});

// NOTE: `itemArtIdentitySet` / `canonicalItemBriefId` were removed when the
// repo-wide bare-concept taxonomy superseded ADR 0051's item-only rule. Every
// asset class is now bare-keyed by `bareConcept`, so an item-specific identity
// set no longer has anything to decide. Coverage lives in
// `tests/unit/sprites/sprite-name-taxonomy.test.ts`.
