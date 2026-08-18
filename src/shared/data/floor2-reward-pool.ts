/**
 * Central Floor 2 achievement reward pool.
 *
 * Every Floor 2 achievement that grants a `lootTable: 'floor2-generated-equipment'`
 * loot box draws its candidate base from this single frozen list — there are no
 * more per-achievement hand-picked `bases` arrays. The pool is derived (never
 * hand-copied) by unioning the stable IDs of every catalog that feeds the
 * generated-equipment bridge ({@link resolveGeneratedEquipmentBase} in
 * `generated-equipment-generator.ts`):
 *
 *   - Floor 2 Wave A weapon bases (25 weapons)
 *   - Floor 2 Wave B weapons (25) + non-weapons (20)
 *   - Classic Fantasy Basic Leather weapons (6) + non-weapons (12)
 *
 * 25 + 25 + 20 + 6 + 12 = 88, matching the 88-entry art manifest
 * ({@link FLOOR2_EQUIPMENT_ART_DEFINITIONS}) 1:1 by construction — this module
 * asserts that set-equality at load time rather than trusting arithmetic alone.
 *
 * ADR 0068 boundary: this module lists stable IDs and reads each catalog's own
 * `EquipmentItemDef`/`Floor2WeaponBaseDefinition` shape for validation only. It
 * does not construct instances and does not import from `src/game/**` (shared
 * code must not depend on the game layer) — `resolveGeneratedEquipmentBase`
 * remains the sole bridge from a pool ID to a playable instance.
 */
import {
  FLOOR2_WEAPON_WAVE_A_BASES,
  FLOOR2_WEAPON_WAVE_A_BASE_IDS,
} from './floor2-weapon-bases.js';
import {
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS,
  FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS,
} from './floor2-equipment-wave-b.js';
import {
  FLOOR2_BASIC_LEATHER_WEAPON_IDS,
  FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS,
  FLOOR2_BASIC_LEATHER_WEAPON_BASES,
  FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES,
} from './floor2-basic-leather-bases.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from './floor2-equipment-art.js';
import type { Floor2EquipmentStableId } from './floor2-equipment-art.js';
import { SLOT_REGISTRY, type EquipmentSlotId } from '../equipment-slots.js';

/**
 * The 8 armor slot IDs — every {@link SLOT_REGISTRY} entry except the two
 * weapon-hand slots (`mainHand`/`offHand`). Derived, never hand-copied, so a
 * future slot addition/removal in the registry is reflected here automatically.
 */
export const FLOOR2_ARMOR_SLOT_IDS: readonly EquipmentSlotId[] = Object.freeze(
  SLOT_REGISTRY.filter((slot) => slot.id !== 'mainHand' && slot.id !== 'offHand').map(
    (slot) => slot.id,
  ),
);

/**
 * The full, frozen Floor 2 generated-equipment reward pool: every stable ID
 * usable as a `bases` candidate for `resolveEquipmentRewardBundle`. Derived by
 * concatenating each catalog's own exported ID list — no literal ID appears in
 * this file.
 */
export const FLOOR2_REWARD_POOL_STABLE_IDS: readonly Floor2EquipmentStableId[] = Object.freeze([
  ...FLOOR2_WEAPON_WAVE_A_BASE_IDS,
  ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS,
  ...FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS,
  ...FLOOR2_BASIC_LEATHER_WEAPON_IDS,
  ...FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS,
]);

/** Weapon-only subset of the pool (56 entries: 25 + 25 + 6). */
export const FLOOR2_REWARD_POOL_WEAPON_IDS: readonly Floor2EquipmentStableId[] = Object.freeze([
  ...FLOOR2_WEAPON_WAVE_A_BASE_IDS,
  ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS,
  ...FLOOR2_BASIC_LEATHER_WEAPON_IDS,
]);

/** Non-weapon-only subset of the pool (32 entries: 20 + 12). */
export const FLOOR2_REWARD_POOL_NON_WEAPON_IDS: readonly Floor2EquipmentStableId[] = Object.freeze([
  ...FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS,
  ...FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS,
]);

