/**
 * Stable Floor 2 equipment art-key manifest — typed accessor module.
 *
 * Loads and re-exports the frozen 70-key data from
 * `data/floor2-equipment-art-keys.json`. Keys are immutable: new keys append
 * to the list; existing IDs are never recycled or renamed.
 *
 * Floor 2 equipment uses TWO stable identifiers on purpose:
 *   - artKey: dotted runtime/integration key (`weapon.iron-cleaver`)
 *   - pipeline briefId: kebab-case generation key (`weapon-iron-cleaver`)
 *
 * The sprite pipeline's brief `name` field forbids dots, so generated and
 * placeholder manifest entries must use the kebab-case briefId while runtime
 * integration continues to point at the dotted artKey.
 *
 * Runtime lookup key convention:
 *   artKey `weapon.iron-cleaver` → runtimeKey `equipment/weapon/iron-cleaver`
 *   (first `.` replaced by `/`, prefixed with `equipment/`)
 *
 * Layer: pure `src/shared/` — no Phaser, no bitecs, no IO.
 */

import rawData from './data/floor2-equipment-art-keys.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Floor2WeaponFamily {
  /** Stable kebab-case family ID (e.g. `heavy-blade`). */
  readonly id: string;
  /** Human-readable label for UI and briefs. */
  readonly label: string;
  /** One-sentence description of the family. */
  readonly description: string;
  /** Base names of the 5 weapons in this family (matches the part after `weapon.` in the artKey). */
  readonly weapons: readonly string[];
}

export interface Floor2EquipmentArtEntry {
  /** Immutable art key in `type.base-name` format (e.g. `weapon.iron-cleaver`). */
  readonly artKey: string;
  /** Sprite type: `weapon` for weapons, `item` for armor/accessories. */
  readonly type: 'weapon' | 'item';
  /** Weapon family ID for weapon entries; null for armor/accessories. */
  readonly family: string | null;
  /** Equipment slot category (e.g. `weapon`, `head`, `torso`, `hands`, `feet`, `accessory`). */
  readonly slot: string;
  /** Human-readable label for UI and briefs. */
  readonly label: string;
  /** Runtime lookup key: `equipment/<type>/<base-name>`. */
  readonly runtimeKey: string;
  /** One-sentence brief description for art generation. */
  readonly description: string;
}

export interface Floor2EquipmentArtManifest {
  readonly version: 1;
  readonly description: string;
  readonly weaponFamilies: readonly Floor2WeaponFamily[];
  readonly entries: readonly Floor2EquipmentArtEntry[];
}

// ---------------------------------------------------------------------------
// Validated data
// ---------------------------------------------------------------------------

const data = rawData as Floor2EquipmentArtManifest;

/** All 70 stable Floor 2 equipment art-key entries. */
export const FLOOR2_EQUIPMENT_ART_ENTRIES: readonly Floor2EquipmentArtEntry[] =
  data.entries as Floor2EquipmentArtEntry[];

/** All 10 Floor 2 weapon families. */
export const FLOOR2_WEAPON_FAMILIES: readonly Floor2WeaponFamily[] =
  data.weaponFamilies as Floor2WeaponFamily[];

/** Set of all 70 stable art keys for O(1) membership checks. */
export const FLOOR2_EQUIPMENT_ART_KEY_SET: ReadonlySet<string> = new Set(
  FLOOR2_EQUIPMENT_ART_ENTRIES.map((e) => e.artKey),
);

/** All weapon entries (50 total). */
export const FLOOR2_WEAPON_ART_ENTRIES: readonly Floor2EquipmentArtEntry[] =
  FLOOR2_EQUIPMENT_ART_ENTRIES.filter((e) => e.type === 'weapon');

/** All non-weapon entries (armor/accessories, 20 total). */
export const FLOOR2_ARMOR_ART_ENTRIES: readonly Floor2EquipmentArtEntry[] =
  FLOOR2_EQUIPMENT_ART_ENTRIES.filter((e) => e.type === 'item');

/**
 * Canonical sprite-pipeline brief id for an equipment art key.
 * Convention: replace the first `.` with `-`
 * (`weapon.iron-cleaver` -> `weapon-iron-cleaver`).
 */
export function floor2EquipmentPipelineBriefId(artKey: string): string {
  const dotIndex = artKey.indexOf('.');
  if (dotIndex === -1) {
    return artKey;
  }
  return `${artKey.slice(0, dotIndex)}-${artKey.slice(dotIndex + 1)}`;
}

/**
 * Derive the manifest placeholder key for an art entry. This is the key used
 * in the generated sprite manifest (`public/assets/generated/manifest.json`).
 * Convention: `<artKey>-placeholder` (e.g. `weapon.iron-cleaver-placeholder`).
 */
export function floor2EquipmentPlaceholderKey(artKey: string): string {
  return `${artKey}-placeholder`;
}

/**
 * Derive the placeholder PNG filename for an art entry.
 * Convention: `<artKey>-placeholder.png` (dots preserved — valid file name).
 */
export function floor2EquipmentPlaceholderPng(artKey: string): string {
  return `${artKey}-placeholder.png`;
}
