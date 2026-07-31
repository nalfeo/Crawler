import { describe, expect, it } from 'vitest';

import { ENTITY_DEPTH, TERRAIN_DEPTH, WORLD_VFX_DEPTH } from '../../src/shared/render-depths.js';
import {
  computeStampOrigin,
  stampSetPiece,
  type StampSetPieceOptions,
} from '../../src/core/map/stampSetPiece.js';
import {
  flattenSetPieceLayers,
  getSetPieceDef,
  type SetPieceDef,
} from '../../src/shared/set-piece-types.js';
import { getNpcDef } from '../../src/shared/npc-types.js';
import type { RoomBounds } from '../../src/shared/map-types.js';

const TILE = 4;

/** A generous room whose interior comfortably holds the 8×7 welcome room. */
const ROOM_LARGE: RoomBounds = { x: 10, y: 20, width: 14, height: 12 };

function welcomeRoom(): SetPieceDef {
  const def = getSetPieceDef('welcome-room');
  if (!def) {
    throw new Error('welcome-room set piece not found');
  }
  return def;
}

function opts(bounds: RoomBounds): StampSetPieceOptions {
  return { roomBounds: bounds, tileSizeFt: TILE };
}

/**
 * A synthetic 8×7 exact-sizing def with a single full-footprint prop, decoupled
 * from the welcome-room content so the origin/sizing logic can be tested in
 * isolation. `placement` and extra layers are supplied per-test.
 */
