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
 *   wide    — 2× width, 1× height → 4 rows × 2 cols = 8 cells (512×256, 2:1)
 *   tall    — 1× width, 2× height → 2 rows × 4 cols = 8 cells (256×512, 1:2)
 *   large   — 2× width, 2× height → 2 rows × 2 cols = 4 cells (512×512, 1:1)
 *
 * The transform scales `size`/`anchor` AND **reshapes the sheet grid by the
 * same multiplier on a fixed 1024² canvas** (a 2× wider cell ⇒ half the
 * columns). It does NOT inflate `nativeCanvas`: the sheet keeps a fixed pixel
 * budget and yields fewer, aspect-matched cells, so a "wide" request produces
 * one sheet of 8 double-width options rather than 16 square ones. See
 * ADR 0029.
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

/**
 * Resize strategy for post-processing a sprite whose brief declares the given
 * sprite type and output dimensions. Tiles stretch to the exact frame after a
 * transparent slice so they ship edge-to-edge instead of letterboxed; non-tile
 * variants use axis-priority strategies so the dominant axis is fully occupied
 * rather than letterboxed:
 *
 *   frameSequence     → 'fit'     — every cell MUST land at exactly W×H so
 *                                   `packFrameStrip`/Phaser's `loader.spritesheet`
 *                                   get uniform, unpadded frames; 'cover' would
 *                                   silently grow the secondary axis past the
 *                                   frame size for a portrait-aspect subject
 *                                   (see the 256×434 defect this branch fixes)
 *   wide   (w >= 2*h) → 'width'  — lock width, allow height growth
 *   tall   (h >= 2*w) → 'height' — lock height, allow width growth
 *   large  (square, w===h, >=128) → 'cover' — max occupancy, expand secondary axis
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
  frameSequenceEnabled?: boolean,
): 'fit' | 'width' | 'height' | 'cover' | 'stretch' {
  if (type === 'tile') return 'stretch';
  // frameSequence briefs have a hard exact-size contract per frame (the
  // animation descriptor and pack-frame-strip both assume uniform, unpadded
  // W×H cells) — this must win over every other axis-occupancy heuristic
  // below, including the square/large 'cover' branch, which is designed to
  // deliberately overflow the secondary axis and is incompatible with a
  // fixed spritesheet cell size.
  if (frameSequenceEnabled) return 'fit';
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
 * - `generation.sheet.{rows,cols}` are **reshaped** by the same multiplier
 *   (cols ÷ width, rows ÷ height, floored at 1) so the sheet keeps a fixed
 *   pixel budget but yields fewer, aspect-matched cells. `nativeCanvas` is left
 *   untouched — wide/tall/large no longer supersample to a larger canvas.
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
    // Reshape the grid by the SAME multiplier instead of inflating the canvas:
    // a 2× wider cell means half as many columns, so the sheet stays a fixed
    // pixel budget (nativeCanvas untouched) but yields fewer, aspect-matched
    // cells — e.g. wide → 4 rows × 2 cols = 8 cells of 512×256. See ADR 0029.
    sheet.cols = reshapeAxis(sheet.cols, mult.width);
    sheet.rows = reshapeAxis(sheet.rows, mult.height);
  }

  return scaled;
}

/**
 * Divide a base grid axis (rows or cols) by a size multiplier, flooring at 1.
 * A non-numeric/absent base falls back to the schema default of 4, so a
 * defaults file that omits the grid still reshapes correctly. The brief
 * schema's divisibility check fails loud if a pathological base/multiplier
 * combo would leave `nativeCanvas` non-divisible by the reshaped grid.
 */
function reshapeAxis(base: unknown, divisor: number): number {
  const n = typeof base === 'number' && Number.isFinite(base) && base > 0 ? base : 4;
  return Math.max(1, Math.round(n / divisor));
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
