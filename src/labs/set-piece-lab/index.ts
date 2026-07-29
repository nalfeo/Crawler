/**
 * Set-Piece Lab — renders authored set pieces through the REAL engine.
 *
 * This lab used to draw set pieces with a bespoke 2D-canvas renderer. That
 * renderer could not load standalone generated PNGs and resolved catalog keys
 * differently from the game, so the preview never matched what actually shipped.
 *
 * It now boots Phaser + {@link createPhaserBridge} and stamps the selected set
 * piece into a synthesized, room-sized floor (Design A: one focused diorama per
 * set piece):
 *   - terrain (floor + walls) is baked by {@link buildTerrainLayer} at depth -20,
 *   - props are spawned via {@link addSetPieceProp} and rendered by the bridge's
 *     real set-piece pass (generated-art resolution, tint, per-layer depth),
 *   - NPCs are spawned via {@link spawnNpc} and render as their real sprites.
 *
 * FIDELITY CONTRACT — read this before trusting a screenshot from this lab.
 *
 * The lab synthesizes its own room instead of running map generation, so two
 * things the real game decides elsewhere must be mirrored here BY HAND. Both
 * were wrong at once, and the lab meanwhile claimed to be "byte-faithful to the
 * game", so every visual review of `welcome-room` was conducted against a room
 * the player never sees — wrong wall art AND the opposite floor temperature:
 *
 *  1. INTERIOR TERRAIN. The game carves a set-piece room as STONE_FLOOR and then
 *     `tagRoomAsSafe` (floorScenario.ts:1034-1040) repaints safe rooms to
 *     SAFE_ROOM_FLOOR — warm orange brick, not the cool blue-grey of
 *     STONE_FLOOR. The lab hardcoded STONE_FLOOR for every def. See
 *     {@link LAB_INTERIOR_TERRAIN}.
 *  2. WALL/DOOR PROPS. Under the prefab-room model the carved terrain layer is
 *     authoritative for walls and doors, so the game SKIPS every `kind:'wall'`
 *     and `kind:'door'` prop (floorScenario.ts:1955-1963) rather than
 *     double-rendering them over the baked tiles. The lab drew them, painting a
 *     blue-grey Kenney placeholder ring over the correct generated stone.
 *
 * `tests/unit/set-piece-lab-fidelity.test.ts` pins both rules against the real
 * game's own predicate so this cannot silently drift again. A lab that renders
 * something the game does not is worse than no lab: it launders a wrong image
 * as evidence, and "observe before done" is the backstop that is supposed to
 * catch exactly that.
 *
 * The floor is sized to the set-piece footprint plus a 1-tile wall border, so a
 * back-wall prop (set-piece y = 0) sits flush under the top wall — this makes
 * the depth straddling visible: rugs render over the baked floor and under NPCs,
 * while a banner renders over the wall. This lab is the deterministic
 * "observe before done" surface for set-piece art wiring and layout tuning.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { createGameWorld, type GameWorld } from '../../core/index.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { stampSetPiece, type StampedSetPiece } from '../../core/map/stampSetPiece.js';
import { addSetPieceProp, spawnNpc } from '../../core/spawners/world-objects.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import { pickGeneratedNpcTextureKey } from '../../engine/phaser-bridge/sprite-kind.js';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../../engine/generatedAssets/index.js';
import { getSheet, getSprite, SHEETS } from '../../engine/sprites/index.js';
import { buildTerrainLayer } from '../../engine/terrain-renderer.js';
import { GAME } from '../../shared/constants.js';
import { emptyGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { createLogger } from '../../shared/logger.js';
import { BiomeType, TilePresets, type MapConfig, type RoomBounds } from '../../shared/map-types.js';
import { getNpcDef } from '../../shared/npc-types.js';
import { ENTITY_DEPTH, TERRAIN_DEPTH, setPieceZToDepth } from '../../shared/render-depths.js';
import {
  collectCustomArtRequests,
  flattenSetPieceLayers,
  getAllSetPieceDefs,
  getSetPieceDef,
  getSetPieceFootprint,
  isStructuralSetPieceProp,
  type SetPieceDef,
  type SetPieceNpcAnchorRole,
  type SpriteRef,
} from '../../shared/set-piece-types.js';
import { ftToPx } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';
import { LAB_BORDER_TERRAIN, labInteriorTerrainFor } from './fidelity.js';
import { isSetPieceRenderReady, spriteRefRendersPersistentPlaceholder } from './readiness.js';

const LAB_ID = 'set-piece-lab';
const SCENE_KEY = 'SetPieceLabScene';
const TILE_SIZE_FT = 4;
const DEPTH_EPSILON = 0.001;
/** Fraction of the viewport the map should occupy after fit (leaves a margin). */
const CAMERA_PADDING = 1.12;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const logger = createLogger('labs:set-piece-lab');
const CRITICAL_SHEET_KEYS = new Set([
  'kenney-tiny-dungeon',
  'kenney-tiny-town',
  'kenney-roguelike-rpg-pack',
  'custom-pixel-sprites',
]);

