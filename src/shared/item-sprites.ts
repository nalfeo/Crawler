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
import { ITEM_CATALOG } from './items.js';
import { SeededRandom } from './random.js';

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

/** Escape a concept for safe use inside a RegExp (item ids are kebab-case, but be safe). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * If `briefId` names `concept` — either bare (`concept`) or versioned
 * (`concept-vN`) — return the match with its parsed version; otherwise null.
 */
function matchConcept(
  briefId: string,
  concept: string,
): { readonly bare: boolean; readonly version: number } | null {
  if (briefId === concept) {
    return { bare: true, version: 0 };
  }
  const match = new RegExp(`^${escapeRegExp(concept)}-v(\\d+)$`).exec(briefId);
  if (match) {
    return { bare: false, version: Number(match[1]) };
  }
  return null;
}

/**
 * Candidate concepts for an item, in preference order: the item id first, then
 * its equipment `weaponId` alias (e.g. `bone-club` → `baseball-bat`) when it
 * differs. Weapon-less items resolve by id alone.
 */
export function itemSpriteConcepts(itemId: string): readonly string[] {
  const weaponId = getEquipmentDefForItem(itemId)?.weaponId;
  return weaponId !== undefined && weaponId !== itemId ? [itemId, weaponId] : [itemId];
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
export function itemArtIdentitySet(): ReadonlySet<string> {
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
 * Resolve the generated sprite for an inventory item, preferring its REAL
 * approved art over any placeholder, deterministically for a given `seed`.
 *
 * Returns null when neither the item id nor its weaponId has any generated art.
 * Pass a stable per-(item, run) seed — e.g. `hashStringToSeed(itemId) ^
 * worldSeed` — so the item keeps one variant for a whole run.
 */
export function resolveItemSprite(
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
