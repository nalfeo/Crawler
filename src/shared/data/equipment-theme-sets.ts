/**
 * Equipment **theme sets** — the shared-layer registry that lets themed art
 * resolve for the equipment it belongs to.
 *
 * ## The problem this exists to solve
 *
 * The sprite pipeline keys a themed art wave by the theme, not by the item:
 * the Classic Fantasy [Basic Leather] wooden bow ships as
 * `classic-fantasy-basic-leather-wooden-bow-v1`, NOT as `wooden-bow-v1`. But
 * `resolveItemSprite` derives its candidate concepts from gameplay identity
 * (item id, `weaponId` alias, Floor 2 slug, Floor 2 `runtimeKey`) and so never
 * looks at a theme-prefixed key. Every piece in a themed wave therefore reads
 * as un-arted to the resolver even when its art is approved and committed.
 *
 * That gap was previously patched in the ENGINE layer: `preload.ts` carried a
 * `resolveBasicLeatherAliasEntry` helper that hardcoded the string
 * `classic-fantasy-basic-leather` and force-aliased that one theme's assets
 * onto their runtime keys. It worked for exactly one theme, and every
 * subsequent theme would have needed its own copy of that hack — the recurring
 * "wire up theme X" change this registry removes the need for.
 *
 * ## The contract
 *
 * A theme set is `(themeId, stableIds)`. For each member stable ID the themed
 * art concept is `<themeId>-<slug>`, where `<slug>` is the stable ID's slug
 * (`weapon.wooden-bow` → `wooden-bow`). Manifest entries then match through
 * the resolver's ordinary versioned-concept path (`<concept>-vN`), so themed
 * art is ranked by the SAME tier rules as everything else:
 * bare-real > versioned-real > placeholder. Themed concepts are appended last
 * in the concept list, so they lose ties to an item's own art but still beat a
 * placeholder — which is exactly the desired precedence.
 *
 * ## Adding a theme
 *
 * Append one row to {@link EQUIPMENT_THEME_SETS} whose `stableIds` come from
 * that wave's own catalog export. No engine change, no resolver change, and no
 * literal theme id anywhere outside this file.
 *
 * Layer: pure `src/shared` — no Phaser, no IO, no world mutation.
 */
import { FLOOR2_BASIC_LEATHER_STABLE_IDS } from './floor2-basic-leather-bases.js';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  type Floor2EquipmentStableId,
} from './floor2-equipment-art.js';

/** One themed art wave: a theme id plus the equipment stable IDs it covers. */
export interface EquipmentThemeSet {
  /**
   * Art-pipeline theme id — the literal prefix its manifest brief IDs carry
   * (e.g. `classic-fantasy-basic-leather` for
   * `classic-fantasy-basic-leather-wooden-bow-v1`).
   */
  readonly themeId: string;
  /** Equipment stable IDs whose art shipped under this theme. */
  readonly stableIds: readonly Floor2EquipmentStableId[];
}

/**
 * Every themed equipment art wave known to the game.
 *
 * Each row's `stableIds` is taken from the wave's own catalog export rather
 * than re-listed here, so a change to that catalog cannot drift from the art
 * wiring.
 *
 * **Overlap policy: array order is priority.** A piece may legitimately appear
 * in more than one theme (a slug can be re-arted by a later wave), and one item
 * can only render one sprite, so a winner must be picked. Earlier rows win,
 * because `themedArtConceptsFor` returns concepts in registry order and the
 * resolver breaks ties on `conceptOrder`. This is deliberate and deterministic:
 * to promote a newer wave over an older one for a shared piece, move its row
 * UP, do not rely on insertion recency.
 */
export const EQUIPMENT_THEME_SETS: readonly EquipmentThemeSet[] = Object.freeze([
  Object.freeze({
    themeId: 'classic-fantasy-basic-leather',
    stableIds: FLOOR2_BASIC_LEATHER_STABLE_IDS,
  }),
]);

/**
 * Lazily built index from every lookup key that can name a themed piece to its
 * themed art concepts.
 *
 * Three key shapes are indexed because all three reach the resolver in
 * production:
 *
 *  - the **stable ID** (`weapon.wooden-bow`) — generated-equipment bases and
 *    the Floor 2 reward pool address gear this way;
 *  - the **slug** (`wooden-bow`) — the legacy inventory catalog's item ids and
 *    weapon ids use the bare slug, so a legacy item whose slug matches a themed
 *    piece resolves that theme's art;
 *  - the **runtime key** (`equipment/weapon/wooden-bow`) — a generated-equipment
 *    instance's frozen `artKey`, which the equipment/inventory panels pass
 *    straight back into `resolveItemSprite` when no texture is preloaded under
 *    that literal key.
 *
 * A key that somehow belongs to two themes accumulates both concepts in
 * registry order, so the ranking stays deterministic rather than
 * last-write-wins.
 */
let themedConceptIndex: ReadonlyMap<string, readonly string[]> | null = null;

function addConcept(index: Map<string, string[]>, key: string, concept: string): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [concept]);
    return;
  }
  if (!existing.includes(concept)) {
    existing.push(concept);
  }
}

function buildThemedConceptIndex(): ReadonlyMap<string, readonly string[]> {
  const runtimeKeyByStableId = new Map<string, string>(
    FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((definition) => [
      definition.stableId,
      definition.runtimeKey,
    ]),
  );
  const index = new Map<string, string[]>();
  for (const themeSet of EQUIPMENT_THEME_SETS) {
    for (const stableId of themeSet.stableIds) {
      const slug = stableId.slice(stableId.indexOf('.') + 1);
      const concept = `${themeSet.themeId}-${slug}`;
      addConcept(index, stableId, concept);
      addConcept(index, slug, concept);
      const runtimeKey = runtimeKeyByStableId.get(stableId);
      if (runtimeKey !== undefined) {
        addConcept(index, runtimeKey, concept);
      }
    }
  }
  return index;
}

function getThemedConceptIndex(): ReadonlyMap<string, readonly string[]> {
  if (themedConceptIndex === null) {
    themedConceptIndex = buildThemedConceptIndex();
  }
  return themedConceptIndex;
}

/** Empty result shared by every miss, so a lookup never allocates. */
const NO_CONCEPTS: readonly string[] = Object.freeze([]);

/**
 * Themed art concepts for a lookup key — its stable ID, slug, or runtime key.
 * Returns an empty array when the key belongs to no themed wave.
 */
export function themedArtConceptsFor(key: string): readonly string[] {
  return getThemedConceptIndex().get(key) ?? NO_CONCEPTS;
}
