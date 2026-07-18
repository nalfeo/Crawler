/**
 * Generated Equipment Instance Types — versioned contract for Floor 2 equipment.
 *
 * Authority: .specify/specs/equipment-system.md §Floor 2 Generated Equipment Contract
 * Decision:  docs/knowledge/adr/0065-versioned-frozen-floor2-equipment-instances.md
 *
 * These types define the identity contract for generated equipment instances. The
 * instance's own non-fingerprint fields constitute the versioned generation inputs:
 *   - baseId / itemLevel / rarity / enhancementLevel → what was requested
 *   - resolvedEffects → the affix choices made during generation
 *   - frozen → the computed output (stats, name, art)
 *
 * The generated registry is the sole owner of full instance records. All other
 * containers (bag, equipped slots, reward bundles, shop stock, carryover) store
 * instanceId references only.
 */

import type { StatId } from './stats.js';

// ---------------------------------------------------------------------------
// Brand types
// ---------------------------------------------------------------------------

/**
 * Stable generated-equipment instance identifier. Format: `gei:v1:<runKey>:<ordinal>`.
 *
 * - `runKey`: alphanumeric + hyphen/underscore, no colons. Derived from the
 *   world/run seed deterministically — never wall-clock time.
 * - `ordinal`: a non-negative integer, monotonically increasing per run.
 *
 * Regex: /^gei:v1:[a-zA-Z0-9_-]+:\d+$/
 */
export type GeneratedEquipmentInstanceId = `gei:v1:${string}:${number}`;

/**
 * Floor 2 rarity values. Rarities above Rare are invalid for every Floor 2
 * generation source in this epic (ADR 0065 DEC-005).
 */
export type GeneratedEquipmentRarity = 'common' | 'uncommon' | 'rare';

/**
 * Versioned SHA-256 fingerprint. Format: `sha256:<64 lowercase hex chars>`.
 *
 * Covers all instance fields except `fingerprint` itself. Object keys sorted
 * lexicographically, arrays ordered, finite numbers in decimal form, no
 * undefined values.
 */
export type EquipmentFingerprintV1 = `sha256:${string}`;

/**
 * Source ID for equipment-granted abilities/passives.
 * Ordinal is the zero-based position in `resolvedEffects`.
 *
 * Grant state maps each ability/passive ID to a set of source IDs.
 * Equipping adds each source idempotently; unequipping removes only the
 * originating source.
 *
 * NOTE: Sourced abilities are excluded from B1 scope. This type is defined
 * here for completeness and used by downstream slices.
 */
export type EquipmentGrantSourceId = `equipment:${GeneratedEquipmentInstanceId}:${number}`;

// ---------------------------------------------------------------------------
// Resolution constants (ADR 0065 DEC-005)
// ---------------------------------------------------------------------------

/**
 * Exact number of effect units allocated for each rarity.
 * Common = 0 (no affixes); Uncommon = 1 minor unit; Rare = 2 units.
 * A Rare item may use two one-unit effects or one two-unit effect.
 */
export const RARITY_EFFECT_BUDGET: Readonly<Record<GeneratedEquipmentRarity, number>> = {
  common: 0,
  uncommon: 1,
  rare: 2,
} as const;

/** Minimum enhancement level (+0 = no enhancement). */
export const ENHANCEMENT_MIN = 0 as const;

/** Maximum enhancement level (+5 = +25% post-rarity inherent damage/armor). */
export const ENHANCEMENT_MAX = 5 as const;

// ---------------------------------------------------------------------------
// Resolved effect unit
// ---------------------------------------------------------------------------

/**
 * One resolved affix/effect chosen during generation (step 6 of the pipeline).
 *
 * - `effectId`: stable affix identifier; append-only, never renamed or recycled.
 * - `magnitude`: the resolved numeric value for the effect.
 * - `units`: effect-unit cost consumed from the rarity budget (1 = minor, 2 = major).
 *
 * The total `units` across all `resolvedEffects` must equal the rarity budget.
 * Effect IDs within one instance must be unique (no duplicates).
 */
export interface ResolvedEquipmentEffectV1 {
  readonly effectId: string;
  readonly magnitude: number;
  readonly units: 1 | 2;
}

// ---------------------------------------------------------------------------
// Frozen fields (step 7 of the resolution pipeline)
// ---------------------------------------------------------------------------

/**
 * Frozen output fields written at the end of the resolution pipeline.
 *
 * These are the consumer-visible computed values. Consumers must execute and
 * display `frozen` fields; they must NOT re-resolve behavior from a later
 * catalog revision.
 *
 * V1 NOTE: `activeWeaponSnapshot` is intentionally absent. It will be added
 * as an optional field (`activeWeaponSnapshot?: ActiveWeaponSnapshotV1 | null`)
 * by the weapon-snapshot slice. Non-weapon V1 items use fingerprints computed
 * without it; weapon items will include it when that slice ships. Consumers
 * may not assume its absence means the weapon behavior is undefined — check
 * the `weaponId` field of the underlying base template instead.
 */
