import { describe, expect, it } from 'vitest';

import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import {
  canonicalItemBriefId,
  isPlaceholderEntry,
  itemArtIdentitySet,
  itemSpriteConcepts,
  resolveItemSprite,
} from '../../src/shared/item-sprites.js';

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

describe('isPlaceholderEntry', () => {
  it('flags entries whose sourceRun is placeholder', () => {
    const registry = makeRegistry([placeholder('iron-ore-placeholder', 'iron-ore')]);
    expect(isPlaceholderEntry(registry.entries()[0]!)).toBe(true);
  });

  it('flags entries whose assetPath ends with -placeholder.png even if sourceRun differs', () => {
    const registry = makeRegistry([
      [
        'iron-ore-placeholder',
        'iron-ore',
        { assetPath: 'assets/generated/iron-ore-placeholder.png' },
      ],
    ]);
    expect(isPlaceholderEntry(registry.entries()[0]!)).toBe(true);
  });

  it('does not flag real approved art', () => {
    const registry = makeRegistry([['iron-ore-var-0', 'iron-ore']]);
    expect(isPlaceholderEntry(registry.entries()[0]!)).toBe(false);
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
    expect(isPlaceholderEntry(result!)).toBe(false);
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
    expect(isPlaceholderEntry(result!)).toBe(true);
  });

  describe('cross-concept (weaponId) resolution — bone-club → baseball-bat', () => {
    it('crosses to the weaponId real art instead of the item-concept placeholder', () => {
      const registry = makeRegistry([
        placeholder('bone-club-placeholder', 'bone-club'),
        ['baseball-bat-v1-var-0', 'baseball-bat-v1'],
      ]);
      const result = resolveItemSprite(registry, 'bone-club', SEED);
      expect(result?.textureKey).toBe('baseball-bat-v1-var-0');
      expect(isPlaceholderEntry(result!)).toBe(false);
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
      expect(isPlaceholderEntry(result!)).toBe(false);
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
      expect(isPlaceholderEntry(result!)).toBe(false);
    });
  });
});

describe('itemArtIdentitySet', () => {
  const identity = itemArtIdentitySet();

  it('includes plain item ids across types (material, weapon, character-art item)', () => {
    // Spans multiple sprite `type`s on purpose — the set is keyed on gameplay
    // item identity, not sprite `type` (classified-dossier art is `character`).
    expect(identity.has('iron-ore')).toBe(true); // material
    expect(identity.has('flame-dagger')).toBe(true); // weapon-typed item
    expect(identity.has('throwing-knife')).toBe(true); // starter weapon item
    expect(identity.has('fireball')).toBe(true); // starter weapon item
    expect(identity.has('classified-dossier')).toBe(true); // character-typed art
    expect(identity.has('bone-club')).toBe(true); // the bat item id
  });

  it('includes weaponId aliases that are not themselves item ids (baseball-bat)', () => {
    // `baseball-bat` is the bone-club weaponId, not an ItemDef.id — it must still
    // be an item identity so `baseball-bat-vN` art is normalized to bare.
    expect(identity.has('baseball-bat')).toBe(true);
    expect(itemSpriteConcepts('bone-club')).toContain('baseball-bat');
  });

  it('excludes non-item concepts (enemies, set-pieces)', () => {
    expect(identity.has('angry-roomba')).toBe(false);
    expect(identity.has('rat')).toBe(false);
    expect(identity.has('welcome-sign-left')).toBe(false);
  });

  it('excludes harvestable world-node ids (they ship VERSIONED, not bare) — guardrail', () => {
    // Harvestable materials (azure-mushroom, etc.) ARE Materials ItemDefs, but
    // their art is a versioned world-node key owned by the harvestable render
    // path (mirrors the enemy pinned-key contract). They must NOT be item
    // art-naming identities, or the approve-time recurrence guard would bare-key
    // `azure-mushroom-v1` and break that live lane.
    expect(identity.has('azure-mushroom')).toBe(false);
    expect(identity.has('crimson-mushroom')).toBe(false);
    expect(identity.has('sunpetal-flower')).toBe(false);
    expect(identity.has('frost-lichen')).toBe(false);
  });
});

describe('canonicalItemBriefId', () => {
  const identity = itemArtIdentitySet();

  it('strips a single trailing -vN for a weapon-typed item', () => {
    expect(canonicalItemBriefId('flame-dagger-v2', identity)).toBe('flame-dagger');
    expect(canonicalItemBriefId('fireball-v1', identity)).toBe('fireball');
  });

  it('strips -vN for character-typed item art (classified-dossier)', () => {
    expect(canonicalItemBriefId('classified-dossier-v1', identity)).toBe('classified-dossier');
  });

  it('strips -vN for a weaponId alias that is not an ItemDef.id (baseball-bat)', () => {
    expect(canonicalItemBriefId('baseball-bat-v1', identity)).toBe('baseball-bat');
    expect(canonicalItemBriefId('baseball-bat-v3', identity)).toBe('baseball-bat');
  });

  it('leaves genuinely non-item versioned concepts versioned', () => {
    expect(canonicalItemBriefId('angry-roomba-v2', identity)).toBe('angry-roomba-v2');
    expect(canonicalItemBriefId('rat-v1', identity)).toBe('rat-v1');
    expect(canonicalItemBriefId('welcome-sign-left-v2', identity)).toBe('welcome-sign-left-v2');
  });

  it('leaves harvestable world-node -vN briefs versioned (guardrail)', () => {
    // The approve recurrence guard must never canonicalize a harvestable
    // world-node brief to bare — `azure-mushroom-v1` stays `azure-mushroom-v1`
    // so the harvestable render path keeps its versioned key.
    expect(canonicalItemBriefId('azure-mushroom-v1', identity)).toBe('azure-mushroom-v1');
    expect(canonicalItemBriefId('crimson-mushroom-v2', identity)).toBe('crimson-mushroom-v2');
  });

  it('is a no-op for an already-bare item id', () => {
    expect(canonicalItemBriefId('iron-ore', identity)).toBe('iron-ore');
    expect(canonicalItemBriefId('classified-dossier', identity)).toBe('classified-dossier');
  });

  it('only strips a single trailing -vN (base must itself be an item identity)', () => {
    // `iron-ore-v1` base is `iron-ore-v1`, not an identity → left unchanged.
    expect(canonicalItemBriefId('iron-ore-v1-v2', identity)).toBe('iron-ore-v1-v2');
    // Non-versioned non-item name is untouched.
    expect(canonicalItemBriefId('goblin', identity)).toBe('goblin');
  });
});
