/**
 * NPC Placement Schema — config-driven NPC spawn system.
 *
 * This module defines NPC placement configurations for floors,
 * enabling data-driven NPC spawning instead of hardcoded logic.
 */
import { z } from 'zod';

/**
 * NPC placement definition for a specific NPC instance.
 */
export const npcPlacementDefSchema = z
  .object({
    /** Unique identifier for this NPC placement. */
    id: z.string().min(1),
    /** NPC type ID (e.g., "tutorial-goon", "shopkeeper", "spell-giver"). */
    npcTypeId: z.string().min(1),
    /** Display name for this NPC. */
    name: z.string().min(1),
    /** Room role to spawn in (e.g., "spawn", "safe", "shop"). */
    roomRole: z.enum(['spawn', 'safe', 'shop', 'boss_stair', 'any']).optional(),
    /** Exact position override (if not using room-based placement). */
    position: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .optional(),
    /** Quest ID this NPC is associated with (if any). */
    questId: z.string().min(1).optional(),
    /** Whether this NPC is a quest giver. */
    isQuestGiver: z.boolean().default(false),
    /** Whether this NPC is a merchant. */
    isMerchant: z.boolean().default(false),
  })
  .strict();

export type NpcPlacementDef = z.infer<typeof npcPlacementDefSchema>;

/**
 * Collection of NPC placements for a floor.
 */
export const npcPlacementCollectionSchema = z
  .object({
    /** Floor ID this collection belongs to. */
    floorId: z.string().min(1),
    /** NPC placements for this floor. */
    npcs: z.array(npcPlacementDefSchema),
  })
  .strict();

export type NpcPlacementCollection = z.infer<typeof npcPlacementCollectionSchema>;
