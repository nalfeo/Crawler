/**
 * Deterministic set-piece reachability gate.
 *
 * The prefab-room model makes a `SetPieceDef` authoritative for its room's
 * geometry: map generation carves the target room to the prefab footprint,
 * lands a real impassable wall ring + door slot(s) as TILE WRITES, and connects
 * corridors to those doors. This module proves the carve never strands a room:
 * for a given floor seed it initialises the real Floor 1 scenario (the same
 * `initializeFloor1Scenario` production path the game + headless runner use — NOT
 * a lab), then floods the map from the player spawn over passable/door tiles and
 * asserts that the welcome-room set piece is reachable and that every door on the
 * room AND every NPC anchor inside it is pathable.
 *
 * It is pure of RNG and I/O (the only randomness is the seeded floor generation),
 * so a sweep over N seeds is fully reproducible. The hard gate (rule #12) is
 * 100% of set-piece rooms reachable with all doors + NPC anchors pathable — one
 * sealed room fails the sweep.
 */

import { query } from 'bitecs';
import { createGameWorld } from '../core/world.js';
import { Npc, Position } from '../core/components.js';
import { spawnPlayer } from '../core/index.js';
import { TileFlags } from '../shared/map-types.js';
import { generatedEquipmentRunKeyFromSeed } from '../shared/generated-equipment-types.js';
import type { FloorMap } from '../core/map/FloorMap.js';
import { initializeFloor1Scenario, WELCOME_ROOM_SET_PIECE_ID } from './floorScenario.js';
import { getSetPieceDef } from '../shared/set-piece-types.js';

/** Per-seed reachability outcome. `pass` is false when any failure is recorded. */
export interface SetPieceReachabilityResult {
  readonly seed: number;
  readonly pass: boolean;
  readonly failures: readonly string[];
  /** Number of doors on the resolved set-piece room. */
  readonly doorCount: number;
  /** Number of NPC anchors found inside the set-piece room bounds. */
  readonly npcCount: number;
}

/**
 * Flood-fill the tiles reachable from the player spawn over passable OR door
 * tiles (a closed door is openable, so it is traversable for reachability).
 * Fixed 4-neighbour scan order — no RNG.
 */
function floodFromSpawn(floorMap: FloorMap): Uint8Array {
  const w = floorMap.width;
  const h = floorMap.height;
  const flags = floorMap.tileMap.flags;
  const visited = new Uint8Array(w * h);
  const spawn = floorMap.playerSpawn;
  if (!floorMap.tileMap.inBounds(spawn.x, spawn.y)) {
    return visited;
  }
  const isOpen = (idx: number): boolean => {
    const f = flags[idx]!;
    return (f & TileFlags.PASSABLE) !== 0 || (f & TileFlags.DOOR) !== 0;
  };
  const startIdx = spawn.y * w + spawn.x;
  if (!isOpen(startIdx)) {
    return visited;
  }
  const queue: number[] = [startIdx];
  visited[startIdx] = 1;
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head]!;
    head += 1;
    const x = idx % w;
    const y = (idx - x) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx] === 1 || !isOpen(nIdx)) continue;
      visited[nIdx] = 1;
      queue.push(nIdx);
    }
  }
  return visited;
}

/**
 * Run the Floor 1 set-piece reachability check for a single seed.
 *
 * Mirrors the production init path (createGameWorld → spawnPlayer →
 * initializeFloor1Scenario) rather than a lab, so a green result reflects the
 * real carved floor. Records a human-readable failure for every unmet invariant
 * instead of throwing, so a sweep can report all failures per seed.
 */
