/**
 * Spawner Battle Arena System — per-tick state machine that cages the player
 * in with a spawner and grants a banked XP reward on kill.
 *
 * Runs IMMEDIATELY BEFORE {@link spawnerSystem} in both pipelines (visual
 * `preSystems` array + headless `simulation-step`). Placement rationale:
 *   - The Floor-1 preSystems contract test asserts
 *     `spawnerSystem` is *immediately adjacent* to `floor1EnemyDirectorSystem`
 *     (`tests/game/floor1-main-scene-options.test.ts`). Anything inserted
 *     between them breaks the invariant, so we run before them instead.
 *   - Running before the spawner system means barrier tiles raised this tick
 *     are already visible to `spawnerSystem` when it computes child spawn
 *     positions — no half-frame windows where a child spawns onto a
 *     just-raised barrier.
 *
 * Per spawner entity we track a 3-value state machine (`spawner.arenaState`):
 *   0 = idle          → check trigger predicate each tick
 *   1 = locked        → arena active; wait for `deathResolved === 1`
 *   2 = resolved      → terminal; XP granted, geometry restored
 *
 * On the transition idle → locked, we:
 *   - Emit a `spawnerArenaStart` VFX event (radial burst, archetype-tinted).
 *   - Push a HUD announcement carrying the display name.
 *   - Raise dynamic barriers (`src/core/barriers/`) to physically cage the
 *     player. Sealed rooms ALSO lock their doors via `setDoorLockConfig` — the
 *     door lock and the doorway barrier are belt-and-suspenders redundant so
 *     an unlock-predicate bug can never let the player escape.
 *
 * On the transition locked → resolved, we:
 *   - Drop the barriers so movement + projectiles flow freely again.
 *   - Set the goal flag (so `doorSystem` unlocks the cached doors on its
 *     next tick) for the sealed-room path.
 *   - Emit a `spawnerArenaEnd` VFX event + a matching HUD announcement.
 *   - Grant the accumulated `bankedXp` as a single XP gem at the spawner's
 *     death position — the sole XP payout for spawner-owned enemies.
 *
 * All randomness reaches the tick through `world.rng` and `world.elapsedMs`;
 * this system introduces no additional sources — replays with the same seed
 * produce byte-identical arena events + banked totals.
 *
 * @see docs/knowledge/adr/0046-dynamic-barrier-primitive.md for why the
 * pre-PR-#767 `TileMap.flags` snapshot approach was replaced.
 */
import { query } from 'bitecs';
import { DoorState, Player, Position, Health, Spawner } from '../../core/components.js';
import {
  clearDoorLockConfig,
  getDoorLockConfig,
  setDoorLockConfig,
  setGoalFlag,
} from '../../core/door-lock.js';
import { spawnXpGem } from '../../core/helpers.js';
import { SPAWNER_ARENA_KIND_UNRESOLVED } from '../../core/spawners/combatants.js';
import type { GameWorld } from '../../core/world.js';
import {
  createRingBarrier,
  createRoomBarrier,
  dropBarrier,
  type BarrierHandle,
} from '../../core/barriers/index.js';
import { decideArenaKind, isArenaTriggered } from '../../core/spawner-arena.js';
import { createLogger } from '../../shared/logger.js';
import { pushAnnouncement } from '../../shared/announcement-events.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';
import { getSpawnerArchetypeByIndex } from './registry.js';

const logger = createLogger('game:spawner-arena');

/**
 * Local alias for the canonical `spawner.arenaKind` "not yet resolved"
 * sentinel. Bound to `SPAWNER_ARENA_KIND_UNRESOLVED` (its single source of
 * truth in `src/core/spawners/combatants.ts`) rather than re-hard-coding the
 * numeric value, so the sentinel can never drift out of sync with core.
 */
const ARENA_KIND_UNRESOLVED = SPAWNER_ARENA_KIND_UNRESOLVED;

/** Numeric enum for `arenaState` — mirrors the SoA docstring. */
const ARENA_STATE = { IDLE: 0, LOCKED: 1, RESOLVED: 2 } as const;

