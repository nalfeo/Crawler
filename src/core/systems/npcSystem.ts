import { query } from 'bitecs';
import { Npc, Player, Position } from '../components.js';
import type { GameWorld } from '../world.js';
import { NPC_INTERACT_RANGE_PX } from '../../shared/npc-types.js';

/**
 * NPC proximity system.
 * Scans all NPC entities each frame and updates the `nearbyPlayer` flag on their
 * NpcInstance sidecar based on whether the player is within NPC_INTERACT_RANGE_PX.
 */
export function npcSystem(world: GameWorld): void {
  const players = query(world.ecs, [Player, Position]);
  const player = players[0];

  const npcs = query(world.ecs, [Npc, Position]);

  if (player === undefined || npcs.length === 0) {
    // Clear proximity flags when no player is present
    for (const eid of npcs) {
      const instance = world.npcs.get(eid);
      if (instance) {
        instance.nearbyPlayer = false;
      }
    }
    return;
  }

  const px = world.stores.position.x[player] ?? 0;
  const py = world.stores.position.y[player] ?? 0;
  const rangeSq = NPC_INTERACT_RANGE_PX * NPC_INTERACT_RANGE_PX;

  for (const eid of npcs) {
    const instance = world.npcs.get(eid);
    if (!instance) {
      continue;
    }
    const nx = world.stores.position.x[eid] ?? 0;
    const ny = world.stores.position.y[eid] ?? 0;
    const dx = px - nx;
    const dy = py - ny;
    instance.nearbyPlayer = dx * dx + dy * dy <= rangeSq;
  }
}