/**
 * Honest render-readiness flag (see {@link isSetPieceRenderReady}). Only `true`
 * while the CURRENTLY selected set piece is rendering REAL art — every TRANSIENT
 * prop placeholder Rectangle resolved (only intentional queued-art stand-ins may
 * remain) and every pinned NPC key resident. Read by the headless visual-review
 * harness through `window.__uiProbe.ready()` so it never captures cold-cache
 * placeholders. Module-scoped so it survives scene restarts (the dropdown
 * restarts the scene, which re-enters `create()` but not the lab factory) and so
 * the probe closure below reflects the latest recompute.
 */
let labReady = false;

/** Globals this lab installs on `window` for the visual-review harness + setup. */
interface SetPieceLabWindow {
  __uiProbe?: { ready: () => boolean };
  __setPieceScene?: Phaser.Scene;
}

function setPieceLabWindow(): SetPieceLabWindow {
  return window as unknown as SetPieceLabWindow;
}

/**
 * Pick which set piece to boot. Honors `?piece=<id>` / `?setPiece=<id>` in the
 * page URL (the headless visual-review harness deep-links `welcome-room`),
 * falling back to the first registered def when the param is absent or unknown.
 * Guarded so a malformed query string can never throw during lab boot.
 */
function resolveInitialSetPieceId(defs: readonly SetPieceDef[]): string {
  const fallback = defs[0]?.id ?? '';
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('piece') ?? params.get('setPiece');
    if (requested && defs.some((def) => def.id === requested)) {
      return requested;
    }
  } catch {
    // Malformed search string — fall back to the first registered def.
  }
  return fallback;
}

/** NPC anchor-role → label colour, mirroring the objective-marker palette. */
const NPC_ANCHOR_COLOR: Record<SetPieceNpcAnchorRole, string> = {
  welcome: '#f6c453',
  shop: '#5ad19b',
  spell: '#c48cff',
};

/** Escape a string for safe innerHTML injection in tooltips / info pane. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A small inline colour swatch + hex label for a tint transform. */
function tintSwatch(hex: string): string {
  return `<span style="display:inline-block;width:9px;height:9px;border:1px solid rgba(0,0,0,0.5);background:${esc(hex)};vertical-align:middle;margin-right:4px"></span>${esc(hex)}`;
}

function normalizeCatalogSpriteId(spriteId: string): string {
  return spriteId.startsWith('sprite:') ? spriteId.slice('sprite:'.length) : spriteId;
}

/** Human label for where a set-piece depth sits relative to the entity plane. */
function depthBandLabel(depth: number): string {
  if (depth < 0) {
    return 'under NPCs · over floor/wall';
  }
  if (depth >= 2) {
    return 'in front of NPCs';
  }
  return 'entity plane';
}

/**
 * Describe how a set-piece sprite ref resolves, mirroring the SAME logic the
 * engine's set-piece pass uses (resolveSetPieceSprite in PhaserBridge), plus
 * whether it lands on real art or the labeled placeholder box. Resolved live
 * against the scene's texture cache so it reflects late-loading generated art.
 */
function describeAsset(scene: Phaser.Scene, ref: SpriteRef): { text: string; real: boolean } {
  if (ref.source === 'sheet') {
    const sheet = getSheet(ref.sheetKey);
    const real = sheet !== undefined && scene.textures?.exists(ref.sheetKey) === true;
    return {
      text: `sheet <code>${esc(ref.sheetKey)}</code> · row ${ref.row}, col ${ref.col}`,
      real,
    };
  }
  if (ref.source === 'catalog') {
    const normalizedSpriteId = normalizeCatalogSpriteId(ref.spriteId);
    const def = getSprite(normalizedSpriteId);
    if (def !== undefined && scene.textures?.exists(def.sheetKey) === true) {
      return {
        text: `catalog <code>${esc(ref.spriteId)}</code> → Kenney <code>${esc(def.sheetKey)}</code> #${def.frame}`,
        real: true,
      };
    }
    // Generated sprites load as individual textures keyed by the bare manifest key.
    if (scene.textures?.exists(normalizedSpriteId) === true) {
      return { text: `generated <code>${esc(normalizedSpriteId)}</code>`, real: true };
    }
    return { text: `catalog <code>${esc(ref.spriteId)}</code> · not loaded`, real: false };
  }
  const placeholder =
    ref.placeholder !== undefined
      ? describeAsset(scene, ref.placeholder)
      : { text: 'labeled box', real: false };
  return {
    text: `custom <code>${esc(ref.requestId)}</code> → ${placeholder.text}`,
    real: placeholder.real,
  };
}

function requiredGeneratedNpcKeyForStamp(
  npcTypeId: string,
  spriteOverride: SpriteRef | undefined,
): string | null {
  if (spriteOverride?.source === 'catalog') {
    const normalizedSpriteId = normalizeCatalogSpriteId(spriteOverride.spriteId);
    if (getSprite(normalizedSpriteId) === undefined) {
      return normalizedSpriteId;
    }
  }
  return pickGeneratedNpcTextureKey(npcTypeId);
}

