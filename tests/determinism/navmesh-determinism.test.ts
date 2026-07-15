/**
 * Navmesh determinism regression guard — Gate 2 of the NAVMESH pathing slice.
 *
 * This LOCKS the load-bearing determinism result behind NAVMESH pathing: recast's
 * `computePath` is byte-for-byte deterministic AND cross-platform-identical
 * (Windows local == Linux CI) under one exact pinned config. The Slice-1 spike
 * first proved cross-platform byte-identity (win/arm64 Node 24 == linux/x64
 * Node 22) for its config; Slice-3 then CORRECTED the config (cs/ch 0.25 +
 * door-inclusive geometry) because the spike's cs 0.5 / doors-omitted config
 * shattered the navmesh into per-room islands and only ever produced 2-point
 * stub paths — determinism held, but on degenerate output. This test reproduces
 * the corrected golden **75917f12** from the PROMOTED production module
 * (`src/game/ai/navmesh/`), not a throwaway spike script, and additionally
 * asserts every query ROUTES to its goal so the golden can never again lock a
 * stub. Crawler's headless win-rate gate runs on linux/x64.
 *
 * If this hash ever changes, the navmesh is no longer producing the proven
 * deterministic output and NAVMESH pathing can NO LONGER be trusted to feed the
 * deterministic gate. Do NOT "update the golden" to make it pass — investigate
 * what perturbed the float path (almost always: the asm.js compat build leaking
 * in instead of the forced real `.wasm`, a recast version bump, or a config
 * drift in `navmesh-config.ts`). The pinned config is a HARD REQUIREMENT
 * enforced in code (`NAVMESH_PINNED_CONFIG`), not a default.
 *
 * STATIC ALL-DOORS geometry (Option B): the navmesh is built ONCE per floor from
 * the all-doors passable footprint (`isPassable || isDoor`) and is NOT rebuilt
 * when doors lock/unlock. A door-aware geometry REBUILD (Option A) was attempted
 * and REVERTED: removing a re-locked door tile SEVERS the recast polygon mesh
 * (recast connectivity ⊊ the 4-connected grid at thin/door connectors under the
 * pinned config), producing undetected partial paths and a Gate-3 timeout
 * regression (see the 2026-07-08 navmesh-pathing-mode handoff). Door lock/unlock
 * semantics therefore belong at the query-time COST layer (Slice 4), not in
 * geometry — so there is deliberately NO rebuild-on-change determinism case
 * here: `buildFloorNavmesh(floor)` uses the all-doors default and this golden is
 * the single static build.
 *
 * This suite is intentionally FAST (build ~35-80ms/floor × 3 seeds + a handful
 * of queries, ~1s) so it lives in the `unit`/`determinism` project and runs in
 * `verify:fast` on every change — the byte-identity guard you want on the hot
 * loop, not deferred to the slow headless gate.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildFloorNavmesh,
  computeTilePath,
  destroyNavmesh,
  exportNavmeshBytes,
  fnv1a,
  fnv1aBytes,
  initNavmesh,
  queryWorldPath,
  serializeRecastWaypoints,
} from '../../src/game/ai/navmesh/index.js';
import { getGenerator } from '../../src/core/map/generators/index.js';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';

/**
 * The canonical cross-platform determinism hash for the Slice-3 corrected config
 * (cs/ch 0.25 + door-inclusive geometry). The Slice-1 spike's `741fefa4` was for
 * cs 0.5 with door tiles OMITTED — that config SHATTERED the navmesh into
 * per-room islands so every query was a 2-point stub; its determinism proof held
 * but only on degenerate paths. This hash locks the config that actually ROUTES
 * (seed-42: 45/45 room centers reached). LOCKED — see file header. Cross-platform
 * re-proof (win local == linux CI) tracked in the Slice-3 handoff.
 */
const GOLDEN_DETERMINISM_HASH = 'da8acb36';

/** The exact seeds the spike hashed. */
const SEEDS = [42, 1337, 999999] as const;

/**
 * Fixed Floor-1 map parameters (mirrors `src/shared/data/floors/floor1.manifest.json`
 * at spike time). Pinned literally so this golden is self-contained and never
 * drifts with a manifest edit — the hash is over these exact inputs.
 */
const FLOOR1_MAP = {
  widthTiles: 240,
  heightTiles: 140,
  tileSizeFt: 4.0,
  biome: BiomeType.BASIC_UNDERGROUND,
  roomWidthRange: [10, 22] as [number, number],
  roomHeightRange: [9, 20] as [number, number],
  maxRooms: 70,
  floorDensity: 0.36,
} as const;

