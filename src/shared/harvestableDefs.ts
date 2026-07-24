/**
 * Harvestable node definitions — registry of interactable resource nodes that
 * the player can harvest by standing on them for a set duration.
 *
 * Each def maps to an item in ITEM_CATALOG and provides visual/timing metadata.
 * The def index is stored in the ECS harvestable store and used by both the
 * harvest system and the render layer.
 */

export interface HarvestableDef {
  /** Stable slug ID for this node type. */
  readonly id: string;
  /** Display name shown in the harvest UI prompt. */
  readonly label: string;
  /** Item ID to add to inventory on successful harvest (must exist in ITEM_CATALOG). */
  readonly itemId: string;
  /** Milliseconds the player must stand on the node to harvest it. */
  readonly durationMs: number;
  /** Node body colour (0xRRGGBB) used for procedural rendering until sprites exist. */
  readonly tint: number;
  /** Maximum number of this node type that may spawn on a single floor. */
  readonly maxPerFloor: number;
  /** Optional light emission for glow nodes (e.g. mushrooms). */
  readonly lightEmission?: {
    readonly radiusFt: number;
    readonly intensity: number;
  };
}

/**
 * Floor 1 harvestable node registry.
 *
 * Index into this array is stored in `world.stores.harvestable.defIndex[eid]`.
 * Always append — never reorder — to keep indices stable across saves/replays.
 */
export const HARVESTABLE_DEFS: readonly HarvestableDef[] = [
  {
    id: 'crimson-mushroom',
    label: 'Crimson Mushroom',
    itemId: 'crimson-mushroom',
    durationMs: 3_000,
    tint: 0xcc3333,
    maxPerFloor: 5,
    lightEmission: { radiusFt: 10, intensity: 0.45 },
  },
  {
    id: 'azure-mushroom',
    label: 'Azure Mushroom',
    itemId: 'azure-mushroom',
    durationMs: 3_000,
    tint: 0x3377cc,
    maxPerFloor: 5,
    lightEmission: { radiusFt: 10, intensity: 0.45 },
  },
  {
    id: 'sunpetal-flower',
    label: 'Sunpetal Flower',
    itemId: 'sunpetal-flower',
    durationMs: 2_500,
    tint: 0xffcc00,
    maxPerFloor: 5,
  },
  {
    id: 'moonbloom-flower',
    label: 'Moonbloom',
    itemId: 'moonbloom-flower',
    durationMs: 2_500,
    tint: 0xcc88ff,
    maxPerFloor: 5,
  },
  {
    id: 'frost-lichen',
    label: 'Frost Lichen',
    itemId: 'frost-lichen',
    durationMs: 4_000,
    tint: 0x99ddee,
    maxPerFloor: 5,
  },
  {
    id: 'shadow-lichen',
    label: 'Shadow Lichen',
    itemId: 'shadow-lichen',
    durationMs: 4_000,
    tint: 0x446688,
    maxPerFloor: 5,
  },
  // --- Floor 2: Industrial-Cave ore / gem nodes (indices 6–8) ---
  // Always append — never reorder — to keep defIndex values stable.
  {
    id: 'iron-vein',
    label: 'Iron Vein',
    itemId: 'iron-ore',
    durationMs: 4_500,
    tint: 0x7a7a8c,
    maxPerFloor: 6,
  },
  {
    id: 'copper-seam',
    label: 'Copper Seam',
    itemId: 'copper-ore',
    durationMs: 4_000,
    tint: 0xb87333,
    maxPerFloor: 6,
  },
  {
    id: 'gem-cluster',
    label: 'Gem Cluster',
    itemId: 'void-crystal',
    durationMs: 7_000,
    tint: 0x9955ff,
    maxPerFloor: 3,
    lightEmission: { radiusFt: 8, intensity: 0.35 },
  },
] as const;

/**
 * Stable boundary between Floor 1 and Floor 2 harvestable defs.
 * Floor 1 spawner must iterate `defIndex < FLOOR2_HARVESTABLE_START_INDEX`.
 * Floor 2 spawner must iterate `defIndex >= FLOOR2_HARVESTABLE_START_INDEX`.
 * Must equal the array index of the first Floor 2 def (iron-vein, index 6).
 */
export const FLOOR2_HARVESTABLE_START_INDEX = 6;

/** Look up a harvestable def by its stable slug ID. */
export function getHarvestableDef(id: string): HarvestableDef | undefined {
  return HARVESTABLE_DEFS.find((d) => d.id === id);
}

/** Look up a harvestable def by its registry index. */
export function getHarvestableDefByIndex(index: number): HarvestableDef | undefined {
  return HARVESTABLE_DEFS[index];
}
