/**
 * Attack wave system: periodic rat pack spawning, feature-flagged and safe-room suppressed.
 *
 * On a recurring interval, a large pack of rats spawns off-screen and charges the player.
 * Waves are suppressed when the player is within a pathable-distance threshold of a safe room.
 *
 * This system is wired unconditionally but returns early (zero RNG draws, zero mutations)
 * when the flag is off, ensuring deterministic replay independence.
 */

import tuning from '../shared/data/tuning.json';
import type { GameWorld } from '../core/world.js';
import { spawnBehaviorEnemy } from '../core/spawners/combatants.js';
import { getRatTemplate } from './spawners/template-accessor.js';
import { AI_TYPE } from './enemyAISystem.js';
import { PATH_PERSONA, TRAVERSAL_MODE } from '../shared/enemy-behavior.js';
import { Player } from '../core/components.js';
import { query } from 'bitecs';
import { computeFlowField } from '../core/map/flow-field.js';
import { RoomRole } from '../shared/map-types.js';

// Type assertion for tuning (schema loaded at build time)
type TuningSchema = typeof tuning & {
  attackWaves: {
    intervalMs: number;
    packSize: number;
    spawnRingRadiusFt: number;
    safeRoomSuppressionTiles: number;
    maxAliveFromWaves: number;
  };
};
const TUNING = tuning as TuningSchema;

const SPAWNER_CHILD_CHASE_DELAY_MIN_MS = 250;
const SPAWNER_CHILD_CHASE_DELAY_MAX_MS = 500;

/** Compute off-screen spawn radius from viewport. */
function computeMinSpawnRingRadiusFt(viewportWidthFt: number, viewportHeightFt: number): number {
  return Math.hypot(viewportWidthFt / 2, viewportHeightFt / 2);
}

/** Get the player's current position, or null if player doesn't exist. */
function getPlayerPosition(world: GameWorld): { x: number; y: number; eid: number } | null {
  const players = query(world.ecs, [Player]);
  for (const eid of players) {
    const x = world.stores.position.x[eid];
    const y = world.stores.position.y[eid];
    if (x !== undefined && y !== undefined) {
      return { x, y, eid };
    }
  }
  return null;
}

/** Check if safe-room distance suppression applies to the player. */
function isPlayerInSafeRoomSuppression(world: GameWorld): boolean {
  if (world.playerInSafeRoom) {
    return true;
  }

  const floorMap = world.floorMap;
  if (!floorMap) {
    return false;
  }

  const playerPos = getPlayerPosition(world);
  if (!playerPos) {
    return false;
  }

  const state = (world.attackWaveState ??= {
    nextWaveAtMs: world.elapsedMs + TUNING.attackWaves.intervalMs,
    aliveWaveRatCount: 0,
  });

  // Invalidate flow field cache if map changed or safe rooms cleared
  if (
    state.safeRoomDistanceFieldMap !== floorMap ||
    (state.safeRoomDistanceField !== undefined &&
      state.safeRoomDistanceField !== null &&
      state.clearedSafeRoomIdsSnapshot &&
      state.clearedSafeRoomIdsSnapshot !== Array.from(world.clearedSafeRoomIds).join(','))
  ) {
    state.safeRoomDistanceField = null;
    state.safeRoomDistanceFieldMap = null;
    state.clearedSafeRoomIdsSnapshot = undefined;
  }

  // Recompute field if not cached
  if (!state.safeRoomDistanceField || state.safeRoomDistanceField === null) {
    const safeRoomTiles: Array<{ x: number; y: number }> = [];

    // Collect all safe room tiles (use room center as anchor)
    const safeRooms = floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE);
    for (const room of safeRooms) {
      const centerX = Math.floor(room.bounds.x + room.bounds.width / 2);
      const centerY = Math.floor(room.bounds.y + room.bounds.height / 2);
      safeRoomTiles.push({ x: centerX, y: centerY });
    }

    // Also include cleared safe rooms
    for (const clearedId of world.clearedSafeRoomIds) {
      const room = floorMap.roomGraph.get(clearedId);
      if (room) {
        const centerX = Math.floor(room.bounds.x + room.bounds.width / 2);
        const centerY = Math.floor(room.bounds.y + room.bounds.height / 2);
        safeRoomTiles.push({ x: centerX, y: centerY });
      }
    }

    // If no safe rooms, cache an empty field (no suppression needed)
    if (safeRoomTiles.length === 0) {
      state.safeRoomDistanceField = null;
      state.safeRoomDistanceFieldMap = floorMap;
      state.clearedSafeRoomIdsSnapshot = '';
      return false;
    }

    // Compute multi-source BFS: use first safe room as goal for flow field
    const firstSafeRoom = safeRoomTiles[0]!;
    const field = computeFlowField(floorMap, firstSafeRoom);

    state.safeRoomDistanceField = field.distance;
    state.safeRoomDistanceFieldMap = floorMap;
    state.clearedSafeRoomIdsSnapshot = Array.from(world.clearedSafeRoomIds).join(',');
  }

  // Read distance at player tile
  if (!state.safeRoomDistanceField || state.safeRoomDistanceField === null) {
    return false;
  }

  const tileSizeFt = floorMap.config.tileSizeFt;
  const playerTx = Math.floor(playerPos.x / tileSizeFt);
  const playerTy = Math.floor(playerPos.y / tileSizeFt);

  if (
    playerTx < 0 ||
    playerTx >= floorMap.tileMap.width ||
    playerTy < 0 ||
    playerTy >= floorMap.tileMap.height
  ) {
    return false;
  }

  const distanceIndex = playerTy * floorMap.tileMap.width + playerTx;
  const distance = state.safeRoomDistanceField[distanceIndex] ?? -1;

  return distance >= 0 && distance <= TUNING.attackWaves.safeRoomSuppressionTiles;
}

