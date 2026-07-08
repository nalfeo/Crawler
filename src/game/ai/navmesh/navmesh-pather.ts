/**
 * Deterministic navmesh path source for Crawler AI (game layer).
 *
 * Wraps `recast-navigation` (a WASM port of Recast & Detour) behind a small,
 * fully-deterministic API used by {@link AIPathingMode.NAVMESH}: build one solo
 * navmesh per floor from tile passability, then answer shortest-path waypoint
 * queries. The Slice-1 spike proved these queries are CROSS-PLATFORM
 * byte-identical under the pinned config in `./navmesh-config.ts` (Windows local
 * == Linux CI), which is what lets a navmesh feed Crawler's deterministic
 * headless win-rate gate.
 *
 * LAYERING: this lives in `src/game/ai/` (game). It imports recast from
 * node_modules and a STRUCTURAL floor type (never `src/core/**` directly), and
 * keeps all recast/WASM handling out of `src/core/`.
 *
 * DETERMINISM CONTRACT (do not break):
 *  - Forces the REAL `.wasm` build (never the asm.js compat default — different
 *    float path). See `./navmesh-wasm-node.ts` for the #1-footgun rationale.
 *  - `setRandomSeed(0)` post-init.
 *  - Every recast parameter is pinned in `./navmesh-config.ts` (the SSOT).
 *  - No Math.random / Date.now anywhere in the build or query path.
 */
import { init, NavMeshQuery, exportNavMesh, setRandomSeed } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import RecastWasm from '@recast-navigation/wasm/wasm';
import {
  NAVMESH_SCALE,
  NAVMESH_PINNED_CONFIG,
  NAVMESH_QUERY_HALF_EXTENTS,
  NAVMESH_PATH_LIMITS,
  NAVMESH_QUAD_INDICES,
  NAVMESH_RANDOM_SEED,
} from './navmesh-config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal structural view of a `FloorMap` the navmesh builder needs. Declared
 * structurally (not imported from `src/core/**`) so this game-layer module stays
 * decoupled from core and trivially unit-testable. A real `FloorMap` satisfies
 * it.
 */
export interface NavmeshFloorSource {
  /** Map width in tiles. */
  readonly width: number;
  /** Map height in tiles. */
  readonly height: number;
  /** Map config — only the world-scale conversion factor is needed. */
  readonly config: { readonly tileSizeFt: number };
  /**
   * Tile passability + door lookup (same semantics as `FloorMap.tileMap`).
   *
   * A tile contributes a walkable navmesh quad when `isPassable` is true OR it is
   * a door tile (`isDoor`). Door tiles are NOT passable in the raw generated map
   * (each room is otherwise a sealed island), but the runtime treats them as
   * walkable — the AI's door-aware A* (`buildDoorAwarePassable` in
   * `src/core/door-navigation.ts`) auto-opens unlocked doors on approach. If the
   * navmesh omitted door tiles it would shatter into disconnected per-room polys
   * and every path would dead-end at the first doorway. `isDoor` is optional so
   * synthetic test sources (open grids) need not implement it.
   */
  readonly tileMap: {
    isPassable(tileX: number, tileY: number): boolean;
    isDoor?(tileX: number, tileY: number): boolean;
  };
}

type SoloNavMeshResult = ReturnType<typeof generateSoloNavMesh>;
type NavMeshInstance = NonNullable<SoloNavMeshResult['navMesh']>;
type NavMeshQueryInstance = InstanceType<typeof NavMeshQuery>;

/** A built, queryable navmesh for one floor. Free with {@link destroyNavmesh}. */
export interface NavmeshHandle {
  readonly navMesh: NavMeshInstance;
  readonly query: NavMeshQueryInstance;
  /** Map width in tiles (recast X extent). */
  readonly width: number;
  /** Map height in tiles (recast Z extent). */
  readonly height: number;
  /** Feet-per-tile scale used to convert world feet ↔ recast tile units. */
  readonly tileSizeFt: number;
  readonly passableTiles: number;
  readonly triangleCount: number;
}

/** World-space (feet) waypoint. */
export interface WorldWaypoint {
  x: number;
  y: number;
}

/** Result of a world-space path query. */
export interface WorldPathResult {
  success: boolean;
  waypoints: WorldWaypoint[];
}

/** Raw recast-space waypoint (X east, Y up, Z south) — full precision, no conversion. */
export interface RecastWaypoint {
  x: number;
  y: number;
  z: number;
}

/** Result of a tile-space path query (raw recast coordinates). */
export interface RecastPathResult {
  success: boolean;
  waypoints: RecastWaypoint[];
}