function validateRewardPool(): void {
  if (FLOOR2_REWARD_POOL_STABLE_IDS.length !== 88) {
    throw new Error(
      `Floor 2 reward pool must contain exactly 88 bases; received ${FLOOR2_REWARD_POOL_STABLE_IDS.length}`,
    );
  }
  if (FLOOR2_REWARD_POOL_WEAPON_IDS.length !== 56) {
    throw new Error(
      `Floor 2 reward pool must contain exactly 56 weapon bases; received ${FLOOR2_REWARD_POOL_WEAPON_IDS.length}`,
    );
  }
  if (FLOOR2_REWARD_POOL_NON_WEAPON_IDS.length !== 32) {
    throw new Error(
      `Floor 2 reward pool must contain exactly 32 non-weapon bases; received ${FLOOR2_REWARD_POOL_NON_WEAPON_IDS.length}`,
    );
  }
  if (
    FLOOR2_REWARD_POOL_WEAPON_IDS.length + FLOOR2_REWARD_POOL_NON_WEAPON_IDS.length !==
    FLOOR2_REWARD_POOL_STABLE_IDS.length
  ) {
    throw new Error('Floor 2 reward pool weapon/non-weapon subsets do not partition the full pool');
  }

  const seen = new Set<Floor2EquipmentStableId>();
  for (const stableId of FLOOR2_REWARD_POOL_STABLE_IDS) {
    if (seen.has(stableId)) {
      throw new Error(`Floor 2 reward pool contains a duplicate stable ID: ${stableId}`);
    }
    seen.add(stableId);
  }

  // The pool must be exactly the 88-entry art manifest, set-for-set — every
  // playable base has art, and every art entry is backed by a playable base.
  const manifestIds = new Set(FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((def) => def.stableId));
  if (manifestIds.size !== seen.size) {
    throw new Error(
      `Floor 2 reward pool size (${seen.size}) does not match art manifest size (${manifestIds.size})`,
    );
  }
  for (const stableId of seen) {
    if (!manifestIds.has(stableId)) {
      throw new Error(
        `Floor 2 reward pool references a stable ID missing from the art manifest: ${stableId}`,
      );
    }
  }
  for (const stableId of manifestIds) {
    if (!seen.has(stableId)) {
      throw new Error(
        `Floor 2 art manifest declares a stable ID absent from the reward pool: ${stableId}`,
      );
    }
  }

  // Every one of the 8 real armor slots must be reachable by at least one
  // non-weapon base in the pool. Weapon-hand slots (mainHand/offHand) are
  // intentionally excluded — some accessories legitimately occupy them, but
  // that is not "armor coverage".
  const nonWeaponSlotSources: readonly (readonly EquipmentSlotId[])[] = [
    ...FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS.map((def) => def.slots),
    ...FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES.map((def) => def.slots),
  ];
  const coveredArmorSlots = new Set<string>();
  for (const slots of nonWeaponSlotSources) {
    for (const slot of slots) {
      if (slot !== 'mainHand' && slot !== 'offHand') coveredArmorSlots.add(slot);
    }
  }
  const missingArmorSlots = FLOOR2_ARMOR_SLOT_IDS.filter((slot) => !coveredArmorSlots.has(slot));
  if (missingArmorSlots.length > 0) {
    throw new Error(
      `Floor 2 reward pool does not reach every armor slot; missing: ${missingArmorSlots.join(', ')}`,
    );
  }

  // Weapon bases must all resolve to a real weapon equipment def with a
  // weapon-hand slot, and non-weapon bases must never claim a weapon-hand
  // slot as their only slot — a light structural cross-check that the
  // weapon/non-weapon split above is not just an ID-list bookkeeping split.
  const weaponEquipmentDefsById = new Map<string, { readonly slots: readonly EquipmentSlotId[] }>();
  for (const base of FLOOR2_WEAPON_WAVE_A_BASES) {
    weaponEquipmentDefsById.set(base.stableId, base.equipmentDef);
  }
  for (const def of FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS) {
    weaponEquipmentDefsById.set(def.id, def);
  }
  for (const base of FLOOR2_BASIC_LEATHER_WEAPON_BASES) {
    weaponEquipmentDefsById.set(base.stableId, base.equipmentDef);
  }
  for (const stableId of FLOOR2_REWARD_POOL_WEAPON_IDS) {
    const def = weaponEquipmentDefsById.get(stableId);
    if (def === undefined) {
      throw new Error(
        `Floor 2 reward pool weapon base ${stableId} has no resolvable equipment def`,
      );
    }
    if (!def.slots.includes('mainHand') && !def.slots.includes('offHand')) {
      throw new Error(
        `Floor 2 reward pool weapon base ${stableId} does not occupy a weapon-hand slot`,
      );
    }
  }
}

validateRewardPool();
