/**
 * Equipment type definitions — item defs, instances, requirements, result types.
 */

import type { EquipmentSlotId } from './equipment-slots.js';
import type { GeneratedEquipmentInstanceKey } from './generated-equipment-types.js';
import type { InventoryBagEntry } from './inventory.js';
import type { StatId } from './stats.js';
import type { StatusEffectSpec } from './status-effect-types.js';

// --- Rarity ---

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

// --- Equip Requirements ---

export type EquipRequirement =
  | { readonly type: 'minLevel'; readonly value: number }
  | { readonly type: 'maxLevel'; readonly value: number }
  | { readonly type: 'minStat'; readonly stat: StatId; readonly value: number }
  | { readonly type: 'hasTag'; readonly tag: string }
  | { readonly type: 'notTag'; readonly tag: string }
  | { readonly type: 'custom'; readonly id: string };

// --- Item Definition ---

export interface EquipmentItemDef {
  readonly id: string;
  readonly name: string;
  readonly slots: readonly EquipmentSlotId[];
  readonly statBonuses: Partial<Readonly<Record<StatId, number>>>;
  readonly rarity: ItemRarity;
  readonly tags?: readonly string[];
  readonly requirements?: readonly EquipRequirement[];
  /**
   * Timed / source-tracked status effects granted while this item is equipped.
   * Distinct from `statBonuses` (the permanent character-sheet lane): these flow
   * through the status-effect framework, so they can be temporary, stack, and be
   * cleared on unequip. Both the runtime `sourceType` (forced to `'equipment'`) and
   * `sourceId` are overridden per equipped instance (see `equipmentSystem.equip`), so
   * those two field values here are only placeholders.
   */
  readonly grantsStatusEffects?: readonly StatusEffectSpec[];
  /**
   * When present, equipping this item activates the corresponding WeaponDef
   * (from `weaponDefs.ts`) as the player's active weapon; unequipping clears
   * it. Handedness is encoded via `slots`: `['mainHand']` for one-handed,
   * `['mainHand', 'offHand']` for two-handed weapons. Non-player entities
   * ignore this field — only the player has an active weapon.
   */
  readonly weaponId?: string;
  /**
   * Physical weight of this item in pounds (lb). Consumed by the encumbrance
   * system (`src/shared/encumbrance.ts`) to derive equipped load and band.
   * Multi-slot items are counted once via unique-instance deduplication.
   * Must be a finite, non-negative number.
   */
  readonly weightLb: number;
}

// --- Equipment Instance ---

export type EquipmentInstanceId = number | GeneratedEquipmentInstanceKey;

export interface EquipmentInstance {
  readonly instanceId: EquipmentInstanceId;
  readonly def: EquipmentItemDef;
}

// --- Equipment State ---

export interface EquipmentState {
  equipped: Record<EquipmentSlotId, EquipmentInstanceId | null>;
  instances: Map<EquipmentInstanceId, EquipmentInstance>;
  disabledSlots: Set<EquipmentSlotId>;
}

// --- Result Types ---

export type EquipFailureReason =
  | { readonly type: 'invalidDef'; readonly message: string }
  | {
      readonly type: 'generatedInstanceNotFound';
      readonly instanceKey: GeneratedEquipmentInstanceKey;
      readonly message: string;
    }
  | {
      readonly type: 'generatedOwnershipConflict';
      readonly instanceKey: GeneratedEquipmentInstanceKey;
      readonly message: string;
    }
  | {
      readonly type: 'unsupportedGeneratedContent';
      readonly instanceKey: GeneratedEquipmentInstanceKey;
      readonly message: string;
    }
  | { readonly type: 'unknownSlot'; readonly slotId: string }
  | { readonly type: 'occupiedSlot'; readonly slotId: string }
  | {
      readonly type: 'requirementFailed';
      readonly requirement: EquipRequirement;
      readonly message: string;
    };

export type EquipResult =
  | { readonly ok: true; readonly instanceId: EquipmentInstanceId }
  | { readonly ok: false; readonly reasons: EquipFailureReason[] };

export type UnequipResult =
  | {
      readonly ok: true;
      readonly item: EquipmentInstance;
      readonly entry: InventoryBagEntry;
      /** Generated references move to the bag atomically; legacy callers still rebag static items. */
      readonly bagUpdated: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export interface CanEquipResult {
  readonly allowed: boolean;
  readonly reasons: EquipFailureReason[];
}