// ─── WASM init (idempotent, environment-aware) ─────────────────────────────────

let initState: 'uninitialized' | 'ready' = 'uninitialized';
let initPromise: Promise<void> | null = null;

function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null &&
    typeof window === 'undefined'
  );
}

/**
 * Initialise the recast WASM runtime, forcing the REAL `.wasm` build and pinning
 * the Detour PRNG seed. Idempotent and concurrency-safe: repeated/parallel calls
 * share one init. MUST be awaited (once) by any caller before the synchronous
 * {@link buildFloorNavmesh}/{@link queryWorldPath} run — e.g. the headless
 * runner's caller, the A/B harness, the lab, and determinism tests.
 */
export async function initNavmesh(): Promise<void> {
  if (initState === 'ready') return;
  if (initPromise) return initPromise;
  initPromise = (async (): Promise<void> => {
    if (isNodeRuntime()) {
      // Node: recast's Emscripten glue would try to fetch() the .wasm URL (fails
      // under Node), so read the bytes ourselves and inject them as `wasmBinary`.
      // The node-only helper is isolated + `@vite-ignore`d so Vite never pulls
      // node builtins into the browser bundle.
      const { readRecastWasmBinary } = await import(/* @vite-ignore */ './navmesh-wasm-node.js');
      const wasmBinary = await readRecastWasmBinary();
      await init((() => RecastWasm({ wasmBinary })) as unknown as typeof RecastWasm);
    } else {
      // Browser (lab/game): Emscripten resolves + fetches the real `.wasm` asset
      // itself (Vite emits it from the glue's `new URL(...)`).
      await init((() => RecastWasm()) as unknown as typeof RecastWasm);
    }
    // Detour FastRand is used ONLY by findRandomPoint*, never by computePath; pin
    // it anyway so nothing in the process can perturb the PRNG.
    setRandomSeed(NAVMESH_RANDOM_SEED);
    initState = 'ready';
  })();
  try {
    await initPromise;
  } catch (err) {
    // Allow a later retry after a failed init.
    initPromise = null;
    throw err;
  }
}

/** True once {@link initNavmesh} has resolved. */
export function isNavmeshReady(): boolean {
  return initState === 'ready';
}

function assertReady(): void {
  if (initState !== 'ready') {
    throw new Error('navmesh: initNavmesh() must be awaited before building/querying a navmesh');
  }
}

// ─── Geometry ──────────────────────────────────────────────────────────────────

/**
 * Emit one flat quad (two triangles, +Y-up winding) per NAVIGABLE tile on the
 * Y=0 plane, in tile-space (SCALE=1). A tile is navigable when it is passable OR
 * a door (see {@link NavmeshFloorSource.tileMap}) — door tiles connect the
 * otherwise-sealed rooms, so omitting them shatters the mesh. Winding is
 * {@link NAVMESH_QUAD_INDICES} so the surface normal points +Y and recast treats
 * it as walkable ground.
 */
function buildGeometry(floor: NavmeshFloorSource): {
  positions: number[];
  indices: number[];
  passable: number;
} {
  const positions: number[] = [];
  const indices: number[] = [];
  const w = floor.width;
  const h = floor.height;
  const tileMap = floor.tileMap;
  const isNavigable = (tx: number, ty: number): boolean =>
    tileMap.isPassable(tx, ty) || (tileMap.isDoor?.(tx, ty) ?? false);
  let passable = 0;
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (!isNavigable(tx, ty)) continue;
      passable++;
      const x0 = tx * NAVMESH_SCALE;
      const x1 = (tx + 1) * NAVMESH_SCALE;
      const z0 = ty * NAVMESH_SCALE;
      const z1 = (ty + 1) * NAVMESH_SCALE;
      const base = positions.length / 3;
      // 4 corners on the Y=0 plane: (x0,z0) (x1,z0) (x1,z1) (x0,z1).
      positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
      for (const idx of NAVMESH_QUAD_INDICES) indices.push(base + idx);
    }
  }
  return { positions, indices, passable };
}

// ─── Build + query ───────────────────────────────────────────────────────────

/**
 * Build a solo navmesh for one floor under the pinned deterministic config.
 * Throws if {@link initNavmesh} was not awaited or if recast fails to build.
 * The returned handle owns WASM objects — free it with {@link destroyNavmesh}.
 */
