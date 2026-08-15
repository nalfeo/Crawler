/**
 * Deterministic composition scoring for set pieces.
 *
 * This is the hard gate behind the Set Piece Designer agent. It answers one
 * question with numbers instead of vibes: *does this room read as hand-made?*
 *
 * The checks were chosen against the observed failure mode in the shipped pack:
 * twelve of thirteen rooms are a uniformly tiled floor box holding three to five
 * props, with **no real-world sizing anywhere**. The one room that reads as
 * curated (`welcome-room`) declares `widthFt`/`heightFt` on every prop. So the
 * gate targets density, stacking, edge treatment, tiling variety, placement
 * asymmetry, real-world scale, playable circulation and a compositional subject.
 *
 * Purity: no I/O, no randomness, no clock. Thresholds are isolated in
 * {@link DEFAULT_THRESHOLDS} so a reference-driven retune never touches logic.
 */
import {
  type SetPieceDef,
  type SetPiecePropDef,
  type SetPiecePropKind,
  type SpriteLayer,
  type SpriteRef,
} from '../../../src/shared/set-piece-types.js';

/**
 * One tile is 4 feet — `FloorConfig.tileSizeFt` is 4 everywhere in the game
 * (`DEFAULT_FLOOR_CONFIG`, every lab, and `stampSetPiece`'s caller), and at
 * `PIXELS_PER_FOOT = 8` that is 32 world px per tile.
 *
 * This was 2 for the gate's first iteration, which silently halved every
 * real-world-scale, footprint-area and layer-offset computation and made the
 * gate report a 40ft-wide room as 20ft. Do not "simplify" it back: derive it
 * from the same 4 the floor config uses, never from the sprite pixel size.
 */
export const FEET_PER_TILE = 4;

/**
 * Prop kinds that count as *dressing* the room.
 *
 * `floor` and `wall` are both excluded because they are structure, not
 * decoration: an auto-generated floor fill plus a wall ring would otherwise
 * score an empty box at >50% occupancy with a fully "dressed" perimeter, which
 * is exactly the slop this gate exists to catch.
 */
const OCCUPYING_KINDS: ReadonlySet<SetPiecePropKind> = new Set<SetPiecePropKind>([
  'door',
  'fixture',
  'furniture',
  'decoration',
  'actor',
]);

/** Prop kinds that block walking, used for circulation and anchor sanity. */
const SOLID_KINDS: ReadonlySet<SetPiecePropKind> = new Set<SetPiecePropKind>([
  'wall',
  'fixture',
  'furniture',
]);

/**
 * Prop kinds that count as dressing a wall-adjacent tile. `wall` itself does not
 * count — a bare wall ring is the box, not the treatment of it.
 */
const PERIMETER_KINDS: ReadonlySet<SetPiecePropKind> = new Set<SetPiecePropKind>([
  'door',
  'fixture',
  'furniture',
  'decoration',
]);

export interface CompositionThresholds {
  /** Minimum share of interior tiles covered by non-floor props. */
  readonly minOccupancy: number;
  /** Minimum share of occupied tiles carrying 2+ overlapping props. */
  readonly minStackedShare: number;
  /** Minimum share of wall-adjacent tiles carrying a prop. */
  readonly minPerimeterDressed: number;
  /** Minimum count of distinct floor sprites. */
  readonly minFloorVariants: number;
  /** Maximum share a single floor sprite may hold. */
  readonly maxFloorVariantShare: number;
  /** Maximum share of non-floor props sitting in an axis-aligned run. */
  readonly maxGridRunShare: number;
  /** Length at which an evenly spaced line of props reads as machine-placed. */
  readonly gridRunLength: number;
  /** Minimum share of non-floor props declaring real-world feet. */
  readonly minFeetDeclared: number;
  /** How much larger the focal prop must be than the median prop. */
  readonly focalDominanceRatio: number;
  /**
   * Minimum share of *large* props (footprint at or above the median) whose
   * footprint sits on or within {@link maxWallGapTiles} of the wall ring. The
   * strongest recurring law in the study set: mass goes against the walls, the
   * middle stays readable.
   */
  readonly minLargePropsWallAnchored: number;
  /**
   * How many tiles of clearance still counts as "against the wall" for
   * {@link minLargePropsWallAnchored}.
   *
   * Must be >= 1. Once a set piece owns a real shell the perimeter ring is wall
   * tiles, so a strict ring-membership test can never be satisfied; and a counter
   * with someone standing behind it (reception desk, shop table, bar) legitimately
   * sits one tile proud of the wall. 2+ tiles of clearance is genuinely adrift.
   */
  readonly maxWallGapTiles: number;
  /** Corridor width, in tiles, that must connect every anchor. */
  /**
   * Minimum clear lane between anchors, **in feet**.
   *
   * This was authored as `circulationWidthTiles: 2` back when the gate wrongly
   * believed a tile was 2 ft — i.e. the intent was always "four feet of
   * clearance", a real doorway/aisle. At the true 4 ft/tile that literal `2`
   * silently demanded an 8 ft hospital corridor, which no believable room-sized
   * interior can satisfy once furniture is massed against the walls. Stating it
   * in feet preserves the original intent and stops it drifting again.
   */
  readonly circulationWidthFt: number;
  /** Share of type-recognised props whose declared height must be plausible. */
  readonly minPlausibleHeightShare: number;
}

