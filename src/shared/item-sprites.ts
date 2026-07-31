/**
 * Item-sprite resolution — maps an inventory item id to its **real generated
 * sprite**, preferring approved art over the 2-character placeholder whenever
 * real art exists.
 *
 * Why this is not just `pickGeneratedVariant(registry, itemId, …)`:
 *
 *   - The sprite pipeline bakes the generation version into a manifest entry's
 *     `briefId` (real `iron-ore` art has `briefId: 'iron-ore-v1'`), while the
 *     placeholder keeps the bare `briefId: 'iron-ore'`. A bare-id lookup would
 *     therefore match the *placeholder*, never the real art.
 *   - The bat's inventory item id is `bone-club`, but its art is keyed
 *     `baseball-bat-*` (via the equipment `weaponId`). Resolution must be able
 *     to cross from the item id to its weapon-id alias.
 *
 * So this resolver gathers candidates across BOTH the item id and its
 * `weaponId`, then ranks the whole pool GLOBALLY by quality tier
 * (bare-real > versioned-real > placeholder) so a real weapon-id match always
 * beats an item-concept placeholder. Ties break deterministically
 * (real-anchor → lower version → item-id over weapon-id → seeded pick), so the
 * same item shows the same variant for a whole run while still varying across
 * items/runs.
 *
 * The generic registry (`lookup`/`variants`/`pickGeneratedVariant`) is left
 * untouched — enemy/tile/set-piece resolution is unaffected. See
 * ADR 0051 (item sprites resolve by item id).
 *
 * Layer: pure `src/shared` — no Phaser, no world mutation, randomness only via
 * `SeededRandom`.
 */
import { getEquipmentDefForItem, getEquippableItemIds } from './equipmentDefs.js';
import type { GeneratedSpriteEntry, GeneratedSpriteRegistry } from './generated-assets.js';
import { HARVESTABLE_DEFS } from './harvestableDefs.js';
import { ITEM_CATALOG } from './items.js';
import { SeededRandom } from './random.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from './data/floor2-equipment-art.js';

/** Quality tiers for a candidate entry; lower is preferred. */
const TIER_BARE_REAL = 0;
const TIER_VERSIONED_REAL = 1;
const TIER_PLACEHOLDER = 2;

/** A manifest entry paired with the deterministic keys used to rank item art. */
interface ScoredCandidate {
  readonly entry: GeneratedSpriteEntry;
  readonly tier: number;
  /** Parsed `-vN` version (0 when the briefId is bare). Lower wins within a tier. */
  readonly version: number;
  /** 0 = matched via the item id, 1 = matched via the weaponId. Item id wins ties. */
  readonly conceptOrder: number;
}

/**
 * True when an entry is a placeholder (not real approved art). Keyed on the
 * pipeline's own signals, never on sprite `type` (real `classified-dossier`
 * art is typed `character`, so `type` is not a reliable discriminator).
 */
export function isPlaceholderEntry(entry: GeneratedSpriteEntry): boolean {
  return entry.sourceRun === 'placeholder' || entry.assetPath.endsWith('-placeholder.png');
}

/**
 * If `briefId` names `concept` — either bare (`concept`) or versioned
 * (`concept-vN`) — return the match with its parsed version; otherwise null.
 *
 * Uses a `startsWith` + digit scan rather than a compiled RegExp: this runs
 * inside `resolveItemSprite`'s per-entry loop (invoked per inventory slot on the
 * open-panel refresh), so avoiding RegExp allocation/execution keeps the hot
 * path allocation-free. Semantics are exactly `^<concept>-v(\d+)$`.
 */
function matchConcept(
  briefId: string,
  concept: string,
): { readonly bare: boolean; readonly version: number } | null {
  if (briefId === concept) {
    return { bare: true, version: 0 };
  }
  const prefix = `${concept}-v`;
  if (!briefId.startsWith(prefix)) {
    return null;
  }
  const digits = briefId.slice(prefix.length);
  if (digits.length === 0) {
    return null;
  }
  for (let i = 0; i < digits.length; i++) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) {
      return null;
    }
  }
  return { bare: false, version: Number(digits) };
}

