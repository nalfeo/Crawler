/**
 * Canonical sprite-type vocabulary — the single source of truth for the six
 * concept families every sprite belongs to.
 *
 * Lives in `src/shared/` (engine-portable, no Phaser) so both the engine-facing
 * generated-asset schema (`generated-assets.ts`) and the Node-side sprite
 * tooling (`scripts/sprites/**`) validate against the *same* list. Scripts may
 * import from `src/shared`; the reverse is banned by the layer rules, so this is
 * the correct home. `scripts/sprites/brief-schema.ts` re-exports `SPRITE_TYPES`
 * from here, keeping its existing importers unchanged.
 */

export const SPRITE_TYPES = [
  'weapon',
  'equipment',
  'enemy',
  'item',
  'prop',
  'tile',
  'vfx',
  'character',
  'icon',
] as const;

export type SpriteType = (typeof SPRITE_TYPES)[number];

/** Type guard: true when `value` is one of the canonical sprite types. */
export function isSpriteType(value: unknown): value is SpriteType {
  return typeof value === 'string' && (SPRITE_TYPES as readonly string[]).includes(value);
}

/**
 * Normalize a free-form type string to a canonical `SpriteType`, or `null` when
 * it isn't one. Trims + lowercases first so `"Item"` / `" enemy "` resolve.
 * Used by the manifest `type` writers (approve + backfill) so only valid types
 * ever land on a manifest entry.
 */
export function toSpriteType(value: string | null | undefined): SpriteType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isSpriteType(normalized) ? normalized : null;
}
