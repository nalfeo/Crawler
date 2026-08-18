/**
 * One-shot redress of `welcome-room` following the Set Piece Designer loop.
 * Kept in-repo as the worked reference for the agent's dressing pass.
 *
 * Blockout:
 *   purpose   contestants arrive, get processed by the Goon, shop, and buy spells
 *   archetype welcome room / production set (high density)
 *   zones     A stage wall (y0-1) · B reception desk (x3-7,y2-3) · C merchant stall
 *             (x0-3,y5-7) · D broker nook (x7-9,y1-6) · E queue line (x3-7,y6-8)
 *   circulation  bottom edge -> E -> centre column x4-5 -> B, branching to C and D;
 *                x4-5 stays clear below y4 and all edge dressing is non-solid
 *   focal     welcome-desk, 8x4 ft
 *   contract  warm desaturated dungeon palette + faded showbiz red/gold; lit from the
 *             top wall, soft down-right contact shadow; worn by decades of syndication;
 *             scale class 1-8 ft
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { log } from 'node:console';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(here, '../../../src/shared/data/set-pieces.json');

const catalog = (spriteId, widthFt, heightFt, extra = {}) => ({
  sprite: { source: 'catalog', spriteId },
  widthFt,
  heightFt,
  ...extra,
});

/** A ranked art gap: placed now as an explicit pending-art stand-in. */
const commissioned = (requestId, label, prompt, widthFt, heightFt, extra = {}) => ({
  sprite: {
    source: 'custom',
    requestId,
    label,
    prompt,
    widthTiles: Math.max(1, Math.round(widthFt / 2)),
    heightTiles: Math.max(1, Math.round(heightFt / 2)),
    tags: ['welcome-room', 'reality-show', 'pixel-dungeon', 'scene-dressing'],
  },
  widthFt,
  heightFt,
  ...extra,
});

const deco = (id, x, y, layers, z = 20) => ({
  id,
  kind: 'decoration',
  x,
  y,
  width: 1,
  height: 1,
  z,
  layers,
  sceneLayer: 'default',
});

const CONTRACT =
  'Warm desaturated dungeon palette with faded showbiz red and tarnished gold accents. ' +
  'Lit from the top wall; soft one-pixel contact shadow down and to the right. ' +
  'Worn by decades of syndication — dusty, threadbare, slightly grimy. ' +
  '3/4 top-down pixel art, silhouette readable at 16px.';

// --- Zone A: the stage wall (top edge) --------------------------------------
const stageWall = [
  deco('poster-left', 0.15, 0, [
    commissioned(
      'welcome-room-show-poster',
      'Show Poster',
      `A curling promotional poster for the dungeon show, taped crooked to the stone wall: a grinning contestant silhouette and a season number, corners peeled. ${CONTRACT}`,
      3,
      4,
      { offsetYFt: -4 },
    ),
  ]),
  deco('sconce-far-left', 1.1, 0.15, [
    catalog('prop-wall-sconce-var-2', 1.5, 1.5, { offsetYFt: -4 }),
  ]),
  deco('camera-rig-left', 3.4, 0.1, [
    commissioned(
      'welcome-room-camera-rig',
      'Wall Camera Rig',
      `A boxy wall-mounted television camera on a swivel bracket, lens catching the light, a red tally lamp lit, cable drooping down the wall. ${CONTRACT}`,
      2.5,
      2.5,
      { offsetYFt: -3.5 },
    ),
  ]),
  deco('sconce-right-inner', 6.1, 0.2, [
    catalog('prop-wall-sconce-var-4', 1.5, 1.5, { offsetYFt: -4 }),
  ]),
  deco('stage-torch-right', 7.35, 0.1, [catalog('prop-torch-var-8', 1.5, 3, { offsetYFt: -4 })]),
  deco('poster-right', 8.2, 0, [
    catalog('welcome-sign-left-var-4', 3, 3, { offsetYFt: -4, flipX: true }),
  ]),
  deco('sconce-far-right', 9, 0.15, [
    catalog('prop-wall-sconce-var-6', 1.5, 1.5, { offsetYFt: -4 }),
  ]),
];