/** VFX + announcement colour hint (green pulse tint, matches spawnerPulse). */
const ARENA_VFX_COLOR = 0x9be15d;
/** Intensity for the start burst — spec `Requirements§8` calls out ≥ 1.5. */
const START_INTENSITY = 1.75;
/** Intensity for the end flash — a touch quieter but still noticeable. */
const END_INTENSITY = 1.25;
/** Banner-on-screen duration for the start announcement. */
const START_ANNOUNCEMENT_MS = 2500;
/** Banner-on-screen duration for the end announcement. */
const END_ANNOUNCEMENT_MS = 2000;
/**
 * How often we re-emit the persistent fence-ring VFX. The renderer holds a
 * per-eid live ring, so the event only needs to arrive periodically to
 * refresh in case the renderer has just come online (scene reload, etc.).
 */
const FENCE_VFX_REFRESH_MS = 400;

/** Compose the door-unlock goal flag key for a given spawner eid. */
function arenaGoalId(spawnerEid: number): string {
  return `spawner-arena-${spawnerEid}-cleared`;
}

/** Pick the first (deterministic) alive Player entity's position. */
function findPlayer(world: GameWorld): { eid: number; x: number; y: number } | undefined {
  const players = query(world.ecs, [Player, Position, Health]);
  const { position, health } = world.stores;
  for (const eid of players) {
    if ((health.current[eid] ?? 0) <= 0) continue;
    return {
      eid,
      x: position.x[eid] ?? 0,
      y: position.y[eid] ?? 0,
    };
  }
  return undefined;
}

/**
 * Cache which door entities cover the tiles listed by a room and lock each
 * of them behind the arena's goal flag. Returns the door entity IDs so the
 * arena system can clear the lock config on resolve.
 */
function lockRoomDoorsImpl(
  world: GameWorld,
  spawnerEid: number,
  doorTiles: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  doorEids: Iterable<number>,
  doorState: GameWorld['stores']['doorState'],
  cachedEids: number[],
): number[] {
  const goalId = arenaGoalId(spawnerEid);
  setGoalFlag(world, goalId, false);
  for (const tile of doorTiles) {
    for (const doorEid of doorEids) {
      if ((doorState.tileX[doorEid] ?? -1) !== tile.x) continue;
      if ((doorState.tileY[doorEid] ?? -1) !== tile.y) continue;
      if (getDoorLockConfig(world, doorEid)) break;
      setDoorLockConfig(world, doorEid, {
        unlock: { operator: 'all', conditions: [{ type: 'goal', goalId }] },
      });
      doorState.isLocked[doorEid] = 1;
      doorState.isOpen[doorEid] = 0;
      cachedEids.push(doorEid);
      break;
    }
  }
  return cachedEids;
}

/** Convert cached door eids back to an unlocked state. */
function unlockRoomDoors(world: GameWorld, spawnerEid: number, doorEids: number[]): void {
  setGoalFlag(world, arenaGoalId(spawnerEid), true);
  const { doorState } = world.stores;
  for (const doorEid of doorEids) {
    clearDoorLockConfig(world, doorEid);
    doorState.isLocked[doorEid] = 0;
  }
}

/**
 * Resolve which room the spawner sits in for sealed-room trigger detection.
 * Cached via caller so we don't hit the room graph every tick.
 */
function findRoomIdAt(world: GameWorld, xFt: number, yFt: number): number {
  const floorMap = world.floorMap;
  if (!floorMap) return -1;
  const tile = floorMap.worldToTile(xFt, yFt);
  return floorMap.roomGraph.getRoomAt(tile.x, tile.y);
}

/**
 * Raise the physical barrier(s) that cage the player. For sealed-room arenas
 * we lay down BOTH a locked-door config (existing behaviour) AND a barrier
 * plugging every doorway — belt-and-suspenders redundant so any door-lock
 * bug still leaves the barrier in the way. For open-fence arenas we raise a
 * ring barrier around the disc. The returned handles are stored on
 * `world.spawnerArenaBarriers` and dropped on resolve.
 */