export function checkFloor1SetPieceReachability(seed: number): SetPieceReachabilityResult {
  const failures: string[] = [];
  const world = createGameWorld({
    seed,
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(seed),
  });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, playerEid);

  const floorMap = world.floorMap;
  const scenario = world.floorScenario;
  if (!floorMap || !scenario) {
    return {
      seed,
      pass: false,
      failures: ['floor map or scenario missing after init'],
      doorCount: 0,
      npcCount: 0,
    };
  }

  const def = getSetPieceDef(WELCOME_ROOM_SET_PIECE_ID);
  if (!def) {
    return {
      seed,
      pass: false,
      failures: ['welcome-room set piece not registered'],
      doorCount: 0,
      npcCount: 0,
    };
  }

  const w = floorMap.width;
  const reachable = floodFromSpawn(floorMap);
  const isReachable = (tx: number, ty: number): boolean =>
    floorMap.tileMap.inBounds(tx, ty) && reachable[ty * w + tx] === 1;

  // Resolve the carved set-piece room via the STABLE hub-room id the scenario
  // records at carve time (`scenario.welcomeRoomId`). We do NOT key off
  // `objective.welcomeOfficePos`: that field is overwritten to the spawned
  // tutorial-goon NPC tile after placement (floorScenario ~1793), which can fall
  // on the ring or just outside the interior, making `getRoomAt` return the wrong
  // room (or -1) and producing a FALSE gate failure (code-review: seed 21). We
  // also do NOT use the SAFE role: the generator pre-assigns SAFE to its own safe
  // room (dungeon/roles.ts), so there are TWO SAFE rooms and role lookup returns
  // the generator's, not the carved welcome office. The recorded room id is the
  // one carveSetPieceRoom resized in place, so it is unambiguous even when a
  // generator room coincidentally matches the 10x9 footprint (floor1 config
  // allows rooms that small).
  const welcomeRoomId = scenario.welcomeRoomId;
  const room =
    typeof welcomeRoomId === 'number' && welcomeRoomId >= 0
      ? floorMap.roomGraph.get(welcomeRoomId)
      : undefined;
  if (!room) {
    return {
      seed,
      pass: false,
      failures: [
        `no welcome-room resolved (scenario.welcomeRoomId=${String(welcomeRoomId)}); the carve could not find the hub room`,
      ],
      doorCount: 0,
      npcCount: 0,
    };
  }

  const { x: bx, y: by, width: bw, height: bh } = room.bounds;

  // 0. The prefab carve actually happened (not the render-only fallback). When
  //    the carve fits, the room's bounds equal the prefab footprint EXACTLY
  //    (see carveSetPieceRoom); the legacy fallback leaves the generator's
  //    arbitrary bounds. Asserting bounds == footprint turns a silent no-fit
  //    fallback — which would still be "reachable" via mapgen's own walls — into
  //    a hard gate failure, so the sweep proves the AUTHORITATIVE carve, not just
  //    reachability. A real no-fit is a carve bug to fix (grow-into-rock / pick
  //    another hub), never a threshold to weaken (rule #11).
  if (bw !== def.width || bh !== def.height) {
    failures.push(
      `welcome-room did not carve to the prefab footprint: bounds ${bw}x${bh} != footprint ${def.width}x${def.height} (no-fit fallback shipped the legacy room)`,
    );
  }

  // 1. The room interior is reachable from spawn: require at least one interior
  //    (inside-the-ring) floor tile to be in the flood set.
  let interiorReachable = false;
  for (let ty = by + 1; ty < by + bh - 1 && !interiorReachable; ty += 1) {
    for (let tx = bx + 1; tx < bx + bw - 1; tx += 1) {
      if (floorMap.tileMap.isPassable(tx, ty) && isReachable(tx, ty)) {
        interiorReachable = true;
        break;
      }
    }
  }
  if (!interiorReachable) {
    failures.push(
      `welcome-room interior (bounds ${bx},${by} ${bw}x${bh}) is not reachable from spawn`,
    );
  }

  // 2. Every door on the room is pathable.
  const doors = room.doors ?? [];
  if (doors.length === 0) {
    failures.push('welcome-room has no doors (a sealed prefab)');
  }
  for (const door of doors) {
    if (!isReachable(door.x, door.y)) {
      failures.push(`door (${door.x},${door.y}) is not reachable from spawn`);
    }
  }

  // 3. Every NPC anchor inside the room bounds is pathable.
  let npcCount = 0;
  for (const npcEid of query(world.ecs, [Npc, Position])) {
    const wx = world.stores.position.x[npcEid] ?? 0;
    const wy = world.stores.position.y[npcEid] ?? 0;
    const tile = floorMap.worldToTile(wx, wy);
    const inside = tile.x >= bx && tile.x <= bx + bw - 1 && tile.y >= by && tile.y <= by + bh - 1;
    if (!inside) continue;
    npcCount += 1;
    if (!isReachable(tile.x, tile.y)) {
      failures.push(
        `NPC anchor at tile (${tile.x},${tile.y}) inside welcome-room is not reachable`,
      );
    }
  }
  if (npcCount === 0) {
    failures.push('no NPC anchors found inside the welcome-room bounds');
  }

  // 4. The carve stranded no OTHER room. Rewriting the hub's geometry + doors
  //    could wall off a corridor that was some other room's only approach, so
  //    assert every room in the graph still has >=1 interior tile reachable from
  //    spawn (the flood treats closed AND locked doors as traversable, so this is
  //    a pure topology check, independent of gameplay gating). The generator's
  //    own reachability pass guarantees this pre-carve; a failure here is a
  //    carve-induced regression (plan-review concern #2), not a pre-existing gap.
  for (const other of floorMap.roomGraph.getAll()) {
    let anyReachable = false;
    const ob = other.bounds;
    for (let ty = ob.y + 1; ty < ob.y + ob.height - 1 && !anyReachable; ty += 1) {
      for (let tx = ob.x + 1; tx < ob.x + ob.width - 1; tx += 1) {
        if (floorMap.tileMap.isPassable(tx, ty) && isReachable(tx, ty)) {
          anyReachable = true;
          break;
        }
      }
    }
    if (!anyReachable) {
      failures.push(
        `room ${other.id} (bounds ${ob.x},${ob.y} ${ob.width}x${ob.height}) is not reachable from spawn after the carve`,
      );
    }
  }

  return { seed, pass: failures.length === 0, failures, doorCount: doors.length, npcCount };
}
