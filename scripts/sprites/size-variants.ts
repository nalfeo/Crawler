/**
 * Size variants for sprite briefs.
 *
 * A sprite's *type* (weapon, enemy, item, …) fixes its house-style defaults —
 * palette, references, anchor, native canvas, and a base output size. Every
 * per-type default is square today (e.g. 64×64). A *size variant* is an
 * orthogonal authoring axis that scales those per-type defaults so the same
 * type can be emitted at a different footprint or aspect ratio without
 * hand-editing `size` / `anchor` / `nativeCanvas` on each brief:
 *
 *   default — 1× width, 1× height (the per-type base size)
 *   wide    — 2× width, 1× height (landscape)
 *   tall    — 1× width, 2× height (portrait)
 *   large   — 2× width, 2× height (bigger, same square aspect)
 *
 * Scaling is applied to the per-type DEFAULTS *before* the minimal brief's
 * explicit overrides are merged on top (see `mergeMinimalIntoDefaults`), so an
 * author can still pin an exact `size` / `anchor` and win over the variant —
 * the variant only stretches inherited defaults.
 *
 * This module is intentionally dependency-free (it must NOT import the brief
 * schema) so `brief-schema.ts` can import `SIZE_VARIANTS` from here without an
 * import cycle.
 */

export const SIZE_VARIANTS = ['default', 'wide', 'tall', 'large'] as const;

export type SizeVariant = (typeof SIZE_VARIANTS)[number];

export const DEFAULT_SIZE_VARIANT: SizeVariant = 'default';

interface SizeMultiplier {
  readonly width: number;
  readonly height: number;
}

/** Per-variant width/height multipliers applied to the per-type base size. */
export const SIZE_VARIANT_MULTIPLIERS: Readonly<Record<SizeVariant, SizeMultiplier>> = {
  default: { width: 1, height: 1 },
  wide: { width: 2, height: 1 },
  tall: { width: 1, height: 2 },
  large: { width: 2, height: 2 },
};

/**
 * Upper bound for the supersampled native canvas after scaling. The brief
 * schema caps `generation.sheet.nativeCanvas` at 2048; scaling the default
 * 1024 by 2 lands exactly on the cap, and 2048 stays evenly divisible by the
 * default 4×4 grid (256 → 512 cells).
 */
export const MAX_NATIVE_CANVAS = 2048;

export function isSizeVariant(value: unknown): value is SizeVariant {
  return typeof value === 'string' && (SIZE_VARIANTS as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted value (a YAML `sizeVariant` field or a `--size` CLI flag)
 * into a {@link SizeVariant}. Absent (`undefined`/`null`) means `'default'`.
 * Anything else that is not a known variant throws a clear, actionable error
 * rather than silently defaulting — a typo'd `sizeVariant: tal` should fail
 * loudly at load time, not produce a default-sized sprite.
 */
export function coerceSizeVariant(value: unknown): SizeVariant {
  if (value === undefined || value === null) return DEFAULT_SIZE_VARIANT;
  if (isSizeVariant(value)) return value;
  throw new Error(
    `Invalid sizeVariant '${String(value)}'. Expected one of ${SIZE_VARIANTS.join(', ')}.`,
  );
}

/**
 * Return a deep copy of per-type defaults with `size`, `anchor`, and
 * `generation.sheet.nativeCanvas` scaled for the given variant.
 *
 * - Only fields that exist and are finite numbers are touched, so legacy or
 *   partial defaults (and `{}` for types without a defaults file) pass through
 *   unchanged.
 * - `size` and `anchor` scale by the same per-axis factor, so the schema
 *   invariant `anchor.x < size.width` (and the `.y` equivalent) is preserved:
 *   strict integer inequality survives multiplication by a positive integer.
 * - `nativeCanvas` scales by the larger of the two multipliers (to preserve
 *   the supersampling ratio on the longer axis) and is clamped to
 *   {@link MAX_NATIVE_CANVAS}.
 *
 * The input is treated as immutable. For the `'default'` variant the original
 * reference is returned as-is (no scaling needed — the caller's deep-merge
 * clones defaults anyway).
 */
export function applySizeVariantToDefaults<T extends Record<string, unknown>>(
  defaults: T,
  variant: SizeVariant,
): T {
  const mult = SIZE_VARIANT_MULTIPLIERS[variant];
  if (mult.width === 1 && mult.height === 1) return defaults;

  const scaled = cloneJson(defaults);

  if (isPlainObject(scaled.size)) {
    scaleNumberField(scaled.size, 'width', mult.width);
    scaleNumberField(scaled.size, 'height', mult.height);
  }
  if (isPlainObject(scaled.anchor)) {
    scaleNumberField(scaled.anchor, 'x', mult.width);
    scaleNumberField(scaled.anchor, 'y', mult.height);
  }

  const generation = scaled.generation;
  if (isPlainObject(generation) && isPlainObject(generation.sheet)) {
    const sheet = generation.sheet;
    const native = sheet.nativeCanvas;
    if (typeof native === 'number' && Number.isFinite(native)) {
      const factor = Math.max(mult.width, mult.height);
      sheet.nativeCanvas = Math.min(Math.round(native * factor), MAX_NATIVE_CANVAS);
    }
  }

  return scaled;
}

function scaleNumberField(obj: Record<string, unknown>, key: string, factor: number): void {
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    obj[key] = Math.round(value * factor);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
