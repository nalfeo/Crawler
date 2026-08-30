import { query } from 'bitecs';
import { Companion, Position, Team } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { RoomRole } from '../shared/map-types.js';

export type Floor3OverworldMarkerKind =
  | 'biome'
  | 'trainer'
  | 'studio'
  | 'final-four-gate'
  | 'rally-point';

export interface Floor3OverworldMarker {
  readonly id: string;
  readonly kind: Floor3OverworldMarkerKind;
  readonly label: string;
  readonly xFt: number;
  readonly yFt: number;
  readonly state: 'available' | 'locked' | 'cleared';
}

/** Read-only semantic marker projection for Floor 3's existing minimap layers. */
export function resolveFloor3OverworldMarkers(
  world: GameWorld,
): readonly Floor3OverworldMarker[] {
  if (world.floorId !== 'floor3' || !world.floorMap) return [];
  const floorMap = world.floorMap;
  const state = world.floorExtendedState?.floor3Studios;
  if (!state) return [];
  const roomCenter = (roomId: number): { xFt: number; yFt: number } | null => {
    const room = floorMap.roomGraph.get(roomId);
    if (!room) return null;
    const x = room.bounds.x + Math.floor(room.bounds.width / 2);
    const y = room.bounds.y + Math.floor(room.bounds.height / 2);
    const center = floorMap.tileToWorld(x, y);
    return { xFt: center.x, yFt: center.y };
  };
  const markers: Floor3OverworldMarker[] = [];

  for (const room of floorMap.rooms) {
    const center = roomCenter(room.id);
    if (!center) continue;
    if (room.role === RoomRole.TERRITORY) {
      const affinity =
        world.floorExtendedState?.floor3BiomeAffinities?.[room.familyIndex ?? -1] ?? 'wild';
      markers.push({
        id: `biome:${room.id}`,
        kind: 'biome',
        label: `${affinity} biome`,
        ...center,
        state: 'available',
      });
    } else if (room.role === RoomRole.SAFE) {
      markers.push({
        id: `rally:${room.id}`,
        kind: 'rally-point',
        label: 'Rally Point',
        ...center,
        state: 'available',
      });
    }
  }
  for (const studio of state.studios) {
    const center = roomCenter(studio.roomId);
    if (!center) continue;
    markers.push({
      id: `studio:${studio.id}`,
      kind: 'studio',
      label: studio.name,
      ...center,
      state: studio.defeated ? 'cleared' : studio.unlocked ? 'available' : 'locked',
    });
  }
  const gateCenter = roomCenter(state.finalFour.roomId);
  if (gateCenter) {
    markers.push({
      id: 'final-four-gate',
      kind: 'final-four-gate',
      label: 'Final Four Gate',
      ...gateCenter,
      state: state.finalFour.defeated
        ? 'cleared'
        : state.finalFour.unlocked
          ? 'available'
          : 'locked',
    });
  }

  const rivalTeamIds = new Set([
    ...state.studios.flatMap((studio) => studio.teamIds),
    ...state.finalFour.teamIds,
  ]);
  const seenTeams = new Set<number>();
  for (const eid of query(world.ecs, [Companion, Position, Team])) {
    const teamId = world.stores.team.id[eid] ?? -1;
    if (!rivalTeamIds.has(teamId) || seenTeams.has(teamId)) continue;
    seenTeams.add(teamId);
    markers.push({
      id: `trainer:${teamId}`,
      kind: 'trainer',
      label: 'Trainer roster',
      xFt: world.stores.position.x[eid] ?? 0,
      yFt: world.stores.position.y[eid] ?? 0,
      state: 'available',
    });
  }
  return markers;
}
