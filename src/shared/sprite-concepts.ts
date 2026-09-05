/**
 * Design-name remaps applied before and after generation-lineage stripping.
 * Keep this map shared so runtime grouping and sprite tooling cannot disagree.
 */
export const SPRITE_DESIGN_NAME_REMAP: Readonly<Record<string, string>> = {
  'angry-roomba-v2': 'angry-roomba-mk2',
};

const LINEAGE_TAG = /^(.+)-v\d+$/;
const VARIANT_SUFFIX = /-var-\d+$/;
const LEGACY_NPC_PREFIX = /^npc-/;

/** Strip one trailing generation-lineage tag while preserving design remaps. */
export function normalizeSpriteLineageId(id: string): string {
  const direct = SPRITE_DESIGN_NAME_REMAP[id];
  if (direct !== undefined) return direct;
  const match = LINEAGE_TAG.exec(id);
  const stripped = match !== null ? match[1]! : id;
  return SPRITE_DESIGN_NAME_REMAP[stripped] ?? stripped;
}

/** True when stripping one lineage tag leaves another malformed tag behind. */
export function hasResidualSpriteLineageTag(id: string): boolean {
  return LINEAGE_TAG.test(normalizeSpriteLineageId(id));
}

/** True when an id still carries a generation-lineage tag. */
export function hasSpriteLineageTag(id: string): boolean {
  return normalizeSpriteLineageId(id) !== id;
}

/**
 * Normalize a concrete runtime sprite ID to its variant-selectable concept.
 *
 * Exact NPC and set-piece pins remain concrete texture keys at their call
 * sites. This helper is only for pools that explicitly opt into variant
 * selection.
 */
export function normalizeGeneratedSpriteConceptId(id: string): string {
  const withoutVariant = id.replace(VARIANT_SUFFIX, '');
  return normalizeSpriteLineageId(withoutVariant).replace(LEGACY_NPC_PREFIX, '');
}
