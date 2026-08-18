/**
 * Set-Piece Lab ↔ real-game FIDELITY CONTRACT.
 *
 * The lab synthesizes its own single-room floor instead of running map
 * generation, so anything the real game decides during generation must be
 * mirrored here BY HAND. That hand-mirroring is exactly where a preview silently
 * stops matching what ships.
 *
 * It already happened, on two rules at once, while the lab's header claimed the
 * preview was "byte-faithful to the game": every visual review of `welcome-room`
 * was conducted against a room with the wrong wall art AND the opposite floor
 * temperature. A lab that renders something the game does not is worse than no
 * lab — it launders a wrong image as evidence, and "observe before done" is the
 * backstop that is supposed to catch precisely that.
 *
 * This module is deliberately Phaser-free so the rules can be unit-tested
 * (`tests/unit/set-piece-lab-fidelity.test.ts`) rather than only observed.
 */
import { TerrainType } from '../../shared/map-types.js';

/**
 * Interior terrain the REAL game ends up with, per set-piece id.
 *
 * `carveSetPieceRoom` paints a set-piece room's interior as STONE_FLOOR
 * (`carveSetPieceRoom.ts:316`, `floorTerrain ?? STONE_FLOOR`). For rooms the game
 * then tags SAFE, `tagRoomAsSafe` REPAINTS every STONE_FLOOR tile in the room's
 * bounds to SAFE_ROOM_FLOOR (`floorScenario.ts:1034-1040`).
 *
 * That is not a tint difference. STONE_FLOOR resolves to the cool blue-grey
 * `tile-stone-floor-var-0`; SAFE_ROOM_FLOOR resolves to the warm orange
 * `tile-safe-room-floor-var-0` (`tile-visuals.ts:244` / `:414`). Reviewing a
 * prop against the wrong one inverts every value and hue judgement made about it,
 * and any brief written from that review inherits the error.
 *
 * Add an entry whenever a set piece is carved into a room the game special-cases
 * (safe rooms, boss-stair rooms, cave settlements). The default is what an
 * ordinary carved dungeon room looks like.
 *
 * CAUTION: `SAFE_ROOM_FLOOR`'s own enum comment in `map-types.ts` says it is
 * "rendered with a calm blue tint". That comment is stale — it renders warm
 * orange. Trust `tile-visuals.ts`, not the enum.
 */
export const LAB_INTERIOR_TERRAIN: Readonly<Record<string, TerrainType>> = Object.freeze({
  'welcome-room': TerrainType.SAFE_ROOM_FLOOR,
});

/** Interior terrain for a set piece carved into an ordinary dungeon room. */
export const DEFAULT_LAB_INTERIOR_TERRAIN = TerrainType.STONE_FLOOR;

/** The terrain the lab must paint inside the room for `setPieceId`. */
export function labInteriorTerrainFor(setPieceId: string): TerrainType {
  return LAB_INTERIOR_TERRAIN[setPieceId] ?? DEFAULT_LAB_INTERIOR_TERRAIN;
}

/** Terrain the lab paints on the 1-tile border ring (matches a carved shell). */
export const LAB_BORDER_TERRAIN = TerrainType.STONE_WALL;
