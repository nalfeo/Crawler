import { describe, it, expect, beforeEach, vi } from 'vitest';
import { addEntity, addComponent, set } from 'bitecs';
import { createTestWorld } from '../../tests/helpers/world-factory';
import { fovSystem } from '../../src/core/systems/fovSystem';
import { Player, Position } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { TileMap } from '../../src/core/map/TileMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TilePresets, BiomeType } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import type { GameWorld } from '../../src/core/world';

function makeSmallMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 20,
    heightTiles: 20,
    tileSizeFt: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(20, 20);
  const terrain = new Uint8Array(400);
  const roomGraph = new RoomGraph();

  // Open room from (1,1) to (18,18), walls on border
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const idx = y * 20 + x;
      if (x === 0 || x === 19 || y === 0 || y === 19) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }

  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 10, y: 10 });
}

/**
 * Build an open N×N room (border walls, floor interior) at a given sub-factor,
 * with an optional `paint` hook to add internal walls (doorways/corridors).
 * Used by the boundary-divergence pins below, which need a map large enough that
 * the vision-radius ring falls inside the map.
 */
function makeOpenMap(n: number, subFactor: number, paint?: (t: TileMap) => void): FloorMap {
  const config: MapConfig = {
    widthTiles: n,
    heightTiles: n,
    tileSizeFt: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const idx = y * n + x;
      tileMap.flags[idx] =
        x === 0 || x === n - 1 || y === 0 || y === n - 1 ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  paint?.(tileMap);
  return new FloorMap(
    config,
    tileMap,
    new RoomGraph(),
    new Uint8Array(n * n),
    { x: 10, y: 10 },
    subFactor,
  );
}

/** Run the real fovSystem for a player at tile `(ptx, pty)` (tile center). */
function runFovAt(floorMap: FloorMap, ptx: number, pty: number): FloorMap {
  const w = createTestWorld({ seed: 42 });
  w.floorMap = floorMap;
  const eid = addEntity(w.ecs);
  addComponent(w.ecs, eid, set(Position, { x: ptx * 32 + 16, y: pty * 32 + 16 }));
  addComponent(w.ecs, eid, Player);
  fovSystem(w);
  return floorMap;
}

describe('FOV System', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
  });

  it('should do nothing when no floorMap exists', () => {
    world.floorMap = null;
    expect(() => fovSystem(world)).not.toThrow();
  });

  it('should do nothing when no player exists', () => {
    world.floorMap = makeSmallMap();
    expect(() => fovSystem(world)).not.toThrow();
  });

  it('should mark tiles visible around the player', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Create player at tile (10, 10) → pixel (320, 320)
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // Player's own tile should be visible
    expect(floorMap.isVisible(10, 10)).toBe(true);

    // Adjacent open tiles should be visible
    expect(floorMap.isVisible(11, 10)).toBe(true);
    expect(floorMap.isVisible(9, 10)).toBe(true);
    expect(floorMap.isVisible(10, 11)).toBe(true);
  });

  it('should not see through walls', () => {
    const floorMap = makeSmallMap();
    // Add an internal wall blocking line of sight
    for (let y = 3; y < 17; y++) {
      floorMap.tileMap.flags[y * 20 + 5] = TilePresets.WALL;
    }
    world.floorMap = floorMap;

    // Player at tile (3, 10) → pixel (96, 320)
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 96, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // Player's tile visible
    expect(floorMap.isVisible(3, 10)).toBe(true);

    // Behind the wall should not be visible
    expect(floorMap.isVisible(8, 10)).toBe(false);
    expect(floorMap.isVisible(15, 10)).toBe(false);
  });

  it('blocks FOV through a diagonal corner seam', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Build a blocked corner seam around tile (6,6): the orthogonals
    // (6,5) and (5,6) are walls, so diagonal peeking across the seam
    // from (5,5) to (6,6) must be blocked.
    floorMap.tileMap.setFlags(6, 5, TilePresets.WALL);
    floorMap.tileMap.setFlags(5, 6, TilePresets.WALL);

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 5 * 32 + 16, y: 5 * 32 + 16 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    expect(floorMap.isVisible(5, 5)).toBe(true);
    expect(floorMap.isVisible(6, 6)).toBe(false);
  });

  it('blocks FOV through a corner seam several tiles from the player (mid-ray seam)', () => {
    // Player at (2,2); blocked seam at the (5,5)→(6,6) diagonal step (walls at
    // (6,5) and (5,6)). The seam is 4 tile-steps away, so this regression ensures
    // the full-ray check catches seams that are not origin-adjacent.
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    floorMap.tileMap.setFlags(6, 5, TilePresets.WALL);
    floorMap.tileMap.setFlags(5, 6, TilePresets.WALL);

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 2 * 32 + 16, y: 2 * 32 + 16 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // The player's own tile and tiles before the seam are visible.
    expect(floorMap.isVisible(2, 2)).toBe(true);
    expect(floorMap.isVisible(5, 5)).toBe(true);
    // Tile (6,6) lies behind the mid-ray blocked seam — must not be visible.
    expect(floorMap.isVisible(6, 6)).toBe(false);
    // Tile (7,7) is even further behind the seam — also not visible.
    expect(floorMap.isVisible(7, 7)).toBe(false);
  });

  it('should clear visibility before recomputing', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Player at tile (10, 10)
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);
    expect(floorMap.isVisible(10, 10)).toBe(true);

    // Place a wall ring around (10,10) so it cannot be seen from far away
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const idx = (10 + dy) * floorMap.tileMap.width + (10 + dx);
        floorMap.tileMap.flags[idx] = TilePresets.WALL;
      }
    }

    // Move player far away — old tile (10,10) should no longer be visible
    world.stores.position.x[eid] = 64; // tile (2, 2)
    world.stores.position.y[eid] = 64;

    fovSystem(world);
    expect(floorMap.isVisible(2, 2)).toBe(true);
    expect(floorMap.isVisible(10, 10)).toBe(false);
  });

  it('reuses visibility while the sub-tile origin and transparency are unchanged', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);
    // `clearVisibility` runs exactly once per real shadowcast pass, so it is the
    // observable for "did the system recompute?" — the inner transparency probe
    // reads the flags array directly and is not independently observable.
    const cleared = vi.spyOn(floorMap, 'clearVisibility');

    fovSystem(world);
    expect(cleared).toHaveBeenCalledTimes(1);
    fovSystem(world);

    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('recomputes visibility after a transparency mutation at the same origin', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);
    const cleared = vi.spyOn(floorMap, 'clearVisibility');

    fovSystem(world);
    expect(cleared).toHaveBeenCalledTimes(1);
    floorMap.tileMap.setFlags(11, 10, TilePresets.WALL);
    fovSystem(world);

    expect(cleared).toHaveBeenCalledTimes(2);
  });

  it('should handle player at map edge gracefully', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Player at tile (1, 1) — near edge
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 32, y: 32 }));
    addComponent(world.ecs, eid, Player);

    expect(() => fovSystem(world)).not.toThrow();
    expect(floorMap.isVisible(1, 1)).toBe(true);
  });

  it('should mark quarter-tiles visible at sub-tile granularity', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Player at tile (10, 10); tileSizeFt = 32, so halfTile = 16.
    // worldToSubTile(320, 320) → (20, 20), the TL quadrant of tile (10,10).
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // The visible array has 4 entries per tile.
    expect(floorMap.visible.length).toBe(floorMap.subWidth * floorMap.subHeight);

    // isVisibleSubtile checks raw sub-tile coords.
    // Player origin sub-tile (20,20) must be visible.
    expect(floorMap.isVisibleSubtile(20, 20)).toBe(true);

    // isVisibleAt using world position maps to the same sub-tile.
    expect(floorMap.isVisibleAt(320, 320)).toBe(true);
    // A world position of (336, 320) → hx = floor(336/16) = 21 (still tile 10)
    expect(floorMap.isVisibleAt(336, 320)).toBe(true);

    // Tile (0,0) is the map's own border corner: it is opaque and diagonal
    // from the player with both orthogonal neighbours (the border wall runs)
    // also opaque. Post-fix, an opaque tile a ray terminates on is always
    // revealed (the seam rule only blocks rays looking PAST an opaque tile,
    // not the tile itself) — so this corner is correctly visible now.
    expect(floorMap.isVisibleSubtile(0, 0)).toBe(true);
  });

  it('HARD GATE: reveals all four interior corner blocks of an enclosed room without leaking vision past them', () => {
    // The defect: a room's interior corner wall tile is diagonal from the
    // player with BOTH orthogonal neighbours (the two wall runs meeting at
    // that corner) opaque — exactly the pattern `hasBlockedCornerSeam` exists
    // to detect for a ray passing THROUGH a diagonal gap. But the corner
    // block itself is the ray's TERMINUS, not something beyond it, so it was
    // being seam-rejected and stayed permanently black even though the two
    // wall runs beside it lit up correctly. Fix: an opaque tile a ray
    // terminates on is exempt from the seam rule; only rays looking PAST an
    // opaque tile remain seam-blocked.
    //
    // Build a fully-enclosed 10x10 room (walls forming a ring at x/y in
    // {5,14}, floor interior x/y in [6,13]) inside a larger open map, with
    // the player standing dead-center. Assert:
    //   1. All four interior corner wall tiles are visible (the fix).
    //   2. Tiles diagonally BEYOND each corner (outside the room) are NOT
    //      revealed — the seam rule still blocks genuine look-through gaps,
    //      and revealing the opaque corner block must not leak vision past it.
    const N = 25;
    const paint = (t: TileMap): void => {
      for (let x = 5; x <= 14; x++) {
        t.flags[5 * N + x] = TilePresets.WALL; // north wall
        t.flags[14 * N + x] = TilePresets.WALL; // south wall
      }
      for (let y = 5; y <= 14; y++) {
        t.flags[y * N + 5] = TilePresets.WALL; // west wall
        t.flags[y * N + 14] = TilePresets.WALL; // east wall
      }
    };
    const floorMap = runFovAt(makeOpenMap(N, 2, paint), 10, 10);

    const corners: ReadonlyArray<readonly [number, number]> = [
      [5, 5],
      [14, 5],
      [5, 14],
      [14, 14],
    ];
    for (const [cx, cy] of corners) {
      expect(floorMap.isVisible(cx, cy)).toBe(true);
    }

    // Diagonally beyond each corner (one tile past it, outside the room ring)
    // must stay hidden — the fix must not leak vision past the corner block.
    const beyondCorners: ReadonlyArray<readonly [number, number]> = [
      [4, 4],
      [15, 4],
      [4, 15],
      [15, 15],
    ];
    for (const [bx, by] of beyondCorners) {
      expect(floorMap.isVisible(bx, by)).toBe(false);
    }

    // Sanity: the wall runs beside the corners (already working pre-fix) and
    // the room interior remain visible, so the fix didn't regress the rest.
    expect(floorMap.isVisible(10, 5)).toBe(true); // mid north wall
    expect(floorMap.isVisible(6, 6)).toBe(true); // interior near corner
  });

  // HARD GATE: the interior-corner exemption must cover ONLY the ray's final
  // step. An opaque tile sitting behind a diagonal pinch crossed EARLIER on
  // the ray is genuinely being peeked at through a gap and must stay hidden.
  // A bypass that skips the seam check for all opaque tiles passes the
  // four-corner gate above while silently failing this one.
  it('HARD GATE: does not reveal an opaque tile behind an earlier blocked corner seam', () => {
    const N = 25;
    const paint = (t: TileMap): void => {
      // Pinch the diagonal step (11,11) -> (12,12) from the player at (10,10).
      t.flags[11 * N + 12] = TilePresets.WALL;
      t.flags[12 * N + 11] = TilePresets.WALL;
      // The opaque tile being peeked at through that pinch.
      t.flags[13 * N + 13] = TilePresets.WALL;
    };
    const floorMap = runFovAt(makeOpenMap(N, 2, paint), 10, 10);

    // Sanity: the two pinch walls themselves are terminal opaque tiles the
    // player looks directly at, so they ARE visible.
    expect(floorMap.isVisible(12, 11)).toBe(true);
    expect(floorMap.isVisible(11, 12)).toBe(true);

    // The gate: the wall beyond the pinch must not be revealed.
    expect(floorMap.isVisible(13, 13)).toBe(false);
  });

  it('visible bitmap is quarter-tile sized (4× tile count)', () => {
    const floorMap = makeSmallMap();
    const tileCount = floorMap.width * floorMap.height;
    expect(floorMap.visible.length).toBe(tileCount * 4);
    expect(floorMap.subWidth).toBe(floorMap.width * 2);
    expect(floorMap.subHeight).toBe(floorMap.height * 2);
  });

  it('marks discovered alongside visible', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // Everything currently visible must also be recorded as discovered.
    expect(floorMap.isVisible(10, 10)).toBe(true);
    expect(floorMap.isDiscovered(10, 10)).toBe(true);
    expect(floorMap.isDiscovered(11, 10)).toBe(true);
  });

  it('retains discovered memory for tiles that leave the view', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);
    expect(floorMap.isVisible(10, 10)).toBe(true);
    expect(floorMap.isDiscovered(10, 10)).toBe(true);

    // Wall-ring tile (10,10) so it can't be seen from afar, then move the player
    // away. (The 20×20 room is smaller than the vision radius, so occlusion —
    // not distance — is what removes a tile from FOV here.)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        floorMap.tileMap.flags[(10 + dy) * floorMap.tileMap.width + (10 + dx)] = TilePresets.WALL;
      }
    }
    world.stores.position.x[eid] = 64; // tile (2,2)
    world.stores.position.y[eid] = 64;
    fovSystem(world);

    // No longer visible, but the discovered memory persists (dim, not black).
    expect(floorMap.isVisible(10, 10)).toBe(false);
    expect(floorMap.isDiscovered(10, 10)).toBe(true);
  });

  it('keeps interior tile visibility identical across sub-factors (default factor 2 is frozen)', () => {
    // subFactor changes only fog *resolution*. For tiles strictly INSIDE the
    // vision radius and unoccluded, tile-level isVisible (read by AI, culling,
    // weapon range and the minimap) is identical at every factor. Boundary tiles
    // (radius edge / shadow edges) may differ by ~1 tile — those are pinned in
    // the two tests below. The 20×20 room sits entirely within the 25-tile radius
    // from (10,10) (max sampled dist ≈7), so tiles 5..15 are all strictly
    // interior. Factor 2 is the frozen shipped default.
    const coarse = makeSmallMap();
    expect(coarse.subFactor).toBe(2);
    const fine = makeSmallMap();
    fine.setSubFactor(8);
    expect(fine.subFactor).toBe(8);

    for (const floorMap of [coarse, fine]) runFovAt(floorMap, 10, 10);

    // Sample the interior tiles; tile-level visibility must match factor-for-factor.
    for (let ty = 5; ty <= 15; ty++) {
      for (let tx = 5; tx <= 15; tx++) {
        expect(fine.isVisible(tx, ty)).toBe(coarse.isVisible(tx, ty));
      }
    }
    // The finer map carries 16× the sub-tiles even though interior tiles match.
    expect(fine.visible.length).toBe(coarse.visible.length * 16);
  });

  it('pins the vision-radius boundary divergence (finer factor sees a strict subset)', () => {
    // On a map large enough that the ~25-tile radius ring falls INSIDE the map,
    // the circular radius edge rasterizes tighter at finer factors. Verified with
    // the real fovSystem: factor-8 visibility is a strict subset of factor-2 (the
    // finer pass never adds a radius-edge tile the coarse pass missed), they are
    // NOT equal, and every differing tile lies on the radius ring (dist ∈ ~[24,27]).
    // Interior (dist < 24) is identical — so gameplay diverges only at the extreme
    // vision edge, and only at lab-only factors (the default stays 2).
    const N = 40;
    const coarse = runFovAt(makeOpenMap(N, 2), 10, 10);
    const fine = runFovAt(makeOpenMap(N, 8), 10, 10);

    let diffs = 0;
    for (let ty = 0; ty < N; ty++) {
      for (let tx = 0; tx < N; tx++) {
        const c = coarse.isVisible(tx, ty);
        const f = fine.isVisible(tx, ty);
        const dist = Math.hypot(tx - 10, ty - 10);
        if (dist < 24) {
          expect(f).toBe(c); // strictly-interior tiles are factor-invariant
          continue;
        }
        if (c !== f) {
          diffs++;
          expect(c).toBe(true); // coarse sees it...
          expect(f).toBe(false); // ...finer does not (strict subset)
          expect(dist).toBeLessThan(27); // and only on the radius ring
        }
      }
    }
    expect(diffs).toBeGreaterThan(0); // the invariant genuinely breaks at the edge
  });

  it('keeps doorway look-through tiles visible at the shipped sub-factor', () => {
    // A vertical wall at column 12 with a 1-tile doorway at y=10 splits an open
    // 40×40 room; the player stands left of the wall, aligned with the doorway.
    // Adjacent diagonal peeking at the corner seam is blocked, but farther
    // tiles that are genuinely reachable through the doorway stay visible.
    const N = 40;
    const col = 12;
    const doorY = 10;
    const ptx = 6;
    const pty = 10;
    const paint = (t: TileMap): void => {
      for (let y = 1; y < N - 1; y++) {
        if (y === doorY) continue; // leave the doorway open
        t.flags[y * N + col] = TilePresets.WALL;
      }
    };
    const coarse = runFovAt(makeOpenMap(N, 2, paint), ptx, pty);
    const fine = runFovAt(makeOpenMap(N, 8, paint), ptx, pty);

    for (const [tx, ty] of [
      [21, 8],
      [22, 8],
      [23, 8],
    ] as const) {
      expect(Math.hypot(tx - ptx, ty - pty)).toBeLessThan(20); // inside radius, not the edge
      expect(coarse.isVisible(tx, ty)).toBe(true);
      expect(fine.isVisible(tx, ty)).toBe(false);
    }
  });
});