function buildFloorMap(seed: number): FloorMap {
  const config: MapConfig = {
    widthTiles: FLOOR1_MAP.widthTiles,
    heightTiles: FLOOR1_MAP.heightTiles,
    tileSizeFt: FLOOR1_MAP.tileSizeFt,
    biome: FLOOR1_MAP.biome,
    seed,
    roomWidthRange: FLOOR1_MAP.roomWidthRange,
    roomHeightRange: FLOOR1_MAP.roomHeightRange,
    maxRooms: FLOOR1_MAP.maxRooms,
    floorDensity: FLOOR1_MAP.floorDensity,
  };
  return getGenerator(config.biome).generate(config, new SeededRandom(seed));
}

/** Nearest passable tile to (tx,ty) via a deterministic expanding ring scan. */
function nearestPassable(floor: FloorMap, tx: number, ty: number): { x: number; y: number } | null {
  if (floor.tileMap.isPassable(tx, ty)) return { x: tx, y: ty };
  for (let r = 1; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        const x = tx + dx;
        const y = ty + dy;
        if (floor.tileMap.isPassable(x, y)) return { x, y };
      }
    }
  }
  return null;
}

interface QuerySpec {
  name: string;
  start: { x: number; y: number };
  goal: { x: number; y: number };
}

/**
 * The fixed, deterministic query set the spike hashed: spawn → boss room,
 * spawn → safe room, and spawn → the centers of the first 8 rooms (by id). All
 * goals are snapped to the nearest passable tile; goals equal to spawn are
 * skipped. Derived from stable map features so it is reproducible per seed.
 */
function buildQuerySpecs(floor: FloorMap): QuerySpec[] {
  const specs: QuerySpec[] = [];
  const spawn = { x: floor.playerSpawn.x, y: floor.playerSpawn.y };

  const push = (name: string, gx: number, gy: number): void => {
    const goal = nearestPassable(floor, gx, gy);
    if (!goal) return;
    if (goal.x === spawn.x && goal.y === spawn.y) return;
    specs.push({ name, start: spawn, goal });
  };

  const boss = floor.bossStairRoom;
  if (boss)
    push(
      'spawn->boss',
      boss.bounds.x + (boss.bounds.width >> 1),
      boss.bounds.y + (boss.bounds.height >> 1),
    );
  const safe = floor.safeRoom;
  if (safe)
    push(
      'spawn->safe',
      safe.bounds.x + (safe.bounds.width >> 1),
      safe.bounds.y + (safe.bounds.height >> 1),
    );

  const rooms = floor.rooms;
  const n = Math.min(8, rooms.length);
  for (let i = 0; i < n; i++) {
    const room = rooms[i]!;
    push(
      `spawn->room${i}`,
      room.bounds.x + (room.bounds.width >> 1),
      room.bounds.y + (room.bounds.height >> 1),
    );
  }
  return specs;
}

interface QueryResult {
  name: string;
  success: boolean;
  pointCount: number;
  waypointsHex: string;
  /** True when the last waypoint lands on the goal tile center (routing reached
   * the goal, not a degenerate partial stub). NOT part of the determinism hash —
   * a separate correctness guard so the golden can never again encode stubs. */
  reachedGoal: boolean;
}

interface SeedResult {
  seed: number;
  passableTiles: number;
  triangleCount: number;
  navMeshDataHash: string;
  queries: QueryResult[];
}

/**
 * Build + query one seed through the PRODUCTION navmesh module (the whole point:
 * exercise `buildFloorNavmesh`/`computeTilePath`/`serializeRecastWaypoints`, not
 * a private copy). Mirrors the spike's `runSeed` field-for-field so the derived
 * `determinismHash` is comparable byte-for-byte.
 */
function runSeed(seed: number): SeedResult {
  const floor = buildFloorMap(seed);
  const handle = buildFloorNavmesh(floor);
  try {
    const navMeshDataHash = fnv1aBytes(exportNavmeshBytes(handle));
    const specs = buildQuerySpecs(floor);
    const queries: QueryResult[] = specs.map((spec) => {
      const path = computeTilePath(handle, spec.start.x, spec.start.y, spec.goal.x, spec.goal.y);
      const last = path.waypoints[path.waypoints.length - 1];
      // Goal tile center in raw recast tile-space (computeTilePath snaps to +0.5).
      const reachedGoal =
        last !== undefined &&
        Math.hypot(last.x - (spec.goal.x + 0.5), last.z - (spec.goal.y + 0.5)) < 1.5;
      return {
        name: spec.name,
        success: path.success,
        pointCount: path.waypoints.length,
        waypointsHex: serializeRecastWaypoints(path.waypoints),
        reachedGoal,
      };
    });
    return {
      seed,
      passableTiles: handle.passableTiles,
      triangleCount: handle.triangleCount,
      navMeshDataHash,
      queries,
    };
  } finally {
    destroyNavmesh(handle);
  }
}

