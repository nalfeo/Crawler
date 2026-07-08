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

describe('computeStampOrigin', () => {
  it('centres an 8×7 def inside a larger interior', () => {
    const def = welcomeRoom();
    // Interior of ROOM_LARGE = [11..22] × [21..30] → 12 wide, 10 tall.
    // Offset = floor((12-8)/2)=2, floor((10-7)/2)=1.
    const origin = computeStampOrigin(def, ROOM_LARGE);
    expect(origin).toEqual({ originTileX: 13, originTileY: 22 });
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

    // welcome-goon authored at (3,1) → tile (origin.x+3, origin.y+1).
    expect(goon?.tileX).toBe(origin.originTileX + 3);
    expect(goon?.tileY).toBe(origin.originTileY + 1);
    // World coords are the tile centre (tile * tileSizeFt + half).
    expect(goon?.x).toBe((origin.originTileX + 3) * TILE + TILE / 2);
    expect(goon?.y).toBe((origin.originTileY + 1) * TILE + TILE / 2);
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

  it('sizes a multi-tile prop footprint in feet', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    // welcome-rug is authored 4×2 tiles.
    const rug = stamp.props.find((p) => p.render.label === 'welcome-rug');
    expect(rug?.render.widthFt).toBe(4 * TILE);
    expect(rug?.render.heightFt).toBe(2 * TILE);
  });

  it('sizes non-base accent layers by their own extent, not the parent footprint', () => {
    const def = welcomeRoom();
    const draws = flattenSetPieceLayers(def);
    const stamp = stampSetPiece(def, opts(ROOM_LARGE));
    // stampSetPiece emits one prop per flattened draw layer, in the same order.
    expect(stamp.props).toHaveLength(draws.length);

    let sawBase = false;
    let sawShrunkAccent = false;
    draws.forEach((draw, i) => {
      const { render } = stamp.props[i]!;
      if (draw.layerIndex === 0) {
        // Base layer fills the whole prop footprint.
        expect(render.widthFt).toBe(draw.prop.width * TILE);
        expect(render.heightFt).toBe(draw.prop.height * TILE);
        sawBase = true;
        return;
      }
      // Accent layer: sized by its own extent (custom tile footprint, else a
      // single tile) — NEVER inflated to the parent footprint.
      const sprite = draw.layer.sprite;
      const expectedW = sprite.source === 'custom' ? (sprite.widthTiles ?? 1) * TILE : TILE;
      const expectedH = sprite.source === 'custom' ? (sprite.heightTiles ?? 1) * TILE : TILE;
      expect(render.widthFt).toBe(expectedW);
      expect(render.heightFt).toBe(expectedH);
      // On a multi-tile prop the accent MUST be strictly smaller than the
      // footprint — this is the giant-bottle regression the fix guards against.
      if (draw.prop.width > 1 || draw.prop.height > 1) {
        expect(render.widthFt).toBeLessThan(draw.prop.width * TILE);
        sawShrunkAccent = true;
      }
    });

    // Guard the fixture: the welcome room must exercise both paths so this test
    // can't silently pass if the content ever loses its layered props.
    expect(sawBase).toBe(true);
    expect(sawShrunkAccent).toBe(true);
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
    // Prop top-left tiles derive from clamped world coords; assert they stay in
    // the interior band (world feet ≥ minX*TILE and ≤ (maxX+1)*TILE).
    for (const prop of stamp.props) {
      expect(prop.x).toBeGreaterThanOrEqual(minX * TILE);
      expect(prop.y).toBeGreaterThanOrEqual(minY * TILE);
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
    const stamp = stampSetPiece(welcomeRoom(), opts(bounds));
    for (const prop of stamp.props) {
      const widthTiles = prop.render.widthFt / TILE;
      const heightTiles = prop.render.heightFt / TILE;
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
    }
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
