/** Decoration Definition Schema — data-driven scene dressing configuration.
 *
 * Decorations are non-interactive ambient objects: torches, rubble, vines, etc.
 * They layer depth, scale, and animation to create visual richness without gameplay impact.
 */

import type { BiomeTag } from './biome-tags.js';

export type DepthLayer = 'back' | 'mid' | 'front';

export interface DecorationDef {
  readonly id: string;
  readonly name: string;
  /** Reference to sprite catalog entry. */
  readonly spriteId: string;
  /** Biome grouping for floor generation. */
  readonly biomeTag: BiomeTag;
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
}

function def(
  partial: Partial<DecorationDef> & Pick<DecorationDef, 'id' | 'name' | 'spriteId' | 'biomeTag'>,
): DecorationDef {
  return {
    scale: 1.0,
    rotation: 0,
    isAnimated: false,
    animationFrames: 1,
    depthLayer: 'mid',
    density: 0.05,
    isDestructible: false,
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
      spriteId: 'deco-torch',
      biomeTag: 'dungeon',
      scale: 1.2,
      rotation: 0,
      isAnimated: true,
      animationFrames: 4,
      depthLayer: 'back',
      density: 0.08,
    }),
  ],
  [
    'stone-pillar',
    def({
      id: 'stone-pillar',
      name: 'Stone Pillar',
      spriteId: 'deco-stone-pillar',
      biomeTag: 'dungeon',
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
      spriteId: 'deco-rubble',
      biomeTag: 'dungeon',
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
      scale: 1.4,
      rotation: -1,
      isAnimated: true,
      animationFrames: 2,
      depthLayer: 'front',
      density: 0.06,
    }),
  ],
]);

export function getDecorationDef(id: string): DecorationDef | undefined {
  return DECORATION_DEFS.get(id);
}

export function getDecorationsByBiome(biome: BiomeTag): DecorationDef[] {
  return Array.from(DECORATION_DEFS.values()).filter((d) => d.biomeTag === biome);
}
