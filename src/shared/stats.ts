/**
 * Stat definitions — primary and secondary stats with clamp ranges.
 *
 * Contract (see ADR — primary-stat overhaul):
 *   - Every primary stat's "effective point" value is `1 (base) + allocated
 *     level-up points + equipment bonuses`. Every per-point rate below is
 *     applied against that full effective value, so even an untouched stat
 *     (effective = 1) contributes its baseline rate once.
 *   - STR and INT are NOT generic secondary stats — they scale damage via a
 *     *typed primary multiplier* applied directly at damage/spell resolution
 *     (see `computeTypedPrimaryMultiplier`), so physical and magic offense
 *     stay independent (STR never boosts spells, INT never boosts weapons).
 *   - CHA is visible but intentionally has zero gameplay effect and is not
 *     allocatable.
 */

export const PRIMARY_STATS = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'charisma',
  'luck',
] as const;

export const SECONDARY_STATS = [
  'armor',
  'damageBonus',
  'damagePercent',
  'attackSpeed',
  'moveSpeed',
  'critChance',
  'critMultiplier',
  'dodgeChance',
  'hpRegen',
  'xpBonus',
  'cooldownReduction',
  /** Derived max HP (base floor + Constitution + equipment/ability modifiers). */
  'maxHp',
  /** Accuracy bonus stacked on top of a weapon's baseAccuracy. */
  'accuracy',
  /**
   * Inert snapshot fields — kept so registries/tests/UI can display them and
   * legacy ability/skill modifiers keep a valid target, but nothing currently
   * consumes them for gameplay (see ADR — no gameplay regression from removing
   * their old INT/LUCK derivations).
   */
  'pickupRange',
  'projectileSpeed',
  'projectileCount',
] as const;

export type PrimaryStatId = (typeof PRIMARY_STATS)[number];
export type SecondaryStatId = (typeof SECONDARY_STATS)[number];
export type StatId = PrimaryStatId | SecondaryStatId;

export const ALL_STAT_IDS: readonly StatId[] = [...PRIMARY_STATS, ...SECONDARY_STATS];
export const VALID_STAT_IDS: ReadonlySet<string> = new Set(ALL_STAT_IDS);

export function isValidStatId(id: string): id is StatId {
  return VALID_STAT_IDS.has(id);
}

const NEAR_INTEGER_EPSILON = 1e-6;

function ceilNearInteger(value: number, epsilon = NEAR_INTEGER_EPSILON): number {
  if (!Number.isFinite(value)) {
    return Math.ceil(value);
  }
  const nearestInteger = Math.round(value);
  const tolerance = Math.max(epsilon, Number.EPSILON * Math.max(1, Math.abs(value)) * 16);
  if (Math.abs(value - nearestInteger) <= tolerance) {
    return nearestInteger;
  }
  return Math.ceil(value);
}

/** Apply cooldown reduction only (ability cooldowns — no attack-speed bonus). */
export function applyCooldownReduction(baseDuration: number, reduction: number): number {
  const scaledDuration = baseDuration * (1 - reduction);
  return Math.max(1, ceilNearInteger(scaledDuration));
}

/**
 * Lower clamp for the `attackSpeed` bonus fraction. Must stay strictly greater
 * than -1 so `1 / (1 + attackSpeedBonus)` never divides by zero or goes
 * negative even if debuffs/modifiers stack heavily.
 */
export const ATTACK_SPEED_BONUS_MIN_CLAMP = -0.9;

/**
 * Weapon cadence: `baseCooldownMs / (1 + attackSpeedBonus) * (1 - cooldownReduction)`.
 * Single rounding pass at the end (no early rounding between the two factors).
 * `attackSpeedBonus` is guarded to stay `> -1` (never divides by zero/flips
 * sign) via `ATTACK_SPEED_BONUS_MIN_CLAMP`.
 */
export function applyAttackSpeedAndCooldownReduction(
  baseCooldownMs: number,
  attackSpeedBonus: number,
  cooldownReduction: number,
): number {
  const safeBonus = Math.max(ATTACK_SPEED_BONUS_MIN_CLAMP, attackSpeedBonus);
  const scaledDuration = (baseCooldownMs / (1 + safeBonus)) * (1 - cooldownReduction);
  return Math.max(1, ceilNearInteger(scaledDuration));
}

export interface StatClamp {
  readonly min?: number;
  readonly max?: number;
}

