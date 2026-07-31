import { FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS } from './floor2-equipment-wave-b.js';
import { FLOOR2_WEAPON_WAVE_A_BASE_IDS } from './floor2-weapon-bases.js';

/**
 * Canonical generated-equipment base pool for Floor 2 achievement rewards.
 *
 * This intentionally spans both the original Floor 2 weapon wave (A) and the
 * later mixed weapon/non-weapon wave (B) so reward tiers draw from one shared
 * pool rather than 36 copy-pasted four-weapon lists.
 */
export const FLOOR2_REWARD_POOL_BASE_IDS: readonly string[] = Object.freeze([
  ...FLOOR2_WEAPON_WAVE_A_BASE_IDS,
  ...FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS,
]);
