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
import { AttackWaveRat, Damage, Enemy, Player, Size, Sprite } from '../core/components.js';
import { setEnemyAppearanceKey } from '../core/spawners/combatants.js';
import { SHAPE_CIRCLE } from '../core/physics-defs.js';
import { addComponent, query, setComponent } from 'bitecs';
import { computeMultiSourceFlowField } from '../core/map/flow-field.js';
import { RoomRole } from '../shared/map-types.js';
import { GAME } from '../shared/constants.js';
import { pxToFt } from '../shared/units.js';
import { floor1Config } from '../shared/floor-config.js';
import { buildDoorAwarePassable, getDoorNavInfos } from '../core/door-navigation.js';

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

/** Snapshot current door navigation blockers for cache invalidation. */
function doorNavigationSnapshot(world: GameWorld): string {
  const infos = getDoorNavInfos(world);
  if (infos.length === 0) {
    return '';
  }
  return infos
    .map((info) => `${info.tileX},${info.tileY}:${info.navigationBlocked ? 1 : 0}`)
    .join('|');
}

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
    nextWaveAtMs: TUNING.attackWaves.intervalMs,
    aliveWaveRatCount: 0,
  });
  const navSnapshot = doorNavigationSnapshot(world);

  // Invalidate flow field cache if map changed or safe rooms cleared
  if (
    state.safeRoomDistanceFieldMap !== floorMap ||
    state.safeRoomDistanceFieldClearedMap !== world.clearedSafeRoomMap ||
    state.safeRoomDoorSnapshot !== navSnapshot ||
    (state.clearedSafeRoomIdsSnapshot !== undefined &&
      state.clearedSafeRoomIdsSnapshot !== Array.from(world.clearedSafeRoomIds).join(','))
  ) {
    state.safeRoomDistanceField = null;
    state.safeRoomDistanceFieldMap = null;
    state.safeRoomDistanceFieldClearedMap = null;
    state.clearedSafeRoomIdsSnapshot = undefined;
    state.safeRoomDoorSnapshot = undefined;
  }

  // Recompute field if not cached
  if (!state.safeRoomDistanceField || state.safeRoomDistanceField === null) {
    const safeRoomTiles: Array<{ x: number; y: number }> = [];
    const addRoomTiles = (room: {
      bounds: { x: number; y: number; width: number; height: number };
      interiorCells?: ReadonlyArray<{ x: number; y: number }>;
    }): void => {
      if (room.interiorCells && room.interiorCells.length > 0) {
        safeRoomTiles.push(...room.interiorCells);
        return;
      }
      for (let y = room.bounds.y; y < room.bounds.y + room.bounds.height; y += 1) {
        for (let x = room.bounds.x; x < room.bounds.x + room.bounds.width; x += 1) {
          safeRoomTiles.push({ x, y });
        }
      }
    };

    // Seed every traversable tile in each safe room so distance is to the room,
    // not to an arbitrary center tile.
    const safeRooms = floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE);
    for (const room of safeRooms) {
      addRoomTiles(room);
    }

    // Cleared room IDs are only meaningful for the map on which they were recorded.
    if (world.clearedSafeRoomMap === floorMap) {
      for (const clearedId of world.clearedSafeRoomIds) {
        const room = floorMap.roomGraph.get(clearedId);
        if (room) {
          addRoomTiles(room);
        }
      }
    }

    // If no safe rooms, cache an empty field (no suppression needed)
    if (safeRoomTiles.length === 0) {
      state.safeRoomDistanceField = new Int32Array(
        floorMap.tileMap.width * floorMap.tileMap.height,
      ).fill(-1);
      state.safeRoomDistanceFieldMap = floorMap;
      state.safeRoomDistanceFieldClearedMap = world.clearedSafeRoomMap;
      state.clearedSafeRoomIdsSnapshot = '';
      state.safeRoomDoorSnapshot = navSnapshot;
      return false;
    }

    const field = computeMultiSourceFlowField(floorMap, safeRoomTiles, {
      isTilePassable: buildDoorAwarePassable(world),
    });

    state.safeRoomDistanceField = field.distance;
    state.safeRoomDistanceFieldMap = floorMap;
    state.safeRoomDistanceFieldClearedMap = world.clearedSafeRoomMap;
    state.clearedSafeRoomIdsSnapshot = Array.from(world.clearedSafeRoomIds).join(',');
    state.safeRoomDoorSnapshot = navSnapshot;
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
  if (spawnRingRadiusFt < minRingRadiusFt) {
    throw new Error('attackWaves.spawnRingRadiusFt must cover the Floor 1 viewport diagonal');
  }

  // Randomized attempts preserve variety; the deterministic scan below ensures
  // a valid point is not lost merely because the ring crosses obstacles.
  for (let attempt = 0; attempt < 32; attempt++) {
    // Pick a random angle
    const angle = world.rng.next() * Math.PI * 2;

    // Keep every spawn at the configured off-screen radius.
    const distance = spawnRingRadiusFt;

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

  for (let ty = 0; ty < floorMap.tileMap.height; ty += 1) {
    for (let tx = 0; tx < floorMap.tileMap.width; tx += 1) {
      if (!floorMap.tileMap.isPassable(tx, ty)) {
        continue;
      }
      const spawnX = (tx + 0.5) * tileSizeFt;
      const spawnY = (ty + 0.5) * tileSizeFt;
      if (Math.hypot(spawnX - playerX, spawnY - playerY) >= spawnRingRadiusFt) {
        return { x: spawnX, y: spawnY };
      }
    }
  }

  throw new Error('attack wave could not find a traversable off-screen spawn tile');
}