export const STAT_CLAMPS: Readonly<Record<StatId, StatClamp>> = {
  strength: { min: 0 },
  dexterity: { min: 0 },
  constitution: { min: 0 },
  intelligence: { min: 0 },
  wisdom: { min: 0 },
  charisma: { min: 0 },
  luck: { min: 0 },
  armor: { min: 0 },
  damageBonus: {},
  damagePercent: { min: 0 },
  attackSpeed: { min: ATTACK_SPEED_BONUS_MIN_CLAMP },
  moveSpeed: { min: 0 },
  critChance: { min: 0, max: 1 },
  critMultiplier: { min: 1 },
  dodgeChance: { min: 0, max: 0.75 },
  hpRegen: { min: 0 },
  xpBonus: { min: 0 },
  cooldownReduction: { min: 0, max: 0.8 },
  maxHp: { min: 1 },
  accuracy: {},
  pickupRange: { min: 0 },
  projectileSpeed: { min: 0 },
  projectileCount: { min: 0 },
};

/**
 * Base-floor Max HP before Constitution's per-point contribution. Combined
 * with `CORE_STAT_TO_SECONDARY.constitution.maxHp` (10/point) so a fresh
 * character (effective CON = 1, no allocation/gear) starts at 150 HP:
 * `140 + 10 * 1 === 150`. The extra floor replaces survivability removed when
 * Strength stopped granting armor.
 */
const BASE_MAX_HP_FLOOR = 140;

export const DEFAULT_BASE_STATS: Readonly<Record<StatId, number>> = {
  strength: 1,
  dexterity: 1,
  constitution: 1,
  intelligence: 1,
  wisdom: 1,
  charisma: 1,
  luck: 1,
  armor: 0,
  damageBonus: 0,
  damagePercent: 0,
  attackSpeed: 0,
  moveSpeed: 0,
  critChance: 0.05,
  critMultiplier: 1.5,
  dodgeChance: 0,
  hpRegen: 0,
  xpBonus: 0,
  cooldownReduction: 0,
  maxHp: BASE_MAX_HP_FLOOR,
  accuracy: 0,
  pickupRange: 0,
  projectileSpeed: 0,
  projectileCount: 0,
};

/** Clamp a stat value to its defined range. */
export function clampStat(statId: StatId, value: number): number {
  const clamp = STAT_CLAMPS[statId];
  let v = value;
  if (clamp.min !== undefined) v = Math.max(clamp.min, v);
  if (clamp.max !== undefined) v = Math.min(clamp.max, v);
  return v;
}

// --- Legacy modifier target keys (StatModifier.stat / ability & skill effects) ---

/**
 * The set of gameplay-facing keys legacy ability/skill `StatModifier`s and
 * `CatalogEffect` `stat_add`/`stat_multiply` entries may target. These are
 * NOT a separate computed pipeline anymore — `foldLegacyStatModifier` folds
 * each one into the unified EffectiveStats fields below, so `EffectiveStats`
 * stays the sole runtime stat snapshot.
 */
export const STAT_KEYS = [
  'maxHp',
  'moveSpeed',
  'damage',
  'armor',
  'attackSpeed',
  'pickupRange',
  'projectileCount',
  'projectileSpeed',
  'accuracy',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

export interface LegacyStatModifierLike {
  readonly stat: StatKey;
  readonly op: 'add' | 'multiply';
  readonly value: number;
}

/**
 * Fold one legacy ability/skill modifier into the unified EffectiveStats
 * accumulator (in place). Preserves the explicit legacy semantics documented
 * in the primary-stat overhaul ADR:
 *   - `damage` splits by op: `add` → flat `damageBonus`, `multiply` → generic
 *     `damagePercent` (both consumed at damage resolution as
 *     `(base+flat)*(1+genericPercent)*typedPrimaryMultiplier`).
 *   - `maxHp`/`armor`/`attackSpeed`/`moveSpeed`/`accuracy`/`pickupRange`/
 *     `projectileSpeed`/`projectileCount` fold additively into their
 *     same-named EffectiveStats field regardless of `op` — skills such as
 *     `combat-flow` intentionally use `multiply` on `attackSpeed` to
 *     contribute to the bonus-fraction lane; both `add` and `multiply` ops
 *     accumulate additively into that lane (documented, deterministic,
 *     never silently dropped).
 */
export function foldLegacyStatModifier(
  eff: Record<StatId, number>,
  mod: LegacyStatModifierLike,
): void {
  if (mod.stat === 'damage') {
    if (mod.op === 'add') {
      eff.damageBonus = (eff.damageBonus ?? 0) + mod.value;
    } else {
      eff.damagePercent = (eff.damagePercent ?? 0) + mod.value;
    }
    return;
  }
  eff[mod.stat] = (eff[mod.stat] ?? 0) + mod.value;
}

// --- Core stat (primary stat) allocation policy ---

/**
 * How many points each PRIMARY_STAT starts with at character creation.
 * Used for display in the level-up UI ("you have X points in Strength").
 */
export const CORE_STAT_BASE: Readonly<Record<PrimaryStatId, number>> = {
  strength: 0,
  dexterity: 0,
  constitution: 0,
  intelligence: 0,
  wisdom: 0,
  charisma: 0,
  luck: 0,
};

const ALLOCATABLE_PRIMARY_STATS = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'luck',
] as const satisfies readonly PrimaryStatId[];