/**
 * v1 thresholds — deliberately ballpark, to be retuned against a reference
 * lookbook. Every number lives here so that retune is a one-block edit.
 */
export const DEFAULT_THRESHOLDS: CompositionThresholds = Object.freeze({
  minOccupancy: 0.22,
  minStackedShare: 0.15,
  minPerimeterDressed: 0.6,
  minFloorVariants: 3,
  maxFloorVariantShare: 0.7,
  maxGridRunShare: 0.4,
  gridRunLength: 4,
  minFeetDeclared: 1,
  focalDominanceRatio: 2.5,
  minLargePropsWallAnchored: 0.6,
  maxWallGapTiles: 1,
  circulationWidthFt: 4,
  /** Share of non-floor props whose declared height must be humanly plausible. */
  minPlausibleHeightShare: 1,
});

/**
 * Real-world VERTICAL height bands in feet, keyed by a substring of the prop id.
 * `heightFt` is apparent vertical height (front-elevation art), so these are the
 * heights you'd measure standing next to the object — not floor depths.
 *
 * This table exists because the shipped pack authored `heightFt` as if it were a
 * floor footprint, which collapsed every tall object (bookcases at 4 ft, 3-crate
 * stacks at 3.5 ft) and made rooms read as small and sparse. `real-world-scale`
 * only proves the numbers are PRESENT; this proves they are BELIEVABLE.
 */
const HEIGHT_BANDS: ReadonlyArray<readonly [RegExp, number, number]> = Object.freeze([
  [/bookcase|bookshelf|shelf-unit|cabinet|wardrobe/, 5, 8],
  [/crate-stack|barrel-stack|stack/, 4, 7],
  // A bracket torch on a wall is a different object from a standing brazier:
  // ~2-3 ft of sconce + flame vs a 5 ft floor-standing pole. Must precede the
  // generic torch band or every wall torch reads as a squashed brazier.
  [/wall-torch|torch-bracket|sconce-torch/, 1.5, 3.5],
  [/torch|lamp-post|standing-lamp/, 4, 8],
  // A banner hung flat on a wall is commonly a 2.5-3 ft strip; only a full drop
  // curtain reaches ceiling height.
  [/banner|curtain/, 2.5, 8],
  [/door|archway/, 6, 8],
  [/desk|counter|workbench/, 2.2, 4],
  [/table/, 2, 3.5],
  [/chair|stool|bench/, 1.2, 3.5],
  [/crate|barrel|chest|bin|sack/, 1.5, 3.5],
  [/plant|shrub|fern/, 1.5, 5],
  [/sconce|switch|sign|poster|plaque|frame|clock|board|call-sheet|clipboard/, 0.75, 4.5],
  [/rug|carpet|mat|cable|tape|stain|seam|scuff/, 0.05, 1],
]);

/**
 * Index of the first {@link HEIGHT_BANDS} entry matching `id`, or -1.
 * The table is ordered specific -> general (`crate-stack` before `crate`,
 * `wall-torch` before `torch`), so a lower index means a more specific match.
 */
function heightBandIndexFor(id: string): number {
  const lower = id.toLowerCase();
  return HEIGHT_BANDS.findIndex(([pattern]) => pattern.test(lower));
}

/**
 * Resolve a prop's height band from BOTH its sprite ids and its own id, keeping
 * the MOST SPECIFIC match (lowest band index) rather than preferring one source.
 *
 * Neither source is reliably better than the other:
 *  - the sprite is ground truth for what is depicted, so a prop named
 *    `crate-bottom-right` drawing `...-crate-stack-var-3` must be judged as a
 *    stack, not as a single crate;
 *  - but a generic sprite can be *less* specific than the prop id. A wall bracket
 *    torch drawing the shared `prop-torch-var-8` is still a wall torch, and
 *    judging it against the standing-brazier band reports a false failure.
 * Taking the most specific match over the union satisfies both.
 */
function heightBandForProp(prop: SetPiecePropDef): readonly [number, number] | null {
  const candidates: number[] = [];
  const consider = (id: string | null): void => {
    if (id === null) return;
    const i = heightBandIndexFor(id);
    if (i !== -1) candidates.push(i);
  };
  consider(prop.id);
  for (const layer of prop.layers) {
    const ref: unknown = layer.sprite;
    consider(
      typeof ref === 'string'
        ? ref
        : typeof (ref as { spriteId?: unknown } | null)?.spriteId === 'string'
          ? (ref as { spriteId: string }).spriteId
          : null,
    );
  }
  if (candidates.length === 0) return null;
  const entry = HEIGHT_BANDS[Math.min(...candidates)];
  return entry ? [entry[1], entry[2]] : null;
}

export interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly pass: boolean;
  /** Measured value, in the threshold's units. */
  readonly actual: number;
  readonly threshold: number;
  /** Human-facing explanation, including the fix when failing. */
  readonly detail: string;
}

