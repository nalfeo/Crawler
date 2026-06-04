/**
 * Equipment type definitions — item defs, instances, requirements, result types.
 */

import type { EquipmentSlotId } from './equipment-slots.js';
import type { StatId } from './stats.js';

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
}

// --- Equipment Instance ---

export type EquipmentInstanceId = number;

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
  | { readonly ok: true; readonly item: EquipmentInstance }
  | { readonly ok: false; readonly reason: string };

export interface CanEquipResult {
  readonly allowed: boolean;
  readonly reasons: EquipFailureReason[];
}
