import type { RoomBounds } from '../../shared/map-types.js';
import type { GameWorld } from '../../core/world.js';

export const FLOOR_SPAWNER_MAX_COUNT = 4;
const DEFAULT_FLOOR_TRASH_SPAWNER_ARCHETYPE_ID = 'rats-nest';
const SLIME_FLOOR_TRASH_SPAWNER_ARCHETYPE_ID = 'slime-pool';

export function toFloorTrashSpawnerArchetypeId(archetypeId: string | null | undefined): string {
  if (archetypeId?.includes('slime')) {
    return SLIME_FLOOR_TRASH_SPAWNER_ARCHETYPE_ID;
  }
  return DEFAULT_FLOOR_TRASH_SPAWNER_ARCHETYPE_ID;
}

export function resolvePassableRoomCenter(
  floorMap: NonNullable<GameWorld['floorMap']>,
  room: { bounds: RoomBounds },
): { x: number; y: number } {
  const centerX = Math.floor(room.bounds.x + room.bounds.width / 2);
  const centerY = Math.floor(room.bounds.y + room.bounds.height / 2);
  if (floorMap.tileMap.isPassable(centerX, centerY)) {
    return floorMap.tileToWorld(centerX, centerY);
  }

  const { x: bx, y: by, width: bw, height: bh } = room.bounds;
  const minX = bx + 1;
  const minY = by + 1;
  const maxX = bx + bw - 2;
  const maxY = by + bh - 2;
  const maxRadius = Math.max(bw, bh);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) {
          continue;
        }
        const tx = centerX + dx;
        const ty = centerY + dy;
        if (
          tx >= minX &&
          tx <= maxX &&
          ty >= minY &&
          ty <= maxY &&
          floorMap.tileMap.isPassable(tx, ty)
        ) {
          return floorMap.tileToWorld(tx, ty);
        }
      }
    }
  }
  return floorMap.tileToWorld(centerX, centerY);
}
