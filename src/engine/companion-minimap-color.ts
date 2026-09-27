import { hasComponent } from 'bitecs';
import { Companion, Team } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { TeamId } from '../shared/constants.js';

/** Shared by the overlay and radar; family tints must never disguise a rival as an ally. */
export function companionMinimapColor(world: GameWorld, eid: number): number | null {
  if (!hasComponent(world.ecs, eid, Companion)) return null;
  return hasComponent(world.ecs, eid, Team) && world.stores.team.id[eid] === TeamId.PLAYER
    ? 0x4ade80
    : 0xef4444;
}