describe('FOV System — whole-tile wall reveal', () => {
  /** Collect the opaque tiles that have at least one visible sub-tile. */
  function visibleOpaqueTiles(map: FloorMap): Array<[number, number]> {
    const opaque: Array<[number, number]> = [];
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        if (!map.isVisible(tx, ty)) continue;
        if (!map.tileMap.isTransparent(tx, ty)) opaque.push([tx, ty]);
      }
    }
    return opaque;
  }

  /** True when every sub-tile of `(tx, ty)` is set in both bitmaps. */
  function tileFullyLit(map: FloorMap, tx: number, ty: number): boolean {
    const sf = map.subFactor;
    for (let dy = 0; dy < sf; dy++) {
      for (let dx = 0; dx < sf; dx++) {
        const hx = tx * sf + dx;
        const hy = ty * sf + dy;
        if (!map.isVisibleSubtile(hx, hy) || !map.isDiscoveredSubtile(hx, hy)) return false;
      }
    }
    return true;
  }

  for (const subFactor of [2, 4, 8]) {
    it(`reveals every sub-tile of a seen wall tile at subFactor ${subFactor}`, () => {
      const map = runFovAt(makeOpenMap(40, subFactor), 20, 20);
      const opaque = visibleOpaqueTiles(map);

      // The room's border walls sit inside the vision radius.
      expect(opaque.length).toBeGreaterThan(0);
      for (const [tx, ty] of opaque) {
        expect(tileFullyLit(map, tx, ty), `wall tile (${tx},${ty}) only partially lit`).toBe(true);
      }
    });
  }

  it('fills the far side of a wall the player only grazes', () => {
    // Vertical wall at column 12; the player stands well to its left, so
    // shadowcasting only lands rays on the wall's left-facing sub-column.
    const N = 40;
    const col = 12;
    const sf = 4;
    const map = runFovAt(
      makeOpenMap(N, sf, (t) => {
        for (let y = 1; y < N - 1; y++) t.flags[y * N + col] = TilePresets.WALL;
      }),
      6,
      10,
    );

    expect(map.isVisible(col, 10)).toBe(true);
    // Far (right-most) sub-column of that wall tile — unreachable by any ray.
    expect(map.isVisibleSubtile(col * sf + sf - 1, 10 * sf)).toBe(true);
    expect(map.isDiscoveredSubtile(col * sf + sf - 1, 10 * sf)).toBe(true);
  });

  it('does not reveal wall tiles outside the field of view', () => {
    const N = 40;
    const col = 12;
    const sf = 4;
    const map = runFovAt(
      makeOpenMap(N, sf, (t) => {
        for (let y = 1; y < N - 1; y++) t.flags[y * N + col] = TilePresets.WALL;
      }),
      6,
      10,
    );

    // The border wall hidden behind the blocking column stays unseen.
    expect(map.isVisible(N - 1, 10)).toBe(false);
    expect(map.isVisibleSubtile((N - 1) * sf, 10 * sf)).toBe(false);
  });

  it('keeps floor tiles at sub-tile granularity (walls are the only exception)', () => {
    // The vision-radius ring must still cut floor tiles part-way; whole-tile
    // filling is opaque-only.
    const map = runFovAt(makeOpenMap(60, 4), 30, 30);
    let partialFloorTiles = 0;
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        if (!map.isVisible(tx, ty)) continue;
        if (!map.tileMap.isTransparent(tx, ty)) continue;
        if (!tileFullyLit(map, tx, ty)) partialFloorTiles += 1;
      }
    }
    expect(partialFloorTiles).toBeGreaterThan(0);
  });

  it('clears filled wall sub-tiles when the player moves away', () => {
    const map = makeOpenMap(40, 4);
    runFovAt(map, 2, 2); // hugging the top-left corner walls
    // Top border wall directly above the player.
    expect(map.isVisible(2, 0)).toBe(true);
    expect(map.isVisibleSubtile(2 * 4 + 3, 3)).toBe(true);

    runFovAt(map, 33, 33);
    expect(map.isVisible(2, 0)).toBe(false);
    expect(map.isVisibleSubtile(2 * 4 + 3, 3)).toBe(false);
    // Discovered memory persists.
    expect(map.isDiscoveredSubtile(2 * 4 + 3, 3)).toBe(true);
  });
});

