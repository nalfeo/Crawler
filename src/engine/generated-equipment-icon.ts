/**
 * generated-equipment-icon — resolves a rendered icon for a
 * `GeneratedEquipmentInstanceKey`, for use by the reward-opening UX
 * (`RewardOpeningUI.ts`) and any future panel that needs to show a granted
 * generated-equipment instance by instance key alone.
 *
 * No engine file previously rendered a generated-equipment instance by
 * instance key — `EquipmentUI.ts`/`InventoryUI.ts` only ever render by base
 * item id (the player's equipped/bagged items reference `itemId`, not an
 * instance key directly). This module bridges that gap by resolving the
 * instance from the generated-equipment registry.
 *
 * Icon resolution mirrors the canonical pattern `EquipmentUI.ts` and
 * `InventoryUI.ts` use for generated-equipment instances: prefer the
 * instance's own `frozen.artKey` as a direct Phaser texture key (real art is
 * preloaded under that literal key once approved/checked in) and render it
 * verbatim when the texture is loaded. `frozen.artKey` is a dotted
 * `equipment/<stableId path>` string derived once at generation time from the
 * base's art definition (see `generated-equipment-generator.ts`), so every
 * instance of the same base always resolves the same key.
 *
 * Only falls back to the legacy `resolveItemSprite`-via-`baseId` registry
 * match (kept for any generated-equipment base that predates the
 * `frozen.artKey` convention or whose art hasn't landed yet), and finally to
 * a two-letter text-abbreviation icon when neither texture is loaded. Never
 * generates or requests new art itself.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { getGeneratedEquipmentInstance } from '../core/generated-equipment-registry.js';
import type {
  GeneratedEquipmentInstanceKey,
  GeneratedEquipmentRarity,
} from '../shared/generated-equipment-types.js';
import {
  emptyGeneratedSpriteRegistry,
  type GeneratedSpriteRegistry,
} from '../shared/generated-assets.js';
import { resolveItemSprite } from '../shared/item-sprites.js';
import { hashStringToSeed } from '../shared/random.js';
import { fitScaleForBox } from './ui-scale.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from './generatedAssets/index.js';

/**
 * Rarity → UI colour for `GeneratedEquipmentRarity` (lowercase 3-value space:
 * `common`/`uncommon`/`rare`) — deliberately NOT `RARITY_COLORS` from
 * `shared/items.ts`, which is keyed by the capitalized 5-value `ItemRarity`
 * enum (`Common`/`Uncommon`/`Rare`/`Epic`/`Legendary`). The two rarity spaces
 * are distinct; reusing the same hex values for the first three keeps the
 * palette visually consistent without conflating the enums.
 */
export const GENERATED_EQUIPMENT_RARITY_COLORS: Readonly<Record<GeneratedEquipmentRarity, number>> =
  {
    common: 0x9e9e9e,
    uncommon: 0x4caf50,
    rare: 0x2196f3,
  };

export interface ResolvedEquipmentIconSpec {
  readonly instanceKey: GeneratedEquipmentInstanceKey;
  readonly baseId: string;
  /**
   * The instance's frozen art key (`equipment/<stableId path>`), preloaded as
   * a literal Phaser texture key once its art is approved and checked in.
   * Preferred over the legacy `resolveItemSprite`-via-`baseId` registry
   * match — see the module doc comment.
   */
  readonly artKey: string;
  readonly itemName: string;
  readonly rarity: GeneratedEquipmentRarity;
  readonly rarityColor: number;
}

/**
 * Resolve display metadata for a granted generated-equipment instance.
 * Returns `null` only if the instance is missing from the registry (should
 * never happen for a just-granted/persisted instance key — a fail-closed
 * signal for callers, never a thrown exception, since this runs inside
 * presentation code that must never crash the reward-opening sequence).
 */
export function resolveEquipmentIconSpec(
  world: GameWorld,
  instanceKey: GeneratedEquipmentInstanceKey,
): ResolvedEquipmentIconSpec | null {
  const instance = getGeneratedEquipmentInstance(world, instanceKey);
  if (!instance) {
    return null;
  }
  return {
    instanceKey,
    baseId: instance.baseId,
    artKey: instance.frozen.artKey,
    itemName: instance.frozen.displayName,
    rarity: instance.rarity,
    rarityColor: GENERATED_EQUIPMENT_RARITY_COLORS[instance.rarity],
  };
}

function getGeneratedRegistry(scene: Phaser.Scene): GeneratedSpriteRegistry {
  const registry = scene.game?.registry?.get(GENERATED_SPRITE_REGISTRY_KEY) as
    | GeneratedSpriteRegistry
    | undefined;
  return registry ?? emptyGeneratedSpriteRegistry();
}

/**
 * Create a Phaser game object rendering `spec`'s icon at `(x, y)`, sized to
 * fit within a `boxSize`-square box. Prefers `spec.artKey` as a direct,
 * preloaded texture key (mirroring `EquipmentUI.ts`/`InventoryUI.ts`); falls
 * back to the legacy registry-matched sprite (deterministic per `worldSeed`)
 * when `artKey` has no loaded texture, and finally to a two-letter text
 * abbreviation of the item name when neither texture is loaded.
 */
export function createGeneratedEquipmentIcon(
  scene: Phaser.Scene,
  world: GameWorld,
  spec: ResolvedEquipmentIconSpec,
  x: number,
  y: number,
  boxSize: number,
): Phaser.GameObjects.GameObject {
  if (spec.artKey !== '' && scene.textures?.exists(spec.artKey) === true) {
    const image = scene.add.image(Math.round(x), Math.round(y), spec.artKey);
    image.setOrigin(0.5, 0.5);
    image.setScale(fitScaleForBox(image.width, image.height, boxSize));
    return image;
  }
  const registry = getGeneratedRegistry(scene);
  const seed = (hashStringToSeed(spec.baseId) ^ (world.seed | 0)) | 0;
  const entry = resolveItemSprite(registry, spec.baseId, seed);
  const textureLoaded = entry !== null && scene.textures?.exists(entry.textureKey) === true;
  if (entry && textureLoaded) {
    const image = scene.add.image(Math.round(x), Math.round(y), entry.textureKey);
    image.setOrigin(0.5, 0.5);
    image.setScale(fitScaleForBox(image.width, image.height, boxSize));
    return image;
  }
  const fallback = scene.add.text(
    Math.round(x),
    Math.round(y),
    spec.itemName.substring(0, 2).toUpperCase(),
    {
      fontFamily: 'Segoe UI, Arial, sans-serif',
      fontSize: '14px',
      color: `#${spec.rarityColor.toString(16).padStart(6, '0')}`,
    },
  );
  fallback.setOrigin(0.5, 0.5);
  return fallback;
}