const ALLOCATABLE_PRIMARY_STATS_SET: ReadonlySet<PrimaryStatId> = new Set(
  ALLOCATABLE_PRIMARY_STATS,
);

export function isAllocatablePrimaryStat(stat: PrimaryStatId): boolean {
  return ALLOCATABLE_PRIMARY_STATS_SET.has(stat);
}

/**
 * Per-point contribution of each PRIMARY_STAT to SECONDARY (effectiveStats)
 * stats. Applied during effective-stat computation (see
 * `core/effective-stats.ts`): each effective primary stat (base 1 + allocated
 * + gear) contributes `value × effectivePoints` to the listed secondary.
 *
 * Strength and Intelligence are intentionally NOT listed here — their per-
 * point payoff is a *typed primary multiplier* applied directly at damage/
 * spell resolution (`computeTypedPrimaryMultiplier`), keeping physical and
 * magic offense fully independent instead of feeding a shared generic stat.
 */
export const CORE_STAT_TO_SECONDARY: Readonly<
  Record<PrimaryStatId, Partial<Record<SecondaryStatId, number>>>
> = {
  strength: {},
  /**
   * Dexterity: +1% attack-speed bonus, +0.25% move-speed bonus
   * (multiplicative — see `computeMoveSpeed`), +0.25pp accuracy, +1/300
   * (≈0.333pp) dodge chance — all per effective point.
   */
  dexterity: {
    attackSpeed: 0.01,
    moveSpeed: 0.0025,
    accuracy: 0.0025,
    dodgeChance: 1 / 300,
  },
  /** Constitution: +10 max HP per effective point. */
  constitution: { maxHp: 10 },
  intelligence: {},
  /** Wisdom: +0.5pp cooldown reduction per effective point (cap 80%, see STAT_CLAMPS). */
  wisdom: { cooldownReduction: 0.005 },
  /** Charisma: visible, intentionally zero gameplay effect, non-allocatable. */
  charisma: {},
  /** Luck: +0.25pp crit chance per effective point (cap 100%, see STAT_CLAMPS). */
  luck: { critChance: 0.0025 },
};

// --- Typed primary damage/magic scaling (STR physical, INT magic) ---

/** Strength: +1% physical damage per effective point. */
export const STR_PHYSICAL_DAMAGE_RATE = 0.01;

/** Intelligence: +1% magic strength per effective point. */
export const INT_MAGIC_STRENGTH_RATE = 0.01;

export type DamageAffinity = 'physical' | 'magic' | 'unscaled';

/**
 * The typed-primary multiplier applied at damage resolution, keyed on the
 * damage's affinity: physical damage scales with effective Strength, magic
 * damage scales with effective Intelligence, and `unscaled` damage (enemy /
 * environment / explicitly-exempt sources) never gets a typed multiplier.
 */
export function computeTypedPrimaryMultiplier(
  affinity: DamageAffinity,
  effectiveStrength: number,
  effectiveIntelligence: number,
): number {
  switch (affinity) {
    case 'physical':
      return 1 + effectiveStrength * STR_PHYSICAL_DAMAGE_RATE;
    case 'magic':
      return 1 + effectiveIntelligence * INT_MAGIC_STRENGTH_RATE;
    case 'unscaled':
    default:
      return 1;
  }
}

// --- Magical-ability explicit output scaling ---

/**
 * Every magical ability's numeric output (damage, healing, duration, radius,
 * knockback, slow, etc.) is authored inline as `{ base, scalesWithIntelligence }`
 * so each field explicitly declares whether it scales. Resolved once through
 * `resolveScalableOutput` — true outputs get `+1%` per effective Intelligence
 * point (the SAME `INT_MAGIC_STRENGTH_RATE` a magic weapon's typed multiplier
 * uses, so a magic weapon and a spell see the same post-gear effective INT
 * rate — see the parity test in `tests/unit/magic-scaling-parity.test.ts`).
 */
export interface ScalableOutput {
  readonly base: number;
  readonly scalesWithIntelligence: boolean;
}

/** Resolve a scalable output's numeric value against effective Intelligence. */
export function resolveScalableOutput(
  output: ScalableOutput,
  effectiveIntelligence: number,
): number {
  return output.scalesWithIntelligence
    ? output.base * (1 + effectiveIntelligence * INT_MAGIC_STRENGTH_RATE)
    : output.base;
}

/**
 * Resolve a scalable output and round to the nearest integer — use for
 * integer-shaped outputs (damage, healing, frame/ms durations) so scaling
 * never leaves a fractional gameplay value. Deterministic (no RNG).
 */
export function resolveScalableOutputRounded(
  output: ScalableOutput,
  effectiveIntelligence: number,
): number {
  return Math.round(resolveScalableOutput(output, effectiveIntelligence));
}
