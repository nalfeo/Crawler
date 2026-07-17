/**
 * Size variants for sprite briefs.
 *
 * A sprite's *type* (weapon, enemy, item, …) fixes its house-style defaults —
 * palette, references, anchor, native canvas, and a base output size. Every
 * per-type default is square today (e.g. 64×64). A *size variant* is an
 * orthogonal authoring axis that emits the same type at a different footprint
 * or aspect ratio without hand-editing `size` / `anchor` / `generation.sheet`
 * on each brief:
 *
 *   default — 1× width, 1× height → 4×4 = 16 cells (256×256 each)
 *   wide    — 2× width, 1× height → 3 rows × 2 cols = 6 cells (~512×341, 2:1)
 *   tall    — 1× width, 2× height → 2 rows × 3 cols = 6 cells (~341×512, 1:2)
 *   large   — 2× width, 2× height → 2 rows × 2 cols = 4 cells (512×512, 1:1)
 *
 * The transform scales `size`/`anchor` and applies the explicit review-density
 * contract on a fixed 1024² canvas. Three-way axes use 341/342px cells separated
 * by detected background gutters; they are intentionally not represented as
 * falsely equal fractional cells. It does NOT inflate `nativeCanvas`.
 *
 * The transform is applied to the per-type DEFAULTS *before* the minimal
 * brief's explicit overrides are merged on top (see `mergeMinimalIntoDefaults`),
 * so an author can still pin an exact `size` / `anchor` / grid and win over the
 * variant — the variant only reshapes inherited defaults.
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

export const SIZE_VARIANT_SHEET_LAYOUTS: Readonly<
  Record<SizeVariant, { readonly rows: number; readonly cols: number }>
> = {
  default: { rows: 4, cols: 4 },
  wide: { rows: 3, cols: 2 },
  tall: { rows: 2, cols: 3 },
  large: { rows: 2, cols: 2 },
};

/**
 * Resize strategy for post-processing a sprite whose brief declares the given
 * sprite type and output dimensions. Tiles stretch to the exact frame after a
 * transparent slice so they ship edge-to-edge instead of letterboxed; non-tile
 * variants use axis-priority strategies so the dominant axis is fully occupied.
 * Secondary-axis overflow remains visible for `dimensions-exact` to reject,
 * rather than being hidden by letterboxing, cropping, or stretching:
 *
 *   wide   (w >= 2*h) → 'width'  — lock width, expose excess height
 *   tall   (h >= 2*w) → 'height' — lock height, expose excess width
 *   large  (square, w===h, >=128) → 'cover' — expose non-square overflow
 *   tile              → 'stretch' — exact W×H frame, no transparent gutters
 *   other             → 'fit'     — nearest-fit inside frame (original behavior)
 *
 * Exported so `postprocess.ts`, `sensors/common.ts`, and `build-prompt.ts`
 * all derive the same answer from the same source of truth.
 */
export function resizeSpriteStrategy(
  type: string,
  width: number,
  height: number,
): 'fit' | 'width' | 'height' | 'cover' | 'stretch' {
  if (type === 'tile') return 'stretch';
  if (width >= height * 2) return 'width';
  if (height >= width * 2) return 'height';
  if (width === height && width >= 128) return 'cover';
  return 'fit';
}

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
 * Return a deep copy of per-type defaults transformed for the given variant.
 *
 * - `size` and `anchor` scale by the same per-axis multiplier, so the schema
 *   invariant `anchor.x < size.width` (and the `.y` equivalent) is preserved:
 *   strict integer inequality survives multiplication by a positive integer.
 * - `generation.sheet.{rows,cols}` use the explicit size-layout contract.
 *   `nativeCanvas` is left untouched — wide/tall/large do not supersample to a
 *   larger canvas.
 * - Only fields that exist and are finite numbers are touched, so legacy or
 *   partial defaults (and `{}` for types without a defaults file) pass through
 *   unchanged.
 *
 * The input is treated as immutable. For the `'default'` variant the original
 * reference is returned as-is (no transform needed — the caller's deep-merge
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
    const layout = SIZE_VARIANT_SHEET_LAYOUTS[variant];
    sheet.rows = layout.rows;
    sheet.cols = layout.cols;
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
