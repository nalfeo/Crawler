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
     * Master switch for the generated-equipment dependency closure on this floor.
     * Consumers may add narrower behavior gates (for example settlement shops or
     * reward bundles), but generated equipment remains unavailable unless this is
     * enabled.
     */
    equipmentEconomy: z.boolean().default(false),
    /**
     * Render the persistent carried main-hand weapon sprite while the player is
     * idle. When false, weapons only render through attack-time effects.
     */
    carriedMainHandWeapon: z.boolean().default(false),
    /** Enable boss-defeat reward chests on this floor. */
    bossChests: z.boolean().default(false),
    /**
     * Gate the Gear panel reveal and the `equipment` feature unlock behind the
     * merchant charm (`SHOPKEEPER_EQUIPMENT_ITEM_ID`). When configured, the
     * feature unlock gate starts once this prerequisite quest exists in the quest
     * log, so unrelated equippable loot (e.g. boss chest drops) cannot unlock Gear
     * early. `null` disables the gate.
     */
    merchantCharmGatesEquipment: z
      .object({
        prerequisiteQuestId: z.string().min(1),
      })
      .nullable()
      .default(null),
    /**
     * Enable the Quartermaster/settlement generated-equipment economy (stock
     * generation, purchasing) and achievement equipment reward bundles on this
     * floor. This is a narrower gate layered on top of the `equipmentEconomy`
     * master switch and may stay disabled on floors (e.g. Floor 1) that want
     * boss-chest equipment rewards without a Quartermaster shop or reward-bundle
     * system.
     */
    settlementEquipmentEconomy: z.boolean().default(false),
  })
  .strict();

/** Per-floor behavior switches consumed by otherwise floor-agnostic systems. */
export type FloorBehavior = z.infer<typeof floorBehaviorSchema>;

/** All-off behavior, used when a floor has no manifest (e.g. synthetic worlds). */
export const DEFAULT_FLOOR_BEHAVIOR: FloorBehavior = floorBehaviorSchema.parse({});