export interface CompositionReport {
  readonly setPieceId: string;
  readonly width: number;
  readonly height: number;
  readonly checks: readonly CheckResult[];
  readonly passed: boolean;
  /** Count of passing checks, for coarse progress tracking. */
  readonly passedCount: number;
  readonly totalCount: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface Cell {
  readonly x: number;
  readonly y: number;
}

const cellKey = (x: number, y: number): string => `${x},${y}`;

/**
 * Tiles a prop covers. Props may sit on fractional tile coordinates (good rooms
 * nudge things off-grid on purpose), so the footprint is every tile the prop's
 * rectangle overlaps at all.
 */
function propCells(prop: SetPiecePropDef, def: SetPieceDef): Cell[] {
  const w = Math.max(prop.width ?? 1, Number.EPSILON);
  const h = Math.max(prop.height ?? 1, Number.EPSILON);
  const x0 = Math.floor(prop.x);
  const y0 = Math.floor(prop.y);
  const x1 = Math.ceil(prop.x + w) - 1;
  const y1 = Math.ceil(prop.y + h) - 1;
  const cells: Cell[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (x >= 0 && y >= 0 && x < def.width && y < def.height) cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * Tiles a prop visually COVERS once rendered, derived from its declared feet.
 *
 * This is deliberately different from {@link propCells}. `prop.width`/`prop.height`
 * are the authored *floor footprint* in tiles, and in practice almost every prop
 * is authored as the schema default 1x1 regardless of what it actually is — a
 * 1.6 ft wall sconce, a 1.4 ft exit sign and a 2 ft strip of floor tape each
 * claim a full tile, which at 4 ft/tile is 16 sq ft apiece. Scoring density off
 * that measures placeholder rectangles, not props: `welcome-room` reported 61%
 * occupancy while both the human and the visual judge read the room as sparse.
 *
 * The renderer does not use the tile footprint for size at all — it draws the
 * sprite at `widthFt` x `heightFt` (see `PhaserBridge` set-piece loop), centred
 * horizontally on the footprint and, for upright props, growing UPWARD from the
 * footprint's base (`anchorBase`). Reproducing that here is what makes the
 * density, stacking and edge-treatment checks agree with the screenshot.
 *
 * Falls back to the authored footprint when a prop declares no feet — those
 * props already fail the `real-world-scale` check, so they are not silently
 * excused here.
 */
function propRenderCells(prop: SetPiecePropDef, def: SetPieceDef): Cell[] {
  const footW = Math.max(prop.width ?? 1, Number.EPSILON);
  const footH = Math.max(prop.height ?? 1, Number.EPSILON);

  let widthFt = 0;
  let heightFt = 0;
  for (const layer of prop.layers) {
    if (!layerHasFeet(layer)) continue;
    // Largest declared layer wins: composite props (table + potion + receipt)
    // are visually bounded by their base object, not by their garnish.
    if ((layer.widthFt ?? 0) * (layer.heightFt ?? 0) > widthFt * heightFt) {
      widthFt = layer.widthFt ?? 0;
      heightFt = layer.heightFt ?? 0;
    }
  }
  if (widthFt <= 0 || heightFt <= 0) return propCells(prop, def);

  const wTiles = widthFt / FEET_PER_TILE;
  const hTiles = heightFt / FEET_PER_TILE;
  const left = prop.x + footW / 2 - wTiles / 2;
  // Floor decals lie flat and are centred on the footprint; everything else is a
  // front elevation standing on the footprint's leading edge and rising from it.
  const top = prop.kind === 'floor' ? prop.y + footH / 2 - hTiles / 2 : prop.y + footH - hTiles;

  const x0 = Math.floor(left);
  const y0 = Math.floor(top);
  const x1 = Math.ceil(left + wTiles) - 1;
  const y1 = Math.ceil(top + hTiles) - 1;
  const cells: Cell[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (x >= 0 && y >= 0 && x < def.width && y < def.height) cells.push({ x, y });
    }
  }
  return cells;
}

/** Stable identity for a sprite reference, used for floor-variety counting. */
export function spriteKey(ref: SpriteRef): string {
  switch (ref.source) {
    case 'catalog':
      return `catalog:${ref.spriteId}`;
    case 'sheet':
      return `sheet:${ref.sheetKey}:${ref.col}:${ref.row}`;
    case 'custom':
      return `custom:${ref.requestId}`;
  }
}

/** A layer declares real-world size when both feet dimensions are present. */
function layerHasFeet(layer: SpriteLayer): boolean {
  return typeof layer.widthFt === 'number' && typeof layer.heightFt === 'number';
}

/**
 * FACADE area in square feet — `widthFt * heightFt` is the object's elevation
 * (front-face) area, NOT its floor area. Crawler's prop art is front-elevation,
 * so `heightFt` is apparent vertical height; a 3x7 ft door has a facade area of
 * 21 sq ft and a floor footprint of almost nothing. Use this only to compare
 * *visual mass* (focal point, "large" props); use tile extent for floor cover.
 */
function propFacadeAreaSqFt(prop: SetPiecePropDef): number {
  let best = 0;
  for (const layer of prop.layers) {
    if (layerHasFeet(layer)) best = Math.max(best, (layer.widthFt ?? 0) * (layer.heightFt ?? 0));
  }
  if (best > 0) return best;
  return (prop.width ?? 1) * FEET_PER_TILE * ((prop.height ?? 1) * FEET_PER_TILE);
}

const isOccupying = (prop: SetPiecePropDef): boolean => OCCUPYING_KINDS.has(prop.kind);

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkOccupancy(
  def: SetPieceDef,
  occupancyCount: ReadonlyMap<string, number>,
  t: CompositionThresholds,
): CheckResult {
  const totalTiles = def.width * def.height;
  const occupied = occupancyCount.size;
  const actual = totalTiles === 0 ? 0 : occupied / totalTiles;
  const pass = actual >= t.minOccupancy;
  return {
    id: 'occupancy',
    label: 'Prop density',
    pass,
    actual,
    threshold: t.minOccupancy,
    detail: pass
      ? `${occupied}/${totalTiles} tiles carry a non-floor prop (${pct(actual)}).`
      : `Only ${occupied}/${totalTiles} tiles (${pct(actual)}) carry a non-floor prop; ` +
        `an empty box reads as generated. Dress it until ${pct(t.minOccupancy)} is covered.`,
  };
}

function checkStacking(
  occupancyCount: ReadonlyMap<string, number>,
  t: CompositionThresholds,
): CheckResult {
  const occupied = occupancyCount.size;
  let stacked = 0;
  for (const count of occupancyCount.values()) if (count >= 2) stacked += 1;
  const actual = occupied === 0 ? 0 : stacked / occupied;
  const pass = actual >= t.minStackedShare;
  return {
    id: 'stacking',
    label: 'Layer depth',
    pass,
    actual,
    threshold: t.minStackedShare,
    detail: pass
      ? `${stacked}/${occupied} occupied tiles stack 2+ props (${pct(actual)}).`
      : `Only ${stacked}/${occupied} occupied tiles (${pct(actual)}) stack 2+ props. ` +
        `Hand-dressed rooms nest things: a plate on a table, a rug under a chair, ` +
        `clutter on a shelf. Stack until ${pct(t.minStackedShare)}.`,
  };
}

/**
 * Edge treatment: how much of the room's boundary carries dressing.
 *
 * A ring tile counts as dressed if it OR its inward neighbour carries a
 * perimeter-kind prop. The inward reach is essential, not a loosening: this
 * check's own remedy text recommends "stacked crates along the walls", and
 * crates stand on the FLOOR *beside* a wall, never inside it. Once a set piece
 * carries a real structural wall ring (mapgen writes those tiles), the only
 * things that can occupy a ring tile are wall-MOUNTED decor — posters, shelves,
 * sconces, banners. Requiring literal ring occupancy would therefore score every
 * floor-standing edge prop as zero and make the check unsatisfiable for exactly
 * the dressing it asks for.
 *
 * The reach is deliberately ONE tile, not `maxWallGapTiles`: this is about the
 * boundary reading as dressed, so a prop two tiles in is genuinely not edge
 * dressing and should not count. A ring CORNER additionally reaches its
 * diagonal-inward neighbour, because that single tile is the only floor cell
 * tucked into the corner — a crate there dresses both adjoining walls, and
 * without the diagonal every room would forfeit its four corners outright.
 */
function checkPerimeter(
  def: SetPieceDef,
  perimeterDressed: ReadonlySet<string>,
  t: CompositionThresholds,
): CheckResult {
  let ringTiles = 0;
  let dressed = 0;
  for (let y = 0; y < def.height; y += 1) {
    for (let x = 0; x < def.width; x += 1) {
      const onRing = x === 0 || y === 0 || x === def.width - 1 || y === def.height - 1;
      if (!onRing) continue;
      ringTiles += 1;
      // Step inward from whichever edge(s) this tile lies on.
      const dx = x === 0 ? 1 : x === def.width - 1 ? -1 : 0;
      const dy = y === 0 ? 1 : y === def.height - 1 ? -1 : 0;
      const inward: Array<readonly [number, number]> = [[x, y]];
      if (dx !== 0) inward.push([x + dx, y]);
      if (dy !== 0) inward.push([x, y + dy]);
      // Corner: the diagonal is the tile actually nestled in the corner.
      if (dx !== 0 && dy !== 0) inward.push([x + dx, y + dy]);
      if (inward.some(([cx, cy]) => perimeterDressed.has(cellKey(cx, cy)))) dressed += 1;
    }
  }
  const actual = ringTiles === 0 ? 0 : dressed / ringTiles;
  const pass = actual >= t.minPerimeterDressed;
  return {
    id: 'perimeter',
    label: 'Edge treatment',
    pass,
    actual,
    threshold: t.minPerimeterDressed,
    detail: pass
      ? `${dressed}/${ringTiles} wall-adjacent tiles are dressed (${pct(actual)}).`
      : `Only ${dressed}/${ringTiles} wall-adjacent tiles (${pct(actual)}) carry anything. ` +
        `Undressed edges make a room read as a box instead of a place — run shelving, ` +
        `trim, posters and stacked crates along the walls.`,
  };
}

function checkFloorVariety(def: SetPieceDef, t: CompositionThresholds): CheckResult {
  const counts = new Map<string, number>();
  let total = 0;
  for (const prop of def.props) {
    if (prop.kind !== 'floor') continue;
    for (const layer of prop.layers) {
      const key = spriteKey(layer.sprite);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  const variants = counts.size;
  const maxShare = total === 0 ? 1 : Math.max(0, ...counts.values()) / total;
  const pass = variants >= t.minFloorVariants && maxShare <= t.maxFloorVariantShare;
  return {
    id: 'floor-variety',
    label: 'Floor variety',
    pass,
    actual: variants,
    threshold: t.minFloorVariants,
    detail: pass
      ? `${variants} distinct floor sprites, dominant one at ${pct(maxShare)}.`
      : `${variants} distinct floor sprite(s), dominant one at ${pct(maxShare)}. ` +
        `A single sprite stamped across every tile is the loudest generated-art tell. ` +
        `Use ${t.minFloorVariants}+ variants (cracks, stains, worn boards) with none ` +
        `above ${pct(t.maxFloorVariantShare)}.`,
  };
}

/**
 * Flags props sitting in long, evenly spaced, axis-aligned runs — the signature
 * of programmatic placement. Human dressers break lines up.
 */
function checkAntiGrid(def: SetPieceDef, t: CompositionThresholds): CheckResult {
  const props = def.props.filter(isOccupying);
  const inRun = new Set<string>();

  const scan = (
    groupBy: (p: SetPiecePropDef) => number,
    sortBy: (p: SetPiecePropDef) => number,
  ): void => {
    const groups = new Map<number, SetPiecePropDef[]>();
    for (const prop of props) {
      const bucket = groups.get(groupBy(prop));
      if (bucket) bucket.push(prop);
      else groups.set(groupBy(prop), [prop]);
    }
    for (const bucket of groups.values()) {
      const sorted = [...bucket].sort((a, b) => sortBy(a) - sortBy(b));
      let runStart = 0;
      for (let i = 1; i <= sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const cur = i < sorted.length ? sorted[i] : undefined;
        const contiguous =
          cur !== undefined &&
          prev !== undefined &&
          Math.abs(sortBy(cur) - sortBy(prev) - 1) < 1e-6;
        if (contiguous) continue;
        if (i - runStart >= t.gridRunLength) {
          for (let j = runStart; j < i; j += 1) {
            const p = sorted[j];
            if (p) inRun.add(p.id);
          }
        }
        runStart = i;
      }
    }
  };

  scan(
    (p) => p.y,
    (p) => p.x,
  );
  scan(
    (p) => p.x,
    (p) => p.y,
  );

  const actual = props.length === 0 ? 0 : inRun.size / props.length;
  const pass = actual <= t.maxGridRunShare;
  return {
    id: 'anti-grid',
    label: 'Placement asymmetry',
    pass,
    actual,
    threshold: t.maxGridRunShare,
    detail: pass
      ? `${inRun.size}/${props.length} props sit in a straight run (${pct(actual)}).`
      : `${inRun.size}/${props.length} props (${pct(actual)}) sit in evenly spaced ` +
        `axis-aligned runs of ${t.gridRunLength}+. Break the lines: stagger spacing, ` +
        `rotate, and let a few pieces sit off-grid.`,
  };
}

/**
 * `real-world-scale` only proves the feet numbers are PRESENT. This proves they
 * are BELIEVABLE, by comparing each prop's declared VERTICAL height against a
 * real-world band for its type ({@link HEIGHT_BANDS}).
 *
 * This check exists because of a concrete failure: the field was documented as a
 * floor footprint, so authors gave tall objects small heights (a 3-crate stack
 * at 3.5 ft, a bookcase at 4 ft). Every vertical object was squashed, and the
 * room read as small and sparse while still passing all eleven other checks —
 * a density gate cannot see a collapsed third dimension.
 */
function checkScaleSanity(def: SetPieceDef, t: CompositionThresholds): CheckResult {
  const props = def.props.filter(isOccupying);
  const judged: string[] = [];
  const bad: string[] = [];
  for (const prop of props) {
    const band = heightBandForProp(prop);
    if (band === null) continue;
    const [min, max] = band;
    let height = 0;
    for (const layer of prop.layers) {
      if (layerHasFeet(layer)) height = Math.max(height, layer.heightFt ?? 0);
    }
    if (height === 0) continue;
    judged.push(prop.id);
    if (height < min) bad.push(`${prop.id} ${height}ft (too short, expect ${min}-${max}ft)`);
    else if (height > max) bad.push(`${prop.id} ${height}ft (too tall, expect ${min}-${max}ft)`);
  }
  const actual = judged.length === 0 ? 1 : (judged.length - bad.length) / judged.length;
  const pass = actual >= t.minPlausibleHeightShare;
  const sample = bad.slice(0, 5).join('; ');
  return {
    id: 'scale-sanity',
    label: 'Believable heights',
    pass,
    actual,
    threshold: t.minPlausibleHeightShare,
    detail: pass
      ? `All ${judged.length} recognised props declare a plausible vertical height.`
      : `${bad.length}/${judged.length} props declare an implausible height. ` +
        `heightFt is APPARENT VERTICAL HEIGHT (front-elevation art), not floor depth — ` +
        `a person is ~6 ft, a door 7 ft, a 3-crate stack ~5.5 ft. Squashing tall objects ` +
        `is what makes a room read as small and sparse. Fix: ${sample}${bad.length > 5 ? ', …' : ''}`,
  };
}

/**
 * The strongest "does it fit" signal. Props sized only by tile extent get
 * stretched to the tile grid; props with declared feet render at believable
 * real-world scale (a 1.5 ft sconce beside a 5 ft desk).
 */
function checkRealWorldScale(def: SetPieceDef, t: CompositionThresholds): CheckResult {
  const props = def.props.filter(isOccupying);
  const missing = props.filter((prop) => !prop.layers.some(layerHasFeet));
  const actual = props.length === 0 ? 1 : (props.length - missing.length) / props.length;
  const pass = actual >= t.minFeetDeclared;
  const sample = missing
    .slice(0, 5)
    .map((p) => p.id)
    .join(', ');
  return {
    id: 'real-world-scale',
    label: 'Real-world scale',
    pass,
    actual,
    threshold: t.minFeetDeclared,
    detail: pass
      ? `All ${props.length} non-floor props declare widthFt/heightFt.`
      : `${missing.length}/${props.length} non-floor props have no widthFt/heightFt, so they ` +
        `stretch to the tile grid and cannot feel correctly sized. 1 tile = ${FEET_PER_TILE} ft — ` +
        `give every prop believable dimensions (chair ~2 ft, desk ~5 ft, door ~3x7 ft). ` +
        `Missing: ${sample}${missing.length > 5 ? ', …' : ''}`,
  };
}

/**
 * The most consistent law in the interior study set: big objects are anchored
 * against walls and the middle of the room is left readable. Link's House rings
 * bed/chests/shelves/pots around a bare rug; Crono's room does the same; the
 * Moonlighter shop stacks every display against the perimeter. A room whose
 * large furniture floats in open floor reads as props scattered in a box, even
 * when its raw density is fine.
 *
 * "Large" is relative (footprint at or above the median), so this scales from a
 * cupboard-sized closet to a throne room without a hardcoded size.
 */
function checkWallAnchoring(def: SetPieceDef, t: CompositionThresholds): CheckResult {
  const props = def.props.filter(isOccupying);
  if (props.length < 2) {
    return {
      id: 'wall-anchoring',
      label: 'Wall anchoring',
      pass: false,
      actual: 0,
      threshold: t.minLargePropsWallAnchored,
      detail: 'Fewer than 2 non-floor props — there is no composition to read.',
    };
  }

  const sorted = [...props].map(propFacadeAreaSqFt).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);

  const large = props.filter((p) => propFacadeAreaSqFt(p) >= median);
  // Anchored = the prop sits ON or WITHIN `maxWallGapTiles` of the perimeter ring.
  //
  // This deliberately does NOT require ring membership. Two reasons, both real:
  //  1. Once a set piece owns a real shell (see `shell-integrity`), the perimeter
  //     ring is WALL TILES. A prop can never occupy it, so a membership test would
  //     be unsatisfiable for every room that passes the shell check.
  //  2. The commonest hand-made interior arrangement is a counter with a person
  //     standing behind it. That person needs a tile. A membership test calls every
  //     shop counter, reception desk and bar "floating", which is simply wrong.
  // A gap of 1 tile (4 ft) is standing room; 2+ tiles is genuinely adrift in the
  // middle of the room, which is the composition failure this check exists to catch.
  const gap = Math.max(0, Math.floor(t.maxWallGapTiles));
  const touchesWall = (prop: SetPiecePropDef): boolean =>
    propCells(prop, def).some(
      (c) => Math.min(c.x, c.y, def.width - 1 - c.x, def.height - 1 - c.y) <= gap,
    );

  const anchored = large.filter(touchesWall);
  const actual = large.length === 0 ? 0 : anchored.length / large.length;
  const pass = actual >= t.minLargePropsWallAnchored;
  const floating = large
    .filter((p) => !touchesWall(p))
    .slice(0, 5)
    .map((p) => p.id)
    .join(', ');
  return {
    id: 'wall-anchoring',
    label: 'Wall anchoring',
    pass,
    actual,
    threshold: t.minLargePropsWallAnchored,
    detail: pass
      ? `${anchored.length}/${large.length} large props are anchored to a wall (${pct(actual)}).`
      : `Only ${anchored.length}/${large.length} large props (${pct(actual)}) touch a wall. ` +
        `Hand-made interiors push mass to the edges and keep the middle readable — ` +
        `move bulk furniture against the perimeter and reserve the core for movement, ` +
        `encounters or one focal cluster. Floating: ${floating}`,
  };
}

/** A composition needs a subject: one prop clearly larger than the rest. */
function checkFocalPoint(def: SetPieceDef, t: CompositionThresholds): CheckResult {
  const areas = def.props
    .filter(isOccupying)
    .map(propFacadeAreaSqFt)
    .sort((a, b) => b - a);
  if (areas.length < 2) {
    return {
      id: 'focal-point',
      label: 'Focal point',
      pass: false,
      actual: 0,
      threshold: t.focalDominanceRatio,
      detail: 'Fewer than 2 non-floor props — there is no composition to read.',
    };
  }
  const largest = areas[0] ?? 0;
  const mid = Math.floor(areas.length / 2);
  const median =
    areas.length % 2 === 0 ? ((areas[mid - 1] ?? 0) + (areas[mid] ?? 0)) / 2 : (areas[mid] ?? 0);
  const actual = median === 0 ? 0 : largest / median;
  const pass = actual >= t.focalDominanceRatio;
  return {
    id: 'focal-point',
    label: 'Focal point',
    pass,
    actual,
    threshold: t.focalDominanceRatio,
    detail: pass
      ? `Largest prop is ${actual.toFixed(1)}x the median footprint.`
      : `Largest prop is only ${actual.toFixed(1)}x the median footprint (${largest.toFixed(1)} ` +
        `vs ${median.toFixed(1)} sq ft). Every hand-made room has a subject the eye lands on ` +
        `first — a counter, an altar, a wrecked bus. Add or enlarge one.`,
  };
}

function buildSolidGrid(def: SetPieceDef): boolean[][] {
  const grid: boolean[][] = Array.from({ length: def.height }, () =>
    Array.from({ length: def.width }, () => false),
  );
  for (const prop of def.props) {
    if (!SOLID_KINDS.has(prop.kind)) continue;
    for (const cell of propCells(prop, def)) {
      const row = grid[cell.y];
      if (row) row[cell.x] = true;
    }
  }
  return grid;
}

/**
 * Anchors (doors + NPCs) must all sit in one region reachable by a corridor of
 * the configured width, or the room is decorative but unplayable.
 */
function checkCirculation(def: SetPieceDef, t: CompositionThresholds): CheckResult {
  const solid = buildSolidGrid(def);
  const w = Math.max(1, Math.ceil(t.circulationWidthFt / FEET_PER_TILE));

  // A tile is "wide-walkable" when it belongs to some free w x w block.
  const wide: boolean[][] = Array.from({ length: def.height }, () =>
    Array.from({ length: def.width }, () => false),
  );
  for (let y = 0; y + w <= def.height; y += 1) {
    for (let x = 0; x + w <= def.width; x += 1) {
      let clear = true;
      for (let dy = 0; dy < w && clear; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          if (solid[y + dy]?.[x + dx] === true) {
            clear = false;
            break;
          }
        }
      }
      if (!clear) continue;
      for (let dy = 0; dy < w; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          const row = wide[y + dy];
          if (row) row[x + dx] = true;
        }
      }
    }
  }

  const anchors: { id: string; x: number; y: number }[] = [
    ...def.props
      .filter((p) => p.kind === 'door')
      .map((p) => ({ id: p.id, x: Math.floor(p.x), y: Math.floor(p.y) })),
    ...def.npcs.map((n) => ({ id: n.id, x: Math.floor(n.x), y: Math.floor(n.y) })),
  ];

  if (anchors.length < 2) {
    const anyWide = wide.some((row) => row.includes(true));
    return {
      id: 'circulation',
      label: 'Circulation',
      pass: anyWide,
      actual: anyWide ? 1 : 0,
      threshold: 1,
      detail: anyWide
        ? `No multi-anchor routing needed; a ${w}-tile-wide walkable area exists.`
        : `No ${w}-tile-wide walkable area anywhere — the room is impassable.`,
    };
  }

  const nearestWide = (ax: number, ay: number): Cell | undefined => {
    let best: Cell | undefined;
    let bestDist = Infinity;
    for (let y = 0; y < def.height; y += 1) {
      for (let x = 0; x < def.width; x += 1) {
        if (wide[y]?.[x] !== true) continue;
        const dist = Math.abs(x - ax) + Math.abs(y - ay);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x, y };
        }
      }
    }
    return best;
  };

  const first = anchors[0];
  const start = first ? nearestWide(first.x, first.y) : undefined;
  const reached = new Set<string>();
  if (start) {
    const queue: Cell[] = [start];
    reached.add(cellKey(start.x, start.y));
    for (let head = 0; head < queue.length; head += 1) {
      const cur = queue[head];
      if (!cur) continue;
      const neighbours: Cell[] = [
        { x: cur.x + 1, y: cur.y },
        { x: cur.x - 1, y: cur.y },
        { x: cur.x, y: cur.y + 1 },
        { x: cur.x, y: cur.y - 1 },
      ];
      for (const n of neighbours) {
        if (n.x < 0 || n.y < 0 || n.x >= def.width || n.y >= def.height) continue;
        if (wide[n.y]?.[n.x] !== true) continue;
        const key = cellKey(n.x, n.y);
        if (reached.has(key)) continue;
        reached.add(key);
        queue.push(n);
      }
    }
  }

  const unreachable = anchors.filter((anchor) => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (reached.has(cellKey(anchor.x + dx, anchor.y + dy))) return false;
      }
    }
    return true;
  });

  const actual = (anchors.length - unreachable.length) / anchors.length;
  const pass = unreachable.length === 0;
  return {
    id: 'circulation',
    label: 'Circulation',
    pass,
    actual,
    threshold: 1,
    detail: pass
      ? `All ${anchors.length} anchors connect via a ${w}-tile-wide path.`
      : `${unreachable.length}/${anchors.length} anchors are cut off from the ` +
        `${w}-tile-wide walkable network (${unreachable.map((a) => a.id).join(', ')}). ` +
        `Clutter must never wall off a door or an NPC.`,
  };
}

