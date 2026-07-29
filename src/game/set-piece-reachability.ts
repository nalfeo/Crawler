/**
 * Deterministic set-piece reachability gate.
 *
 * The prefab-room model makes a `SetPieceDef` authoritative for its room's
 * geometry: map generation carves the target room to the prefab footprint,
 * lands a real impassable wall ring + door slot(s) as TILE WRITES, and connects
 * corridors to those doors. This module proves the carve never strands a room:
 * for a given floor seed it initialises the real Floor 1 scenario (the same
 * `initializeFloor1Scenario` production path the game + headless runner use — NOT
 * a lab), then floods the map from the player spawn and asserts that the
 * welcome-room set piece is reachable and that every door on the room AND every
 * NPC anchor inside it is pathable. The welcome-hub checks flood LOCK-AWARE
 * (around the doors A* treats as walls at floor start), so a hub reachable only
 * through an initially-locked quest door — the seed-21 failure mode — fails the
 * gate; a separate topology-only flood asserts the carve stranded no other room
 * by walls.
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
import { getNavigationBlockedDoors } from '../core/door-navigation.js';
import { getSetPieceDef, resolveSetPieceDoorSlots } from '../shared/set-piece-types.js';

/** Per-seed reachability outcome. `pass` is false when any failure is recorded. */
export interface SetPieceReachabilityResult {
  readonly seed: number;
  readonly pass: boolean;
  readonly failures: readonly string[];
  /** Number of doors on the resolved set-piece room. */
  readonly doorCount: number;
  /** Number of NPC anchors found inside the set-piece room bounds. */
  readonly npcCount: number;
  /**
   * Whether the prefab was authoritatively CARVED, taken from the persisted
   * ground truth `scenario.welcomeRoomCarved` (`welcomeCarve.fitted`), NOT from
   * the `bounds == footprint` proxy — a coincidentally footprint-sized generator
   * room could satisfy that proxy while shipping the render-only fallback, a
   * false-green. `bounds == footprint` survives only as defense-in-depth (check
   * #0a) for the distinct fitted-but-inconsistent-bounds bug class. Do NOT
   * "simplify" this back to the bounds proxy — that reintroduces the false-pass
   * (rule #11). Surfaced as a first-class signal so the sweep can report
   * degradation as a number: `carved: false` is a hard failure (see check #0)
   * AND the expected steady state is zero degradations. A non-zero count means
   * carve tiers 1–2 are under-powered, never an acceptable resting place.
   */
  readonly carved: boolean;
}

/**
 * Flood-fill the tiles reachable from the player spawn over passable OR door
 * tiles. Fixed 4-neighbour scan order — no RNG.
 *
 * `blockedDoorTiles` (tile indices `y*w+x`) are door tiles that must be treated
 * as walls — the LOCKED-unsatisfied doors A* treats as impassable at floor start
 * (staircase / slime-rat gates). Pass it to build a LOCK-AWARE mask (the true
 * floor-start player invariant: reachable without any key). Omit it (or pass an
 * empty set) for a pure-TOPOLOGY mask that treats closed AND locked doors as
 * traversable — used for the "no room sealed by walls" check.
 */