/**
 * Lazy map from item identifier to its Floor 2 equipment `runtimeKey`
 * (e.g. `'equipment/weapon/iron-cleaver'`). Indexed by BOTH the bare slug
 * (e.g. `'iron-cleaver'`) AND the full stableId (e.g. `'weapon.iron-cleaver'`)
 * so that all three production ID shapes resolve correctly:
 *
 *  - Wave A: `id = 'weapon.iron-cleaver'`; Wave A equipment defs are NOT
 *    registered in `getEquipmentDefForItem`, so resolution relies on the
 *    stableId → runtimeKey entry here.
 *  - Wave B: `id = weaponId = 'weapon.moon-scythe'`; same stableId path.
 *  - Non-weapon: `id = 'torso.chain-hauberk'`, no weaponId; stableId path.
 */
let floor2SlugToRuntimeKey: ReadonlyMap<string, string> | null = null;

function getFloor2SlugToRuntimeKey(): ReadonlyMap<string, string> {
  if (floor2SlugToRuntimeKey !== null) {
    return floor2SlugToRuntimeKey;
  }
  const map = new Map<string, string>();
  for (const def of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
    const dot = def.stableId.indexOf('.');
    const slug = def.stableId.slice(dot + 1);
    map.set(slug, def.runtimeKey);
    // Also index by the full stableId so Wave B items (whose EquipmentItemDef.id
    // IS the stableId, e.g. `weapon.moon-scythe`) and non-weapon gear (e.g.
    // `torso.chain-hauberk`) resolve their runtimeKey from the itemId path.
    map.set(def.stableId, def.runtimeKey);
  }
  floor2SlugToRuntimeKey = map;
  return map;
}

/**
 * Candidate concepts for an item, in preference order:
 *  1. The item id itself (e.g. `weapon.moon-scythe` for a Wave B weapon,
 *     `torso.chain-hauberk` for non-weapon gear).
 *  2. Its equipment `weaponId` alias (e.g. `bone-club` → `baseball-bat`) when
 *     it differs from the item id.
 *  3. For any concept that maps to a Floor 2 base, the bare slug derived from
 *     the runtimeKey (e.g. `moon-scythe` from `equipment/weapon/moon-scythe`)
 *     so that legacy versioned entries keyed by slug (e.g. `moon-scythe-v2`)
 *     are still found.
 *  4. The Floor 2 `runtimeKey` itself (e.g. `equipment/weapon/moon-scythe`) so
 *     wiring entries whose `briefId` is the full path are matched. These are
 *     bare-real (TIER_BARE_REAL) and outrank any slug-keyed versioned entry in
 *     the same pool, so priority remains correct without needing a special order.
 *
 * Duplicates are suppressed so slug and stableId both resolving the same key
 * don't produce two identical concepts.
 */
export function itemSpriteConcepts(itemId: string): readonly string[] {
  const weaponId = getEquipmentDefForItem(itemId)?.weaponId;
  const base: readonly string[] =
    weaponId !== undefined && weaponId !== itemId ? [itemId, weaponId] : [itemId];

  const f2 = getFloor2SlugToRuntimeKey();
  const extra: string[] = [];
  const seen = new Set<string>(base);
  for (const concept of base) {
    const runtimeKey = f2.get(concept);
    if (runtimeKey !== undefined) {
      // Also push the bare slug (last path segment of runtimeKey) so legacy
      // versioned entries are still found (e.g. `chain-hauberk` for `chain-hauberk-v3`).
      const slug = runtimeKey.slice(runtimeKey.lastIndexOf('/') + 1);
      if (!seen.has(slug)) {
        extra.push(slug);
        seen.add(slug);
      }
      if (!seen.has(runtimeKey)) {
        extra.push(runtimeKey);
        seen.add(runtimeKey);
      }
    }
  }
  return extra.length > 0 ? [...base, ...extra] : base;
}

