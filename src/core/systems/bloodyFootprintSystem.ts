import { query } from 'bitecs';
import { Player, Position } from '../components.js';
import type { GameWorld } from '../world.js';
import {
  BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
  BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS,
  MAX_BLOODY_FOOTPRINTS,
  MAX_BLOODY_FOOTPRINT_EMITS_PER_FRAME,
  createBloodFootprintSurface,
  isBloodyFootprintSourceActive,
  isPointInsideBloodPool,
  mixBloodColors,
} from '../../shared/blood-surfaces.js';

const MAX_CONTINUOUS_FOOTPRINT_GAP_FT =
  MAX_BLOODY_FOOTPRINT_EMITS_PER_FRAME * BLOODY_FOOTPRINT_EMIT_DISTANCE_FT;

function pruneExpiredInPlace<T extends { expiresAtMs: number }>(items: T[], nowMs: number): void {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < items.length; readIndex += 1) {
    const item = items[readIndex]!;
    if (item.expiresAtMs <= nowMs) {
      continue;
    }
    if (writeIndex !== readIndex) {
      items[writeIndex] = item;
    }
    writeIndex += 1;
  }
  items.length = writeIndex;
}

function refreshSource(
  world: GameWorld,
  color: number,
  playerX: number,
  playerY: number,
  shouldMix: boolean,
): void {
  const state = world.bloodyFootprintState;
  const nowMs = world.elapsedMs;
  const source = state.source;
  if (isBloodyFootprintSourceActive(source, nowMs)) {
    source.color = shouldMix ? mixBloodColors(source.color, color) : color;
    source.expiresAtMs = nowMs + BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS;
    source.lastEmitX ??= playerX;
    source.lastEmitY ??= playerY;
    return;
  }
  state.source = {
    color,
    expiresAtMs: nowMs + BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS,
    lastEmitX: playerX,
    lastEmitY: playerY,
  };
}

export function bloodyFootprintSystem(world: GameWorld): void {
  const nowMs = world.elapsedMs;
  pruneExpiredInPlace(world.bloodPools, nowMs);
  pruneExpiredInPlace(world.bloodyFootprints, nowMs);

  const state = world.bloodyFootprintState;
  if (!isBloodyFootprintSourceActive(state.source, nowMs)) {
    state.source = null;
  }

  const players = query(world.ecs, [Player, Position]);
  if (players.length === 0) {
    state.overlappingPoolIds.clear();
    if (state.source) {
      state.source.lastEmitX = null;
      state.source.lastEmitY = null;
    }
    return;
  }

  const playerEid = players[0]!;
  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const previousOverlaps = state.overlappingPoolIds;
  const nextOverlaps = state.nextOverlappingPoolIds;
  nextOverlaps.clear();
  let touchedPool = false;

  for (const pool of world.bloodPools) {
    const dx = playerX - (pool.x + pool.renderOffsetXFt);
    const dy = playerY - (pool.y + pool.renderOffsetYFt);
    if (dx * dx + dy * dy > pool.contactRadiusFt * pool.contactRadiusFt) {
      continue;
    }
    if (!isPointInsideBloodPool(pool, playerX, playerY, nowMs)) {
      continue;
    }
    touchedPool = true;
    nextOverlaps.add(pool.id);
    if (!previousOverlaps.has(pool.id)) {
      const shouldMix =
        isBloodyFootprintSourceActive(state.source, nowMs) && state.source.color !== pool.color;
      refreshSource(world, pool.color, playerX, playerY, shouldMix);
    }
  }

  if (touchedPool && isBloodyFootprintSourceActive(state.source, nowMs)) {
    state.source.expiresAtMs = nowMs + BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS;
  }
  state.overlappingPoolIds = nextOverlaps;
  previousOverlaps.clear();
  state.nextOverlappingPoolIds = previousOverlaps;

  const source = state.source;
  if (!isBloodyFootprintSourceActive(source, nowMs)) {
    return;
  }

  if (source.lastEmitX === null || source.lastEmitY === null) {
    source.lastEmitX = playerX;
    source.lastEmitY = playerY;
    return;
  }

  let fromX = source.lastEmitX;
  let fromY = source.lastEmitY;
  const dx = playerX - fromX;
  const dy = playerY - fromY;
  const distanceFt = Math.hypot(dx, dy);
  if (distanceFt > MAX_CONTINUOUS_FOOTPRINT_GAP_FT) {
    source.lastEmitX = playerX;
    source.lastEmitY = playerY;
    return;
  }
  if (distanceFt < BLOODY_FOOTPRINT_EMIT_DISTANCE_FT) {
    return;
  }

  const dirX = dx / distanceFt;
  const dirY = dy / distanceFt;
  const emitCount = Math.min(
    MAX_BLOODY_FOOTPRINT_EMITS_PER_FRAME,
    Math.floor(distanceFt / BLOODY_FOOTPRINT_EMIT_DISTANCE_FT),
  );
  for (let i = 0; i < emitCount; i += 1) {
    const toX = fromX + dirX * BLOODY_FOOTPRINT_EMIT_DISTANCE_FT;
    const toY = fromY + dirY * BLOODY_FOOTPRINT_EMIT_DISTANCE_FT;
    world.bloodyFootprints.push(
      createBloodFootprintSurface({
        worldSeed: world.seed,
        footprintId: state.nextFootprintId++,
        stampId: state.nextStampId++,
        color: source.color,
        fromX,
        fromY,
        toX,
        toY,
        createdAtMs: nowMs,
        strideDistanceFt: distanceFt,
      }),
    );
    fromX = toX;
    fromY = toY;
  }

  if (world.bloodyFootprints.length > MAX_BLOODY_FOOTPRINTS) {
    world.bloodyFootprints.splice(0, world.bloodyFootprints.length - MAX_BLOODY_FOOTPRINTS);
  }
  source.lastEmitX = fromX;
  source.lastEmitY = fromY;
}
