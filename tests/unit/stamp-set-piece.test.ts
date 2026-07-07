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

  it('carries the rug tint through to the render sidecar', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    const rug = stamp.props.find((p) => p.render.label === 'welcome-rug');
    expect(rug?.render.tintHex).toBe('#7f1d1d');
  });

  it('sizes a multi-tile prop footprint in feet', () => {
    const stamp = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    // welcome-rug is authored 4×2 tiles.
    const rug = stamp.props.find((p) => p.render.label === 'welcome-rug');
    expect(rug?.render.widthFt).toBe(4 * TILE);
    expect(rug?.render.heightFt).toBe(2 * TILE);
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

  it('is deterministic — identical inputs yield identical output', () => {
    const a = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    const b = stampSetPiece(welcomeRoom(), opts(ROOM_LARGE));
    expect(a).toEqual(b);
  });
});
