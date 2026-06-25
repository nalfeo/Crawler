/**
 * Set Piece data model — serializable themed-room definitions + a validated registry.
 *
 * A "set piece" is a hand-authored chunk of the world that was "picked up from
 * Earth and dropped into the dungeon" — Jimmy's NYC pizza joint, a doctor's
 * office, a blue-collar break room, etc. They are pure config and never embed
 * rendering logic, so the same definition can be inspected in a lab, fed to an
 * art pipeline, or (later) stamped into a generated floor.
 *
 * Like quests, set pieces are loaded from data "packs" and compiled at runtime.
 * This keeps content config-driven and lets LLM/procedural providers inject
 * additional packs later without touching the evaluator. NOTE: set pieces are
 * deliberately NOT wired into map generation yet — this module only defines the
 * model, the registry, and pure layout helpers.
 *
 * ## Sprite sourcing
 *
 * Every visual layer references art through a {@link SpriteRef} union with three
 * modes that mirror the three ways content authors get art:
 * - `catalog` — reuse an existing sprite-catalog entry by id.
 * - `sheet`   — "record" an existing spritesheet frame (sheetKey + col/row) that
 *               has not yet been promoted to its own catalog entry.
 * - `custom`  — request bespoke art to be generated. A `placeholder` is shown in
 *               viewers/labs until the real asset lands. See
 *               {@link collectCustomArtRequests}.
 *
 * ## Layering
 *
 * A prop's visual is an ordered list of {@link SpriteLayer}s, so composites like
 * "a flower pot on a table" are a table layer with a flower-pot layer stacked on
 * top (offset within the tile). Props are ordered against each other by `z`
 * (defaulted from {@link SetPiecePropKind} when omitted).
 */
import { z } from 'zod';
import setPiecesPack from './data/set-pieces.json';

/** Edge length, in pixels, of a single set-piece grid tile (matches sprite frames). */
export const SET_PIECE_TILE_SIZE = 16;

/**
 * How a set piece is sized when placed.
 * - `exact`  — a specific, fixed-footprint locale (e.g. Jimmy's pizza shop).
 * - `themed`  — a flexible "kit" (e.g. doctor's office) that can fill a range of
 *               room sizes; `width`/`height` is the nominal/min footprint and
 *               `maxWidth`/`maxHeight` the largest supported footprint.
 */
export type SetPieceSizingKind = 'exact' | 'themed';

/**
 * What a prop represents. Drives the default render `z` and lets later systems
 * reason about collision/interactivity without parsing sprites.
 */
export type SetPiecePropKind =
  | 'floor'
  | 'wall'
  | 'door'
  | 'fixture'
  | 'furniture'
  | 'decoration'
  | 'actor';

/** Default render order per prop kind (lower draws first / underneath). */
export const PROP_KIND_Z: Readonly<Record<SetPiecePropKind, number>> = Object.freeze({
  floor: 0,
  wall: 10,
  door: 12,
  fixture: 20,
  furniture: 30,
  decoration: 40,
  actor: 50,
});

export type SpriteSourceKind = 'catalog' | 'sheet' | 'custom';

/** Reuse an existing sprite-catalog entry. */
export interface CatalogSpriteRef {
  readonly source: 'catalog';
  readonly spriteId: string;
}

/** "Record" an existing spritesheet frame not yet promoted to a catalog entry. */
export interface SheetSpriteRef {
  readonly source: 'sheet';
  readonly sheetKey: string;
  readonly col: number;
  readonly row: number;
}

/** Placeholder shown for a custom-art request until the real asset is generated. */
export type CustomArtPlaceholder = CatalogSpriteRef | SheetSpriteRef;

/**
 * Request bespoke art to be generated. Until the asset lands, viewers render the
 * optional `placeholder` (or a labeled stand-in). The `requestId` is the stable
 * handle the art pipeline keys generated assets against.
 */
export interface CustomSpriteRef {
  readonly source: 'custom';
  readonly requestId: string;
  /** Human-facing label for the requested asset. */
  readonly label: string;
  /** Generation prompt / art direction. */
  readonly prompt: string;
  /** Requested footprint in tiles (defaults to 1×1). */
  readonly widthTiles?: number;
  readonly heightTiles?: number;
  /** Free-form art tags (style, palette hints, etc.). */
  readonly tags?: readonly string[];
  /** Stand-in shown until the real asset is generated. */
  readonly placeholder?: CustomArtPlaceholder;
}

/** Discriminated union describing where a layer's art comes from. */
export type SpriteRef = CatalogSpriteRef | SheetSpriteRef | CustomSpriteRef;

/** A single drawable layer within a prop. Layers stack to form composites. */
export interface SpriteLayer {
  readonly sprite: SpriteRef;
  /** Sub-tile pixel offset from the prop's top-left tile. */
  readonly offsetX?: number;
  readonly offsetY?: number;
  /** Uniform scale multiplier (1 = native). */
  readonly scale?: number;
  /** Optional tint as `#rrggbb`. */
  readonly tintHex?: string;
}