// --- Zone C: merchant stall (left edge) --------------------------------------
const leftEdge = [
  deco('crate-stack-left', 0, 1.2, [
    commissioned(
      'welcome-room-crate-stack',
      'Stacked Crates',
      `Two mismatched wooden shipping crates stacked askew, stencilled with a faded production logo, lid gapped and straw poking out. ${CONTRACT}`,
      3,
      3.5,
    ),
    catalog('purple-potion-bottle-var-4', 1, 1, { offsetXFt: 0.5, offsetYFt: -2 }),
  ]),
  deco('call-sheet-left', 0.1, 2.4, [
    catalog('welcome-sign-left-var-5', 2, 2.5, { offsetXFt: -0.5 }),
  ]),
  deco('wall-shelf-left', 0, 3.1, [
    commissioned(
      'welcome-room-wall-shelf',
      'Wall Shelf',
      `A short plank shelf on iron brackets carrying a leaning row of ledgers and a stub candle, dust on the top edge. ${CONTRACT}`,
      3,
      1.5,
    ),
    catalog('autograph-book-placeholder', 1, 1, { offsetXFt: 1, offsetYFt: -1 }),
  ]),
  deco('merchant-sign', 0.15, 6.4, [
    catalog('welcome-sign-left-var-6', 2.5, 2.5, { offsetXFt: -0.5 }),
  ]),
  deco('cable-coil-left', 0.1, 7.2, [
    commissioned(
      'welcome-room-cable-coil',
      'Coiled Cable',
      `A loose coil of thick black production cable dumped against the wall, taped down at one end with gaffer tape gone grey. ${CONTRACT}`,
      2.5,
      1.5,
    ),
  ]),
];

// --- Zone D: broker nook (right edge) ---------------------------------------
const rightEdge = [
  deco('broker-torch', 9, 2.6, [catalog('prop-torch-var-14', 1.5, 3, { offsetXFt: 0.5 })]),
  deco('crate-right-upper', 9, 3.4, [
    commissioned(
      'welcome-room-crate-single',
      'Single Crate',
      `A single squat wooden crate with a pried-open lid, one board split, packing straw spilling over the edge. ${CONTRACT}`,
      2.5,
      2.5,
    ),
  ]),
  deco('wall-shelf-right', 9, 5.2, [
    commissioned(
      'welcome-room-wall-shelf',
      'Wall Shelf',
      `A short plank shelf on iron brackets carrying a leaning row of ledgers and a stub candle, dust on the top edge. ${CONTRACT}`,
      3,
      1.5,
      { flipX: true },
    ),
    catalog('purple-potion-bottle-var-4', 1, 1, { offsetYFt: -1.25 }),
  ]),
  deco('trash-bin-right', 9, 6.35, [
    commissioned(
      'welcome-room-trash-bin',
      'Dented Bin',
      `A dented metal bin overflowing with crumpled call sheets and a snapped clapperboard, lid resting crooked on top. ${CONTRACT}`,
      2,
      2.5,
    ),
  ]),
  deco('sconce-right-low', 9, 7.4, [catalog('prop-wall-sconce-var-7', 1.5, 1.5)]),
];

// --- Zone E: queue line (bottom edge) ---------------------------------------
const bottomEdge = [
  deco('crate-bottom-left', 1.2, 8, [
    commissioned(
      'welcome-room-crate-single',
      'Single Crate',
      `A single squat wooden crate with a pried-open lid, one board split, packing straw spilling over the edge. ${CONTRACT}`,
      2.5,
      2.5,
    ),
  ]),
  deco('cable-run-bottom', 2.4, 8, [
    commissioned(
      'welcome-room-cable-coil',
      'Coiled Cable',
      `A loose coil of thick black production cable dumped against the wall, taped down at one end with gaffer tape gone grey. ${CONTRACT}`,
      2.5,
      1.5,
      { flipX: true },
    ),
  ]),
  deco('cable-run-bottom-right', 6.6, 8, [
    commissioned(
      'welcome-room-cable-coil',
      'Coiled Cable',
      `A loose coil of thick black production cable dumped against the wall, taped down at one end with gaffer tape gone grey. ${CONTRACT}`,
      2.5,
      1.5,
    ),
  ]),
  deco('crate-bottom-right', 7.8, 8, [
    commissioned(
      'welcome-room-crate-stack',
      'Stacked Crates',
      `Two mismatched wooden shipping crates stacked askew, stencilled with a faded production logo, lid gapped and straw poking out. ${CONTRACT}`,
      3,
      3.5,
      { flipX: true },
    ),
  ]),
  deco('exit-sign-bottom', 0.1, 8, [catalog('welcome-sign-left-var-13', 2, 2)]),
  deco('sconce-bottom-right', 9, 8, [catalog('prop-wall-sconce-var-8', 1.5, 1.5)]),
];