/**
 * Prune dead/recycled entity ids from the tracked wave-rat set and return the
 * live count. `aliveWaveRatCount` on its own only ever incremented, so a
 * killed wave-rat would permanently and incorrectly count against the cap;
 * this keeps the cap check honest against entities that are still alive.
 */
function countLiveWaveRats(world: GameWorld): number {
  return query(world.ecs, [Enemy, AttackWaveRat]).length;
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
  const viewportWidthFt = pxToFt(GAME.WIDTH / floor1Config.camera.zoom);
  const viewportHeightFt = pxToFt(GAME.HEIGHT / floor1Config.camera.zoom);
  const minRingRadiusFt = computeMinSpawnRingRadiusFt(viewportWidthFt, viewportHeightFt);

  const state = (world.attackWaveState ??= {
    nextWaveAtMs: TUNING.attackWaves.intervalMs,
    aliveWaveRatCount: 0,
  });

  const packSize = TUNING.attackWaves.packSize;
  const maxAlive = TUNING.attackWaves.maxAliveFromWaves;

  let liveCount = countLiveWaveRats(world);
  state.aliveWaveRatCount = liveCount;

  // Check cap
  if (liveCount >= maxAlive) {
    return;
  }

  const ratTemplate = getRatTemplate();
  const spawnBudget = Math.min(packSize, maxAlive - liveCount);

  for (let i = 0; i < spawnBudget; i++) {
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
      setComponent(world.ecs, eid, Sprite, {
        textureId: ratTemplate.textureId,
        width: ratTemplate.spriteWidth,
        height: ratTemplate.spriteHeight,
      });
      setComponent(world.ecs, eid, Size, {
        radius: Math.max(ratTemplate.spriteWidth, ratTemplate.spriteHeight) * 0.5,
        halfWidth: 0,
        halfHeight: 0,
        shape: SHAPE_CIRCLE,
      });
      setEnemyAppearanceKey(world, eid, ratTemplate.id);
      if (ratTemplate.contactDamage > 0) {
        setComponent(world.ecs, eid, Damage, {
          amount: ratTemplate.contactDamage,
          cooldownMs: 0,
          lastFireMs: 0,
        });
      }
      liveCount++;
      state.aliveWaveRatCount = liveCount;

      // The ECS tag prevents recycled entity ids from being mistaken for rats.
      addComponent(world.ecs, eid, AttackWaveRat);
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
  if (world.floorId !== 'floor1') {
    return;
  }

  const state = (world.attackWaveState ??= {
    nextWaveAtMs: TUNING.attackWaves.intervalMs,
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
