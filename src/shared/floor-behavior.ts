/**
 * Floor behavior flags — the config half of "generic systems, floor-specific
 * config".
 *
 * Systems that used to branch on a hardcoded floor number or floor id
 * (`world.floor === 1`, `world.floorId === 'floor2'`) instead ask the floor
 * which behavior it wants. Adding a floor is then a manifest edit, not a set of
 * scattered code edits, and each flag documents the behavior it controls.
 *
 * Every flag defaults to `false`: a new floor opts in explicitly rather than
 * silently inheriting Floor 1 or Floor 2 semantics.
 */
import { z } from 'zod';

export const floorBehaviorSchema = z
  .object({
    /**
     * Treat the floor's spawn room as a safe space in addition to any room
     * explicitly tagged `RoomRole.SAFE`. Floor 2's settlement entrance doubles
     * as its safe room.
     */
    spawnRoomIsSafe: z.boolean().default(false),
    /**
     * Suppress player-owned melee/area/beam damage while the player stands in a
     * safe space, so a stray swing inside the safe room cannot hit anything.
     */
    safeRoomWeaponImmunity: z.boolean().default(false),
    /**
     * Force the safe room's doors closed while the player is inside it (and not
     * transitioning through a doorway), keeping the safe room sealed.
     */
    safeRoomDoorsAutoClose: z.boolean().default(false),
    /**
     * Allow enemies to acquire the player through a direct line of sight even
     * when no room/door adjacency test passes. Needed by open cave geometry
     * where a shared sightline does not imply a shared room id.
     */
    lineOfSightAggro: z.boolean().default(false),
    /**
     * Enable the generated-equipment economy (Quartermaster stock, purchases,
     * achievement reward bundles) on this floor.
     */
    equipmentEconomy: z.boolean().default(false),
    /** Enable boss-defeat reward chests on this floor. */
    bossChests: z.boolean().default(false),
  })
  .strict();

/** Per-floor behavior switches consumed by otherwise floor-agnostic systems. */
export type FloorBehavior = z.infer<typeof floorBehaviorSchema>;

/** All-off behavior, used when a floor has no manifest (e.g. synthetic worlds). */
export const DEFAULT_FLOOR_BEHAVIOR: FloorBehavior = floorBehaviorSchema.parse({});