/** Try to find an off-screen spawn position for a single rat. */
function resolveWaveSpawnPoint(
  world: GameWorld,
  playerX: number,
  playerY: number,
  minRingRadiusFt: number,
): { x: number; y: number } | null {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }

  const spawnRingRadiusFt = TUNING.attackWaves.spawnRingRadiusFt;
  const tileSizeFt = floorMap.config.tileSizeFt;

  // Try up to 5 attempts to find a valid spawn point on the ring
  for (let attempt = 0; attempt < 5; attempt++) {
    // Pick a random angle
    const angle = world.rng.next() * Math.PI * 2;

    // Pick a random distance within the ring (at least minRingRadiusFt)
    const distance = minRingRadiusFt + world.rng.next() * (spawnRingRadiusFt - minRingRadiusFt);

    const spawnX = playerX + Math.cos(angle) * distance;
    const spawnY = playerY + Math.sin(angle) * distance;

    // Check if traversable
    const tx = Math.floor(spawnX / tileSizeFt);
    const ty = Math.floor(spawnY / tileSizeFt);

    if (
      tx >= 0 &&
      tx < floorMap.tileMap.width &&
      ty >= 0 &&
      ty < floorMap.tileMap.height &&
      floorMap.tileMap.isPassable(tx, ty)
    ) {
      return { x: spawnX, y: spawnY };
    }
  }

  return null;
}

/** Spawn a pack of rats for the attack wave. */
function spawnWavePack(world: GameWorld): void {
  const playerPos = getPlayerPosition(world);
  if (!playerPos) {
    return;
  }

  const floorMap = world.floorMap;
  if (!floorMap) {
    return;
  }

  // Compute minimum off-screen radius (half viewport diagonal)
  const viewportWidthFt = 16; // Standard viewport width (GAME.WIDTH = 800px, FLOOR_1_CAMERA_ZOOM = 2.5, so 800 / 2.5 / 50 = 6.4ft, use 16 as reasonable estimate)
  const viewportHeightFt = 12; // Standard viewport height (GAME.HEIGHT = 600px, 600 / 2.5 / 50 = 4.8ft, use 12 as reasonable estimate)
  const minRingRadiusFt = computeMinSpawnRingRadiusFt(viewportWidthFt, viewportHeightFt);

  const state = (world.attackWaveState ??= {
    nextWaveAtMs: world.elapsedMs + TUNING.attackWaves.intervalMs,
    aliveWaveRatCount: 0,
  });

  const packSize = TUNING.attackWaves.packSize;
  const maxAlive = TUNING.attackWaves.maxAliveFromWaves;

  // Check cap
  if (state.aliveWaveRatCount >= maxAlive) {
    return;
  }

  const ratTemplate = getRatTemplate();

  for (let i = 0; i < packSize; i++) {
    const spawnPoint = resolveWaveSpawnPoint(world, playerPos.x, playerPos.y, minRingRadiusFt);
    if (!spawnPoint) {
      continue;
    }

    const aggroDelayMs =
      SPAWNER_CHILD_CHASE_DELAY_MIN_MS +
      world.rng.next() * (SPAWNER_CHILD_CHASE_DELAY_MAX_MS - SPAWNER_CHILD_CHASE_DELAY_MIN_MS);

    const eid = spawnBehaviorEnemy(
      world,
      spawnPoint.x,
      spawnPoint.y,
      ratTemplate.hp,
      AI_TYPE.CHASE,
      ratTemplate.speed,
      0, // aggroRange: 0 = always aggro
      ratTemplate.attackRange,
      {
        persona: PATH_PERSONA.NAVIGATOR,
        traversalMode: TRAVERSAL_MODE.GROUND,
        aggroEnableAtMs: world.elapsedMs + aggroDelayMs,
        weight: ratTemplate.weight,
        bloodColor: ratTemplate.bloodColor,
      },
    );

    if (eid) {
      state.aliveWaveRatCount++;

      // Tag the rat as spawned by attack waves so we can track it
      if (!world.attackWaveSpawnedRats) {
        world.attackWaveSpawnedRats = new Set<number>();
      }
      world.attackWaveSpawnedRats.add(eid);
    }
  }
}

/**
 * System entry point. Checks flag, timer, and suppression; spawns pack if conditions met.
 */
export function attackWaveSystem(world: GameWorld): void {
  // Early return when flag is off: zero RNG draws, zero mutations
  if (!world.attackWaveFlags.attackWaves) {
    return;
  }

  const state = (world.attackWaveState ??= {
    nextWaveAtMs: world.elapsedMs + TUNING.attackWaves.intervalMs,
    aliveWaveRatCount: 0,
  });

  // Check if it's time to spawn a wave
  if (world.elapsedMs < state.nextWaveAtMs) {
    return;
  }

  // Check safe-room suppression
  if (isPlayerInSafeRoomSuppression(world)) {
    return;
  }

  // Spawn the wave
  spawnWavePack(world);

  // Schedule next wave
  state.nextWaveAtMs = world.elapsedMs + TUNING.attackWaves.intervalMs;
}
