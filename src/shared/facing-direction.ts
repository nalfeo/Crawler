/**
 * Shared eight-direction compass facing contract for generated sprite art.
 *
 * Historically the sprite pipeline only supported a binary `'left' | 'right'`
 * static-art facing (used to decide horizontal mirroring at render time). This
 * module introduces the full eight-compass-direction contract while staying
 * backward compatible with every persisted `'left'`/`'right'` value already
 * written to `manifest.json`, run summaries, and postprocess override files.
 *
 * Naming reuses the existing `animation.directions` convention from
 * `generated-assets.ts` (`north`, `northEast`, `east`, `southEast`, `south`,
 * `southWest`, `west`, `northWest`) so both schemas speak the same vocabulary.
 *
 * Layer rule: lives in `src/shared/` so both the Node sprite pipeline
 * (`scripts/sprites/**`) and the browser engine (`src/engine/**`) can import
 * the same type/parsing logic without duplicating it.
 */

/** Canonical eight-direction compass facing value. */
export type CompassDirection =
  | 'north'
  | 'northEast'
  | 'east'
  | 'southEast'
  | 'south'
  | 'southWest'
  | 'west'
  | 'northWest';

/** All canonical compass directions, in clockwise order starting from north. */
export const COMPASS_DIRECTIONS: readonly CompassDirection[] = Object.freeze([
  'north',
  'northEast',
  'east',
  'southEast',
  'south',
  'southWest',
  'west',
  'northWest',
]);

/**
 * Legacy binary facing value. Still accepted at every parsing boundary
 * (persisted JSON, HTTP payloads, manifest entries) and normalized to its
 * compass equivalent: `'left' -> 'west'`, `'right' -> 'east'`.
 */
export type LegacyFacingDirection = 'left' | 'right';

/** Union accepted at parsing boundaries: canonical compass values plus legacy aliases. */
export type FacingDirectionInput = CompassDirection | LegacyFacingDirection;

const LEGACY_ALIAS_MAP: Readonly<Record<LegacyFacingDirection, CompassDirection>> = Object.freeze({
  left: 'west',
  right: 'east',
});

/** Default compass direction used when no facing has ever been set (legacy default was `'right'`). */
export const DEFAULT_COMPASS_DIRECTION: CompassDirection = 'east';

function isLegacyFacingDirection(value: unknown): value is LegacyFacingDirection {
  return value === 'left' || value === 'right';
}

function isCompassDirection(value: unknown): value is CompassDirection {
  return typeof value === 'string' && COMPASS_DIRECTIONS.includes(value as CompassDirection);
}

/**
 * Type guard accepting both canonical compass directions and legacy
 * `'left'`/`'right'` aliases — use at every untrusted-input parsing boundary
 * (HTTP bodies, persisted JSON) before calling {@link normalizeCompassDirection}.
 */
export function isFacingDirectionInput(value: unknown): value is FacingDirectionInput {
  return isCompassDirection(value) || isLegacyFacingDirection(value);
}

/**
 * Normalize any accepted facing input (canonical compass value or legacy
 * `'left'`/`'right'` alias) to its canonical {@link CompassDirection}.
 * Returns `null` for anything else so callers can decide how to handle
 * invalid input (reject vs. fall back to a default).
 */
export function normalizeCompassDirection(value: unknown): CompassDirection | null {
  if (isCompassDirection(value)) return value;
  if (isLegacyFacingDirection(value)) return LEGACY_ALIAS_MAP[value];
  return null;
}

/**
 * Whether a compass direction has an "eastward" horizontal component, for
 * legacy binary-mirror render logic that only distinguishes left/right-facing
 * art. `north` and `south` (no horizontal component) are treated as
 * east-leaning, matching the pre-migration default of `'right'`.
 */
export function compassDirectionFacesEast(direction: CompassDirection): boolean {
  return (
    direction === 'east' ||
    direction === 'northEast' ||
    direction === 'southEast' ||
    direction === 'north' ||
    direction === 'south'
  );
}

/** Convert a canonical compass direction back to the legacy binary alias, for callers/serializers that still speak left/right (e.g. render-time mirroring). */
export function compassDirectionToLegacy(direction: CompassDirection): LegacyFacingDirection {
  return compassDirectionFacesEast(direction) ? 'right' : 'left';
}

/** Human-readable label for UI dropdowns, e.g. `'northEast' -> 'Northeast'`. */
export const COMPASS_DIRECTION_LABELS: Readonly<Record<CompassDirection, string>> = Object.freeze({
  north: 'North',
  northEast: 'Northeast',
  east: 'East',
  southEast: 'Southeast',
  south: 'South',
  southWest: 'Southwest',
  west: 'West',
  northWest: 'Northwest',
});
