/**
 * Arena lock-in detector for the BT AI.
 *
 * The spawner battle-arena feature (ADR 0044) traps the player inside either
 * a sealed room (doors lock) or a fence ring around a spawner until the
 * spawner dies. Floor-1 boss rooms (Slime Rat, Rat Slime staircase boss)
 * apply the same treatment — doors close behind the player when the boss
 * fight begins and only reopen on defeat.
 *
 * The BT AI's default priority selector (Retreat > Interact > Progress >
 * Explore …) does not know about either kind of lock-in, so on natural
 * Floor-1 runs the AI can walk into a triggered spawner arena or a
 * newly-started boss battle and then wander toward a stale progression
 * target (e.g. the far-away staircase), stalling until the timer collapses
 * or the AI dies to accumulated damage.
 *
 * This module is the pure, deterministic detector consumed by
 * `bt-ai-provider.ts` in a new priority slot (1.5 — above Interact; Retreat
 * yields while lock-in is active so sealed arenas use defensive engagement
 * instead of cage-kiting loops). It has:
 *
 *   - No side effects.
 *   - No dependency on the BT provider or its blackboard.
 *   - No RNG or wall-clock reads.
 *
 * Precondition on the caller: player position is expressed in feet,
 * matching `Position.x/y` and the arena SoA fields.
 */

import { query, entityExists } from 'bitecs';
import { Position, Spawner, Health } from '../../core/index.js';
import type { GameWorld } from '../../core/index.js';
import { isPlayerInArenaRadius } from '../../core/spawner-arena.js';

/**
 * Arena state values mirrored from the SoA in `Spawner.arenaState`.
 * Kept private to this module so the BT provider stays decoupled from the
 * numeric literal.
 */
const ARENA_STATE_LOCKED = 1 as const;

/** Small slack applied to the radius check so the AI still targets the
 * spawner when the player is barely inside the disc (numeric jitter). */
const ARENA_RADIUS_SLACK_FT = 0.5;

/**
 * The target the AI should engage when it detects it is locked in an arena.
 * Deliberately narrow: eid + world-space position + the source of the
 * lock-in. Anything else (planEngagement, kite orbit, …) is the caller's
 * responsibility once `decision.targetEid` is set to `eid`.
 */
export interface ArenaLockinTarget {
  /** Entity to attack: the spawner structure or the boss. */
  readonly eid: number;
  /** Target x-position in feet (spawner or boss centre). */
  readonly x: number;
  /** Target y-position in feet. */
  readonly y: number;
  /** Which lock-in source fired — useful for logging + tests. */
  readonly kind: 'spawner' | 'boss';
  /**
   * For debug: the spawner eid whose arena locked the player in, or `-1`
   * for boss-room lock-ins. Included so labs and tests can trace back to
   * the source arena without another lookup.
   */
  readonly arenaSpawnerEid: number;
}

/**
 * Detect whether the player is currently locked in an arena (spawner or
 * boss room) and, if so, return the entity they must kill to leave.
 *
 * Rules — a spawner arena locks the player when ALL are true:
 *   1. `arenaState[spawnerEid] === 1` (locked).
 *   2. Spawner is alive: `health.current > 0` and `deathResolved === 0`.
 *   3. A real barrier is present: `world.spawnerArenaBarriers` has a barrier
 *      handle for this spawner that actually blocks — either a non-empty tile
 *      set (sealed-room doorway plugs) OR an analytic `shape` (the open-fence
 *      ring WALL, which carries `tiles: []` and only a `BarrierRingShape`) —
 *      OR `world.spawnerArenaDoors` has one or more actually-locked doors.
 *      Without a real barrier the AI can
 *      walk out of the arena on its own — the "priority the objective"
 *      rule only applies when leaving requires killing it.
 *   4. Player is inside the arena:
 *      - open-fence: `distance(player, spawner) ≤ arenaRadiusFt + 0.5`
 *      - sealed:     player is in the same room as the spawner.
 *
 * Rules — a Floor-1 boss room locks the player when ALL are true:
 *   1. `world.floorScenario?.objective?.bossBattles` has an entry with a valid
 *      `bossEid` pointing at a living boss.
 *   2. `battle.started === true` (the doors were locked on that trigger).
 *   3. Player and boss are in the same room (`roomGraph.getRoomAt`).
 *
 * Precedence + tie-break:
 *   - Spawner lock-in wins over boss lock-in when both hold — the spawner
 *     is the more localized cage (fence disc or single sealed room), and
 *     killing it releases the fence *and* leaves the boss encounter
 *     available for its own natural progression pass afterwards.
 *   - Deterministic tie-break among multiple locked spawners: lowest eid.
 *
 * Returns `null` if the player is not locked into any arena, so the caller
 * (a BT `Condition` node) can fail cleanly and fall through to the rest of
 * the selector.
 */
export function detectArenaLockin(
  world: GameWorld,
  playerX: number,
  playerY: number,
): ArenaLockinTarget | null {
  const spawnerTarget = findSpawnerLockin(world, playerX, playerY);
  if (spawnerTarget !== null) return spawnerTarget;
  return findBossLockin(world, playerX, playerY);
}

/**
 * Scan every Spawner entity for one that currently traps the player. Prefers
 * the lowest eid on a tie so the choice is deterministic across replays.
 */