export function buildFloorNavmesh(floor: NavmeshFloorSource): NavmeshHandle {
  assertReady();
  const { positions, indices, passable } = buildGeometry(floor);
  const w = floor.width;
  const h = floor.height;
  const bounds: [[number, number, number], [number, number, number]] = [
    [0, -1, 0],
    [w * NAVMESH_SCALE, 1, h * NAVMESH_SCALE],
  ];
  const res = generateSoloNavMesh(positions, indices, { ...NAVMESH_PINNED_CONFIG, bounds });
  if (!res.success || !res.navMesh) {
    throw new Error(`navmesh: solo build failed: ${res.error ?? 'unknown error'}`);
  }
  const query = new NavMeshQuery(res.navMesh);
  return {
    navMesh: res.navMesh,
    query,
    width: w,
    height: h,
    tileSizeFt: floor.config.tileSizeFt,
    passableTiles: passable,
    triangleCount: indices.length / 3,
  };
}

/** Free the WASM objects backing a handle (call on floor change / teardown). */
export function destroyNavmesh(handle: NavmeshHandle): void {
  const q = handle.query as { destroy?: () => void };
  const n = handle.navMesh as { destroy?: () => void };
  q.destroy?.();
  n.destroy?.();
}

/**
 * World-space (feet) shortest-path query used by the runtime AI. Converts feet →
 * recast tile-units (`÷ tileSizeFt`, exact for power-of-two feet), runs
 * `computePath`, and converts each waypoint back to world feet (`× tileSizeFt`).
 * World Y (feet, "south") maps to recast Z; recast Y (up) is ignored (flat).
 * Fully deterministic: no Math.random / Date.now, and the float conversions are
 * IEEE-754 bit-identical cross-platform.
 */
export function queryWorldPath(
  handle: NavmeshHandle,
  startWorldX: number,
  startWorldY: number,
  goalWorldX: number,
  goalWorldY: number,
): WorldPathResult {
  assertReady();
  const ts = handle.tileSizeFt;
  const start = { x: startWorldX / ts, y: 0, z: startWorldY / ts };
  const goal = { x: goalWorldX / ts, y: 0, z: goalWorldY / ts };
  const path = handle.query.computePath(start, goal, {
    halfExtents: NAVMESH_QUERY_HALF_EXTENTS,
    ...NAVMESH_PATH_LIMITS,
  });
  const waypoints: WorldWaypoint[] = [];
  for (const p of path.path) waypoints.push({ x: p.x * ts, y: p.z * ts });
  return { success: path.success, waypoints };
}

/**
 * Tile-space shortest-path query that snaps start/goal to their TILE CENTERS
 * (`tile + 0.5`) and returns RAW recast waypoints (no world conversion). This is
 * the primitive the determinism regression test uses to reproduce the Slice-1
 * spike's golden hash byte-for-byte, proving the pinned config is intact.
 */
export function computeTilePath(
  handle: NavmeshHandle,
  startTileX: number,
  startTileY: number,
  goalTileX: number,
  goalTileY: number,
): RecastPathResult {
  assertReady();
  const start = {
    x: (startTileX + 0.5) * NAVMESH_SCALE,
    y: 0,
    z: (startTileY + 0.5) * NAVMESH_SCALE,
  };
  const goal = { x: (goalTileX + 0.5) * NAVMESH_SCALE, y: 0, z: (goalTileY + 0.5) * NAVMESH_SCALE };
  const path = handle.query.computePath(start, goal, {
    halfExtents: NAVMESH_QUERY_HALF_EXTENTS,
    ...NAVMESH_PATH_LIMITS,
  });
  const waypoints: RecastWaypoint[] = path.path.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  return { success: path.success, waypoints };
}

// ─── Deterministic serialisation primitives (used by the regression test) ──────

const _f64 = new DataView(new ArrayBuffer(8));

/** Lossless full-precision serialisation of a number: 16-char big-endian hex of its IEEE-754 bits. */
export function float64Hex(n: number): string {
  _f64.setFloat64(0, n, false);
  return _f64.getBigUint64(0, false).toString(16).padStart(16, '0');
}

/** FNV-1a 32-bit over a string — stable, dependency-free (matches the golden tests). */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** FNV-1a 32-bit over bytes. */
export function fnv1aBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Concatenated float64 big-endian hex of every waypoint (x,y,z) — full precision. */
export function serializeRecastWaypoints(waypoints: readonly RecastWaypoint[]): string {
  let hex = '';
  for (const p of waypoints) hex += float64Hex(p.x) + float64Hex(p.y) + float64Hex(p.z);
  return hex;
}

/** Export the built navmesh to its portable binary form (for hashing/diffing). */
export function exportNavmeshBytes(handle: NavmeshHandle): Uint8Array {
  return exportNavMesh(handle.navMesh);
}