/** One hover-testable rectangle (a prop layer or an NPC), in world pixels. */
interface HoverItem {
  readonly centreXpx: number;
  readonly centreYpx: number;
  readonly halfWpx: number;
  readonly halfHpx: number;
  readonly depth: number;
  readonly header: string;
  /** Prop layers carry their sprite ref for live asset resolution; NPCs don't. */
  readonly ref?: SpriteRef;
  /**
   * NPC entries carry their def id so the tooltip can resolve the pinned
   * generated sprite key live against the running scene (mirrors {@link ref}
   * for props). Undefined for prop layers.
   */
  readonly npcDefId?: string;
  /** Pre-rendered transform/metadata lines (asset resolution happens live). */
  readonly bodyHtml: string;
}

/**
 * Build the hover index for a stamped set piece: one entry per flattened prop
 * layer (zipped with {@link flattenSetPieceLayers} for authored kind/z/layer/
 * offset metadata) plus one per NPC. Rects are in world pixels matching the
 * bridge's `ftToPx` prop pass, so a pointer world-point hit-test lines up with
 * exactly what is drawn.
 */
function buildHoverItems(def: SetPieceDef, stamp: StampedSetPiece): HoverItem[] {
  const items: HoverItem[] = [];
  const draws = flattenSetPieceLayers(def);
  stamp.props.forEach((sp, index) => {
    const r = sp.render;
    const draw = draws[index];
    const scale = r.scale ?? 1;
    const lines: string[] = [];
    if (draw !== undefined) {
      lines.push(
        `<span style="color:#94a3b8">kind</span> ${esc(draw.prop.kind)} · <span style="color:#94a3b8">z</span> ${draw.z} · <span style="color:#94a3b8">layer</span> ${draw.layerIndex + 1}/${draw.prop.layers.length}`,
      );
    }
    lines.push(
      `<span style="color:#94a3b8">depth</span> ${r.depth.toFixed(3)} <span style="color:#64748b">(${depthBandLabel(r.depth)})</span>`,
    );
    lines.push(
      `<span style="color:#94a3b8">size</span> ${r.widthFt}×${r.heightFt} ft · <span style="color:#94a3b8">scale</span> ${scale}`,
    );
    lines.push(
      `<span style="color:#94a3b8">tint</span> ${r.tintHex !== undefined ? tintSwatch(r.tintHex) : 'none'}`,
    );
    const offX = draw?.layer.offsetX ?? 0;
    const offY = draw?.layer.offsetY ?? 0;
    if (offX !== 0 || offY !== 0) {
      lines.push(`<span style="color:#94a3b8">layer offset</span> ${offX}, ${offY} px`);
    }
    items.push({
      centreXpx: ftToPx(sp.x),
      centreYpx: ftToPx(sp.y),
      halfWpx: ftToPx(r.widthFt * scale) / 2,
      halfHpx: ftToPx(r.heightFt * scale) / 2,
      depth: r.depth,
      header: draw?.prop.id ?? r.label ?? 'prop',
      ref: r.sprite,
      bodyHtml: lines.join('<br/>'),
    });
  });
  for (const npc of stamp.npcs) {
    const ndef = getNpcDef(npc.npcTypeId);
    const wFt = npc.widthFt ?? ndef?.widthFt ?? TILE_SIZE_FT;
    const hFt = npc.heightFt ?? ndef?.heightFt ?? TILE_SIZE_FT;
    const authoredNpcDepth = npc.z !== undefined ? setPieceZToDepth(npc.z) : undefined;
    const npcDepth =
      authoredNpcDepth !== undefined
        ? Math.max(TERRAIN_DEPTH + DEPTH_EPSILON, authoredNpcDepth)
        : ENTITY_DEPTH;
    const lines: string[] = [];
    if (npc.anchorRole !== undefined) {
      const color = NPC_ANCHOR_COLOR[npc.anchorRole];
      lines.push(
        `<span style="color:#94a3b8">objective anchor</span> <span style="color:${color}">${npc.anchorRole}</span>`,
      );
    }
    lines.push(
      `<span style="color:#94a3b8">tile</span> (${npc.tileX}, ${npc.tileY}) · <span style="color:#94a3b8">size</span> ${wFt}×${hFt} ft`,
    );
    lines.push(
      `<span style="color:#94a3b8">depth</span> ${npcDepth.toFixed(3)} <span style="color:#64748b">(${depthBandLabel(npcDepth)})</span>`,
    );
    if (authoredNpcDepth !== undefined && authoredNpcDepth < TERRAIN_DEPTH + DEPTH_EPSILON) {
      lines.push(
        `<span style="color:#94a3b8">depth clamp</span> authored z ${npc.z} mapped to ${authoredNpcDepth.toFixed(3)} and was raised above terrain`,
      );
    }
    lines.push(
      `<span style="color:#94a3b8">transform</span> rot ${npc.rotationDeg ?? 0}° · flipX ${npc.flipX === true ? 'on' : 'off'} · flipY ${npc.flipY === true ? 'on' : 'off'}${npc.z !== undefined ? ` · z ${npc.z}` : ''}`,
    );
    items.push({
      centreXpx: ftToPx(npc.x),
      centreYpx: ftToPx(npc.y),
      halfWpx: ftToPx(wFt) / 2,
      halfHpx: ftToPx(hFt) / 2,
      depth: npcDepth,
      header: `NPC · ${esc(ndef?.name ?? npc.npcTypeId)}`,
      ...(npc.spriteOverride !== undefined
        ? { ref: npc.spriteOverride }
        : { npcDefId: npc.npcTypeId }),
      bodyHtml: lines.join('<br/>'),
    });
  }
  return items;
}