describe('FloorMap.clearVisibility — bounded bounding box', () => {
  it('only clears sub-tiles within the FOV footprint, not the full bitmap', () => {
    const config: MapConfig = {
      widthTiles: 20,
      heightTiles: 20,
      tileSizeFt: 32,
      biome: BiomeType.ARENA,
      seed: 42,
      roomWidthRange: [4, 8],
      roomHeightRange: [4, 8],
      maxRooms: 1,
      floorDensity: 0.5,
    };
    const tileMap = new TileMap(20, 20);
    const terrain = new Uint8Array(400);
    const roomGraph = new RoomGraph();
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        tileMap.flags[y * 20 + x] =
          x === 0 || x === 19 || y === 0 || y === 19 ? TilePresets.WALL : TilePresets.FLOOR;
      }
    }
    const floorMap = new FloorMap(config, tileMap, roomGraph, terrain, { x: 10, y: 10 });

    // Manually set a sub-tile far from the FOV footprint (simulate a never-visited cell).
    // Indexed in sub-grid coordinates via `subWidth`, so this is independent of the FOV
    // sub-factor; sub-tile (15,15) sits far outside the (5,5) footprint used below.
    // We'll set sub-tile (15,15) directly so it's non-zero before any FOV call.
    // Then run setVisible for only one small cell, then clearVisibility — that
    // far cell must NOT be cleared (because it was never in the FOV bounding box).
    floorMap['visible'][15 * floorMap.subWidth + 15] = 1;

    // Simulate FOV visiting only sub-tile (5,5).
    floorMap.setVisible(5, 5);

    // Now clear — should only zero (5,5); (15,15) was not in the bounding box.
    floorMap.clearVisibility();

    // (5,5) was in the bounding box → must be cleared.
    expect(floorMap['visible'][5 * floorMap.subWidth + 5]).toBe(0);
    // (15,15) was NOT in the bounding box → must be untouched.
    expect(floorMap['visible'][15 * floorMap.subWidth + 15]).toBe(1);
  });

  it('clears nothing (empty bbox) when no setVisible was called after construction', () => {
    const config: MapConfig = {
      widthTiles: 10,
      heightTiles: 10,
      tileSizeFt: 4,
      biome: BiomeType.ARENA,
      seed: 1,
      roomWidthRange: [4, 8],
      roomHeightRange: [4, 8],
      maxRooms: 1,
      floorDensity: 0.5,
    };
    const tileMap = new TileMap(10, 10);
    const terrain = new Uint8Array(100);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        tileMap.flags[y * 10 + x] = TilePresets.FLOOR;
      }
    }
    const floorMap = new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 5, y: 5 });

    // Manually plant a visible cell — no setVisible called, so bounding box is empty.
    floorMap['visible'][5 * floorMap.subWidth + 5] = 1;
    floorMap.clearVisibility();
    // Empty bounding box → no zeroing — cell should remain 1.
    expect(floorMap['visible'][5 * floorMap.subWidth + 5]).toBe(1);
  });

  it('revealAll sets bounding box to full extent so clearVisibility zeros everything', () => {
    const config: MapConfig = {
      widthTiles: 8,
      heightTiles: 8,
      tileSizeFt: 4,
      biome: BiomeType.ARENA,
      seed: 2,
      roomWidthRange: [4, 8],
      roomHeightRange: [4, 8],
      maxRooms: 1,
      floorDensity: 0.5,
    };
    const tileMap = new TileMap(8, 8);
    const terrain = new Uint8Array(64);
    for (let i = 0; i < 64; i++) tileMap.flags[i] = TilePresets.FLOOR;
    const floorMap = new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 4, y: 4 });
    floorMap.revealAll();

    // All sub-tiles visible before clear.
    expect(floorMap['visible'].every((v) => v === 1)).toBe(true);

    floorMap.clearVisibility();

    // After clear via full bounding box, all sub-tiles must be zero.
    expect(floorMap['visible'].every((v) => v === 0)).toBe(true);
  });
});