/**
 * The set of names that identify a **gameplay item** for art-naming purposes:
 * every `ItemDef.id` plus every equipment `weaponId` alias (e.g. `baseball-bat`,
 * which backs the `bone-club` item). Art approved for any of these concepts must
 * be keyed BARE (`<name>-var-N`), never versioned (`<name>-vN-var-N`) — the
 * `-vN` lineage tag is a generation-time concern that must not leak into an
 * item's consumer-facing key (items resolve by item id; ADR 0051).
 *
 * This is keyed on gameplay identity, NOT sprite `type`: the item set spans
 * `material`/`weapon`/`consumable`/… `type`s and even `character`-typed art
 * (`classified-dossier`), so a `type === 'item'` gate would miss exactly the
 * concepts being normalized.
 */
let cachedItemArtIdentitySet: ReadonlySet<string> | null = null;

export function itemArtIdentitySet(): ReadonlySet<string> {
  if (cachedItemArtIdentitySet !== null) {
    return cachedItemArtIdentitySet;
  }
  const identity = new Set<string>();
  for (const item of ITEM_CATALOG) {
    identity.add(item.id);
  }
  for (const itemId of getEquippableItemIds()) {
    const weaponId = getEquipmentDefForItem(itemId)?.weaponId;
    if (weaponId !== undefined) {
      identity.add(weaponId);
    }
  }
  // Harvestable world-node ids (e.g. `azure-mushroom`) also register as Materials
  // ItemDefs, but their generated art ships as a VERSIONED world-node key
  // (`<id>-vN`) owned by the harvestable render path — the same pinned-key
  // contract enemies use, NOT the bare item-icon contract (ADR 0051). Excluding
  // them here keeps the approve-time recurrence guard from bare-keying (and thus
  // colliding with / breaking) that live world-node art. The inventory Materials
  // icon still resolves fine: `resolveItemSprite` is version-tolerant and matches
  // the versioned key at runtime regardless of this set.
  //
  // Only exclude the itemId when it equals the harvestable node id (e.g.
  // `azure-mushroom` → `azure-mushroom`). When they differ (e.g. `iron-vein` →
  // `iron-ore`), the item ships its own separate icon art and must stay in the
  // identity set so it is bare-keyed normally.
  for (const harvestable of HARVESTABLE_DEFS) {
    if (harvestable.itemId === harvestable.id) {
      identity.delete(harvestable.itemId);
    }
  }
  cachedItemArtIdentitySet = identity;
  return identity;
}

/**
 * Canonicalize a brief/sprite name for an item concept: when `briefId` is
 * `<base>-vN` and `<base>` is a known item identity (see `itemArtIdentitySet`),
 * strip the trailing `-vN` and return the bare `<base>`; otherwise return
 * `briefId` unchanged. This is what keeps approve-time item art bare so it
 * resolves by item id, while genuinely non-item concepts (enemies, tiles,
 * props) keep their `-vN` lineage. Only a single trailing `-vN` is stripped.
 */
export function canonicalItemBriefId(briefId: string, identity: ReadonlySet<string>): string {
  const match = /^(.+)-v\d+$/.exec(briefId);
  if (match !== null && identity.has(match[1]!)) {
    return match[1]!;
  }
  return briefId;
}

/**
 * Total order within a tier: real anchor first, then lower version, then item
 * id over weaponId, then the registry's own variant order (variantIndex,
 * textureKey) so the leading equal-group is well-defined and the seeded pick is
 * independent of manifest iteration order.
 */
function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  const anchorA = a.entry.anchorIsDefault ? 1 : 0;
  const anchorB = b.entry.anchorIsDefault ? 1 : 0;
  if (anchorA !== anchorB) {
    return anchorA - anchorB;
  }
  if (a.version !== b.version) {
    return a.version - b.version;
  }
  if (a.conceptOrder !== b.conceptOrder) {
    return a.conceptOrder - b.conceptOrder;
  }
  if (a.entry.variantIndex !== b.entry.variantIndex) {
    return a.entry.variantIndex - b.entry.variantIndex;
  }
  if (a.entry.textureKey < b.entry.textureKey) return -1;
  if (a.entry.textureKey > b.entry.textureKey) return 1;
  return 0;
}

