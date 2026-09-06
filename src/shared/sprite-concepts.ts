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
  const withoutLegacyNpcPrefix = withoutVariant.replace(LEGACY_NPC_PREFIX, '');
  return normalizeSpriteLineageId(withoutLegacyNpcPrefix);
}

const PLACEHOLDER_SUFFIX = /-placeholder$/;

/**
 * Canonical concept key for TOOLING that groups or indexes art by concept
 * (reference selection, the placeholder audit, the sprite backlog).
 *
 * It is deliberately {@link normalizeGeneratedSpriteConceptId} plus the extra
 * tolerance tooling inputs need — a namespaced id (`enemy.slime`), mixed case,
 * or a `-placeholder` stand-in name — so a tooling key and the runtime concept
 * key can never disagree. Sharing one implementation is what keeps the explicit
 * {@link SPRITE_DESIGN_NAME_REMAP} entries (e.g. `angry-roomba-v2` →
 * `angry-roomba-mk2`) honoured by every grouping site: a second, hand-rolled
 * "strip -vN" regex would silently split a remapped design into two concepts,
 * so one side excludes/indexes art the other side does not.
 *
 * For a bare lowercase kebab id this is EXACTLY
 * {@link normalizeGeneratedSpriteConceptId}.
 *
 * Examples:
 *   `slime-queen-var-0`       -> `slime-queen`
 *   `iron-sword-v1`           -> `iron-sword`
 *   `aether-dust-placeholder` -> `aether-dust`
 *   `enemy.slime`             -> `slime`
 *   `npc.guide` / `npc-guide` -> `guide`
 *   `angry-roomba-v2-var-1`   -> `angry-roomba-mk2`
 */
export function normalizeSpriteConceptKey(name: string): string {
  const lastSegment = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const lowered = lastSegment.trim().toLowerCase();
  return normalizeGeneratedSpriteConceptId(lowered).replace(PLACEHOLDER_SUFFIX, '');
}