export interface FrozenEquipmentFieldsV1 {
  /** Rolled display name (e.g. "Rusty Iron Visor of Swiftness"). */
  readonly displayName: string;
  /** Art asset key for rendering (references the sprite/item catalog). */
  readonly artKey: string;
  /**
   * Final resolved stat bonuses (after base template, level curve, rarity
   * scalar, enhancement, and affix effects). All keys must be valid StatIds;
   * all values must be finite numbers.
   */
  readonly statBonuses: Partial<Readonly<Record<StatId, number>>>;
}

// ---------------------------------------------------------------------------
// Main instance record (schema v1)
// ---------------------------------------------------------------------------

/**
 * Versioned generated-equipment instance — the canonical identity record.
 *
 * Immutable after freeze (step 7). The only legal mutation is a legal atomic
 * enhancement revision: it replaces the full immutable record under the same
 * instanceId, increments contentRevision by one, and recomputes frozen +
 * fingerprint.
 *
 * All containers (bag, slots, reward bundles, shop stock, carryover) store
 * `instanceId` references only. The registry is the sole owner.
 *
 * Fields `baseId`, `itemLevel`, `rarity`, `enhancementLevel`, and
 * `resolvedEffects` constitute the versioned generation inputs (what was
 * requested + the affix choices made). Field `frozen` is the validated output.
 */
export interface GeneratedEquipmentInstanceV1 {
  /** Schema identifier — must be exactly 'floor2-equipment-instance/v1'. */
  readonly schemaVersion: 'floor2-equipment-instance/v1';
  /**
   * Stable instance identity. Allocated deterministically from an immutable
   * run key plus a monotonically increasing per-run ordinal. Never changes
   * when the item moves between floors or containers.
   */
  readonly instanceId: GeneratedEquipmentInstanceId;
  /**
   * Starts at 0. A legal enhancement revision increments this by 1 and
   * recomputes frozen + fingerprint. No other operation may change it.
   */
  readonly contentRevision: number;
  /** Immutable provenance — the stable base ID from the equipment catalog. */
  readonly baseId: string;
  /** Positive integer item level at generation time. */
  readonly itemLevel: number;
  /** Rarity tier. Only common/uncommon/rare are valid for Floor 2. */
  readonly rarity: GeneratedEquipmentRarity;
  /** Enhancement level 0..5. Starts at +0 for all newly generated instances. */
  readonly enhancementLevel: 0 | 1 | 2 | 3 | 4 | 5;
  /**
   * Resolved effects selected during generation (step 6). Total effect units
   * must equal RARITY_EFFECT_BUDGET[rarity]. Effect IDs must be unique.
   */
  readonly resolvedEffects: readonly ResolvedEquipmentEffectV1[];
  /** Frozen computed output. Consumers display and execute these fields. */
  readonly frozen: FrozenEquipmentFieldsV1;
  /**
   * Versioned SHA-256 fingerprint. Covers all fields above except this one,
   * over canonical JSON (keys sorted, no undefined, decimal numbers).
   * Moving the instance between containers does NOT change the fingerprint.
   */
  readonly fingerprint: EquipmentFingerprintV1;
}

// ---------------------------------------------------------------------------
// The only supported schema version (fail-closed for unknown versions)
// ---------------------------------------------------------------------------

/** The only known/supported schema version for Floor 2 generated instances. */
export const KNOWN_GENERATED_SCHEMA_VERSION = 'floor2-equipment-instance/v1' as const;

// ---------------------------------------------------------------------------
// Type guards and validators
// ---------------------------------------------------------------------------

/** Regex for valid generated instance IDs. */
const INSTANCE_ID_RE = /^gei:v1:[a-zA-Z0-9_-]+:\d+$/;

/** Regex for valid V1 fingerprints. */
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Type guard: is this string a valid GeneratedEquipmentInstanceId?
 * Checks format: gei:v1:<alphanumericHyphenUnderscore>:<non-negative integer>
 */
export function isValidGeneratedInstanceId(id: string): id is GeneratedEquipmentInstanceId {
  return INSTANCE_ID_RE.test(id);
}

/**
 * Type guard: is this the only known generated-instance schema version?
 * Unknown versions must fail closed (per ADR 0065 DEC-009).
 */
export function isKnownGeneratedSchemaVersion(
  v: string,
): v is typeof KNOWN_GENERATED_SCHEMA_VERSION {
  return v === KNOWN_GENERATED_SCHEMA_VERSION;
}

/**
 * Validator: is this a properly-formatted V1 fingerprint (sha256: + 64 hex chars)?
 */
export function isValidFingerprintV1(s: string): s is EquipmentFingerprintV1 {
  return FINGERPRINT_RE.test(s);
}

/**
 * Create a valid run key from arbitrary input. Strips characters not in
 * [a-zA-Z0-9_-]. Throws if the result is empty (seed must be non-trivial).
 */
export function makeRunKey(seed: number | string): string {
  const key = String(seed).replace(/[^a-zA-Z0-9_-]/g, '');
  if (key.length === 0) {
    throw new Error(`makeRunKey: seed "${seed}" produces an empty run key`);
  }
  return key;
}