// --- Floor variety -----------------------------------------------------------
// The room's floor is a warm orange carpet. Every floor sprite in the catalog is
// stone/cave/sewer grey — dropping those in reads as holes punched in the carpet
// (found by rendering, not by the gate). So the variants are commissioned inside
// the room's palette instead, with the existing rug as the stand-in.
const floorVariant = (id, x, y, requestId, label, prompt) => ({
  id,
  kind: 'floor',
  x,
  y,
  width: 1,
  height: 1,
  z: 0,
  layers: [
    {
      sprite: {
        source: 'custom',
        requestId,
        label,
        prompt: `${prompt} ${CONTRACT}`,
        widthTiles: 1,
        heightTiles: 1,
        tags: ['welcome-room', 'floor', 'reality-show', 'pixel-dungeon'],
        placeholder: { source: 'catalog', spriteId: 'welcome-room-rug-var-0' },
      },
      widthFt: 2,
      heightFt: 2,
    },
  ],
  sceneLayer: 'default',
});

const WORN = [
  'welcome-room-floor-worn',
  'Worn Carpet Tile',
  'A carpet tile worn down to the backing along a traffic line, nap flattened and colour faded.',
];
const STAIN = [
  'welcome-room-floor-stain',
  'Stained Carpet Tile',
  'A carpet tile with an old dark spill stain and a scorch mark at one corner.',
];
const TAPE = [
  'welcome-room-floor-tape',
  'Taped Mark Tile',
  'A carpet tile marked with a stage-crew gaffer-tape cross, the tape lifting at one edge.',
];
const SEAM = [
  'welcome-room-floor-seam',
  'Seamed Carpet Tile',
  'A carpet tile where two runs of carpet meet badly, edges frayed and curling.',
];

const floorScatter = [
  floorVariant('floor-worn-1', 2, 2, ...WORN),
  floorVariant('floor-worn-2', 7, 6, ...WORN),
  floorVariant('floor-worn-3', 3, 5, ...WORN),
  floorVariant('floor-stain-1', 6, 4, ...STAIN),
  floorVariant('floor-stain-2', 1, 3, ...STAIN),
  floorVariant('floor-tape-1', 2, 7, ...TAPE),
  floorVariant('floor-tape-2', 7, 3, ...TAPE),
  floorVariant('floor-seam-1', 5, 6, ...SEAM),
  floorVariant('floor-seam-2', 6, 7, ...SEAM),
];

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const room = data.setPieces.find((p) => p.id === 'welcome-room');
if (!room) throw new Error('welcome-room not found');

// Clutter the existing hero furniture so surfaces are not bare.
const byId = new Map(room.props.map((p) => [p.id, p]));
byId
  .get('welcome-desk')
  ?.layers.push(
    catalog('autograph-book-placeholder', 1.25, 1.25, { offsetXFt: -2.5, offsetYFt: -1.5 }),
  );
byId
  .get('broker-bookcase')
  ?.layers.push(catalog('purple-potion-bottle-var-4', 1, 1, { offsetXFt: 1, offsetYFt: -1.5 }));
byId
  .get('shop-table')
  ?.layers.push(
    catalog('autograph-book-placeholder', 1.25, 1.25, { offsetXFt: -2, offsetYFt: -1 }),
  );

// Move the potted plant onto the left wall so the edge reads as dressed.
const plant = byId.get('potted-plant');
if (plant) {
  plant.x = 0.1;
  plant.y = 4.2;
}
// Push the lounge stool into the broker nook's wall line.
const stool = byId.get('lounge-stool');
if (stool) {
  stool.x = 9;
  stool.y = 1.3;
}

room.props.push(...stageWall, ...leftEdge, ...rightEdge, ...bottomEdge, ...floorScatter);

writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
log(`welcome-room: ${room.props.length} props`);