/** No NPC or door may sit inside a solid prop. */
function checkAnchorSanity(def: SetPieceDef): CheckResult {
  const solid = buildSolidGrid(def);
  const offenders: string[] = [];
  for (const npc of def.npcs) {
    if (solid[Math.floor(npc.y)]?.[Math.floor(npc.x)] === true) offenders.push(npc.id);
  }
  for (const door of def.props.filter((p) => p.kind === 'door')) {
    for (const cell of propCells(door, def)) {
      if (solid[cell.y]?.[cell.x] === true) {
        offenders.push(door.id);
        break;
      }
    }
  }
  const pass = offenders.length === 0;
  return {
    id: 'anchor-sanity',
    label: 'Anchor sanity',
    pass,
    actual: offenders.length,
    threshold: 0,
    detail: pass
      ? 'No NPC or door overlaps a solid prop.'
      : `${offenders.length} anchor(s) sit inside solid props (${offenders.join(', ')}). ` +
        `This soft-locks interaction and spawning.`,
  };
}

/**
 * Every set piece must be a real, sealed room with a way in: a complete wall (or
 * door) ring around its footprint, and at least one `door` prop on that ring.
 *
 * This is the AUTHORING precondition for the prefab-room map-gen model, in which
 * a set piece owns its own shell and map-gen carves the room to fit and connects
 * corridors to its door slots. A def with a gapped ring has no shell to carve
 * against; a def with a ring but no door describes a sealed room, which — once
 * shells are real collision — is an unreachable room and an unwinnable seed.
 *
 * Checked purely on authored data: the ring is the footprint perimeter, and a
 * ring tile counts as covered when a `wall` or `door` prop occupies it. Doors
 * are counted separately because a complete ring of pure wall is the exact
 * failure this check exists to catch.
 */
