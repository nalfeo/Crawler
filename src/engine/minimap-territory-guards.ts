import type { FloorMap } from '../core/map/FloorMap.js';
import type { GameWorld } from '../core/world.js';
import { RoomRole, type RoomData } from '../shared/map-types.js';

export function shouldUseFamilyRoomTint(
  room: Pick<RoomData, 'role'>,
  world: Pick<GameWorld, 'floorExtendedState'>,
): boolean {
  if (world.floorExtendedState?.familyState != null) return true;
  // These roles have familyTintForRoom fallback colors even without live Floor-2 family state.
  return (
    room.role === RoomRole.TERRITORY ||
    room.role === RoomRole.BOSS_DEN ||
    room.role === RoomRole.SETTLEMENT ||
    room.role === RoomRole.RESOURCE_HEART
  );
}

export function shouldDrawTerritoryOverlayBands(
  floorMap: Pick<FloorMap, 'territoryZones'>,
): boolean {
  return floorMap.territoryZones.length > 0;
}
