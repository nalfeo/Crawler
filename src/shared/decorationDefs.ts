/** Decoration Definition Schema — data-driven scene dressing configuration.
 *
 * Decorations are non-interactive ambient objects: torches, rubble, vines, etc.
 * They layer depth, scale, and animation to create visual richness without gameplay impact.
 */

import type { BiomeTag } from './biome-tags.js';

export type DepthLayer = 'back' | 'mid' | 'front';

/**
 * Category tag for prop filtering (used by floor manifests via `allowedCategories`).
 */
export type PropCategory = 'rubbish' | 'light-source' | 'structural' | 'organic' | 'tech';

/**
 * Placement zone controls which terrain tiles are valid candidates for a prop.
 * The prop placer resolves each zone against `floorMap.terrain` at spawn time.
 */
export type PlacementZone =
  | 'anywhere' // any passable non-special tile (room, corridor, cave)
  | 'room-only' // STONE_FLOOR tiles that belong to a RoomRole.NORMAL room
  | 'cave-only' // CAVE_FLOOR tiles only (cave sub-regions)
  | 'corridor-only' // CORRIDOR tiles only
  | 'wall-adjacent'; // passable tile with ≥1 adjacent wall tile (for sconces, etc.)

/** Light emission parameters for props that act as secondary light sources. */
export interface LightEmission {
  /** Emission radius in feet. */
  readonly radiusFt: number;
  /** Intensity 0–1. */
  readonly intensity: number;
  /** Packed 0xRRGGBB light colour. */
  readonly colorHex: number;
}

export interface DecorationDef {
  readonly id: string;
  readonly name: string;
  /** Reference to sprite catalog entry. */
  readonly spriteId: string;
  /** Biome grouping for floor generation. */
  readonly biomeTag: BiomeTag;
  /** Semantic category used by floor-manifest allowedCategories filtering. */
  readonly category: PropCategory;
  /** Placement zone — which terrain tiles are valid spawn candidates. */
  readonly placementZone: PlacementZone;
  /** Size multiplier relative to base (1.0 = 100%). */
  readonly scale: number;
  /** Fixed rotation in degrees, or -1 for random. */
  readonly rotation: number;
  /** Whether this decoration animates. */
  readonly isAnimated: boolean;
  /** Frame count for animated sprites (1 = static). */
  readonly animationFrames: number;
  /** Render layer depth (back to front). */
  readonly depthLayer: DepthLayer;
  /** Spawn density: average count per 1000 floor square-feet. */
  readonly density: number;
  /** Whether this decoration can be destroyed (for loot). */
  readonly isDestructible: boolean;
  /** Optional loot table ID if destructible. */
  readonly lootTableId?: string;
  /** Optional light emission — present on props that emit a secondary light source. */
  readonly lightEmission?: LightEmission;
  /**
   * Prop weight in lb. Consumed by `knockbackSystem` (see ADR 0044 / Slice 2)
   * to scale knockback displacement. Every entity with `Prop` MUST have a
   * positive weight — `scripts/agent/health/check-weight-coverage.ts` fails CI
   * if a spawner regresses. Defaults to 100 lb (a medium crate/table) via the
   * `def(...)` factory; individual entries may override for stone/statue-class
   * props that should shrug off knockback.
   */
  readonly weight?: number;
}

function def(
  partial: Partial<DecorationDef> &
    Pick<DecorationDef, 'id' | 'name' | 'spriteId' | 'biomeTag' | 'category' | 'placementZone'>,
): DecorationDef {
  return {
    scale: 1.0,
    rotation: 0,
    isAnimated: false,
    animationFrames: 1,
    depthLayer: 'mid',
    density: 0.05,
    isDestructible: false,
    weight: 100,
    ...partial,
  };
}

