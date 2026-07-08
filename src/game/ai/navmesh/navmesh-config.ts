/**
 * Pinned, load-bearing navmesh determinism configuration — the SINGLE SOURCE OF
 * TRUTH for every recast/Detour parameter Crawler's navmesh pathing depends on.
 *
 * WHY EVERY FIELD IS PINNED
 * -------------------------
 * The Slice-1 de-risking spike proved `recast-navigation` (a WASM port of Recast
 * & Detour) produces CROSS-PLATFORM byte-identical `computePath` results — the
 * pre-condition for ever letting a navmesh feed Crawler's sacred deterministic
 * Floor-1 headless win-rate gate (same seed → byte-identical simulation, Windows
 * local == Linux CI). That determinism only holds under an EXACT config; library
 * defaults can drift across versions and silently invalidate the proof. So the
 * config is enforced in code here (never left to defaults) and locked by the
 * `tests/determinism/navmesh-determinism.test.ts` golden-hash regression test.
 *
 * DO NOT change these values without re-running the cross-platform spike and
 * re-baselining the golden determinism hash — a change here is a change to the
 * simulation's byte identity.
 *
 * Rationale per field (from the spike; see
 * docs/knowledge/handoffs/2026-07-07-navmesh-determinism-spike.md):
 *  - Point agent (`walkableRadius: 0`): no erosion, so 1-tile corridors are not
 *    shrunk away — a pre-condition for routing through the dungeon's narrow
 *    doorways at all.
 *  - `cs`/`ch: 0.25` (NOT 0.5 — 4 cells per tile, not 2): the Slice-3 build
 *    discovered that 2-cell-wide passages (a 1-tile corridor/doorway at cs 0.5)
 *    get pinched off by contour/region building, so the navmesh SHATTERS into
 *    per-room islands and every `computePath` degrades to a 2-point stub that
 *    never leaves the spawn room. At cs 0.25 a 1-tile passage is 4 cells wide and
 *    survives, so paths route end-to-end (seed-42: 45/45 room centers reached vs
 *    1/45 at cs 0.5). 0.25 is exactly representable in IEEE-754, so it introduces
 *    no new float error. The Slice-1 spike hashed cs 0.5 and only ever produced
 *    those stubs — its determinism proof held, but on degenerate paths; cs 0.25
 *    is the corrected value and required its own cross-platform re-proof.
 *  - `minRegionArea: 8` (NOT 1): a tiny min-region can explode the region count
 *    and overflow `buildPolyMeshDetail` (crash). 8 is the library default; pinned
 *    so it never drifts.
 *  - `detailSampleDist: 6` / `detailSampleMaxError: 1`: safe defaults; on flat
 *    ground the detail mesh is trivial regardless.
 *  - Watershed partitioning (generateSoloNavMesh's built-in) is a deterministic
 *    flood-fill given identical float input.
 */

/**
 * World scale: 1 tile → 1 recast world unit. Tile (tx,ty) maps to the XZ ground
 * plane; Y is up (recast convention). All geometry coordinates are then integers
 * (and query points half-integers), exactly representable in IEEE-754 — this
 * removes input float error as a variable and isolates determinism to recast's
 * own math. World feet ↔ recast units convert via `± tileSizeFt` at the edges.
 */
export const NAVMESH_SCALE = 1;

/**
 * The EXACT deterministic solo-navmesh RecastConfig. Bounds are supplied per
 * build (they depend on map dimensions) — everything else is frozen here.
 */
export const NAVMESH_PINNED_CONFIG = Object.freeze({
  borderSize: 0,
  tileSize: 0,
  cs: 0.25, // cell size (world units) — 4 cells per tile; 1-tile corridors = 4 cells wide (survive contour build)
  ch: 0.25, // cell height
  walkableSlopeAngle: 45,
  walkableHeight: 1,
  walkableClimb: 0,
  walkableRadius: 0, // point agent — 1-tile corridors survive
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8, // NOT 1 (would crash buildPolyMeshDetail)
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
} as const);

/**
 * Half-extents used by `computePath` to snap query start/goal onto the navmesh
 * (world/recast units). Generous on Y (flat ground at Y=0) and ±4 on XZ so a
 * point that lands just off a poly edge still snaps to the nearest passable
 * surface.
 */
export const NAVMESH_QUERY_HALF_EXTENTS = { x: 4, y: 8, z: 4 } as const;

/** Path-buffer caps passed to `computePath` (pinned; large enough for Floor-1). */
export const NAVMESH_PATH_LIMITS = {
  maxPathPolys: 2048,
  maxStraightPathPoints: 2048,
} as const;

/**
 * Triangle winding for a passable tile's ground quad, emitted so the surface
 * normal points +Y (walkable). Corners are pushed in order
 * `(x0,z0) (x1,z0) (x1,z1) (x0,z1)`; these two triangles `(0,2,1)` and `(0,3,2)`
 * are CCW seen from above. WRONG winding → "Failed to create Detour navmesh
 * data". Pinned as the load-bearing geometry contract.
 */
export const NAVMESH_QUAD_INDICES = [0, 2, 1, 0, 3, 2] as const;

/** Detour FastRand seed pinned post-init. computePath never uses it; this is
 * belt-and-suspenders so nothing in the process can perturb the PRNG. */
export const NAVMESH_RANDOM_SEED = 0;