function raiseArenaBarriers(
  world: GameWorld,
  spawnerEid: number,
  spawnerRoomId: number,
  spawnerXFt: number,
  spawnerYFt: number,
  radiusFt: number,
  arenaKind: 0 | 1,
): BarrierHandle | null {
  if (arenaKind === 0 && spawnerRoomId >= 0) {
    // Sealed-room path: barrier ONLY the doorways. The room's walls already
    // provide the physical cage; the doorway plugs make the door-lock
    // impossible to bypass.
    const handle = createRoomBarrier(world, spawnerRoomId, 'fence', { doorwaysOnly: true });
    world.spawnerArenaBarriers.set(spawnerEid, handle);
    return handle;
  }
  // Open-fence path: full ring barrier — every tile at radius ± half-tile is
  // barriered regardless of underlying passability, so a ring landing on
  // walls still forms a closed cage (see ADR 0046 for the leak class this
  // eliminates).
  const handle = createRingBarrier(world, spawnerXFt, spawnerYFt, radiusFt, 'fence');
  world.spawnerArenaBarriers.set(spawnerEid, handle);
  return handle;
}

/** Drop the barrier raised for `spawnerEid` (if any). Idempotent. */
function dropArenaBarrier(world: GameWorld, spawnerEid: number): void {
  const handle = world.spawnerArenaBarriers.get(spawnerEid);
  if (!handle) return;
  dropBarrier(world, handle);
  world.spawnerArenaBarriers.delete(spawnerEid);
}