/** A placed prop: furniture, wall, door, etc., made of one or more sprite layers. */
export interface SetPiecePropDef {
  readonly id: string;
  readonly kind: SetPiecePropKind;
  /** Tile column within the set piece (0-based, left to right). */
  readonly x: number;
  /** Tile row within the set piece (0-based, top to bottom). */
  readonly y: number;
  /** Footprint in tiles (defaults to 1×1). */
  readonly width: number;
  readonly height: number;
  /** Explicit render order; defaults to {@link PROP_KIND_Z} for the prop kind. */
  readonly z: number;
  /** Ordered visual layers (base first, stacked extras after). */
  readonly layers: readonly SpriteLayer[];
}

export interface SetPieceDef {
  readonly id: string;
  readonly name: string;
  /** Theme grouping, e.g. `food`, `office`, `transit`. */
  readonly theme: string;
  readonly sizing: SetPieceSizingKind;
  /** Nominal footprint in tiles (for `themed`, the minimum supported). */
  readonly width: number;
  readonly height: number;
  /** Largest supported footprint for `themed` kits (omitted for `exact`). */
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly description: string;
  readonly tags: readonly string[];
  readonly props: readonly SetPiecePropDef[];
}

export interface SetPiecePackDef {
  readonly version: 1;
  readonly packId: string;
  readonly setPieces: readonly SetPieceSource[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const catalogSpriteSchema = z
  .object({
    source: z.literal('catalog'),
    spriteId: z.string().trim().min(1),
  })
  .strict();

const sheetSpriteSchema = z
  .object({
    source: z.literal('sheet'),
    sheetKey: z.string().trim().min(1),
    col: z.number().int().min(0),
    row: z.number().int().min(0),
  })
  .strict();

const customSpriteSchema = z
  .object({
    source: z.literal('custom'),
    requestId: z.string().trim().min(1),
    label: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    widthTiles: z.number().int().positive().optional(),
    heightTiles: z.number().int().positive().optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    placeholder: z
      .discriminatedUnion('source', [catalogSpriteSchema, sheetSpriteSchema])
      .optional(),
  })
  .strict();

const spriteRefSchema = z.discriminatedUnion('source', [
  catalogSpriteSchema,
  sheetSpriteSchema,
  customSpriteSchema,
]);

const spriteLayerSchema = z
  .object({
    sprite: spriteRefSchema,
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
    scale: z.number().positive().optional(),
    tintHex: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'tintHex must be #rrggbb')
      .optional(),
  })
  .strict();

const propKinds = ['floor', 'wall', 'door', 'fixture', 'furniture', 'decoration', 'actor'] as const;

const propSourceSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.enum(propKinds),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    z: z.number().int().optional(),
    layers: z.array(spriteLayerSchema).min(1),
  })
  .strict();

const setPieceSourceSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    theme: z.string().trim().min(1),
    sizing: z.enum(['exact', 'themed']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    maxWidth: z.number().int().positive().optional(),
    maxHeight: z.number().int().positive().optional(),
    description: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).default([]),
    props: z.array(propSourceSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isThemed = value.sizing === 'themed';
    const boundW = isThemed ? (value.maxWidth ?? value.width) : value.width;
    const boundH = isThemed ? (value.maxHeight ?? value.height) : value.height;
    if (value.maxWidth !== undefined && value.maxWidth < value.width) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'maxWidth must be >= width.' });
    }
    if (value.maxHeight !== undefined && value.maxHeight < value.height) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'maxHeight must be >= height.' });
    }
    if (!isThemed && (value.maxWidth !== undefined || value.maxHeight !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'maxWidth/maxHeight are only valid for themed set pieces.',
      });
    }
    const seen = new Set<string>();
    for (const prop of value.props) {
      if (seen.has(prop.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate prop id "${prop.id}".`,
        });
      }
      seen.add(prop.id);
      const w = prop.width ?? 1;
      const h = prop.height ?? 1;
      if (prop.x + w > boundW || prop.y + h > boundH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Prop "${prop.id}" extends outside the ${boundW}×${boundH} footprint.`,
        });
      }
    }
  });

type SetPieceSourceInput = z.input<typeof setPieceSourceSchema>;
export type SetPieceSource = z.infer<typeof setPieceSourceSchema>;
export type SetPieceAuthoringInput = SetPieceSourceInput;