function makeDef(overrides: Partial<SetPieceDef> = {}): SetPieceDef {
  return {
    id: 'synthetic',
    name: 'Synthetic',
    theme: 'test',
    sizing: 'exact',
    width: 8,
    height: 7,
    description: 'synthetic def for origin/sizing tests',
    tags: [],
    props: [
      {
        id: 'base',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        z: 0,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [],
    ...overrides,
  };
}

describe('computeStampOrigin', () => {
  it('centres a placement-free 8×7 def inside a larger interior', () => {
    // Interior of ROOM_LARGE = [11..22] × [21..30] → 12 wide, 10 tall.
    // Offset = floor((12-8)/2)=2, floor((10-7)/2)=1.
    const origin = computeStampOrigin(makeDef(), ROOM_LARGE);
    expect(origin).toEqual({ originTileX: 13, originTileY: 22 });
  });

  it('hugs the top wall for a placement.verticalAlign="top" def', () => {
    // Vertical slack (3) collapses to 0 at the top, so the origin pins to the
    // interior's top row while X stays centred — this is what mounts the
    // welcome-room reception against the real back wall.
    const origin = computeStampOrigin(makeDef({ placement: { verticalAlign: 'top' } }), ROOM_LARGE);
    expect(origin).toEqual({ originTileX: 13, originTileY: 21 });
  });

  it('pushes to the far edge for bottom/right alignment', () => {
    const origin = computeStampOrigin(
      makeDef({ placement: { verticalAlign: 'bottom', horizontalAlign: 'right' } }),
      ROOM_LARGE,
    );
    // slackX=4 → originX = 11+4 = 15; slackY=3 → originY = 21+3 = 24.
    expect(origin).toEqual({ originTileX: 15, originTileY: 24 });
  });

  it('matches the shipped welcome-room top placement', () => {
    const origin = computeStampOrigin(welcomeRoom(), ROOM_LARGE);
    expect(origin.originTileY).toBe(21);
  });

  it('pins the origin to the interior top-left when the def overflows the room', () => {
    const def = welcomeRoom();
    // Interior = [1..6]×[1..5] (6 wide, 5 tall) — smaller than 8×7.
    const origin = computeStampOrigin(def, { x: 0, y: 0, width: 8, height: 7 });
    expect(origin).toEqual({ originTileX: 1, originTileY: 1 });
  });
});

describe('stampSetPiece — welcome room NPCs', () => {
  it('places all three quest NPCs with their authored anchor roles', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    const byRole = new Map(stamp.npcs.map((n) => [n.anchorRole, n]));

    expect(stamp.npcs).toHaveLength(3);
    expect(byRole.get('welcome')?.npcTypeId).toBe('tutorial-goon');
    expect(byRole.get('shop')?.npcTypeId).toBe('shopkeeper');
    expect(byRole.get('spell')?.npcTypeId).toBe('spell-quest-giver');
  });

  it('spawns NPCs at tile centres offset from the stamp origin', () => {
    const def = welcomeRoom();
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    const origin = computeStampOrigin(def, ROOM_LARGE);
    const goon = stamp.npcs.find((n) => n.anchorRole === 'welcome');
    const authoredGoon = def.npcs.find((n) => n.anchorRole === 'welcome');
    expect(authoredGoon).toBeDefined();
    const rawTileX = origin.originTileX + (authoredGoon?.x ?? 0);
    const rawTileY = origin.originTileY + (authoredGoon?.y ?? 0);
    const goonDef = getNpcDef(authoredGoon?.npcTypeId ?? '');
    const widthTiles = (authoredGoon?.widthFt ?? goonDef?.widthFt ?? TILE) / TILE;
    const heightTiles = (authoredGoon?.heightFt ?? goonDef?.heightFt ?? TILE) / TILE;

    expect(goon?.tileX).toBe(Math.floor(rawTileX + widthTiles / 2));
    expect(goon?.tileY).toBe(Math.floor(rawTileY + heightTiles / 2));
    expect(goon?.x).toBe((rawTileX + widthTiles / 2) * TILE);
    expect(goon?.y).toBe((rawTileY + heightTiles / 2) * TILE);
  });

  it('threads NPC sprite override, size, and transform metadata while preserving sub-tile world coords', () => {
    const def = makeDef({
      npcs: [
        {
          id: 'npc-probe',
          npcTypeId: 'tutorial-goon',
          x: 1.25,
          y: 2.75,
          widthFt: 5,
          heightFt: 7,
          flipX: true,
          flipY: true,
          rotationDeg: 90,
          z: 7,
          spriteOverride: { source: 'catalog', spriteId: 'sprite:npc.guide' },
        },
      ],
    });
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    const origin = computeStampOrigin(def, ROOM_LARGE);
    const npc = stamp.npcs[0]!;
    const rawTileX = origin.originTileX + 1.25;
    const rawTileY = origin.originTileY + 2.75;

    const widthTiles = 5 / TILE;
    const heightTiles = 7 / TILE;
    expect(npc.tileX).toBe(Math.floor(rawTileX + widthTiles / 2));
    expect(npc.tileY).toBe(Math.floor(rawTileY + heightTiles / 2));
    expect(npc.x).toBe((rawTileX + widthTiles / 2) * TILE);
    expect(npc.y).toBe((rawTileY + heightTiles / 2) * TILE);
    expect(npc.widthFt).toBe(5);
    expect(npc.heightFt).toBe(7);
    expect(npc.flipX).toBe(true);
    expect(npc.flipY).toBe(true);
    expect(npc.rotationDeg).toBe(90);
    expect(npc.z).toBe(7);
    expect(npc.spriteOverride).toEqual({ source: 'catalog', spriteId: 'sprite:npc.guide' });
  });

  it('keeps every pair of NPCs at least 3 tiles apart (Chebyshev)', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    for (let i = 0; i < stamp.npcs.length; i += 1) {
      for (let j = i + 1; j < stamp.npcs.length; j += 1) {
        const a = stamp.npcs[i]!;
        const b = stamp.npcs[j]!;
        const cheb = Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
        expect(cheb).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('omits NPC placements whose authored footprint cannot fit inside the room interior', () => {
    const def = makeDef({
      width: 3,
      height: 3,
      npcs: [
        {
          id: 'giant',
          npcTypeId: 'tutorial-goon',
          x: 0,
          y: 0,
          widthFt: 24,
          heightFt: 24,
        },
      ],
    });

    const stamp = stampSetPiece(def, opts({ x: 0, y: 0, width: 5, height: 5 }));
    expect(stamp.npcs).toHaveLength(0);
  });
});

describe('stampSetPiece — props and layering', () => {
  it('emits one stamped prop per flattened draw layer', () => {
    const def = welcomeRoom();
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    expect(stamp.props).toHaveLength(flattenSetPieceLayers(def).length);
  });

  it('produces monotonically non-decreasing depths in render order', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    for (let i = 1; i < stamp.props.length; i += 1) {
      expect(stamp.props[i]!.render.depth).toBeGreaterThanOrEqual(stamp.props[i - 1]!.render.depth);
    }
  });

  it('layers background props (rug/banner) below entities and foreground props (desk) above', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    const rug = stamp.props.find((p) => p.render.label === 'welcome-rug');
    const desk = stamp.props.find((p) => p.render.label === 'welcome-desk');

    expect(rug).toBeDefined();
    expect(desk).toBeDefined();
    // Rug sits above baked terrain but below entities.
    expect(rug!.render.depth).toBeGreaterThan(TERRAIN_DEPTH);
    expect(rug!.render.depth).toBeLessThan(ENTITY_DEPTH);
    // Desk reads as foreground furniture: above entities, below gore.
    expect(desk!.render.depth).toBeGreaterThan(ENTITY_DEPTH);
    expect(desk!.render.depth).toBeLessThan(WORLD_VFX_DEPTH.gore);
    // The rug is drawn underneath the desk.
    expect(rug!.render.depth).toBeLessThan(desk!.render.depth);
  });

  it('drops the rug tint so the shipped red-velvet art is not double-darkened', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    const rug = stamp.props.find((p) => p.render.label === 'welcome-rug');
    expect(rug).toBeDefined();
    // The rug now resolves to real red-velvet art; a leftover #7f1d1d tint would
    // multiply onto it and double-darken it, so the authored tint was removed.
    expect(rug?.render.tintHex).toBeUndefined();
  });

  it('propagates an authored layer tint through to the render sidecar', () => {
    // Synthetic fixture preserves coverage of the tint pass-through now that no
    // real welcome-room prop is tinted (see the rug de-tint above).
    const def: SetPieceDef = {
      id: 'tint-fixture',
      name: 'Tint Fixture',
      theme: 'test',
      sizing: 'exact',
      width: 1,
      height: 1,
      description: 'synthetic single tinted prop',
      tags: [],
      props: [
        {
          id: 'tinted',
          kind: 'floor',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          z: 0,
          layers: [
            { sprite: { source: 'catalog', spriteId: 'sprite:item.gem' }, tintHex: '#3fae5a' },
          ],
        },
      ],
      npcs: [],
    };
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    const tinted = stamp.props.find((p) => p.render.label === 'tinted');
    expect(tinted?.render.tintHex).toBe('#3fae5a');
  });

  it('propagates authored prop-layer rotation into stamped render metadata', () => {
    const def: SetPieceDef = {
      id: 'rotation-fixture',
      name: 'Rotation Fixture',
      theme: 'test',
      sizing: 'exact',
      width: 1,
      height: 1,
      description: 'synthetic rotated prop',
      tags: [],
      props: [
        {
          id: 'rotated',
          kind: 'fixture',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          z: 20,
          layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' }, rotationDeg: 45 }],
        },
      ],
      npcs: [],
    };
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    expect(stamp.props[0]?.render.rotationDeg).toBe(45);
  });

  it('honours an explicit feet box over the tile-derived footprint (no-stretch sizing)', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    // welcome-rug occupies a 6×4 TILE footprint (12×8 ft) but carries an explicit
    // feet box, which must win: the shipped art keeps its own aspect instead of
    // being stretched to fill the tile box.
    const rug = stamp.props.find((p) => p.render.label === 'welcome-rug');
    const authored = welcomeRoom().props.find((p) => p.id === 'welcome-rug')!.layers[0]!;
    expect(rug?.render.widthFt).toBe(authored.widthFt);
    expect(rug?.render.heightFt).toBe(authored.heightFt);
    expect(rug?.render.widthFt).not.toBe(12); // 6 tiles × 2 ft/tile
  });

  it('falls back to the footprint (base) / native tile (accent) box when no feet box is authored', () => {
    // A synthetic composite: a 4×2 base plus a custom 2×1 accent and a plain
    // single-tile accent, none carrying an explicit feet box — so the tile-derived
    // fallback path is what sizes them.
    const def = makeDef({
      width: 4,
      height: 2,
      props: [
        {
          id: 'composite',
          kind: 'floor',
          x: 0,
          y: 0,
          width: 4,
          height: 2,
          z: 0,
          layers: [
            { sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } },
            {
              sprite: {
                source: 'custom',
                requestId: 'r',
                label: 'accent',
                prompt: 'p',
                widthTiles: 2,
                heightTiles: 1,
              },
            },
            { sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } },
          ],
        },
      ],
    });
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    // Base layer fills the whole 4×2 footprint.
    expect(stamp.props[0]!.render.widthFt).toBe(4 * TILE);
    expect(stamp.props[0]!.render.heightFt).toBe(2 * TILE);
    // Custom accent keeps its own 2×1 tile extent — NOT inflated to the parent.
    expect(stamp.props[1]!.render.widthFt).toBe(2 * TILE);
    expect(stamp.props[1]!.render.heightFt).toBe(1 * TILE);
    expect(stamp.props[1]!.render.widthFt).toBeLessThan(4 * TILE);
    // Plain accent falls back to a single tile.
    expect(stamp.props[2]!.render.widthFt).toBe(TILE);
    expect(stamp.props[2]!.render.heightFt).toBe(TILE);
  });

  it('threads a feet offset and flip through to the render sidecar', () => {
    const def = makeDef({
      width: 2,
      height: 2,
      props: [
        {
          id: 'nudged',
          kind: 'decoration',
          x: 0,
          y: 0,
          width: 2,
          height: 2,
          z: 0,
          layers: [
            {
              sprite: { source: 'catalog', spriteId: 'sprite:item.gem' },
              widthFt: 1.5,
              heightFt: 1.5,
              offsetXFt: 1,
              offsetYFt: -4,
              flipX: true,
            },
          ],
        },
      ],
    });
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    const prop = stamp.props[0]!;
    // Explicit box wins.
    expect(prop.render.widthFt).toBe(1.5);
    expect(prop.render.heightFt).toBe(1.5);
    // Flip flag threads through untouched.
    expect(prop.render.flipX).toBe(true);
    // The -4 ft vertical nudge lifts the sprite a full tile off its footprint
    // centre (this is what mounts a sconce onto the wall row).
    const origin = computeStampOrigin(def, ROOM_LARGE);
    const footprintCentreY = origin.originTileY * TILE + (2 * TILE) / 2;
    expect(prop.y).toBe(footprintCentreY - 4);
    const footprintCentreX = origin.originTileX * TILE + (2 * TILE) / 2;
    expect(prop.x).toBe(footprintCentreX + 1);
  });
});