/** Render the tooltip HTML for a hovered item, resolving prop art live. */
function renderTooltip(scene: Phaser.Scene, item: HoverItem): string {
  const parts: string[] = [`<b style="font-size:12px">${esc(item.header)}</b>`];
  if (item.ref !== undefined) {
    const asset = describeAsset(scene, item.ref);
    parts.push(`<span style="color:#94a3b8">asset</span> ${asset.text}`);
    parts.push(
      asset.real
        ? '<span style="color:#5ad19b">✔ real art</span>'
        : '<span style="color:#f6c453">▢ placeholder box</span>',
    );
  } else if (item.npcDefId !== undefined) {
    // NPCs resolve their pinned generated sprite key def-aware (mirrors the
    // bridge's resolveNpcTexture). A loaded key = distinct real art; otherwise
    // the bridge falls back to the shared Kenney villager placeholder.
    const key = pickGeneratedNpcTextureKey(item.npcDefId);
    if (key !== null && scene.textures?.exists(key) === true) {
      parts.push(`<span style="color:#94a3b8">asset</span> generated <code>${esc(key)}</code>`);
      parts.push('<span style="color:#5ad19b">✔ real art</span>');
    } else if (key !== null) {
      parts.push(
        `<span style="color:#94a3b8">asset</span> generated <code>${esc(key)}</code> · not loaded → Kenney villager`,
      );
      parts.push('<span style="color:#f6c453">▢ villager fallback</span>');
    } else {
      parts.push(`<span style="color:#94a3b8">asset</span> Kenney villager (no generated art)`);
      parts.push('<span style="color:#f6c453">▢ villager fallback</span>');
    }
  }
  parts.push(item.bodyHtml);
  return parts.join('<br/>');
}

interface LabRoom {
  floorMap: FloorMap;
  roomBounds: RoomBounds;
}

/**
 * Build a single-room {@link FloorMap} sized exactly to the set piece's
 * footprint plus a 1-tile wall border. The interior therefore equals the
 * footprint, so a set-piece prop authored at row 0 lands flush against the top
 * wall (demonstrating banner-over-wall + rug-over-floor layering).
 *
 * The interior terrain comes from {@link labInteriorTerrainFor}, NOT a literal —
 * see `./fidelity.js` for why that rule is shared and unit-tested.
 */
function buildRoomForDef(def: SetPieceDef): LabRoom {
  const footprint = getSetPieceFootprint(def);
  const widthTiles = footprint.width + 2;
  const heightTiles = footprint.height + 2;
  const interiorTerrain = labInteriorTerrainFor(def.id);

  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: TILE_SIZE_FT,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [Math.max(3, footprint.width), Math.max(3, footprint.width)],
    roomHeightRange: [Math.max(3, footprint.height), Math.max(3, footprint.height)],
    maxRooms: 1,
    floorDensity: 1,
  };

  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  for (let ty = 0; ty < heightTiles; ty += 1) {
    for (let tx = 0; tx < widthTiles; tx += 1) {
      const idx = ty * widthTiles + tx;
      const isBorder = tx === 0 || ty === 0 || tx === widthTiles - 1 || ty === heightTiles - 1;
      tileMap.flags[idx] = isBorder ? TilePresets.WALL : TilePresets.FLOOR;
      terrain[idx] = isBorder ? LAB_BORDER_TERRAIN : interiorTerrain;
    }
  }

  const playerSpawn = {
    x: (widthTiles / 2) * TILE_SIZE_FT,
    y: (heightTiles / 2) * TILE_SIZE_FT,
  };
  const floorMap = new FloorMap(config, tileMap, new RoomGraph(), terrain, playerSpawn);
  // Interior room (1-tile wall inset). stampSetPiece further insets to the
  // interior, so the footprint lands exactly on the floor tiles.
  const roomBounds: RoomBounds = { x: 0, y: 0, width: widthTiles, height: heightTiles };
  return { floorMap, roomBounds };
}

function createSetPieceLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const defs = getAllSetPieceDefs();
  const state = { selectedId: resolveInitialSetPieceId(defs) };

  // Install the honest-ready probe the headless visual-review harness waits on
  // (`waitForFunction(() => __uiProbe.ready() === true)` in visual-review-agent),
  // and reset the flag — remounting the lab must start from "not ready" until the
  // scene recomputes it against the live display list.
  labReady = false;
  setPieceLabWindow().__uiProbe = { ready: () => labReady };

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #141018 0%, #0a0810 60%, #05060b 100%)';

  // Top: the engine-rendered room fills the remaining height. `position:relative`
  // anchors the hover tooltip; `minHeight:0` lets it shrink so the info pane
  // below is never clipped.
  const gameHost = document.createElement('div');
  gameHost.style.position = 'relative';
  gameHost.style.flex = '1 1 auto';
  gameHost.style.minHeight = '0';
  gameHost.style.width = '100%';

  // Bottom: the info pane (was a floating top-left overlay). A full-width,
  // scrollable pane UNDER the rendered room.
  const info = document.createElement('div');
  info.style.flex = '0 0 auto';
  info.style.width = '100%';
  info.style.boxSizing = 'border-box';
  info.style.maxHeight = '38%';
  info.style.overflowY = 'auto';
  info.style.padding = '10px 14px';
  info.style.background = 'rgba(12, 10, 20, 0.92)';
  info.style.borderTop = '1px solid rgba(255, 255, 255, 0.14)';
  info.style.color = '#f8fafc';
  info.style.fontSize = '12px';
  info.style.lineHeight = '1.5';

  // Floating tooltip shown while hovering a prop layer or NPC in the room.
  const tooltip = document.createElement('div');
  tooltip.style.position = 'absolute';
  tooltip.style.display = 'none';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.zIndex = '20';
  tooltip.style.maxWidth = '300px';
  tooltip.style.padding = '8px 10px';
  tooltip.style.borderRadius = '8px';
  tooltip.style.background = 'rgba(8, 6, 14, 0.96)';
  tooltip.style.border = '1px solid rgba(255, 255, 255, 0.18)';
  tooltip.style.boxShadow = '0 6px 18px rgba(0, 0, 0, 0.5)';
  tooltip.style.color = '#f8fafc';
  tooltip.style.fontSize = '11px';
  tooltip.style.lineHeight = '1.5';

  const hint = document.createElement('p');
  hint.textContent =
    'Rendered through the real engine (PhaserBridge): terrain is baked, generated art is resolved exactly as in-game, and props are depth-layered (rug over floor + under NPCs, banner over the wall). Hover any prop or NPC to inspect its source asset + applied transforms. Scroll to zoom; use "Reset camera" to re-fit. Pick a set piece from the dropdown to preview it.';
  hint.style.marginTop = '16px';
  hint.style.color = '#e7d2ff';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  gameHost.append(tooltip);
  root.append(gameHost, info);
  canvasHost.append(root);

  let hoverItems: HoverItem[] = [];

  let restartScene = () => undefined as void;
  let resetCamera = () => undefined as void;

  /**
   * @param propCount   props actually RENDERED (structural wall/door props are
   *                    excluded — the carved terrain owns those tiles).
   * @param skippedCount structural props deliberately not drawn. Reported
   *                    explicitly so the panel never claims a count the screen
   *                    does not show; a silently-inflated number is how a
   *                    preview starts lying about what shipped.
   */
  function updateInfoPanel(
    def: SetPieceDef,
    npcCount: number,
    propCount: number,
    skippedCount: number,
  ): void {
    const footprint = getSetPieceFootprint(def);
    const requests = collectCustomArtRequests([def]);
    const lines: string[] = [];
    lines.push(`<b style="font-size:13px">${def.name}</b>`);
    lines.push(
      `<span style="color:#94a3b8">${def.theme} · footprint ${footprint.width}×${footprint.height} tiles</span>`,
    );
    if (def.description) {
      lines.push(`<span style="color:#cbd5e1">${def.description}</span>`);
    }
    lines.push('');
    lines.push(`<b>Props:</b> ${propCount} · <b>NPCs:</b> ${npcCount}`);
    if (skippedCount > 0) {
      lines.push(
        `<span style="color:#94a3b8">+${skippedCount} wall/door props not drawn — carved terrain owns the shell (matches the game)</span>`,
      );
    }
    for (const npc of def.npcs ?? []) {
      const color = npc.anchorRole ? NPC_ANCHOR_COLOR[npc.anchorRole] : '#e2e8f0';
      const anchor = npc.anchorRole
        ? ` <span style="color:${color}">[${npc.anchorRole}]</span>`
        : '';
      lines.push(
        `<span style="color:${color}">●</span> <code>${npc.npcTypeId}</code> @(${npc.x},${npc.y})${anchor}`,
      );
    }
    if (requests.length > 0) {
      lines.push('');
      lines.push(
        `<span style="color:#facc15">◴ ${requests.length} custom-art request(s) still pending generation.</span>`,
      );
    }
    info.innerHTML = lines.join('<br/>');
  }

  class SetPieceLabScene extends Phaser.Scene {
    private bridge?: ReturnType<typeof createPhaserBridge>;
    private world!: GameWorld;
    /**
     * Pinned generated NPC texture keys the current piece must resolve before it
     * counts as "real art" — until each is resident the NPC still shows its
     * villager fallback sprite. Computed once in create() from the stamped NPCs.
     */
    private requiredNpcKeys = new Set<string>();

    /**
     * How many placeholder Rectangles this piece is EXPECTED to keep forever —
     * one per prop layer that renders an intentional queued-art stand-in (a
     * `custom` sprite with no placeholder fallback; see
     * {@link spriteRefRendersPersistentPlaceholder}). Computed once in create()
     * from the stamped props and fed to the readiness gate so those honest
     * stand-ins do not wedge `ready()` at false forever. 0 for pieces made
     * entirely of catalog/sheet art (e.g. every piece before welcome-room's
     * Kenney→custom conversion).
     */
    private expectedPersistentPlaceholderCount = 0;

    /**
     * The floor map + baked terrain RenderTexture from the last bake, kept so
     * the terrain can be RE-baked once generated tile textures finish loading.
     *
     * create() must bake immediately (so the room is never blank), but at that
     * point `warmGeneratedSprites()` has not resolved, so every generated tile
     * key is missing and `buildTerrainLayer` falls through to its flat-colour
     * path. Without a re-bake the lab shows a solid colour floor that the real
     * game never renders — which silently invalidates any visual review done
     * here. Re-baking on load-complete makes the lab floor the game floor.
     */
    private bakedFloorMap: FloorMap | null = null;
    private terrainRt: Phaser.GameObjects.RenderTexture | null = null;

    constructor() {
      super({ key: SCENE_KEY });
    }

    preload(): void {
      if (!this.load) return;

      // Failures are non-fatal: PhaserBridge falls back to procedural textures.
      this.load.on('loaderror', (file: Phaser.Loader.File) => {
        logger.warn('Sprite asset failed to load; falling back to procedural texture', {
          key: file.key,
          url: file.url,
        });
      });

      for (const sheet of SHEETS) {
        if (!CRITICAL_SHEET_KEYS.has(sheet.key)) continue;
        this.load.spritesheet(sheet.key, sheet.path, {
          frameWidth: sheet.frameWidth,
          frameHeight: sheet.frameHeight,
          margin: sheet.margin,
          spacing: sheet.spacing,
        });
      }

      // Seed a non-null registry immediately, then warm generated textures.
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());
    }

    create(): void {
      this.cameras.main.setBackgroundColor('#05060b');
      // A restart (dropdown change) re-enters create(): drop readiness until the
      // freshly stamped piece re-resolves its art on the next recompute.
      labReady = false;
      this.requiredNpcKeys = new Set<string>();
      this.expectedPersistentPlaceholderCount = 0;

      const def = getSetPieceDef(state.selectedId) ?? defs[0];
      if (!def) {
        this.add
          .text(16, 16, 'No set pieces registered.', { color: '#f87171', fontSize: '16px' })
          .setScrollFactor(0);
        return;
      }

      const { floorMap, roomBounds } = buildRoomForDef(def);
      this.world = createGameWorld({ seed: 1 });
      this.world.floorMap = floorMap;

      // Bake terrain to a single flat RenderTexture beneath the entity plane.
      const terrain = buildTerrainLayer(this, floorMap);
      terrain.rt.setDepth(-20);
      this.bakedFloorMap = floorMap;
      this.terrainRt = terrain.rt;

      // Stamp the set piece: pure, deterministic tile → world-feet placement.
      // Structural (wall/door) props are SKIPPED to match the real game — the
      // carved terrain layer already owns those tiles. See the fidelity contract
      // in this file's header and `isStructuralSetPieceProp`.
      const stamp = stampSetPiece(def, { roomBounds, tileSizeFt: TILE_SIZE_FT });
      const structuralPropIds = new Set(
        def.props.filter(isStructuralSetPieceProp).map((prop) => prop.id),
      );
      let renderedPropCount = 0;
      let skippedStructuralCount = 0;
      for (const prop of stamp.props) {
        if (prop.render.label && structuralPropIds.has(prop.render.label)) {
          skippedStructuralCount += 1;
          continue;
        }
        renderedPropCount += 1;
        addSetPieceProp(this.world, prop.x, prop.y, prop.render);
        // Count intentional queued-art stand-ins (custom sprites with no
        // placeholder) so the readiness gate expects them to stay Rectangles
        // rather than waiting for art that will never load.
        if (spriteRefRendersPersistentPlaceholder(prop.render.sprite)) {
          this.expectedPersistentPlaceholderCount += 1;
        }
      }
      for (const npc of stamp.npcs) {
        spawnNpc(this.world, npc.x, npc.y, npc.npcTypeId, {
          ...(npc.spriteOverride !== undefined ? { spriteOverride: npc.spriteOverride } : {}),
          ...(npc.widthFt !== undefined ? { widthFt: npc.widthFt } : {}),
          ...(npc.heightFt !== undefined ? { heightFt: npc.heightFt } : {}),
          ...(npc.flipX !== undefined ? { flipX: npc.flipX } : {}),
          ...(npc.flipY !== undefined ? { flipY: npc.flipY } : {}),
          ...(npc.rotationDeg !== undefined ? { rotationDeg: npc.rotationDeg } : {}),
          ...(npc.z !== undefined ? { z: npc.z } : {}),
        });
        const npcKey = requiredGeneratedNpcKeyForStamp(npc.npcTypeId, npc.spriteOverride);
        if (npcKey) {
          this.requiredNpcKeys.add(npcKey);
        }
      }

      this.bridge = createPhaserBridge(this);
      this.bridge.sync(this.world);
      this.recomputeReady();
      // Expose the live scene so the review setup file can poll the display list.
      setPieceLabWindow().__setPieceScene = this;
      void this.warmGeneratedSprites();

      this.fitCamera();
      this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
        const cam = this.cameras.main;
        const factor = dy > 0 ? 0.9 : 1.1;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM));
      });

      // --- Hover inspection ---
      // Build a world-pixel hit-index for every prop layer + NPC, then show an
      // HTML tooltip (asset + transforms) for the topmost item under the pointer.
      hoverItems = buildHoverItems(def, stamp);
      const camera = this.cameras.main;
      const onPointerMove = (pointer: Phaser.Input.Pointer): void => {
        const point = camera.getWorldPoint(pointer.x, pointer.y);
        let hovered: HoverItem | undefined;
        let hoveredDepth = Number.NEGATIVE_INFINITY;
        for (const item of hoverItems) {
          const withinX = Math.abs(point.x - item.centreXpx) <= item.halfWpx;
          const withinY = Math.abs(point.y - item.centreYpx) <= item.halfHpx;
          if (withinX && withinY && item.depth >= hoveredDepth) {
            hovered = item;
            hoveredDepth = item.depth;
          }
        }
        if (hovered === undefined) {
          tooltip.style.display = 'none';
          return;
        }
        tooltip.innerHTML = renderTooltip(this, hovered);
        tooltip.style.display = 'block';
        const pad = 14;
        const tipW = tooltip.offsetWidth;
        const tipH = tooltip.offsetHeight;
        let left = pointer.x + pad;
        let top = pointer.y + pad;
        if (left + tipW > gameHost.clientWidth) {
          left = pointer.x - tipW - pad;
        }
        if (top + tipH > gameHost.clientHeight) {
          top = pointer.y - tipH - pad;
        }
        tooltip.style.left = `${Math.max(0, left)}px`;
        tooltip.style.top = `${Math.max(0, top)}px`;
      };
      const hideTooltip = (): void => {
        tooltip.style.display = 'none';
      };
      this.input.on('pointermove', onPointerMove);
      this.input.on('pointerout', hideTooltip);
      this.input.on('gameout', hideTooltip);

      restartScene = () => this.scene.restart();
      resetCamera = () => this.fitCamera();
      updateInfoPanel(def, stamp.npcs.length, renderedPropCount, skippedStructuralCount);

      this.events.once('shutdown', () => {
        this.input.off('wheel');
        this.input.off('pointermove', onPointerMove);
        this.input.off('pointerout', hideTooltip);
        this.input.off('gameout', hideTooltip);
        hoverItems = [];
        tooltip.style.display = 'none';
        this.bridge?.destroy();
        this.bridge = undefined;
        labReady = false;
        this.requiredNpcKeys.clear();
        this.expectedPersistentPlaceholderCount = 0;
        if (setPieceLabWindow().__setPieceScene === this) {
          setPieceLabWindow().__setPieceScene = undefined;
        }
        restartScene = () => undefined;
        resetCamera = () => undefined;
      });
    }

    update(): void {
      // Static diorama: no system stepping. Re-sync each frame so late-loading
      // generated textures upgrade the placeholder rects to real art. The
      // set-piece render pass is idempotent + keyed by list index, so a
      // per-frame re-sync reuses visuals and never leaks GameObjects.
      this.bridge?.sync(this.world);
      // Re-evaluate honest readiness AFTER the sync so a sync that just upgraded
      // the last placeholder to real art can flip __uiProbe.ready() true.
      this.recomputeReady();
    }

    /** Fit and centre the camera on the whole synthesized room. */
    fitCamera(): void {
      const floorMap = this.world?.floorMap;
      if (!floorMap) return;
      const cam = this.cameras.main;
      const mapWpx = ftToPx(floorMap.widthFt);
      const mapHpx = ftToPx(floorMap.heightFt);
      if (mapWpx <= 0 || mapHpx <= 0) return;
      const zoom = Math.min(
        cam.width / (mapWpx * CAMERA_PADDING),
        cam.height / (mapHpx * CAMERA_PADDING),
      );
      cam.setZoom(
        Number.isFinite(zoom) && zoom > 0 ? Phaser.Math.Clamp(zoom, MIN_ZOOM, MAX_ZOOM) : 1,
      );
      cam.centerOn(mapWpx / 2, mapHpx / 2);
    }

    /**
     * Walk the live display list and update {@link labReady} via the pure
     * {@link isSetPieceRenderReady} gate. Real art is on screen iff at least one
     * Image has rendered, no more than the expected count of intentional
     * queued-art placeholder Rectangles remain (every transient cold-cache rect
     * resolved), and every required pinned NPC key is resident. The only
     * Rectangles this scene creates are set-piece prop placeholders (terrain bakes
     * to a RenderTexture and no health bars/markers are added here), so counting
     * them by type is an exact "unresolved prop" signal.
     */
    private recomputeReady(): void {
      let placeholderRectCount = 0;
      let imageCount = 0;
      const presentKeys = new Set<string>();
      for (const obj of this.children.list) {
        if (obj.type === 'Rectangle') {
          placeholderRectCount += 1;
        } else if (obj.type === 'Image') {
          imageCount += 1;
          const key = (obj as Phaser.GameObjects.Image).texture?.key;
          if (key) {
            presentKeys.add(key);
          }
        }
      }
      let resolvedNpcKeyCount = 0;
      for (const key of this.requiredNpcKeys) {
        if (presentKeys.has(key)) {
          resolvedNpcKeyCount += 1;
        }
      }
      labReady = isSetPieceRenderReady({
        placeholderRectCount,
        imageCount,
        requiredNpcKeyCount: this.requiredNpcKeys.size,
        resolvedNpcKeyCount,
        expectedPersistentPlaceholderCount: this.expectedPersistentPlaceholderCount,
      });
    }

    /**
     * Rebuild the terrain RenderTexture now that generated tile art is loaded.
     * Safe to call when the scene has been torn down or never baked.
     */
    private rebakeTerrain(): void {
      const floorMap = this.bakedFloorMap;
      if (!floorMap || !this.scene.isActive()) return;
      this.terrainRt?.destroy();
      const terrain = buildTerrainLayer(this, floorMap);
      terrain.rt.setDepth(-20);
      this.terrainRt = terrain.rt;
    }

    private async warmGeneratedSprites(): Promise<void> {
      try {
        const registry = await fetchGeneratedSpriteRegistry();
        this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);
        if (registry.size === 0 || !this.load) return;
        const queued = preloadGeneratedSprites(this.load, registry);
        if (queued.length === 0) return;
        // Re-bake terrain once the generated tile textures are resident; the
        // create()-time bake could only reach the flat-colour fallback.
        this.load.once(Phaser.Loader.Events.COMPLETE, () => this.rebakeTerrain());
        this.load.start();
      } catch (error) {
        logger.warn('Generated sprite load failed; continuing with built-in sprites', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const setPieceOptions: Record<string, string> = {};
  for (const def of defs) {
    setPieceOptions[`${def.name} (${def.theme})`] = def.id;
  }

  const api = {
    setPieceId: state.selectedId,
    resetCamera: () => resetCamera(),
  };
  gui
    .add(api, 'setPieceId', setPieceOptions)
    .name('Set piece')
    .onChange((id: string) => {
      state.selectedId = id;
      restartScene();
    });
  gui.add(api, 'resetCamera').name('Reset camera');

  const summary = {
    totalSetPieces: defs.length,
    totalCustomRequests: collectCustomArtRequests(defs).length,
  };
  const meta = gui.addFolder('Pack summary');
  meta.add(summary, 'totalSetPieces').name('Set pieces').disable();
  meta.add(summary, 'totalCustomRequests').name('Custom art requests').disable();

  const getSize = () => ({
    width: Math.max(1, Math.round(gameHost.clientWidth || GAME.WIDTH)),
    height: Math.max(1, Math.round(gameHost.clientHeight || GAME.HEIGHT)),
  });

  const initialSize = getSize();
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: initialSize.width,
    height: initialSize.height,
    backgroundColor: '#05060b',
    scene: [SetPieceLabScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  const game = new Phaser.Game(config);
  const resizeObserver = new ResizeObserver(() => {
    const nextSize = getSize();
    game.scale.resize(nextSize.width, nextSize.height);
    resetCamera();
  });
  resizeObserver.observe(gameHost);

  return () => {
    resizeObserver.disconnect();
    game.destroy(true);
    hint.remove();
    root.remove();
    // Tear down the harness-facing globals so a later lab never reads a stale
    // probe / scene from this one.
    labReady = false;
    const labWindow = setPieceLabWindow();
    labWindow.__uiProbe = undefined;
    labWindow.__setPieceScene = undefined;
  };
}

registerLab(LAB_ID, {
  category: 'Meta' as LabCategory,
  name: 'Set Piece Viewer',
  description:
    'Preview authored set pieces rendered through the real engine (baked terrain, resolved generated art, depth-layered props over floors and walls) with their NPCs stamped in place. Hover props/NPCs to inspect source asset + transforms; details show in a pane beneath the room.',
  create: createSetPieceLab,
});
