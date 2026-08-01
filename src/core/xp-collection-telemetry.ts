import { query } from 'bitecs';
import { XpGem } from './components.js';
import type { GameWorld } from './world.js';

export interface XpCollectionEpoch {
  floorId: string;
  floorStartPlayerXp: number;
  spawned: number;
  collected: number;
}

export interface XpCollectionFloorSummary extends XpCollectionEpoch {
  remaining: number;
  efficiency: number;
}

export interface XpCollectionSummary {
  floors: XpCollectionFloorSummary[];
}

export interface XpCollectionTelemetry {
  current: XpCollectionEpoch;
  completed: XpCollectionFloorSummary[];
}

function summarizeEpoch(epoch: XpCollectionEpoch, remaining: number): XpCollectionFloorSummary {
  return {
    ...epoch,
    remaining,
    efficiency: epoch.spawned > 0 ? epoch.collected / epoch.spawned : 0,
  };
}

export function createXpCollectionTelemetry(
  floorId: string,
  floorStartPlayerXp: number,
): XpCollectionTelemetry {
  return {
    current: {
      floorId,
      floorStartPlayerXp,
      spawned: 0,
      collected: 0,
    },
    completed: [],
  };
}

function synchronizeFloorEpoch(world: GameWorld): XpCollectionTelemetry | undefined {
  const telemetry = world.xpCollectionTelemetry;
  if (!telemetry || telemetry.current.floorId === world.floorId) return telemetry;

  telemetry.completed.push(
    summarizeEpoch(
      telemetry.current,
      Math.max(0, telemetry.current.spawned - telemetry.current.collected),
    ),
  );
  telemetry.current = {
    floorId: world.floorId,
    floorStartPlayerXp: world.playerLevel.xp,
    spawned: 0,
    collected: 0,
  };
  return telemetry;
}

export function recordSpawnedXp(world: GameWorld, value: number): void {
  if (!(value > 0)) return;
  const telemetry = synchronizeFloorEpoch(world);
  if (telemetry) telemetry.current.spawned += value;
}

export function recordCollectedXp(world: GameWorld, value: number): void {
  if (!(value > 0)) return;
  const telemetry = synchronizeFloorEpoch(world);
  if (telemetry) telemetry.current.collected += value;
}

export function summarizeXpCollection(world: GameWorld): XpCollectionSummary | undefined {
  const telemetry = synchronizeFloorEpoch(world);
  if (!telemetry) return undefined;

  let remaining = 0;
  for (const eid of query(world.ecs, [XpGem])) {
    remaining += world.stores.xpGem.value[eid] ?? 0;
  }

  return {
    floors: [...telemetry.completed, summarizeEpoch(telemetry.current, remaining)],
  };
}