describe('stampSetPiece — clamping and determinism', () => {
  it('clamps every prop and NPC tile to the room interior', () => {
    // Interior of this room is [1..8]×[1..7]. The 8×7 def exactly fills it, so
    // nothing should be clamped away — but assert the invariant holds anyway.
    const bounds: RoomBounds = { x: 0, y: 0, width: 10, height: 9 };
    const stamp = stampSetPiece(welcomeRoom(), opts(bounds));
    const minX = 1;
    const minY = 1;
    const maxX = 8;
    const maxY = 7;
    for (const npc of stamp.npcs) {
      expect(npc.tileX).toBeGreaterThanOrEqual(minX);
      expect(npc.tileX).toBeLessThanOrEqual(maxX);
      expect(npc.tileY).toBeGreaterThanOrEqual(minY);
      expect(npc.tileY).toBeLessThanOrEqual(maxY);
    }
    // Prop top-left tiles are clamped to the interior. (The render x/y may sit
    // slightly outside this band by design — e.g. a wall sconce's offsetYFt lifts
    // its sprite up onto the wall row — so the invariant is asserted on the
    // clamped footprint TILE, not the offset-adjusted render position.)
    for (const prop of stamp.props) {
      expect(prop.tileX).toBeGreaterThanOrEqual(minX);
      expect(prop.tileX).toBeLessThanOrEqual(maxX + 1);
      expect(prop.tileY).toBeGreaterThanOrEqual(minY);
      // Fractional authored footprint heights can legitimately clamp to a
      // fractional top-left tile just past the integer interior max.
      expect(prop.tileY).toBeLessThanOrEqual(maxY + 1);
    }
  });

  it('keeps NPC tiles inside a too-small room via clamping', () => {
    // Interior [1..4]×[1..3]; the def overflows so far tiles must clamp in.
    const bounds: RoomBounds = { x: 0, y: 0, width: 6, height: 5 };
    const stamp = stampSetPiece(welcomeRoom(), opts(bounds));
    for (const npc of stamp.npcs) {
      expect(npc.tileX).toBeGreaterThanOrEqual(1);
      expect(npc.tileX).toBeLessThanOrEqual(4);
      expect(npc.tileY).toBeGreaterThanOrEqual(1);
      expect(npc.tileY).toBeLessThanOrEqual(3);
    }
  });

  it('keeps every multi-tile prop footprint fully inside a tight interior', () => {
    // Interior [1..6]×[1..5] (6×5) — narrower than the 8×7 def, so props that
    // sit near the def's right/bottom edge would overflow onto walls if only the
    // top-left tile were clamped. Assert the WHOLE footprint stays interior.
    const bounds: RoomBounds = { x: 0, y: 0, width: 8, height: 7 };
    const interiorMinX = 1;
    const interiorMaxX = 6;
    const interiorMinY = 1;
    const interiorMaxY = 5;
    const def = welcomeRoom();
    // Footprint tiles come from the flattened draw layers (aligned by index with
    // stamp.props), NOT the render feet box — an explicit widthFt/heightFt is a
    // contain-fit visual box that can be fractional and decoupled from the tile
    // footprint the clamp actually operates on.
    const draws = flattenSetPieceLayers(def);
    const stamp = stampSetPiece(def, opts(bounds));
    expect(stamp.props).toHaveLength(draws.length);
    stamp.props.forEach((prop, i) => {
      const widthTiles = draws[i]!.prop.width;
      const heightTiles = draws[i]!.prop.height;
      expect(prop.tileX).toBeGreaterThanOrEqual(interiorMinX);
      expect(prop.tileY).toBeGreaterThanOrEqual(interiorMinY);
      // A prop no wider/taller than the interior must fit entirely; a prop
      // bigger than the interior pins to the top-left (best effort).
      if (widthTiles <= interiorMaxX - interiorMinX + 1) {
        expect(prop.tileX + widthTiles - 1).toBeLessThanOrEqual(interiorMaxX);
      } else {
        expect(prop.tileX).toBe(interiorMinX);
      }
      if (heightTiles <= interiorMaxY - interiorMinY + 1) {
        expect(prop.tileY + heightTiles - 1).toBeLessThanOrEqual(interiorMaxY);
      } else {
        expect(prop.tileY).toBe(interiorMinY);
      }
    });
  });

  it('clamps NPC anchor by half-extents so resized collision boxes stay inside interior', () => {
    const bounds: RoomBounds = { x: 0, y: 0, width: 10, height: 9 };
    const def = makeDef({
      npcs: [
        {
          id: 'large-npc',
          npcTypeId: 'tutorial-goon',
          x: 7,
          y: 6,
          widthFt: 8,
          heightFt: 8,
        },
      ],
    });
    const stamp = stampSetPiece(def, opts(bounds));
    expect(stamp.npcs).toHaveLength(1);
    const npc = stamp.npcs[0]!;
    const interiorMinX = 1;
    const interiorMaxX = 8;
    const interiorMinY = 1;
    const interiorMaxY = 7;
    const widthTiles = (npc.widthFt ?? 8) / TILE;
    const heightTiles = (npc.heightFt ?? 8) / TILE;
    const centerTileX = npc.x / TILE;
    const centerTileY = npc.y / TILE;
    const minEdgeX = centerTileX - widthTiles / 2;
    const maxEdgeX = centerTileX + widthTiles / 2;
    const minEdgeY = centerTileY - heightTiles / 2;
    const maxEdgeY = centerTileY + heightTiles / 2;

    expect(minEdgeX).toBeGreaterThanOrEqual(interiorMinX);
    expect(maxEdgeX).toBeLessThanOrEqual(interiorMaxX + 1);
    expect(minEdgeY).toBeGreaterThanOrEqual(interiorMinY);
    expect(maxEdgeY).toBeLessThanOrEqual(interiorMaxY + 1);
  });

  it('omits oversized NPC footprints that cannot fit in the room interior', () => {
    const bounds: RoomBounds = { x: 0, y: 0, width: 6, height: 5 };
    const def = makeDef({
      npcs: [
        {
          id: 'oversized',
          npcTypeId: 'tutorial-goon',
          x: 0,
          y: 0,
          widthFt: 40,
          heightFt: 40,
        },
      ],
    });
    const stamp = stampSetPiece(def, opts(bounds));
    expect(stamp.npcs).toHaveLength(0);
  });

  it('returns no placements for a room with no passable interior', () => {
    // 2×2 room → interior width/height 0 after the 1-tile wall inset. Nothing
    // can be placed without landing on a wall, so the stamp is empty.
    const bounds: RoomBounds = { x: 5, y: 5, width: 2, height: 2 };
    const stamp = stampSetPiece(welcomeRoom(), opts(bounds));
    expect(stamp.props).toHaveLength(0);
    expect(stamp.npcs).toHaveLength(0);
  });

  it('is deterministic — identical inputs yield identical output', () => {
    const a = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    const b = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    expect(a).toEqual(b);
  });
});
