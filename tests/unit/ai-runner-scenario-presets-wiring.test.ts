import { describe, expect, it } from 'vitest';
import {
  AI_RUNNER_SCENARIO_PRESETS,
  AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS,
  DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID,
  getAiRunnerScenarioPreset,
} from '../../src/labs/ai-runner-lab/scenario-presets.js';
import { TerrainType, TilePresets } from '../../src/shared/map-types.js';

describe('AI runner scenario presets wiring', () => {
  it('defines deterministic scenario catalog and lookup', () => {
    const ids = AI_RUNNER_SCENARIO_PRESETS.map((preset) => preset.id);
    expect(DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID).toBe('floor1-default');
    expect(ids).toEqual([
      'floor1-default',
      'spawner-sealable-room',
      'spawner-unsealable-room',
      'spawner-cave',
      'terrain-wall-junctions',
    ]);
    expect(getAiRunnerScenarioPreset('spawner-sealable-room')?.defaultSeed).toBe(4206);
    expect(getAiRunnerScenarioPreset('spawner-unsealable-room')?.defaultSeed).toBe(4206);
    expect(getAiRunnerScenarioPreset('spawner-cave')?.defaultSeed).toBe(4208);
  });

  it('builds a two-room sealed slice: lockable doorway, side room, and passable gap', () => {
    const sealed = AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS.makeSealedRoomSliceMap(true);
    const unsealable = AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS.makeSealedRoomSliceMap(false);
    const cave = AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS.makeCaveSliceMap();

    // Doorway gap between the two rooms (tile 7,15). Starts OPEN (passable but
    // lockable) so the AI can walk through and the arena seals it on arming.
    const doorIdx = 15 * sealed.width + 7;
    expect(sealed.flags[doorIdx]).toBe(TilePresets.DOOR_OPEN);
    expect(unsealable.flags[doorIdx]).toBe(TilePresets.FLOOR);
    expect(sealed.terrain[doorIdx]).toBe(TerrainType.DOOR);
    expect(unsealable.terrain[doorIdx]).toBe(TerrainType.STONE_FLOOR);

    // The divider is a real wall either side of the doorway gap.
    expect(sealed.flags[15 * sealed.width + 6]).toBe(TilePresets.WALL);
    expect(sealed.flags[15 * sealed.width + 8]).toBe(TilePresets.WALL);

    // Spawner (arena room) and player (starter room) sit in DIFFERENT rooms so
    // the arena only arms once the AI walks through the doorway.
    const arenaRoom = sealed.roomGraph.getRoomAt(7, 7);
    const starterRoom = sealed.roomGraph.getRoomAt(7, 18);
    expect(arenaRoom).toBeGreaterThanOrEqual(0);
    expect(starterRoom).toBeGreaterThanOrEqual(0);
    expect(arenaRoom).not.toBe(starterRoom);

    // Both spawn tiles and the doorway are passable so the AI can path in.
    expect(sealed.tileMap.isPassable(7, 7)).toBe(true);
    expect(sealed.tileMap.isPassable(7, 18)).toBe(true);

    expect(cave.terrain[8 * cave.width + 12]).toBe(TerrainType.CAVE_FLOOR);
    expect(cave.terrain[0]).toBe(TerrainType.CAVE_WALL);
  });

  describe('terrain-wall-junctions inspection slice', () => {
    // This scene only earns its keep if it ACTUALLY contains the adjacencies it
    // claims. A door that drifts off a wall run, or a material seam that stops
    // crossing a wall, silently turns the scene into a scene of nothing — and
    // the failure mode is "the screenshot looked fine", which is exactly what
    // this scene exists to stop being the standard of proof.
    const { makeTerrainJunctionSliceMap, TERRAIN_JUNCTION_SLICE } =
      AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS;
    const map = makeTerrainJunctionSliceMap();
    const at = (x: number, y: number): number => y * map.width + x;

    it('puts every door inside a wall run, flanked by wall on both sides', () => {
      for (const door of TERRAIN_JUNCTION_SLICE.doors) {
        expect(map.terrain[at(door.x, door.y)]).toBe(TerrainType.DOOR);
        expect(map.flags[at(door.x, door.y)]).toBe(TilePresets.DOOR_OPEN);

        // A door in a horizontal wall run is flanked E/W; one in a vertical run
        // is flanked N/S. Exactly one of those must hold, or the "door" is a
        // hole in open floor and exercises no junction at all.
        const flankedEW =
          map.flags[at(door.x - 1, door.y)] === TilePresets.WALL &&
          map.flags[at(door.x + 1, door.y)] === TilePresets.WALL;
        const flankedNS =
          map.flags[at(door.x, door.y - 1)] === TilePresets.WALL &&
          map.flags[at(door.x, door.y + 1)] === TilePresets.WALL;
        expect(flankedEW || flankedNS).toBe(true);
      }
    });

    it('covers all four wall orientations and both material packs', () => {
      const { roomMinX, roomMaxX, roomMinY, roomMaxY, materialSeamX, doors } =
        TERRAIN_JUNCTION_SLICE;
      expect(doors.some((d) => d.y === roomMinY)).toBe(true); // north
      expect(doors.some((d) => d.y === roomMaxY)).toBe(true); // south
      expect(doors.some((d) => d.x === roomMinX)).toBe(true); // west
      expect(doors.some((d) => d.x === roomMaxX)).toBe(true); // east
      // Door junctions must exist on BOTH sides of the material seam, so the
      // fix is observable in the cave pack too and not just the dungeon pack.
      expect(doors.some((d) => d.x < materialSeamX)).toBe(true);
      expect(doors.some((d) => d.x >= materialSeamX)).toBe(true);
    });

    it('runs the material seam through a continuous wall run', () => {
      // The cross-pack seam ADR 0078 scopes validation to is only observable
      // where a stone wall cell is directly adjacent to a cave wall cell.
      const { materialSeamX, roomMinY } = TERRAIN_JUNCTION_SLICE;
      expect(map.terrain[at(materialSeamX - 1, roomMinY)]).toBe(TerrainType.STONE_WALL);
      expect(map.terrain[at(materialSeamX, roomMinY)]).toBe(TerrainType.CAVE_WALL);
    });

    it('spawns the player on a passable tile with the junctions in view', () => {
      const { playerTile, roomMinX, roomMaxX, roomMinY, roomMaxY } = TERRAIN_JUNCTION_SLICE;
      expect(map.tileMap.isPassable(playerTile.x, playerTile.y)).toBe(true);
      expect(playerTile.x).toBeGreaterThan(roomMinX);
      expect(playerTile.x).toBeLessThan(roomMaxX);
      expect(playerTile.y).toBeGreaterThan(roomMinY);
      expect(playerTile.y).toBeLessThan(roomMaxY);
    });

    it('contains at least one T-junction stub (degree-3 wall cluster) per material pack', () => {
      // A T-junction is a stub tile with three orthogonal wall-stub neighbours.
      // Without at least one per pack the scene only exercises convex corners
      // (elbows) and misses the three-neighbour silhouette case entirely.
      const { stubs, materialSeamX } = TERRAIN_JUNCTION_SLICE;
      const stubSet = new Set(stubs.map((s) => `${s.x},${s.y}`));
      const stubNeighborCount = (x: number, y: number): number =>
        [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ].filter(([nx, ny]) => stubSet.has(`${nx},${ny}`)).length;

      const hasTeeOnStoneSide = stubs
        .filter((s) => s.x < materialSeamX)
        .some((s) => stubNeighborCount(s.x, s.y) >= 3);
      const hasTeeOnCaveSide = stubs
        .filter((s) => s.x >= materialSeamX)
        .some((s) => stubNeighborCount(s.x, s.y) >= 3);

      expect(hasTeeOnStoneSide).toBe(true);
      expect(hasTeeOnCaveSide).toBe(true);
    });

    it('borders a wall run with explicit in-map VOID on one side and floor on the other (Fix 1 coverage)', () => {
      // The dynamic wall-inset fix must be observable against real in-map rock,
      // not just the map's own out-of-bounds edge (the outer border already
      // covers that case). `voidWall` is a straight wall column; `voidPocket`
      // is VOID immediately west of it; the column's east side stays floor.
      const { voidWall, voidPocket } = TERRAIN_JUNCTION_SLICE;
      expect(voidPocket.x).toBe(voidWall.x - 1);
      for (let y = voidWall.yStart; y <= voidWall.yEnd; y += 1) {
        expect(map.flags[at(voidWall.x, y)]).toBe(TilePresets.WALL);
        // West neighbour is explicit VOID (rock), not merely a wall terrain type.
        expect(map.terrain[at(voidPocket.x, y)]).toBe(TerrainType.VOID);
        expect(map.flags[at(voidPocket.x, y)]).toBe(TilePresets.WALL);
        // East neighbour of the wall column stays ordinary passable floor, so
        // the inset-vs-no-inset contrast is visible on the same wall run.
        expect(map.tileMap.isPassable(voidWall.x + 1, y)).toBe(true);
        expect(map.terrain[at(voidWall.x + 1, y)]).not.toBe(TerrainType.VOID);
      }
    });

    it('never punches a door at a central-chamber corner, so all four interior corners stay solid wall (Fix 2 coverage)', () => {
      // Fix 2 (FOV corner reveal) needs a fully-enclosed room whose four
      // interior corner blocks are genuinely opaque wall — if a door ever
      // drifted onto a corner tile, that corner would no longer exercise the
      // seam-rejection bug the fix addresses.
      const { roomMinX, roomMaxX, roomMinY, roomMaxY, doors, playerTile } = TERRAIN_JUNCTION_SLICE;
      const corners: ReadonlyArray<readonly [number, number]> = [
        [roomMinX, roomMinY],
        [roomMaxX, roomMinY],
        [roomMinX, roomMaxY],
        [roomMaxX, roomMaxY],
      ];
      for (const [cx, cy] of corners) {
        expect(doors.some((d) => d.x === cx && d.y === cy)).toBe(false);
        expect(map.flags[at(cx, cy)]).toBe(TilePresets.WALL);
        expect(map.terrain[at(cx, cy)]).not.toBe(TerrainType.VOID);
      }
      // The player sits at the chamber centre, so the fully-enclosed corners
      // above are within default FOV radius and observable in the scene.
      expect(playerTile.x).toBeGreaterThan(roomMinX);
      expect(playerTile.x).toBeLessThan(roomMaxX);
      expect(playerTile.y).toBeGreaterThan(roomMinY);
      expect(playerTile.y).toBeLessThan(roomMaxY);
    });
  });
});
