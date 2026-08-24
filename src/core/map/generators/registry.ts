/**
 * Generator registry — maps BiomeType to MapGenerator instances.
 *
 * Extensible: add new generators by calling register().
 */

import { BiomeType } from '../../../shared/map-types';
import type { MapGenerator } from './types';
import { DungeonGenerator } from './DungeonGenerator';
import { CaveGenerator } from './CaveGenerator';
import { ArenaGenerator } from './ArenaGenerator';
import { CaveSystemGenerator } from './cave-system';
import { ShowcaseArenaGenerator } from './ShowcaseArenaGenerator';

const registry = new Map<BiomeType, MapGenerator>();

/** Register a generator for a biome type. */
export function registerGenerator(biome: BiomeType, generator: MapGenerator): void {
  registry.set(biome, generator);
}

/** Get the generator for a biome type. Throws if not registered. */
export function getGenerator(biome: BiomeType): MapGenerator {
  const gen = registry.get(biome);
  if (!gen) {
    throw new Error(`No generator registered for biome: ${biome}`);
  }
  return gen;
}

/** Check if a biome has a registered generator. */
export function hasGenerator(biome: BiomeType): boolean {
  return registry.has(biome);
}

/** Get all registered biome types. */
export function getRegisteredBiomes(): BiomeType[] {
  return [...registry.keys()];
}

// --- Register built-in generators ---

const dungeonGen = new DungeonGenerator();
registerGenerator(BiomeType.DUNGEON, dungeonGen);
registerGenerator(BiomeType.CASTLE, dungeonGen);
registerGenerator(
  BiomeType.BASIC_UNDERGROUND,
  new DungeonGenerator({ roomVariety: true, caveRegions: true }),
);

registerGenerator(BiomeType.CAVE, new CaveGenerator());
registerGenerator(
  BiomeType.FIRE_SWAMP,
  new CaveGenerator({
    initialFill: 0.55,
    born: [4, 5, 6, 7, 8],
    survive: [3, 4, 5, 6, 7, 8],
    smoothingPasses: 3,
  }),
);

const arenaGen = new ArenaGenerator();
registerGenerator(BiomeType.ARENA, arenaGen);
// Forest and town will be added in future phases
registerGenerator(BiomeType.FOREST, new CaveGenerator({ initialFill: 0.4, smoothingPasses: 5 }));
registerGenerator(BiomeType.OPEN_WORLD, arenaGen); // placeholder
registerGenerator(BiomeType.TOWN, arenaGen); // placeholder

// Floor 2 — open cave system with 3–4 family territories, boss dens, settlement,
// and a central resource-heart cavern. Slice 8 will pass presentCount through
// the manifest; today the generator defaults to 4.
// TODO(floor2-slice-8): wire presentCount + family roster from manifest.
registerGenerator(BiomeType.CAVE_SYSTEM, new CaveSystemGenerator());
registerGenerator(
  BiomeType.CAVE_SYSTEM_BIOMES,
  new CaveSystemGenerator({ layout: 'floor3-biomes' }),
);

// Floor 4 — the authored broadcast venue (arena + curtain tunnel + Green Room).
// Consumes no RNG: the geometry is authored, and only the manifest's
// `showcaseArena` block moves it.
registerGenerator(BiomeType.SHOWCASE_ARENA, new ShowcaseArenaGenerator());
