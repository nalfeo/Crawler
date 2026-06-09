/** Tile Definition Schema — data-driven floor tileset configuration.
 *
 * Tiles are described by biome (dungeon, organic, tech, void) and properties
 * (collision, hazard, audio). The same schema supports any floor theme.
 */

export type BiomeTag = 'dungeon' | 'organic' | 'tech' | 'void';
export type Collider = 'none' | 'solid' | 'hazard';
export type Passability = 'walkable' | 'blocked' | 'deadly';

export interface TileDef {
  readonly id: string;
  readonly name: string;
  /** Reference to sprite catalog entry. */
  readonly spriteId: string;
  /** Biome grouping for floor generation. */
  readonly biomeTag: BiomeTag;
  /** Collision behavior. */
  readonly collider: Collider;
  /** Damage per second (hazards only). */
  readonly damagePerSecond: number;
  /** Variant index for multi-sprite tile sets (0 = base, 1..N = variants). */
  readonly variant: number;
  /** Whether entities can walk through this tile. */
  readonly passability: Passability;
  /** Audio cue ID for foot steps / interactions. */
  readonly audioCue: string;
}

function def(
  partial: Partial<TileDef> & Pick<TileDef, 'id' | 'name' | 'spriteId' | 'biomeTag'>,
): TileDef {
  return {
    collider: 'none',
    damagePerSecond: 0,
    variant: 0,
    passability: 'walkable',
    audioCue: 'step-stone',
    ...partial,
  };
}

export const TILE_DEFS: ReadonlyMap<string, TileDef> = new Map([
  // --- DUNGEON Biome ---
  [
    'stone-floor',
    def({
      id: 'stone-floor',
      name: 'Stone Floor',
      spriteId: 'tile-stone-floor',
      biomeTag: 'dungeon',
      passability: 'walkable',
      audioCue: 'step-stone',
    }),
  ],
  [
    'stone-wall',
    def({
      id: 'stone-wall',
      name: 'Stone Wall',
      spriteId: 'tile-stone-wall',
      biomeTag: 'dungeon',
      collider: 'solid',
      passability: 'blocked',
      audioCue: 'impact-stone',
    }),
  ],
  [
    'stone-grate',
    def({
      id: 'stone-grate',
      name: 'Stone Grate',
      spriteId: 'tile-stone-grate',
      biomeTag: 'dungeon',
      passability: 'walkable',
      audioCue: 'step-metal',
    }),
  ],
  [
    'torch-floor',
    def({
      id: 'torch-floor',
      name: 'Torchlit Floor',
      spriteId: 'tile-torch-floor',
      biomeTag: 'dungeon',
      passability: 'walkable',
      audioCue: 'step-stone',
      variant: 0,
    }),
  ],

  // --- ORGANIC Biome ---
  [
    'flesh-floor',
    def({
      id: 'flesh-floor',
      name: 'Flesh Floor',
      spriteId: 'tile-flesh-floor',
      biomeTag: 'organic',
      passability: 'walkable',
      audioCue: 'step-wet',
    }),
  ],
  [
    'flesh-wall',
    def({
      id: 'flesh-wall',
      name: 'Flesh Wall',
      spriteId: 'tile-flesh-wall',
      biomeTag: 'organic',
      collider: 'solid',
      passability: 'blocked',
      audioCue: 'impact-flesh',
    }),
  ],
  [
    'bone-tile',
    def({
      id: 'bone-tile',
      name: 'Bone Tile',
      spriteId: 'tile-bone',
      biomeTag: 'organic',
      passability: 'walkable',
      audioCue: 'step-bone',
    }),
  ],
  [
    'blood-pool',
    def({
      id: 'blood-pool',
      name: 'Blood Pool',
      spriteId: 'tile-blood-pool',
      biomeTag: 'organic',
      collider: 'hazard',
      damagePerSecond: 5,
      passability: 'deadly',
      audioCue: 'step-wet',
    }),
  ],

  // --- TECH Biome ---
  [
    'metal-plate',
    def({
      id: 'metal-plate',
      name: 'Metal Plate',
      spriteId: 'tile-metal-plate',
      biomeTag: 'tech',
      passability: 'walkable',
      audioCue: 'step-metal',
    }),
  ],
  [
    'circuit-tile',
    def({
      id: 'circuit-tile',
      name: 'Circuit Tile',
      spriteId: 'tile-circuit',
      biomeTag: 'tech',
      passability: 'walkable',
      audioCue: 'step-electric',
    }),
  ],
  [
    'energy-barrier',
    def({
      id: 'energy-barrier',
      name: 'Energy Barrier',
      spriteId: 'tile-energy-barrier',
      biomeTag: 'tech',
      collider: 'hazard',
      damagePerSecond: 10,
      passability: 'deadly',
      audioCue: 'impact-electric',
    }),
  ],
  [
    'neon-floor',
    def({
      id: 'neon-floor',
      name: 'Neon Floor',
      spriteId: 'tile-neon-floor',
      biomeTag: 'tech',
      passability: 'walkable',
      audioCue: 'step-neon',
    }),
  ],

  // --- VOID Biome ---
  [
    'void-tile',
    def({
      id: 'void-tile',
      name: 'Void Tile',
      spriteId: 'tile-void',
      biomeTag: 'void',
      passability: 'walkable',
      audioCue: 'step-void',
    }),
  ],
  [
    'corrupted-wall',
    def({
      id: 'corrupted-wall',
      name: 'Corrupted Wall',
      spriteId: 'tile-corrupted-wall',
      biomeTag: 'void',
      collider: 'solid',
      passability: 'blocked',
      audioCue: 'impact-void',
    }),
  ],
  [
    'rift',
    def({
      id: 'rift',
      name: 'Rift',
      spriteId: 'tile-rift',
      biomeTag: 'void',
      collider: 'hazard',
      damagePerSecond: 20,
      passability: 'deadly',
      audioCue: 'impact-void',
    }),
  ],
  [
    'starfield-floor',
    def({
      id: 'starfield-floor',
      name: 'Starfield Floor',
      spriteId: 'tile-starfield',
      biomeTag: 'void',
      passability: 'walkable',
      audioCue: 'step-void',
    }),
  ],
]);

export function getTileDef(id: string): TileDef | undefined {
  return TILE_DEFS.get(id);
}

export function getTilesByBiome(biome: BiomeTag): TileDef[] {
  return Array.from(TILE_DEFS.values()).filter((t) => t.biomeTag === biome);
}
