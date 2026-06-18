/**
 * Floor 1 NPC Placements — validated NPC spawn configuration.
 *
 * Provides the NPC placements for Floor 1, loaded from npcs.floor1.json
 * and validated against the npc-placements schema.
 */
import { npcPlacementCollectionSchema, type NpcPlacementCollection } from './npc-placements.js';
import floor1NpcPlacementsJson from './data/npcs.floor1.json';

/**
 * Load and validate Floor 1 NPC placements.
 */
function loadFloor1NpcPlacements(): NpcPlacementCollection {
  const parsed = npcPlacementCollectionSchema.parse(floor1NpcPlacementsJson);
  return parsed;
}

/**
 * Validated Floor 1 NPC placements, loaded at module initialization.
 */
export const floor1NpcPlacements: NpcPlacementCollection = loadFloor1NpcPlacements();
