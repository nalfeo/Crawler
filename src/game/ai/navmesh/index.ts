/**
 * Deterministic navmesh path source for Crawler AI ({@link AIPathingMode.NAVMESH}
 * and {@link AIPathingMode.NAVMESH_FUSED}, which share this exact query layer).
 * See `./navmesh-pather.ts` for the API and `./navmesh-config.ts` for the pinned,
 * load-bearing determinism config.
 */
export {
  initNavmesh,
  isNavmeshReady,
  buildFloorNavmesh,
  destroyNavmesh,
  queryWorldPath,
  computeTilePath,
  float64Hex,
  fnv1a,
  fnv1aBytes,
  serializeRecastWaypoints,
  exportNavmeshBytes,
  type NavmeshFloorSource,
  type NavmeshHandle,
  type WorldWaypoint,
  type WorldPathResult,
  type RecastWaypoint,
  type RecastPathResult,
} from './navmesh-pather.js';
export {
  NAVMESH_SCALE,
  NAVMESH_PINNED_CONFIG,
  NAVMESH_QUERY_HALF_EXTENTS,
  NAVMESH_PATH_LIMITS,
  NAVMESH_QUAD_INDICES,
  NAVMESH_RANDOM_SEED,
} from './navmesh-config.js';