function floodFromSpawn(floorMap: FloorMap, blockedDoorTiles?: ReadonlySet<number>): Uint8Array {
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
    if ((f & TileFlags.PASSABLE) !== 0) return true;
    if ((f & TileFlags.DOOR) !== 0) return !(blockedDoorTiles?.has(idx) ?? false);
    return false;
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
      carved: false,
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
      carved: false,
    };
  }

  const w = floorMap.width;
  // LOCK-AWARE reachability for the welcome-hub checks (1–3). The tutorial hub
  // MUST be reachable from spawn at floor start WITHOUT unlocking anything — that
  // is the real player invariant and the exact seed-21 failure mode (a hub
  // reachable only through an initially-locked quest door reads as "reachable" to
  // a pure-topology flood but is sealed to the player). We snapshot the doors A*
  // itself treats as walls (`getNavigationBlockedDoors` — the same locked-door
  // model the game + AI consume) and flood around them. Pure read, no RNG, no
  // system tick required (the verdict derives from the lock config set at init).
  const blockedDoorTiles = new Set<number>();
  for (const info of getNavigationBlockedDoors(world)) {
    blockedDoorTiles.add(info.tileY * w + info.tileX);
  }
  const reachable = floodFromSpawn(floorMap, blockedDoorTiles);
  const isReachable = (tx: number, ty: number): boolean =>
    floorMap.tileMap.inBounds(tx, ty) && reachable[ty * w + tx] === 1;
  // TOPOLOGY-ONLY reachability for the no-strand check (#4): closed AND locked
  // doors are traversable, so this asserts pure wall-connectivity independent of
  // gameplay gating (locked rooms are INTENTIONALLY gated, not stranded).
  const reachableTopo = floodFromSpawn(floorMap);
  const isReachableTopo = (tx: number, ty: number): boolean =>
    floorMap.tileMap.inBounds(tx, ty) && reachableTopo[ty * w + tx] === 1;

  // Resolve the carved set-piece room via the STABLE hub-room id the scenario
  // records at carve time (`scenario.welcomeRoomId`). We do NOT key off
  // `objective.welcomeOfficePos`: that field is overwritten to the spawned
  // tutorial-goon NPC tile after placement (floorScenario ~1793), which can fall
  // on the ring or just outside the interior, making `getRoomAt` return the wrong
  // room (or -1) and producing a FALSE gate failure (code-review: seed 21). We
  // also do NOT use the SAFE role: role-selection policy has changed over time
  // (historically this floor had two SAFE rooms), and role lookup is inherently
  // ambiguous if that invariant regresses again. The recorded room id is the one
  // carveSetPieceRoom resized in place, so it is unambiguous even when a generator
  // room coincidentally matches the 10x9 footprint (floor1 config allows rooms
  // that small).
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
      carved: false,
    };
  }

  const { x: bx, y: by, width: bw, height: bh } = room.bounds;

  // Whether the prefab carved authoritatively. GROUND TRUTH from the persisted
  // `carveWelcomeRoomPrefab` `fitted` result — NOT re-derived from `bounds ==
  // footprint`. (Code-review round 2, gpt-5.4: Floor 1's room-size config permits
  // the generator to emit a coincidentally 10x9 welcome room, which the no-fit
  // fallback then leaves untouched while `tagRoomAsSafe`/`sealSpecialRooms`
  // hardens its perimeter — so a bounds match plus the #0b shell checks could BOTH
  // pass on a render-only degraded floor, reporting "authoritative carve" when the
  // prefab never applied. That is exactly the false-green the parent plan-review
  // flagged. `welcomeRoomCarved` is the only unambiguous signal the carve
  // tile-writes ran.)
  const carved = scenario.welcomeRoomCarved === true;

  // 0. The prefab carve actually happened (not the render-only fallback). A no-fit
  //    degrades to the legacy render-only stamp — still "reachable" via mapgen's
  //    own walls — so making it a hard failure proves the sweep is green because
  //    the AUTHORITATIVE carve applied, not merely because the room is reachable.
  //    A real no-fit is a carve bug to fix (grow-into-rock / pick another hub),
  //    never a threshold to weaken (rule #11).
  if (!carved) {
    failures.push(
      `welcome-room did not carve authoritatively (scenario.welcomeRoomCarved=${String(scenario.welcomeRoomCarved)}): the no-fit fallback shipped the legacy render-only room`,
    );
  }

  // 0a. Defense-in-depth: when the carve DID run, its bounds MUST equal the
  //     footprint exactly (carveSetPieceRoom resizes the room in place to the
  //     footprint). A `fitted` carve whose bounds diverge is a carve bug distinct
  //     from a no-fit, so assert it rather than let it slide.
  if (carved && (bw !== def.width || bh !== def.height)) {
    failures.push(
      `welcome-room carved (fitted) but bounds ${bw}x${bh} != footprint ${def.width}x${def.height}: the carve wrote inconsistent bounds`,
    );
  }

  const doors = room.doors ?? [];

  // 0b. The prefab SHELL actually landed as tile writes. Reachability + correct
  //     bounds are necessary but NOT sufficient (parent plan-review): the legacy
  //     render-only fallback has NO impassable walls, so a room that silently
  //     degraded is TRIVIALLY reachable — the sweep would be greenest exactly
  //     when the feature failed. And a carve that resized bounds without writing
  //     the ring would pass checks #0/#1. So — only when the prefab claims to have
  //     carved authoritatively — POSITIVELY assert the shell:
  //       (a) every perimeter tile is impassable wall OR a door (no open breach),
  //       (b) every recorded door tile carries TileFlags.DOOR and sits on the ring,
  //       (c) the door count equals the def's resolved door slots.
  //     These prove the prefab APPLIED, not merely that the room is reachable.
  if (carved) {
    let ringBreaches = 0;
    for (let tx = bx; tx < bx + bw; tx += 1) {
      for (let ty = by; ty < by + bh; ty += 1) {
        const onPerimeter = tx === bx || tx === bx + bw - 1 || ty === by || ty === by + bh - 1;
        if (!onPerimeter) continue;
        if (!floorMap.tileMap.isDoor(tx, ty) && floorMap.tileMap.isPassable(tx, ty)) {
          ringBreaches += 1;
        }
      }
    }
    if (ringBreaches > 0) {
      failures.push(
        `welcome-room perimeter has ${ringBreaches} passable non-door tile(s): the prefab wall ring did not land as impassable tiles`,
      );
    }
    for (const door of doors) {
      const onPerimeter =
        door.x === bx || door.x === bx + bw - 1 || door.y === by || door.y === by + bh - 1;
      if (!onPerimeter) {
        failures.push(`door (${door.x},${door.y}) is not on the room's perimeter ring`);
      }
      if (!floorMap.tileMap.isDoor(door.x, door.y)) {
        failures.push(`door (${door.x},${door.y}) tile does not carry TileFlags.DOOR`);
      }
    }
    // The def's resolved slots are the MINIMUM, not an exact count:
    // carveSetPieceRoom intentionally converts load-bearing ring breaches
    // (corridors that already connected to the room) into ADDITIONAL doors so no
    // spawn-reachable region is ever stranded (see sealRoomPerimeter, step 5). An
    // exact match would FALSELY fail seeds where corridors join the ring (e.g.
    // seed 2024: 1 declared + 2 connectivity doors). Assert the declared doors
    // landed (a floor); a count BELOW that floor means the prefab's own doors did
    // not all land — a hard failure (never a threshold to relax, rule #11).
    const expectedDoorCount = resolveSetPieceDoorSlots(def).length;
    if (doors.length < expectedDoorCount) {
      failures.push(
        `welcome-room carved ${doors.length} door(s) but the def declares ${expectedDoorCount} door slot(s): the prefab's declared doors did not all land`,
      );
    }
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
      `welcome-room interior (bounds ${bx},${by} ${bw}x${bh}) is not reachable from spawn at floor start (lock-aware: not sealed behind an initially-locked door)`,
    );
  }

  // 2. Every door on the room is pathable.
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

  // 4. The carve stranded no OTHER room. Rewriting the hub's geometry + doors —
  //    including GROWING the footprint beyond the old room into surrounding rock —
  //    could wall off or overwrite a corridor that was some other room's only
  //    approach, so assert every room in the graph still has >=1 interior tile
  //    reachable from spawn. This is the topological backstop for the parent's
  //    "grown carve swallows a third-party corridor" concern: carveSetPieceRoom
  //    step 3 already REJECTS any footprint that overlaps another room's bounds,
  //    and sealRoomPerimeter converts load-bearing ring breaches to DOORS (not
  //    walls) so a corridor crossing the ring is preserved; this check is the
  //    final guarantee that no ROOM ends up stranded regardless. It uses the
  //    TOPOLOGY-only flood (closed AND locked doors traversable), so it is a pure
  //    wall-connectivity check independent of gameplay gating — locked rooms are
  //    INTENTIONALLY gated, not stranded, and must not fail here just because
  //    their door starts locked. The generator's own reachability pass guarantees
  //    this pre-carve; a failure here is a carve-induced regression (plan-review
  //    concern #2). The only uncovered residual — severing the sole approach to a
  //    ROOMLESS corridor pocket (no room, NPC anchor, or objective) — is not
  //    gameplay-relevant and is out of the hard gate's scope by design.
  for (const other of floorMap.roomGraph.getAll()) {
    let anyReachable = false;
    const ob = other.bounds;
    for (let ty = ob.y + 1; ty < ob.y + ob.height - 1 && !anyReachable; ty += 1) {
      for (let tx = ob.x + 1; tx < ob.x + ob.width - 1; tx += 1) {
        if (floorMap.tileMap.isPassable(tx, ty) && isReachableTopo(tx, ty)) {
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

  return { seed, pass: failures.length === 0, failures, doorCount: doors.length, npcCount, carved };
}