/**
 * Canonical determinism hash over the platform-INDEPENDENT parts of a run
 * (identical string layout to the Slice-1 spike). Excludes timings + platform
 * meta by construction.
 */
function determinismHash(seeds: SeedResult[]): string {
  const parts: string[] = [];
  for (const s of seeds) {
    parts.push(
      `seed=${s.seed};nav=${s.navMeshDataHash};tris=${s.triangleCount};passable=${s.passableTiles}`,
    );
    for (const q of s.queries) {
      parts.push(`${q.name}|${q.success}|${q.pointCount}|${q.waypointsHex}`);
    }
  }
  return fnv1a(parts.join('\n'));
}

describe('NAVMESH determinism — pinned config regression guard (Gate 2)', () => {
  beforeAll(async () => {
    // Forces the real .wasm build + setRandomSeed(0). MUST resolve before any
    // synchronous build/query below (see initNavmesh docs).
    await initNavmesh();
  });

  it('reproduces the corrected Slice-3 golden determinism hash (da8acb36)', () => {
    const results = SEEDS.map((s) => runSeed(s));
    // Sanity: every seed must produce passable geometry AND every query must
    // ROUTE ALL THE WAY to its goal — not just return >1 point. The Slice-1
    // golden matched vacuously on 2-point stubs that never left the spawn room;
    // this guard makes the golden encode real end-to-end routing so a future
    // shatter/stub regression fails here loudly instead of hashing green.
    for (const r of results) {
      expect(r.passableTiles).toBeGreaterThan(0);
      expect(r.triangleCount).toBeGreaterThan(0);
      expect(r.queries.length).toBeGreaterThan(0);
      for (const q of r.queries) {
        expect(q.success, `seed ${r.seed} ${q.name} success`).toBe(true);
        expect(q.reachedGoal, `seed ${r.seed} ${q.name} reached goal`).toBe(true);
        expect(q.pointCount).toBeGreaterThan(1);
      }
    }
    expect(determinismHash(results)).toBe(GOLDEN_DETERMINISM_HASH);
  });

  it('is byte-identical across repeated in-process rebuild+requery', () => {
    const first = determinismHash(SEEDS.map((s) => runSeed(s)));
    const second = determinismHash(SEEDS.map((s) => runSeed(s)));
    expect(second).toBe(first);
    expect(second).toBe(GOLDEN_DETERMINISM_HASH);
  });

  it('queryWorldPath returns the tile-space route scaled by tileSizeFt (world feet)', () => {
    const floor = buildFloorMap(42);
    const handle = buildFloorNavmesh(floor);
    try {
      const ts = FLOOR1_MAP.tileSizeFt;
      const specs = buildQuerySpecs(floor);
      const spec = specs.find((s) => s.name === 'spawn->boss') ?? specs[0];
      expect(spec).toBeDefined();
      const s = spec!;

      // World query starts/goals at the SAME tile centers, expressed in feet.
      const startWX = (s.start.x + 0.5) * ts;
      const startWY = (s.start.y + 0.5) * ts;
      const goalWX = (s.goal.x + 0.5) * ts;
      const goalWY = (s.goal.y + 0.5) * ts;

      const world = queryWorldPath(handle, startWX, startWY, goalWX, goalWY);
      const tile = computeTilePath(handle, s.start.x, s.start.y, s.goal.x, s.goal.y);
      expect(world.success).toBe(tile.success);
      expect(world.waypoints.length).toBe(tile.waypoints.length);

      // Each world waypoint is the recast (x,z) tile-space point × tileSizeFt,
      // bit-exact (tileSizeFt is a power of two, so the scaling is lossless).
      for (let i = 0; i < world.waypoints.length; i++) {
        const w = world.waypoints[i]!;
        const t = tile.waypoints[i]!;
        expect(w.x).toBe(t.x * ts);
        expect(w.y).toBe(t.z * ts);
      }

      // Determinism of the world query itself (same call twice → identical).
      const again = queryWorldPath(handle, startWX, startWY, goalWX, goalWY);
      expect(serializeWorld(again.waypoints)).toBe(serializeWorld(world.waypoints));
    } finally {
      destroyNavmesh(handle);
    }
  });
});

/** Full-precision serialize of world waypoints (x,y) for equality comparison. */
function serializeWorld(waypoints: readonly { x: number; y: number }[]): string {
  return serializeRecastWaypoints(waypoints.map((w) => ({ x: w.x, y: 0, z: w.y })));
}