export const DECORATION_DEFS: ReadonlyMap<string, DecorationDef> = new Map([
  // --- DUNGEON ---
  [
    'torch',
    def({
      id: 'torch',
      name: 'Torch',
      spriteId: 'prop-torch-var-10',
      biomeTag: 'dungeon',
      category: 'light-source',
      placementZone: 'wall-adjacent',
      scale: 1.2,
      rotation: 0,
      isAnimated: true,
      animationFrames: 4,
      depthLayer: 'back',
      density: 0.08,
      lightEmission: { radiusFt: 20, intensity: 0.7, colorHex: 0xffb347 },
    }),
  ],
  [
    'stone-pillar',
    def({
      id: 'stone-pillar',
      name: 'Stone Pillar',
      spriteId: 'deco-stone-pillar',
      biomeTag: 'dungeon',
      category: 'structural',
      placementZone: 'room-only',
      scale: 1.5,
      rotation: 0,
      depthLayer: 'mid',
      density: 0.03,
      isDestructible: true,
      lootTableId: 'pillar-rubble',
    }),
  ],
  [
    'barrel',
    def({
      id: 'barrel',
      name: 'Barrel',
      spriteId: 'deco-barrel',
      biomeTag: 'dungeon',
      category: 'structural',
      placementZone: 'room-only',
      scale: 0.9,
      rotation: 0,
      depthLayer: 'mid',
      density: 0.06,
      isDestructible: true,
      lootTableId: 'barrel-contents',
    }),
  ],
  [
    'rubble',
    def({
      id: 'rubble',
      name: 'Rubble Pile',
      spriteId: 'prop-rubble-pile-var-1',
      biomeTag: 'dungeon',
      category: 'rubbish',
      placementZone: 'anywhere',
      scale: 1.1,
      rotation: -1,
      depthLayer: 'mid',
      density: 0.1,
    }),
  ],
  [
    'chain',
    def({
      id: 'chain',
      name: 'Hanging Chain',
      spriteId: 'deco-chain',
      biomeTag: 'dungeon',
      category: 'structural',
      placementZone: 'wall-adjacent',
      scale: 1.0,
      rotation: 0,
      isAnimated: true,
      animationFrames: 2,
      depthLayer: 'front',
      density: 0.04,
    }),
  ],

  // --- ORGANIC ---
  [
    'vine',
    def({
      id: 'vine',
      name: 'Vine',
      spriteId: 'deco-vine',
      biomeTag: 'organic',
      category: 'organic',
      placementZone: 'cave-only',
      scale: 1.3,
      rotation: -1,
      depthLayer: 'back',
      density: 0.12,
    }),
  ],
  [
    'skull-pile',
    def({
      id: 'skull-pile',
      name: 'Skull Pile',
      spriteId: 'deco-skull-pile',
      biomeTag: 'organic',
      category: 'organic',
      placementZone: 'anywhere',
      scale: 1.1,
      rotation: -1,
      depthLayer: 'mid',
      density: 0.07,
    }),
  ],
  [
    'bone-arch',
    def({
      id: 'bone-arch',
      name: 'Bone Arch',
      spriteId: 'deco-bone-arch',
      biomeTag: 'organic',
      category: 'organic',
      placementZone: 'anywhere',
      scale: 1.5,
      rotation: 0,
      depthLayer: 'mid',
      density: 0.02,
      isDestructible: true,
      lootTableId: 'bone-dust',
    }),
  ],
  [
    'pustule',
    def({
      id: 'pustule',
      name: 'Pustule',
      spriteId: 'deco-pustule',
      biomeTag: 'organic',
      category: 'organic',
      placementZone: 'cave-only',
      scale: 0.8,
      rotation: 0,
      isAnimated: true,
      animationFrames: 3,
      depthLayer: 'mid',
      density: 0.09,
      isDestructible: true,
      lootTableId: 'pustule-ooze',
    }),
  ],
  [
    'moss-patch',
    def({
      id: 'moss-patch',
      name: 'Moss Patch',
      spriteId: 'deco-moss',
      biomeTag: 'organic',
      category: 'organic',
      placementZone: 'cave-only',
      scale: 1.2,
      rotation: -1,
      depthLayer: 'back',
      density: 0.15,
    }),
  ],

  // --- TECH ---
  [
    'light-panel',
    def({
      id: 'light-panel',
      name: 'Light Panel',
      spriteId: 'deco-light-panel',
      biomeTag: 'tech',
      category: 'light-source',
      placementZone: 'wall-adjacent',
      scale: 1.0,
      rotation: 0,
      isAnimated: true,
      animationFrames: 2,
      depthLayer: 'back',
      density: 0.06,
    }),
  ],
  [
    'server-stack',
    def({
      id: 'server-stack',
      name: 'Server Stack',
      spriteId: 'deco-server-stack',
      biomeTag: 'tech',
      category: 'tech',
      placementZone: 'room-only',
      scale: 1.2,
      rotation: 0,
      depthLayer: 'mid',
      density: 0.04,
      isDestructible: true,
      lootTableId: 'circuits',
    }),
  ],
  [
    'cable-bundle',
    def({
      id: 'cable-bundle',
      name: 'Cable Bundle',
      spriteId: 'deco-cable',
      biomeTag: 'tech',
      category: 'tech',
      placementZone: 'anywhere',
      scale: 1.1,
      rotation: -1,
      depthLayer: 'mid',
      density: 0.08,
    }),
  ],
  [
    'hologram',
    def({
      id: 'hologram',
      name: 'Hologram',
      spriteId: 'deco-hologram',
      biomeTag: 'tech',
      category: 'tech',
      placementZone: 'room-only',
      scale: 1.0,
      rotation: 0,
      isAnimated: true,
      animationFrames: 4,
      depthLayer: 'front',
      density: 0.03,
    }),
  ],

  // --- VOID ---
  [
    'crystal-shard',
    def({
      id: 'crystal-shard',
      name: 'Crystal Shard',
      spriteId: 'deco-crystal-shard',
      biomeTag: 'void',
      category: 'structural',
      placementZone: 'anywhere',
      scale: 1.1,
      rotation: -1,
      depthLayer: 'mid',
      density: 0.1,
    }),
  ],
  [
    'void-orb',
    def({
      id: 'void-orb',
      name: 'Void Orb',
      spriteId: 'deco-void-orb',
      biomeTag: 'void',
      category: 'organic',
      placementZone: 'anywhere',
      scale: 0.9,
      rotation: 0,
      isAnimated: true,
      animationFrames: 3,
      depthLayer: 'back',
      density: 0.05,
    }),
  ],
  [
    'rune-circle',
    def({
      id: 'rune-circle',
      name: 'Rune Circle',
      spriteId: 'deco-rune-circle',
      biomeTag: 'void',
      category: 'structural',
      placementZone: 'anywhere',
      scale: 1.3,
      rotation: 0,
      isAnimated: true,
      animationFrames: 2,
      depthLayer: 'back',
      density: 0.02,
    }),
  ],
  [
    'void-tendril',
    def({
      id: 'void-tendril',
      name: 'Void Tendril',
      spriteId: 'deco-void-tendril',
      biomeTag: 'void',
      category: 'organic',
      placementZone: 'anywhere',
      scale: 1.4,
      rotation: -1,
      isAnimated: true,
      animationFrames: 2,
      depthLayer: 'front',
      density: 0.06,
    }),
  ],

  // --- DUNGEON (reality-show theme additions) ---
  [
    'junk-pile',
    def({
      id: 'junk-pile',
      name: 'Junk Pile',
      spriteId: 'prop-junk-pile-var-0',
      biomeTag: 'dungeon',
      category: 'rubbish',
      placementZone: 'anywhere',
      scale: 1.0,
      rotation: -1,
      depthLayer: 'mid',
      density: 0.12,
    }),
  ],
  [
    'wall-sconce',
    def({
      id: 'wall-sconce',
      name: 'Wall Sconce',
      spriteId: 'prop-wall-sconce-var-1',
      biomeTag: 'dungeon',
      category: 'light-source',
      placementZone: 'wall-adjacent',
      scale: 1.0,
      rotation: 0,
      isAnimated: true,
      animationFrames: 3,
      depthLayer: 'back',
      density: 0.06,
      lightEmission: { radiusFt: 20, intensity: 0.7, colorHex: 0xffb347 },
    }),
  ],

  // --- CAVE (industrial-cave / Floor 2 set-dressing) ---
  [
    'mining-cart',
    def({
      id: 'mining-cart',
      name: 'Mining Cart',
      spriteId: 'prop-mining-cart-v1-var-0',
      biomeTag: 'cave',
      category: 'structural',
      placementZone: 'room-only',
      scale: 1.2,
      rotation: -1,
      depthLayer: 'mid',
      density: 0.04,
      weight: 300,
    }),
  ],
  [
    'support-beam',
    def({
      id: 'support-beam',
      name: 'Support Beam',
      spriteId: 'prop-support-beam-v1-var-0',
      biomeTag: 'cave',
      category: 'structural',
      placementZone: 'wall-adjacent',
      scale: 1.3,
      rotation: 0,
      depthLayer: 'mid',
      density: 0.06,
      weight: 500,
    }),
  ],
  [
    'cave-rubble',
    def({
      id: 'cave-rubble',
      name: 'Cave Rubble',
      spriteId: 'prop-cave-rubble-v1-var-0',
      biomeTag: 'cave',
      category: 'rubbish',
      placementZone: 'anywhere',
      scale: 1.0,
      rotation: -1,
      depthLayer: 'back',
      density: 0.18,
      weight: 80,
    }),
  ],
  [
    'pipe-section',
    def({
      id: 'pipe-section',
      name: 'Pipe Section',
      spriteId: 'prop-pipe-section-v1-var-0',
      biomeTag: 'cave',
      category: 'structural',
      placementZone: 'wall-adjacent',
      scale: 1.1,
      rotation: -1,
      depthLayer: 'back',
      density: 0.05,
      weight: 150,
    }),
  ],
  [
    'wall-lantern-cave',
    def({
      id: 'wall-lantern-cave',
      name: 'Wall Lantern',
      spriteId: 'prop-wall-lantern-v1-var-0',
      biomeTag: 'cave',
      category: 'light-source',
      placementZone: 'wall-adjacent',
      scale: 1.0,
      rotation: 0,
      isAnimated: false,
      animationFrames: 1,
      depthLayer: 'back',
      density: 0.05,
      lightEmission: { radiusFt: 18, intensity: 0.65, colorHex: 0xffa040 },
    }),
  ],
  [
    'glowing-crystal-shard',
    def({
      id: 'glowing-crystal-shard',
      name: 'Glowing Crystal',
      spriteId: 'prop-glowing-crystal-v1-var-0',
      biomeTag: 'cave',
      category: 'light-source',
      placementZone: 'cave-only',
      scale: 0.9,
      rotation: -1,
      depthLayer: 'mid',
      density: 0.04,
      lightEmission: { radiusFt: 14, intensity: 0.5, colorHex: 0x8844ff },
    }),
  ],
]);