/**
 * Per-registry memo of resolved item art. Resolution is deterministic per
 * `(itemId, seed)` and `seed` is fixed for a whole run, but the open inventory /
 * equipment panels call this once per slot on their every-frame refresh — so
 * without a cache each frame re-scans all manifest entries for every slot. The
 * registry is a boot-set singleton (stable object identity per run), so a WeakMap
 * keyed on it memoizes cleanly and is GC'd with the registry; test registries key
 * their own caches. `null` is a real (no-art) result, so membership uses `has`.
 */
const resolvedItemSpriteCache = new WeakMap<
  GeneratedSpriteRegistry,
  Map<string, GeneratedSpriteEntry | null>
>();

/**
 * Resolve the generated sprite for an inventory item, preferring its REAL
 * approved art over any placeholder, deterministically for a given `seed`.
 *
 * Returns null only when neither the item id nor its weaponId matches any
 * generated entry at all; when the sole match is a placeholder, that placeholder
 * is returned (real art is merely preferred). Pass a stable per-(item, run) seed
 * — e.g. `hashStringToSeed(itemId) ^ worldSeed` — so the item keeps one variant
 * for a whole run.
 */
export function resolveItemSprite(
  registry: GeneratedSpriteRegistry,
  itemId: string,
  seed: number,
): GeneratedSpriteEntry | null {
  let perRegistry = resolvedItemSpriteCache.get(registry);
  if (perRegistry === undefined) {
    perRegistry = new Map();
    resolvedItemSpriteCache.set(registry, perRegistry);
  }
  const cacheKey = `${itemId}\u0000${seed}`;
  if (perRegistry.has(cacheKey)) {
    return perRegistry.get(cacheKey) ?? null;
  }
  const resolved = computeItemSprite(registry, itemId, seed);
  perRegistry.set(cacheKey, resolved);
  return resolved;
}

/** Uncached resolution — see `resolveItemSprite`. */
function computeItemSprite(
  registry: GeneratedSpriteRegistry,
  itemId: string,
  seed: number,
): GeneratedSpriteEntry | null {
  const concepts = itemSpriteConcepts(itemId);
  const scored: ScoredCandidate[] = [];
  for (const entry of registry.entries()) {
    for (let conceptOrder = 0; conceptOrder < concepts.length; conceptOrder++) {
      const match = matchConcept(entry.briefId, concepts[conceptOrder]!);
      if (match === null) {
        continue;
      }
      const tier = isPlaceholderEntry(entry)
        ? TIER_PLACEHOLDER
        : match.bare
          ? TIER_BARE_REAL
          : TIER_VERSIONED_REAL;
      scored.push({ entry, tier, version: match.version, conceptOrder });
      break; // an entry counts once, against its best (earliest) concept
    }
  }
  if (scored.length === 0) {
    return null;
  }

  const bestTier = scored.reduce((min, s) => (s.tier < min ? s.tier : min), TIER_PLACEHOLDER);
  const tierCandidates = scored.filter((s) => s.tier === bestTier).sort(compareCandidates);

  // The leading group that is equally good on every deterministic key holds
  // interchangeable variants — seed-pick among them so the choice varies per
  // (item, run) yet stays stable for a whole run.
  const head = tierCandidates[0]!;
  const equallyGood = tierCandidates.filter(
    (s) =>
      s.entry.anchorIsDefault === head.entry.anchorIsDefault &&
      s.version === head.version &&
      s.conceptOrder === head.conceptOrder,
  );
  const chosen =
    equallyGood.length === 1 ? equallyGood[0]! : new SeededRandom(seed).pick(equallyGood);
  return chosen.entry;
}