function checkShellIntegrity(def: SetPieceDef): CheckResult {
  const footprint = { width: def.width, height: def.height };
  const { width, height } = footprint;
  const ring: Cell[] = [];
  for (let x = 0; x < width; x += 1) {
    ring.push({ x, y: 0 }, { x, y: height - 1 });
  }
  for (let y = 1; y < height - 1; y += 1) {
    ring.push({ x: 0, y }, { x: width - 1, y });
  }
  const ringKeys = new Set(ring.map((c) => cellKey(c.x, c.y)));

  const covered = new Set<string>();
  let doorCount = 0;
  for (const prop of def.props) {
    if (prop.kind !== 'wall' && prop.kind !== 'door') continue;
    let onRing = false;
    for (const cell of propCells(prop, def)) {
      const key = cellKey(cell.x, cell.y);
      if (ringKeys.has(key)) {
        covered.add(key);
        onRing = true;
      }
    }
    if (prop.kind === 'door' && onRing) doorCount += 1;
  }

  const gaps = ringKeys.size - covered.size;
  const pass = gaps === 0 && doorCount >= 1;
  const problems: string[] = [];
  if (gaps > 0) {
    problems.push(`${gaps} of ${ringKeys.size} perimeter tile(s) have no wall or door prop`);
  }
  if (doorCount === 0) {
    problems.push('no door prop sits on the perimeter');
  }
  return {
    id: 'shell-integrity',
    label: 'Shell integrity',
    pass,
    actual: doorCount,
    threshold: 1,
    detail: pass
      ? `Complete ${ringKeys.size}-tile wall ring with ${doorCount} door(s).`
      : `${problems.join('; ')}. A set piece owns its own shell: map-gen carves the room ` +
        `to this footprint and connects corridors to the declared door slots. A gapped ring ` +
        `has nothing to carve against, and a ring with no door is a sealed, unreachable room.`,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Score one set piece against the composition gate. Pure. */
export function scoreSetPiece(
  def: SetPieceDef,
  thresholds: CompositionThresholds = DEFAULT_THRESHOLDS,
): CompositionReport {
  const occupancyCount = new Map<string, number>();
  const perimeterDressed = new Set<string>();

  for (const prop of def.props) {
    // Density, stacking and edge treatment are about what the room LOOKS like,
    // so they run off the rendered extent, not the authored tile footprint.
    const renderCells = propRenderCells(prop, def);
    if (isOccupying(prop)) {
      for (const cell of renderCells) {
        const key = cellKey(cell.x, cell.y);
        occupancyCount.set(key, (occupancyCount.get(key) ?? 0) + 1);
      }
      // Layer depth is about *visual* nesting, so a composite prop that carries
      // extra sprite layers (table + potion + receipt) counts the same as
      // separate overlapping props. Each extra layer lands on the single tile its
      // foot-offset resolves to, not across the whole footprint.
      for (let i = 1; i < prop.layers.length; i += 1) {
        const layer = prop.layers[i];
        if (!layer) continue;
        const lx = Math.floor(prop.x + (layer.offsetXFt ?? 0) / FEET_PER_TILE);
        const ly = Math.floor(prop.y + (layer.offsetYFt ?? 0) / FEET_PER_TILE);
        if (lx < 0 || ly < 0 || lx >= def.width || ly >= def.height) continue;
        const key = cellKey(lx, ly);
        if (!occupancyCount.has(key)) continue;
        occupancyCount.set(key, (occupancyCount.get(key) ?? 0) + 1);
      }
    }
    if (PERIMETER_KINDS.has(prop.kind)) {
      for (const cell of renderCells) perimeterDressed.add(cellKey(cell.x, cell.y));
    }
  }

  const checks: readonly CheckResult[] = [
    checkOccupancy(def, occupancyCount, thresholds),
    checkStacking(occupancyCount, thresholds),
    checkPerimeter(def, perimeterDressed, thresholds),
    checkFloorVariety(def, thresholds),
    checkAntiGrid(def, thresholds),
    checkRealWorldScale(def, thresholds),
    checkScaleSanity(def, thresholds),
    checkFocalPoint(def, thresholds),
    checkWallAnchoring(def, thresholds),
    checkCirculation(def, thresholds),
    checkAnchorSanity(def),
    checkShellIntegrity(def),
  ];

  const passedCount = checks.filter((c) => c.pass).length;
  return {
    setPieceId: def.id,
    width: def.width,
    height: def.height,
    checks,
    passed: passedCount === checks.length,
    passedCount,
    totalCount: checks.length,
  };
}
