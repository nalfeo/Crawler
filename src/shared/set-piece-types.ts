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
 *
 * ## Actors / NPCs
 *
 * A set piece may also place NPCs via {@link SetPieceNpcDef}, positioned in the
 * same tile grid as props. NPCs are not props — the stamping pass spawns them as
 * living entities, and an optional `anchorRole` lets a placed NPC drive a
 * Floor-scenario objective tile so the objective marker tracks where the NPC stands.
 */
import { z } from 'zod';
import setPiecesPack from './data/set-pieces.json';
import { getNpcDef } from './npc-types.js';

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

/**
 * Prop kinds whose visual is owned by the CARVED TERRAIN LAYER, not by the prop.
 *
 * Under the prefab-room model a `kind:'wall'` / `kind:'door'` prop exists in the
 * def to define the shell — it is the composition gate's wall ring and map-gen's
 * door-tile source of truth — but it must NEVER be rendered as a sprite. The
 * generator has already written STONE_WALL / DOOR tiles at those coordinates, so
 * drawing the prop on top double-renders and z-fights the baked tile with
 * (typically stock placeholder) art.
 *
 * Every renderer that stamps a set piece MUST filter on this predicate. It is
 * shared rather than duplicated because the Set Piece Lab drifted from the real
 * game on exactly this rule and spent a full session presenting a blue-grey
 * Kenney wall ring that the game does not draw — laundering a wrong image as
 * visual evidence.
 */
export const STRUCTURAL_PROP_KINDS: readonly SetPiecePropKind[] = Object.freeze([
  'wall',
  'door',
] as const);

/**
 * True when a prop's visual comes from carved terrain and the prop must not be
 * rendered. See {@link STRUCTURAL_PROP_KINDS}.
 */
export function isStructuralSetPieceProp(prop: { readonly kind: SetPiecePropKind }): boolean {
  return STRUCTURAL_PROP_KINDS.includes(prop.kind);
}

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
  /** Sub-tile pixel offset from the prop's top-left tile (lab pixels). */
  readonly offsetX?: number;
  readonly offsetY?: number;
  /**
   * Sub-tile position nudge in FEET, added on top of any pixel offset. Prefer
   * this over `offsetX`/`offsetY` for real-world placement (e.g. lifting a
   * sconce up onto the wall with `offsetYFt: -3.5`).
   */
  readonly offsetXFt?: number;
  readonly offsetYFt?: number;
  /**
   * Explicit render box in FEET for this layer, overriding the tile-derived
   * size. The sprite is contain-fit inside this box (aspect preserved, never
   * stretched). Both must be supplied together.
   *
   * IMPORTANT — what these two numbers mean. Crawler's prop art is drawn as a
   * **front elevation** (the welcome desk has "WELCOME" painted on its front
   * face), so the sprite's vertical pixels are the object's *real vertical
   * height*, NOT its depth across the floor:
   *
   * - `widthFt`  = true horizontal width, as you'd measure it in the world.
   * - `heightFt` = **apparent vertical height** — how tall the object stands
   *   (a door is 3x7 ft, an adult ~2x6 ft, a 3-crate stack ~3x5.5 ft).
   *
   * The object's FLOOR FOOTPRINT is a separate concept and lives on the prop
   * as `width`/`height` in TILES. Do NOT author `heightFt` as a floor depth:
   * that is what collapsed every tall object in the shipped pack (bookcases at
   * 4 ft, crate stacks at 3.5 ft) and made rooms read as small and sparse.
   *
   * `widthFt * heightFt` is therefore a FACADE area, never a floor area.
   */
  readonly widthFt?: number;
  readonly heightFt?: number;
  /**
   * Anchor the sprite by its BASE (bottom-centre) instead of its centre, so the
   * object stands on its floor position and grows upward as `heightFt`
   * increases. Required for anything tall enough that centre-anchoring would
   * sink half of it through the floor (bookcases, crate stacks, torches, doors).
   *
   * Opt-in: omitted/false preserves the historical centre-anchored behaviour so
   * existing rooms do not shift.
   */
  readonly anchorBase?: boolean;
  /** Uniform scale multiplier (1 = native), applied on top of the render box. */
  readonly scale?: number;
  /** Mirror the sprite horizontally / vertically (e.g. mirror a paired sconce). */
  readonly flipX?: boolean;
  readonly flipY?: boolean;
  /** Optional clockwise rotation in degrees. */
  readonly rotationDeg?: number;
  /** Optional tint as `#rrggbb`. */
  readonly tintHex?: string;
}