export const setPiecePackSchema = z
  .object({
    version: z.literal(1),
    packId: z.string().trim().min(1),
    setPieces: z.array(setPieceSourceSchema).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Compilation + registry
// ---------------------------------------------------------------------------

function compileProp(source: SetPieceSource['props'][number]): SetPiecePropDef {
  return {
    id: source.id,
    kind: source.kind,
    x: source.x,
    y: source.y,
    width: source.width ?? 1,
    height: source.height ?? 1,
    z: source.z ?? PROP_KIND_Z[source.kind],
    layers: source.layers,
  };
}

function compileSetPiece(source: SetPieceSource): SetPieceDef {
  return {
    id: source.id,
    name: source.name,
    theme: source.theme,
    sizing: source.sizing,
    width: source.width,
    height: source.height,
    maxWidth: source.maxWidth,
    maxHeight: source.maxHeight,
    description: source.description,
    tags: source.tags,
    props: source.props.map(compileProp),
  };
}

function buildRegistry(packs: readonly SetPiecePackDef[]): ReadonlyMap<string, SetPieceDef> {
  const registry = new Map<string, SetPieceDef>();
  for (const pack of packs) {
    for (const source of pack.setPieces) {
      const compiled = compileSetPiece(setPieceSourceSchema.parse(source));
      registry.set(compiled.id, compiled);
    }
  }
  return registry;
}

const DEFAULT_SET_PIECE_PACKS: readonly SetPiecePackDef[] = Object.freeze([
  setPiecePackSchema.parse(setPiecesPack),
]);

let setPiecePacks: readonly SetPiecePackDef[] = DEFAULT_SET_PIECE_PACKS;
let setPieceRegistry: ReadonlyMap<string, SetPieceDef> = buildRegistry(DEFAULT_SET_PIECE_PACKS);

/** Replace loaded set-piece content with validated packs (e.g. an LLM-authored pack). */
export function installSetPiecePacks(packs: readonly SetPiecePackDef[]): void {
  const parsed = packs.map((pack) => setPiecePackSchema.parse(pack));
  setPiecePacks = parsed;
  setPieceRegistry = buildRegistry(parsed);
}

/** Reset set-piece content back to the bundled defaults. */
export function installDefaultSetPiecePacks(): void {
  setPiecePacks = DEFAULT_SET_PIECE_PACKS;
  setPieceRegistry = buildRegistry(DEFAULT_SET_PIECE_PACKS);
}

export function getSetPiecePacks(): readonly SetPiecePackDef[] {
  return setPiecePacks;
}

export function getSetPieceDef(id: string): SetPieceDef | undefined {
  return setPieceRegistry.get(id);
}

export function getAllSetPieceDefs(): SetPieceDef[] {
  return [...setPieceRegistry.values()];
}

export function getSetPiecesByTheme(theme: string): SetPieceDef[] {
  return getAllSetPieceDefs().filter((def) => def.theme === theme);
}

// ---------------------------------------------------------------------------
// Pure layout helpers (no rendering imports)
// ---------------------------------------------------------------------------

/** Footprint of a set piece in tiles. For `themed`, this is the maximum extent. */
export function getSetPieceFootprint(def: SetPieceDef): { width: number; height: number } {
  if (def.sizing === 'themed') {
    return { width: def.maxWidth ?? def.width, height: def.maxHeight ?? def.height };
  }
  return { width: def.width, height: def.height };
}

/** A single resolved draw instruction, flattened across props and their layers. */
export interface SetPieceDrawLayer {
  readonly prop: SetPiecePropDef;
  readonly layer: SpriteLayer;
  /** Effective render order (prop `z`, then layer index within the prop). */
  readonly z: number;
  readonly layerIndex: number;
}

/**
 * Flatten a set piece into a render-ordered list of draw layers. Props are
 * ordered by `z` (then authored order); layers within a prop keep their order
 * and stack above the prop's base layer. Stable sort preserves ties.
 */
export function flattenSetPieceLayers(def: SetPieceDef): SetPieceDrawLayer[] {
  const draws: SetPieceDrawLayer[] = [];
  for (const prop of def.props) {
    prop.layers.forEach((layer, layerIndex) => {
      draws.push({ prop, layer, z: prop.z, layerIndex });
    });
  }
  return draws
    .map((draw, index) => ({ draw, index }))
    .sort((a, b) => a.draw.z - b.draw.z || a.index - b.index)
    .map((entry) => entry.draw);
}

/** Whether a sprite reference targets art that does not exist yet. */
export function isCustomSpriteRef(ref: SpriteRef): ref is CustomSpriteRef {
  return ref.source === 'custom';
}

/**
 * Collect the de-duplicated custom-art requests across one or more set pieces,
 * so the art pipeline can plan/generate the missing assets. Requests are keyed
 * by `requestId`; the first occurrence wins.
 */
export function collectCustomArtRequests(
  defs: SetPieceDef | readonly SetPieceDef[],
): CustomSpriteRef[] {
  const list = Array.isArray(defs) ? defs : [defs as SetPieceDef];
  const byId = new Map<string, CustomSpriteRef>();
  for (const def of list) {
    for (const prop of def.props) {
      for (const layer of prop.layers) {
        if (isCustomSpriteRef(layer.sprite) && !byId.has(layer.sprite.requestId)) {
          byId.set(layer.sprite.requestId, layer.sprite);
        }
      }
    }
  }
  return [...byId.values()];
}