export function getDecorationDef(id: string): DecorationDef | undefined {
  return DECORATION_DEFS.get(id);
}

export function getDecorationsByBiome(biome: BiomeTag): DecorationDef[] {
  return Array.from(DECORATION_DEFS.values()).filter((d) => d.biomeTag === biome);
}

/**
 * Stable integer index for each decoration def. Used for compact ECS storage
 * (Prop.defIdIndex). Values are explicitly assigned so adding new entries
 * at the end never changes existing mappings.
 */
export const DECORATION_DEF_INDEX: Readonly<Record<string, number>> = Object.freeze({
  torch: 0,
  'stone-pillar': 1,
  barrel: 2,
  rubble: 3,
  chain: 4,
  vine: 5,
  'skull-pile': 6,
  'bone-arch': 7,
  pustule: 8,
  'moss-patch': 9,
  'light-panel': 10,
  'server-stack': 11,
  'cable-bundle': 12,
  hologram: 13,
  'crystal-shard': 14,
  'void-orb': 15,
  'rune-circle': 16,
  'void-tendril': 17,
  'junk-pile': 18,
  'wall-sconce': 19,
  'mining-cart': 20,
  'support-beam': 21,
  'cave-rubble': 22,
  'pipe-section': 23,
  'wall-lantern-cave': 24,
  'glowing-crystal-shard': 25,
});

/** Reverse index: integer → def id. */
export const DECORATION_INDEX_TO_ID: readonly string[] = Object.freeze(
  Object.entries(DECORATION_DEF_INDEX)
    .sort(([, a], [, b]) => a - b)
    .map(([id]) => id),
);