/** A placed prop: furniture, wall, door, etc., made of one or more sprite layers. */
export interface SetPiecePropDef {
  readonly id: string;
  readonly kind: SetPiecePropKind;
  /** Tile-space X within the set piece (0-based; supports sub-tile offsets). */
  readonly x: number;
  /** Tile-space Y within the set piece (0-based; supports sub-tile offsets). */
  readonly y: number;
  /** Footprint in tiles (defaults to 1×1). */
  readonly width: number;
  readonly height: number;
  /** Explicit render order; defaults to {@link PROP_KIND_Z} for the prop kind. */
  readonly z: number;
  /** Optional scene-layer id used by editors for visibility/locking workflows. */
  readonly sceneLayer?: string;
  /**
   * True when the prop physically blocks movement. Its footprint tiles are
   * written impassable-but-transparent at carve time, so the player and AI walk
   * around it while still seeing (and being able to talk) over it.
   */
  readonly solid?: boolean;
  /** Ordered visual layers (base first, stacked extras after). */
  readonly layers: readonly SpriteLayer[];
}

/**
 * Which Floor-scenario objective anchor a set-piece NPC drives, if any. The
 * stamping pass points the matching objective tile at the NPC's spawned tile so
 * the objective marker always tracks where the NPC actually stands.
 */
export type SetPieceNpcAnchorRole = 'welcome' | 'shop' | 'spell';

/**
 * A placed NPC within a set piece, in set-piece tile coordinates (same origin as
 * props). Spawned as a living entity by the stamping pass; `npcTypeId` is
 * resolved against the NPC registry (see {@link getNpcDef}).
 */
export interface SetPieceNpcDef {
  readonly id: string;
  /** NPC type id resolved against the NPC registry, e.g. `tutorial-goon`. */
  readonly npcTypeId: string;
  /** Tile-space X within the set piece (0-based; supports sub-tile offsets). */
  readonly x: number;
  /** Tile-space Y within the set piece (0-based; supports sub-tile offsets). */
  readonly y: number;
  /** Optional per-instance render/collision width in feet. Must pair with heightFt. */
  readonly widthFt?: number;
  /** Optional per-instance render/collision height in feet. Must pair with widthFt. */
  readonly heightFt?: number;
  /** Optional sprite mirror flags applied at render time. */
  readonly flipX?: boolean;
  readonly flipY?: boolean;
  /** Optional clockwise sprite rotation in degrees. */
  readonly rotationDeg?: number;
  /** Optional local z-order within its scene layer (higher draws on top). */
  readonly z?: number;
  /** Optional scene-layer id used by editors for visibility/locking workflows. */
  readonly sceneLayer?: string;
  /** Optional visual override sprite; NPC behavior still comes from npcTypeId. */
  readonly spriteOverride?: SpriteRef;
  /** If set, this NPC's spawn tile drives the named objective anchor. */
  readonly anchorRole?: SetPieceNpcAnchorRole;
}

/**
 * How the set piece's footprint is positioned within the target room's interior
 * when it is smaller than the room. Floor-1 rooms are usually much larger than
 * an authored set piece, so the default (centre/centre) strands "back wall"
 * decor in open floor. Setting `verticalAlign: "top"` slides the whole block up
 * against the room's top wall, keeping every authored intra-block relationship
 * (wall decor above the goon, desk in front of him) while letting the wall props
 * actually reach the wall (paired with a small negative `offsetYFt` lift).
 *
 * Alignment is applied per axis over the SLACK (interior extent − footprint
 * extent); when the footprint meets or exceeds the interior on an axis the
 * origin pins to that interior edge and per-tile clamping keeps tiles passable.
 */
export type SetPieceVerticalAlign = 'top' | 'center' | 'bottom';
export type SetPieceHorizontalAlign = 'left' | 'center' | 'right';

export interface SetPiecePlacement {
  /** Vertical anchoring within the room interior. Defaults to `center`. */
  readonly verticalAlign?: SetPieceVerticalAlign;
  /** Horizontal anchoring within the room interior. Defaults to `center`. */
  readonly horizontalAlign?: SetPieceHorizontalAlign;
}

