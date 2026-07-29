import { query } from 'bitecs';
import { Npc, Player, Position } from '../components.js';
import type { GameWorld } from '../world.js';
import { NPC_INTERACT_RANGE_FT } from '../../shared/npc-types.js';

/**
 * NPC proximity system.
 * Scans all NPC entities each frame and updates the `nearbyPlayer` flag on their
 * NpcInstance sidecar based on whether the player is within NPC_INTERACT_RANGE_FT
 * AND has unobstructed line of sight to the NPC.
 *
 * The LOS test matters because NPC_INTERACT_RANGE_FT (10 ft) is wider than a
 * tile (4 ft), so a pure radius check lets the player talk to an NPC through a
 * solid wall from the adjacent room. This mirrors what `meleeSwingSystem` already
 * does so weapons never swing through walls.
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
  const rangeSq = NPC_INTERACT_RANGE_FT * NPC_INTERACT_RANGE_FT;
  const floorMap = world.floorMap;

  for (const eid of npcs) {
    const instance = world.npcs.get(eid);
    if (!instance) {
      continue;
    }
    const nx = world.stores.position.x[eid] ?? 0;
    const ny = world.stores.position.y[eid] ?? 0;
    const dx = px - nx;
    const dy = py - ny;
    const inRange = dx * dx + dy * dy <= rangeSq;
    instance.nearbyPlayer = inRange && (!floorMap || floorMap.hasLineOfSight(px, py, nx, ny));
  }
}
