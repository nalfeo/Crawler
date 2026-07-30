/**
 * Terrain Pack Registry — centralized, fail-fast terrain-pack manifest loader.
 *
 * Mirrors the `floor-registry.ts` / `floor-manifest.ts` pattern: manifest JSON
 * files are imported statically (bundled, no runtime fetch), parsed through
 * the strict `terrainPackDefSchema` at module-initialization time (so a
 * malformed/incomplete manifest fails the build immediately, not at first
 * floor-load), and exposed via `getTerrainPack(id)` keyed by the
 * registry-backed `TerrainPackId` enum (refinement #6 — a typo'd
 * `terrainPackId` in a floor manifest fails Zod validation long before it
 * would reach this registry).
 */
import industrialCaveManifestJson from './data/terrain-packs/industrial-cave.manifest.json';
import floor1DungeonManifestJson from './data/terrain-packs/floor1-dungeon.manifest.json';
import floor1CaveManifestJson from './data/terrain-packs/floor1-cave.manifest.json';
import caelesFixtureManifestJson from './data/terrain-packs/caeles-fixture.manifest.json';
import {
  terrainPackDefSchema,
  type TerrainPackDef,
  type TerrainPackId,
  type RuntimeTerrainPackId,
  TERRAIN_PACK_IDS,
  RUNTIME_TERRAIN_PACK_IDS,
} from './terrain-pack-types.js';

function loadTerrainPack(id: TerrainPackId): TerrainPackDef {
  let manifestJson: unknown;
  if (id === 'industrial-cave') {
    manifestJson = industrialCaveManifestJson;
  } else if (id === 'floor1-dungeon') {
    manifestJson = floor1DungeonManifestJson;
  } else if (id === 'floor1-cave') {
    manifestJson = floor1CaveManifestJson;
  } else if (id === 'caeles-fixture') {
    manifestJson = caelesFixtureManifestJson;
  } else {
    // Exhaustiveness guard: TERRAIN_PACK_IDS must list every id handled above.
    throw new Error(`Terrain pack manifest not found: ${id satisfies never}`);
  }
  return terrainPackDefSchema.parse(manifestJson);
}

const TERRAIN_PACK_REGISTRY: ReadonlyMap<TerrainPackId, TerrainPackDef> = new Map(
  TERRAIN_PACK_IDS.map((id) => [id, loadTerrainPack(id)]),
);

/** Look up a validated terrain pack definition by its registry-backed id. */
export function getTerrainPack(id: TerrainPackId): TerrainPackDef {
  const pack = TERRAIN_PACK_REGISTRY.get(id);
  if (!pack) {
    throw new Error(`Terrain pack not registered: ${id}`);
  }
  return pack;
}

/** All registered terrain-pack ids, in declaration order. */
export function getAllTerrainPackIds(): readonly TerrainPackId[] {
  return TERRAIN_PACK_IDS;
}

/** Runtime-only terrain pack ids — preloadable at boot, valid in floor manifests. */
export function getAllRuntimeTerrainPackIds(): readonly RuntimeTerrainPackId[] {
  return RUNTIME_TERRAIN_PACK_IDS;
}