/** A perimeter edge of a set-piece footprint. */
export type SetPieceDoorEdge = 'top' | 'bottom' | 'left' | 'right';

/**
 * How map generation resolves a door slot when carving the prefab room.
 * - `fixed`   — the corridor is pinned to the door prop's authored ring tile
 *               (a shop's street entrance, a boss den's single approach).
 * - `dynamic` — map-gen may relocate the door to whichever tile along the
 *               eligible `edges` connects most straightforwardly to the floor.
 */
export type SetPieceDoorSlotMode = 'fixed' | 'dynamic';

/**
 * Map-generation resolution metadata for a door in a prefab set-piece room.
 *
 * Door **props** (`kind: 'door'`) remain the single source of truth for where a
 * door renders and for the {@link https shell-integrity} composition gate. A
 * `SetPieceDoorSlot` only layers on the map-gen *resolution* behaviour, keyed to
 * a door prop by {@link propId}. When a def declares no slots, every ring door
 * prop is treated as an implicit `fixed` slot (see {@link resolveSetPieceDoorSlots}).
 */
export interface SetPieceDoorSlot {
  /** References a `kind: 'door'` prop (by id) that lies on the footprint ring. */
  readonly propId: string;
  /** `fixed` pins the corridor to the door tile; `dynamic` relocates along `edges`. */
  readonly mode: SetPieceDoorSlotMode;
  /** For `dynamic`: the eligible perimeter edges map-gen may relocate the door onto. */
  readonly edges?: readonly SetPieceDoorEdge[];
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
  /** How the block anchors within an oversized room. Defaults to centre/centre. */
  readonly placement?: SetPiecePlacement;
  readonly props: readonly SetPiecePropDef[];
  /**
   * Optional map-gen door-slot resolution metadata (see {@link SetPieceDoorSlot}).
   * When omitted, every ring door prop is treated as an implicit `fixed` slot.
   */
  readonly doorSlots?: readonly SetPieceDoorSlot[];
  /** NPCs placed by this set piece (empty when none authored). */
  readonly npcs: readonly SetPieceNpcDef[];
  /** Optional editor scene layers (editor visibility/locking grouping only). */
  readonly sceneLayers?: readonly SetPieceSceneLayerDef[];
}

export interface SetPiecePackDef {
  readonly version: 1;
  readonly packId: string;
  readonly setPieces: readonly SetPieceSource[];
}

export interface SetPieceSceneLayerDef {
  readonly id: string;
  readonly name: string;
  readonly visible?: boolean;
  readonly locked?: boolean;
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
    offsetXFt: z.number().optional(),
    offsetYFt: z.number().optional(),
    widthFt: z.number().finite().positive().optional(),
    heightFt: z.number().finite().positive().optional(),
    anchorBase: z.boolean().optional(),
    scale: z.number().finite().positive().optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    rotationDeg: z.number().finite().optional(),
    tintHex: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'tintHex must be #rrggbb')
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.widthFt === undefined) !== (value.heightFt === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'widthFt and heightFt must be supplied together.',
      });
    }
  });

const propKinds = ['floor', 'wall', 'door', 'fixture', 'furniture', 'decoration', 'actor'] as const;

const propSourceSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.enum(propKinds),
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
    z: z.number().int().optional(),
    sceneLayer: z.string().trim().min(1).optional(),
    /**
     * Opt-in physical collision. When true the prop's footprint tiles are
     * written as impassable at carve time, so the player and the AI walk
     * around it instead of through it. Off by default: props are decor unless
     * they are bulk furniture the player should not clip through.
     *
     * Solidity is applied with a revert-on-disconnect guard
     * (`applySolidProps`), so marking a prop solid can never strand a room —
     * a prop whose blocking would cut the interior off from its door is left
     * render-only instead.
     */
    solid: z.boolean().optional(),
    layers: z.array(spriteLayerSchema).min(1),
  })
  .strict();

const npcAnchorRoles = ['welcome', 'shop', 'spell'] as const;

const npcSourceSchema = z
  .object({
    id: z.string().trim().min(1),
    npcTypeId: z.string().trim().min(1),
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    widthFt: z.number().finite().positive().optional(),
    heightFt: z.number().finite().positive().optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    rotationDeg: z.number().finite().optional(),
    z: z.number().int().optional(),
    sceneLayer: z.string().trim().min(1).optional(),
    spriteOverride: spriteRefSchema.optional(),
    anchorRole: z.enum(npcAnchorRoles).optional(),
  })
  .strict();

const setPieceSceneLayerSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .strict();

const placementSchema = z
  .object({
    verticalAlign: z.enum(['top', 'center', 'bottom']).optional(),
    horizontalAlign: z.enum(['left', 'center', 'right']).optional(),
  })
  .strict();

const doorEdges = ['top', 'bottom', 'left', 'right'] as const;

const doorSlotSchema = z
  .object({
    propId: z.string().trim().min(1),
    mode: z.enum(['fixed', 'dynamic']),
    edges: z.array(z.enum(doorEdges)).min(1).optional(),
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
    placement: placementSchema.optional(),
    props: z.array(propSourceSchema).min(1),
    doorSlots: z.array(doorSlotSchema).optional(),
    npcs: z.array(npcSourceSchema).default([]),
    sceneLayers: z.array(setPieceSceneLayerSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isThemed = value.sizing === 'themed';
    const boundW = isThemed ? (value.maxWidth ?? value.width) : value.width;
    const boundH = isThemed ? (value.maxHeight ?? value.height) : value.height;
    const layerIds = new Set<string>();
    const hasDeclaredLayers = value.sceneLayers !== undefined;
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
    if (value.sceneLayers !== undefined) {
      for (const layer of value.sceneLayers) {
        if (layerIds.has(layer.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate scene layer id "${layer.id}".`,
          });
        } else {
          layerIds.add(layer.id);
        }
      }
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
      if (hasDeclaredLayers && prop.sceneLayer !== undefined && !layerIds.has(prop.sceneLayer)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Prop "${prop.id}" references unknown sceneLayer "${prop.sceneLayer}".`,
        });
      }
    }
    if (value.doorSlots !== undefined) {
      // Door slots resolve against the nominal footprint ring (value.width ×
      // value.height), matching the shell-integrity composition gate. A slot
      // references a `door` prop by id; that prop must lie on the ring.
      const ringW = value.width;
      const ringH = value.height;
      const doorPropsById = new Map<string, (typeof value.props)[number]>();
      for (const prop of value.props) {
        if (prop.kind === 'door') doorPropsById.set(prop.id, prop);
      }
      const isSingleTileRingOrigin = (prop: (typeof value.props)[number]): boolean => {
        const w = Math.floor(prop.width ?? 1);
        const h = Math.floor(prop.height ?? 1);
        if (w !== 1 || h !== 1) return false;
        const x0 = Math.floor(prop.x);
        const y0 = Math.floor(prop.y);
        return x0 <= 0 || y0 <= 0 || x0 >= ringW - 1 || y0 >= ringH - 1;
      };
      const seenSlotProps = new Set<string>();
      for (const slot of value.doorSlots) {
        if (seenSlotProps.has(slot.propId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate door slot for prop "${slot.propId}" — one slot per door prop.`,
          });
        }
        seenSlotProps.add(slot.propId);
        const prop = doorPropsById.get(slot.propId);
        if (prop === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Door slot references unknown door prop "${slot.propId}" (must be a kind:'door' prop).`,
          });
          continue;
        }
        if (!isSingleTileRingOrigin(prop)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Door slot prop "${slot.propId}" must be a 1×1 door with origin on the ${ringW}×${ringH} footprint ring.`,
          });
        }
        if (slot.mode === 'dynamic' && (slot.edges === undefined || slot.edges.length === 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Dynamic door slot "${slot.propId}" must declare at least one eligible edge.`,
          });
        }
        if (slot.mode === 'fixed' && slot.edges !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Fixed door slot "${slot.propId}" must not declare edges (edges are for dynamic slots).`,
          });
        }
      }
    }
    const seenNpcIds = new Set<string>();
    const seenAnchors = new Set<string>();
    for (const npc of value.npcs) {
      if (seenNpcIds.has(npc.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate NPC id "${npc.id}".`,
        });
      }
      seenNpcIds.add(npc.id);
      if ((npc.widthFt === undefined) !== (npc.heightFt === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `NPC "${npc.id}" must specify widthFt and heightFt together.`,
        });
      }
      if (npc.x >= boundW || npc.y >= boundH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `NPC "${npc.id}" sits outside the ${boundW}×${boundH} footprint.`,
        });
      }
      if (getNpcDef(npc.npcTypeId) === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `NPC "${npc.id}" references unknown npcTypeId "${npc.npcTypeId}".`,
        });
      }
      if (hasDeclaredLayers && npc.sceneLayer !== undefined && !layerIds.has(npc.sceneLayer)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `NPC "${npc.id}" references unknown sceneLayer "${npc.sceneLayer}".`,
        });
      }
      if (npc.anchorRole !== undefined) {
        if (seenAnchors.has(npc.anchorRole)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate anchorRole "${npc.anchorRole}" — each objective anchor may be driven by at most one NPC.`,
          });
        }
        seenAnchors.add(npc.anchorRole);
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
    sceneLayer: source.sceneLayer,
    solid: source.solid ?? false,
    layers: source.layers,
  };
}

function compileNpc(source: SetPieceSource['npcs'][number]): SetPieceNpcDef {
  return {
    id: source.id,
    npcTypeId: source.npcTypeId,
    x: source.x,
    y: source.y,
    widthFt: source.widthFt,
    heightFt: source.heightFt,
    flipX: source.flipX,
    flipY: source.flipY,
    rotationDeg: source.rotationDeg,
    z: source.z,
    sceneLayer: source.sceneLayer,
    spriteOverride: source.spriteOverride,
    anchorRole: source.anchorRole,
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
    ...(source.placement !== undefined ? { placement: source.placement } : {}),
    props: source.props.map(compileProp),
    ...(source.doorSlots !== undefined ? { doorSlots: source.doorSlots } : {}),
    npcs: source.npcs.map(compileNpc),
    ...(source.sceneLayers !== undefined ? { sceneLayers: source.sceneLayers } : {}),
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

/** Find the NPC that drives a given objective anchor, if any. */
export function findSetPieceNpcByAnchor(
  def: SetPieceDef,
  role: SetPieceNpcAnchorRole,
): SetPieceNpcDef | undefined {
  return def.npcs.find((npc) => npc.anchorRole === role);
}

/** A door slot resolved to concrete set-piece tiles for map generation. */
export interface SetPieceResolvedDoorSlot {
  /** The door prop this slot renders as. */
  readonly propId: string;
  readonly mode: SetPieceDoorSlotMode;
  /** For `dynamic`: eligible perimeter edges map-gen may relocate the door onto. */
  readonly edges?: readonly SetPieceDoorEdge[];
  /** Door tile(s) in set-piece coords (top-left). Doors are usually 1×1. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Resolve the door slots map generation should carve for a prefab set-piece room.
 *
 * Door **props** on the footprint ring are the source of truth for door position
 * and rendering. A matching {@link SetPieceDoorSlot} (by `propId`) upgrades a
 * door to `dynamic` (relocatable along its eligible edges); a door prop with no
 * matching slot is an implicit `fixed` door pinned to its authored tile. Result
 * order follows authored prop order, so the output is fully deterministic.
 */
export function resolveSetPieceDoorSlots(def: SetPieceDef): SetPieceResolvedDoorSlot[] {
  const ringW = def.width;
  const ringH = def.height;
  const slotByProp = new Map<string, SetPieceDoorSlot>();
  for (const slot of def.doorSlots ?? []) slotByProp.set(slot.propId, slot);

  const resolved: SetPieceResolvedDoorSlot[] = [];
  for (const prop of def.props) {
    if (prop.kind !== 'door') continue;
    const x0 = Math.floor(prop.x);
    const y0 = Math.floor(prop.y);
    const w = Math.max(1, Math.floor(prop.width));
    const h = Math.max(1, Math.floor(prop.height));
    const onRing = x0 <= 0 || y0 <= 0 || x0 >= ringW - 1 || y0 >= ringH - 1;
    if (w !== 1 || h !== 1 || !onRing) continue;
    const slot = slotByProp.get(prop.id);
    const mode: SetPieceDoorSlotMode = slot?.mode ?? 'fixed';
    resolved.push({
      propId: prop.id,
      mode,
      ...(mode === 'dynamic' && slot?.edges !== undefined ? { edges: slot.edges } : {}),
      x: x0,
      y: y0,
      width: w,
      height: h,
    });
  }
  return resolved;
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
