import type { GameWorld } from '../core/world.js';

/**
 * Marks a hostile lock-in as active. Input providers observe the revision at
 * their next deterministic poll boundary and rebuild transient decisions
 * against the newly spawned threats.
 */
export function activateHostileEncounter(world: GameWorld): number {
  world.hostileEncounterRevision += 1;
  return world.hostileEncounterRevision;
}