export function spawnerArenaSystem(world: GameWorld): void {
  const spawners = query(world.ecs, [Spawner, Position, Health]);
  if (spawners.length === 0) return;

  const { spawner, position } = world.stores;
  const floorMap = world.floorMap;
  const player = findPlayer(world);

  // Cache the player's tile-room lookup so we do it once per tick.
  const playerRoomId = floorMap && player ? findRoomIdAt(world, player.x, player.y) : -1;

  for (const eid of spawners) {
    const arenaState = spawner.arenaState[eid] ?? ARENA_STATE.IDLE;
    if (arenaState === ARENA_STATE.RESOLVED) continue;

    const defIndex = spawner.defIndex[eid] ?? 0;
    const archetype = getSpawnerArchetypeByIndex(defIndex);
    const radiusFt = spawner.arenaRadiusFt[eid] ?? 0;
    const sx = position.x[eid] ?? 0;
    const sy = position.y[eid] ?? 0;

    // Resolve the arena kind once we can (floorMap present).
    if ((spawner.arenaKind[eid] ?? ARENA_KIND_UNRESOLVED) === ARENA_KIND_UNRESOLVED && floorMap) {
      const kind = decideArenaKind({
        floorMap,
        spawnerXFt: sx,
        spawnerYFt: sy,
        arenaRadiusFt: radiusFt,
      });
      spawner.arenaKind[eid] = kind === 'sealed-room' ? 0 : 1;
    }
    const arenaKind = spawner.arenaKind[eid] ?? ARENA_KIND_UNRESOLVED;

    if (arenaState === ARENA_STATE.IDLE) {
      // If the spawner dies before the arena triggers, still grant the
      // banked XP so Requirement 5/7's reward isn't orphaned.
      if ((spawner.deathResolved[eid] ?? 0) === 1) {
        const bankedXp = spawner.bankedXp[eid] ?? 0;
        if (bankedXp > 0) {
          spawnXpGem(world, sx, sy, bankedXp);
        }
        spawner.arenaState[eid] = ARENA_STATE.RESOLVED;
        logger.info('Spawner arena skipped (spawner died before trigger)', {
          eid,
          archetype: archetype?.id,
          bankedXp,
          bankedChildren: spawner.bankedChildren[eid] ?? 0,
        });
        continue;
      }
      if (!player) continue;

      const spawnerRoomId = arenaKind === 0 ? findRoomIdAt(world, sx, sy) : -1;
      const sameSealedRoom =
        arenaKind === 0 && spawnerRoomId >= 0 && spawnerRoomId === playerRoomId;
      const triggered = isArenaTriggered({
        playerX: player.x,
        playerY: player.y,
        spawnerX: sx,
        spawnerY: sy,
        arenaRadiusFt: radiusFt,
        sameSealedRoom,
      });
      if (!triggered) continue;

      // ── Idle → Locked transition ─────────────────────────────────────────
      // Sealed-room path: lock the doors (existing behaviour) + raise a
      // doorway barrier (belt-and-suspenders). Open-fence path: raise the
      // ring barrier.
      if (arenaKind === 0 && floorMap && spawnerRoomId >= 0) {
        const room = floorMap.roomGraph.get(spawnerRoomId);
        const doorTiles = room?.doors ?? [];
        const doorEids = query(world.ecs, [DoorState]);
        const cached = lockRoomDoorsImpl(
          world,
          eid,
          doorTiles,
          doorEids,
          world.stores.doorState,
          [],
        );
        world.spawnerArenaDoors.set(eid, cached);
      }
      const barrier = raiseArenaBarriers(
        world,
        eid,
        arenaKind === 0 ? findRoomIdAt(world, sx, sy) : -1,
        sx,
        sy,
        radiusFt,
        arenaKind === 0 ? 0 : 1,
      );
      if ((barrier?.tiles.length ?? 0) > 0) {
        world.spawnerArenaEverArmed.add(eid);
      }
      spawner.arenaState[eid] = ARENA_STATE.LOCKED;

      pushVfxEvent(world.vfxEvents, {
        kind: 'spawnerArenaStart',
        x: sx,
        y: sy,
        color: ARENA_VFX_COLOR,
        intensity: START_INTENSITY,
        radiusFt,
      });
      pushVfxEvent(world.vfxEvents, {
        kind: 'spawnerArenaFence',
        x: sx,
        y: sy,
        color: ARENA_VFX_COLOR,
        intensity: 1,
        radiusFt,
      });
      pushAnnouncement(world.announcements, {
        kind: 'spawnerArenaStart',
        archetypeIndex: defIndex,
        displayName: archetype?.name,
        durationMs: START_ANNOUNCEMENT_MS,
        elapsedMs: world.elapsedMs,
      });
      logger.info('Spawner arena triggered', {
        eid,
        archetype: archetype?.id,
        arenaKind: arenaKind === 0 ? 'sealed-room' : 'open-fence',
        radiusFt,
      });
      continue;
    }

    // arenaState === LOCKED
    if ((spawner.deathResolved[eid] ?? 0) === 1) {
      // ── Locked → Resolved transition ────────────────────────────────────
      const cachedDoors = world.spawnerArenaDoors.get(eid);
      if (cachedDoors) {
        unlockRoomDoors(world, eid, cachedDoors);
        world.spawnerArenaDoors.delete(eid);
      }
      dropArenaBarrier(world, eid);
      const bankedXp = spawner.bankedXp[eid] ?? 0;
      if (bankedXp > 0) {
        spawnXpGem(world, sx, sy, bankedXp);
      }
      spawner.arenaState[eid] = ARENA_STATE.RESOLVED;

      pushVfxEvent(world.vfxEvents, {
        kind: 'spawnerArenaEnd',
        x: sx,
        y: sy,
        color: ARENA_VFX_COLOR,
        intensity: END_INTENSITY,
        radiusFt,
      });
      pushAnnouncement(world.announcements, {
        kind: 'spawnerArenaEnd',
        archetypeIndex: defIndex,
        displayName: archetype?.name,
        durationMs: END_ANNOUNCEMENT_MS,
        elapsedMs: world.elapsedMs,
      });
      logger.info('Spawner arena resolved', {
        eid,
        archetype: archetype?.id,
        bankedXp,
        bankedChildren: spawner.bankedChildren[eid] ?? 0,
      });
      continue;
    }

    // Still locked, no death yet — periodically refresh the fence VFX so a
    // late-mounted renderer can pick up the persistent ring. At the 60 Hz fixed
    // step (`GAME.DELTA_MS = 1000/60` ≈ 16.67 ms) the `< 40` window below is
    // satisfied on ~3 consecutive ticks each FENCE_VFX_REFRESH_MS (400 ms)
    // cycle — a small burst, not a steady stream. In headless there is no
    // renderer to drain `world.vfxEvents`; unbounded growth is instead bounded
    // by `pushVfxEvent`'s VFX_EVENT_CAP, which evicts the oldest events.
    if (
      (arenaKind === 1 || arenaKind === ARENA_KIND_UNRESOLVED) &&
      world.elapsedMs % FENCE_VFX_REFRESH_MS < 40
    ) {
      pushVfxEvent(world.vfxEvents, {
        kind: 'spawnerArenaFence',
        x: sx,
        y: sy,
        color: ARENA_VFX_COLOR,
        intensity: 1,
        radiusFt,
      });
    }
  }
}