function findSpawnerLockin(
  world: GameWorld,
  playerX: number,
  playerY: number,
): ArenaLockinTarget | null {
  const spawners = query(world.ecs, [Spawner, Position, Health]);
  if (spawners.length === 0) return null;

  const { spawner, position, health } = world.stores;
  const floorMap = world.floorMap;
  const playerRoomId = floorMap
    ? (() => {
        const tile = floorMap.worldToTile(playerX, playerY);
        return floorMap.roomGraph.getRoomAt(tile.x, tile.y);
      })()
    : -1;

  // Walk in ascending eid order — query() already returns ascending eids in
  // bitecs, but wrap this in an explicit "lowest eid wins" scan so the
  // tie-break is guaranteed even if the query order ever changes.
  let bestEid = -1;
  let bestX = 0;
  let bestY = 0;
  for (const eid of spawners) {
    if ((spawner.arenaState[eid] ?? 0) !== ARENA_STATE_LOCKED) continue;
    if ((health.current[eid] ?? 0) <= 0) continue;
    if ((spawner.deathResolved[eid] ?? 0) !== 0) continue;

    // Only treat the arena as a lock-in if it actually *blocks* the player
    // out — i.e. a real barrier was raised or the room's doors were
    // successfully locked. A raised barrier blocks in one of two shapes:
    //   - sealed-room: a handle with doorway-plug TILES (`tiles.length > 0`);
    //   - open-fence:  a handle with an analytic ring-WALL `shape` and zero
    //     tiles (`createRingWallBarrier`).
    // Without this check we would force the AI to fight even for arenas that
    // trigger the state machine but have no physical barrier (e.g. a spawner
    // in an open corridor where the barrier came up empty), regressing the
    // natural walk-past behaviour there. The AI is only "stuck" when leaving
    // requires killing the objective.
    const barrier = world.spawnerArenaBarriers?.get(eid);
    const hasFence = barrier != null && ((barrier.tiles?.length ?? 0) > 0 || barrier.shape != null);
    const hasLockedDoors = (world.spawnerArenaDoors?.get(eid)?.length ?? 0) > 0;
    if (!hasFence && !hasLockedDoors) continue;

    const sx = position.x[eid] ?? 0;
    const sy = position.y[eid] ?? 0;
    const radiusFt = spawner.arenaRadiusFt[eid] ?? 0;
    const arenaKind = spawner.arenaKind[eid] ?? 1; // default to open-fence

    let inside: boolean;
    if (arenaKind === 0 /* sealed-room */ && floorMap && playerRoomId >= 0) {
      const spawnerTile = floorMap.worldToTile(sx, sy);
      const spawnerRoomId = floorMap.roomGraph.getRoomAt(spawnerTile.x, spawnerTile.y);
      inside =
        spawnerRoomId >= 0 &&
        (spawnerRoomId === playerRoomId ||
          isPlayerInArenaRadius(playerX, playerY, sx, sy, radiusFt + ARENA_RADIUS_SLACK_FT));
    } else {
      // Open-fence (or unresolved / mapless): distance-only with a small
      // slack so the AI still commits when the player is a hair inside.
      inside = isPlayerInArenaRadius(playerX, playerY, sx, sy, radiusFt + ARENA_RADIUS_SLACK_FT);
    }
    if (!inside) continue;

    if (bestEid === -1 || eid < bestEid) {
      bestEid = eid;
      bestX = sx;
      bestY = sy;
    }
  }
  if (bestEid === -1) return null;
  return {
    eid: bestEid,
    x: bestX,
    y: bestY,
    kind: 'spawner',
    arenaSpawnerEid: bestEid,
  };
}

/**
 * Scan Floor-1 boss encounters for one whose room contains the player.
 * Deterministic: iterates the Map in insertion order (V8/JS Map iteration
 * is insertion-ordered by spec).
 */
function findBossLockin(
  world: GameWorld,
  playerX: number,
  playerY: number,
): ArenaLockinTarget | null {
  const bossBattles = world.floorScenario?.objective?.bossBattles;
  if (!bossBattles || bossBattles.size === 0) return null;
  const floorMap = world.floorMap;
  if (!floorMap) return null;

  const playerTile = floorMap.worldToTile(playerX, playerY);
  const playerRoomId = floorMap.roomGraph.getRoomAt(playerTile.x, playerTile.y);
  if (playerRoomId < 0) return null;

  const { position, health } = world.stores;

  for (const battle of bossBattles.values()) {
    if (!battle.started) continue;
    if (battle.defeated) continue;
    const bossEid = battle.bossEid;
    if (bossEid === null) continue;
    if (!entityExists(world.ecs, bossEid)) continue;
    if ((health.current[bossEid] ?? 0) <= 0) continue;

    const bx = position.x[bossEid] ?? 0;
    const by = position.y[bossEid] ?? 0;
    const bossTile = floorMap.worldToTile(bx, by);
    const bossRoomId = floorMap.roomGraph.getRoomAt(bossTile.x, bossTile.y);
    if (bossRoomId < 0) continue;
    if (bossRoomId !== playerRoomId) continue;

    return {
      eid: bossEid,
      x: bx,
      y: by,
      kind: 'boss',
      arenaSpawnerEid: -1,
    };
  }
  return null;
}
