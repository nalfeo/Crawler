/**
 * H1 — Build-deterministic AI equipment loadout scoring.
 *
 * Pure, world-free evaluator that scores complete loadout transitions using
 * production combat / stat / ability formulas and produces a deterministic
 * expected-run-value (ERV) breakdown per candidate.
 *
 * Architecture: full-state delta.
 *
 *   ERV(candidate) = scoreLoadout(hypothetical) - scoreLoadout(current)
 *
 * `scoreLoadout` evaluates a complete loadout snapshot to a single float using:
 *   1. DPS  — baseDamage × typedPrimaryMultiplier × accuracy × critEV × encumbranceMult
 *             ÷ effectiveCooldownSec × encounterFitMultiplier
 *   2. Defense — effective HP derived from armor-flat-reduction semantics
 *   3. Ability access — configured active abilities × slot weight
 *                       × remainingFractionDiscount
 *
 * The delta approach automatically captures displacement/opportunity cost: when
 * a candidate displaces a weapon, scoreHypothetical already reflects the swap.
 *
 * Constraints:
 *   - No world mutation, no equip/purchase actions, no pathfinding, no Phaser imports.
 *   - All randomness uses only expected-value formulas (no SeededRandom calls).
 *   - Tie-breaking is stable and independent of Map/Set iteration order.
 *   - Uses only production formulas from src/shared/ and src/core/effective-stats.ts.
 */

import { WeaponType } from '../../shared/constants.js';
import { computeEncumbranceMultiplierForMass } from '../../shared/encumbrance.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../../shared/abilities.js';
import {
  type PrimaryStatId,
  type StatId,
  type LegacyStatModifierLike,
  applyAttackSpeedAndCooldownReduction,
  computeTypedPrimaryMultiplier,
} from '../../shared/stats.js';
import {
  computeEffectiveStatsFromLoadout,
  type StatBonusSource,
} from '../../core/effective-stats.js';
import type {
  ActiveWeaponSnapshotV1,
  GeneratedEquipmentInstanceV1,
} from '../../shared/generated-equipment-types.js';
import type { EquipmentSlotId } from '../../shared/equipment-slots.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of the encounter that contextualises the score.
 *
 * - `aoeRatio`: 0 = pure single-target (score AOE weapons lower),
 *               1 = pure multi-target (score AOE weapons higher).
 *   Applies a continuous multiplier to the DPS component of AOE weapons.
 *
 * - `remainingFractionDiscount`: 0 = no future value (end of floor),
 *   1 = full future value (start of floor).  Only discounts the
 *   **ability-access** component, which is long-horizon; combat-DPS and
 *   defense components always apply at full value.
 */
export interface EncounterShape {
  /** 0 = single-target, 1 = full AOE encounter. */
  readonly aoeRatio: number;
  /** 0 = no future value, 1 = full future value. Discounts ability-access only. */
  readonly remainingFractionDiscount: number;
}

/**
 * Tuning parameters for the evaluator.  All values have sensible defaults
 * in {@link DEFAULT_EVALUATOR_CONFIG}.
 */
export interface EvaluatorConfig {
  /**
   * Expected single-enemy incoming hit size used to compute effective HP.
   * Armor reduces flat: `reducedHit = max(1, expectedHit - armor)`.
   */
  readonly expectedEnemyHitDmg: number;
  /**
   * Weight of the defense (eHP) component relative to the DPS component.
   * A value of 1 means 1 point of eHP is worth the same as 1 point of DPS.
   * Lower values prioritise raw damage output.
   */
  readonly defenseWeight: number;
  /** Player body weight in lb for encumbrance computation. */
  readonly bodyWeightLb: number;
  /**
   * Score weight per net configured active ability slot.  One freely-
   * configurable active ability is worth this many DPS/EHP score units.
   */
  readonly abilitySlotWeight: number;
  /**
   * DPS multiplier applied to AOE-capable weapons at `aoeRatio = 1.0`.
   * Linearly interpolated at intermediate aoeRatio values.
   */
  readonly aoeEncounterFitMultiplier: number;
}

/** Conservative defaults tuned to a mid-floor D1 encounter profile. */
export const DEFAULT_EVALUATOR_CONFIG: Readonly<EvaluatorConfig> = {
  expectedEnemyHitDmg: 20,
  defenseWeight: 0.5,
  bodyWeightLb: 180,
  abilitySlotWeight: 5,
  aoeEncounterFitMultiplier: 1.5,
};

/**
 * All context that does NOT change between candidate comparisons within one
 * scoring session.  Build once from world state, then pass to
 * {@link scoreEquipmentCandidate} repeatedly.
 */
export interface LoadoutEvalContext {
  /** Player base stats (before equipment and core-stat allocation). */
  readonly baseStats: Partial<Readonly<Record<StatId, number>>>;
  /** Allocated core-stat level-up points. */
  readonly coreStatPoints: Partial<Readonly<Record<PrimaryStatId, number>>>;
  /** Non-equipment active modifiers (skill / ability bonuses from the world). */
  readonly nonEquipmentModifiers: readonly LegacyStatModifierLike[];
  /** Encounter shape for this decision. */
  readonly encounterShape: EncounterShape;
  /** Evaluator tuning. */
  readonly config: EvaluatorConfig;
}

/**
 * A single equipped item as seen by the evaluator.
 *
 * Carries the full generated instance (for ability-grant extraction) plus the
 * exact slot IDs it currently occupies (may be fewer than `instance.frozen.slots`
 * for multi-slot items equipped in only some slots).
 */
export interface EquippedLoadoutItem {
  /** Full generated instance (used for ability grants). */
  readonly instance: GeneratedEquipmentInstanceV1;
  /** Slot IDs this instance currently occupies (deduplicated). */
  readonly occupiedSlots: readonly EquipmentSlotId[];
}

/**
 * Complete snapshot of the player's current equipped state.  Build this from
 * the live world before each round of scoring, then pass it (together with a
 * {@link LoadoutEvalContext}) to {@link scoreEquipmentCandidate}.
 */
export interface CurrentLoadoutState {
  /** All currently equipped items with their occupied slots. */
  readonly equippedItems: readonly EquippedLoadoutItem[];
  /**
   * Active weapon snapshot from the current loadout (null = no weapon or
   * non-generated weapon).  When non-null, its `generatedEquipmentInstanceId`
   * MUST correspond to one of the `equippedItems`.
   */
  readonly activeWeaponSnapshot: ActiveWeaponSnapshotV1 | null;
  /**
   * Currently configured active-ability IDs (the subset of all granted
   * active abilities that are assigned to a slot).
   */
  readonly configuredActiveAbilityIds: readonly string[];
  /** All currently active passive-ability IDs. */
  readonly activePassiveAbilityIds: readonly string[];
}

/**
 * Per-component scores produced by {@link scoreLoadoutSnapshot}.
 * All values are in the same unit (score points); larger = better.
 */
export interface LoadoutScoreBreakdown {
  /** Expected damage per second × encumbrance × encounter-fit. */
  readonly dps: number;
  /**
   * Defensive value: effective hit-points computed from armor flat-reduction
   * semantics × defenseWeight.
   */
  readonly defense: number;
  /**
   * Move-speed multiplier from encumbrance band (0–1).  Applied to DPS
   * component.  Exposed separately for telemetry; already folded into `dps`.
   */
  readonly encumbranceMultiplier: number;
  /**
   * Value of configured active abilities × abilitySlotWeight × remaining-
   * fraction discount.
   */
  readonly abilityAccess: number;
  /** Total: dps + defense + abilityAccess. */
  readonly total: number;
}

/**
 * Result of evaluating one equipment candidate against the current loadout.
 */
export interface EquipmentERVBreakdown {
  /** Total expected-run-value delta: positive = candidate is better. */
  readonly totalERV: number;
  /** DPS component delta. */
  readonly dpsDelta: number;
  /** Defense component delta. */
  readonly defenseDelta: number;
  /** Ability-access component delta. */
  readonly abilityAccessDelta: number;
  /** Score breakdown for the hypothetical (candidate-equipped) loadout. */
  readonly hypothetical: LoadoutScoreBreakdown;
  /** Score breakdown for the current loadout. */
  readonly current: LoadoutScoreBreakdown;
  /**
   * Whether the transition is legal: the candidate's slots are available or
   * fully covered by items that would be displaced.
   */
  readonly isLegalTransition: boolean;
  /**
   * Stable sort key for deterministic tie-breaking across reordered inputs.
   * Format: `<totalERV padded>:<instanceId>`.  Lexicographic sort is correct.
   */
  readonly sortKey: string;
}

/**
 * Ranked result from {@link rankEquipmentCandidates}.
 */
export interface RankedEquipmentCandidate {
  readonly candidate: GeneratedEquipmentInstanceV1;
  readonly breakdown: EquipmentERVBreakdown;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the net ability grants from a set of equipped items.
 *
 * Returns two Maps: `active → grantCount`, `passive → grantCount`.
 * Multiple items granting the same ability ID each contribute +1.
 */
function collectAbilityGrantCounts(items: readonly EquippedLoadoutItem[]): {
  active: Map<string, number>;
  passive: Map<string, number>;
} {
  const active = new Map<string, number>();
  const passive = new Map<string, number>();
  for (const { instance } of items) {
    for (const effect of instance.resolvedEffects) {
      if (!('kind' in effect)) continue;
      if (effect.kind === 'abilityGrant') {
        active.set(effect.grantId, (active.get(effect.grantId) ?? 0) + 1);
      } else if (effect.kind === 'passiveGrant') {
        passive.set(effect.grantId, (passive.get(effect.grantId) ?? 0) + 1);
      }
    }
  }
  return { active, passive };
}

/** Subtract `delta` grant counts; remove keys that reach 0. */
function subtractGrantCounts(
  base: Map<string, number>,
  delta: Map<string, number>,
): Map<string, number> {
  const result = new Map(base);
  for (const [id, count] of delta) {
    const remaining = (result.get(id) ?? 0) - count;
    if (remaining <= 0) {
      result.delete(id);
    } else {
      result.set(id, remaining);
    }
  }
  return result;
}

/** Add `delta` grant counts. */
function addGrantCounts(
  base: Map<string, number>,
  delta: Map<string, number>,
): Map<string, number> {
  const result = new Map(base);
  for (const [id, count] of delta) {
    result.set(id, (result.get(id) ?? 0) + count);
  }
  return result;
}

/**
 * Build the `StatBonusSource` array for `computeEffectiveStatsFromLoadout`.
 * Uses the `frozen` fields of each instance (same shape as the runtime path).
 */
function toStatBonusSources(items: readonly EquippedLoadoutItem[]): StatBonusSource[] {
  return items.map(({ instance }) => ({
    statBonuses: instance.frozen.statBonuses,
    weightLb: instance.frozen.weightLb,
  }));
}

/** Determine if a weapon snapshot corresponds to an AOE-capable weapon. */
function isAoeWeapon(snapshot: ActiveWeaponSnapshotV1): boolean {
  return (
    snapshot.aoeRadius > 0 ||
    snapshot.weaponType === WeaponType.MAGIC ||
    snapshot.weaponType === WeaponType.TRAP
  );
}

/** Return the damage affinity for a weapon snapshot. */
function weaponAffinity(snapshot: ActiveWeaponSnapshotV1): 'physical' | 'magic' | 'unscaled' {
  return snapshot.weaponType === WeaponType.MAGIC ? 'magic' : 'physical';
}

/**
 * Compute the expected DPS for a weapon snapshot given effective stats and
 * encounter shape.  Returns 0 when `snapshot` is null.
 *
 * Formula:
 *   rawDps = (baseDamage + damageBonus) × (1 + damagePercent)
 *            × typedPrimaryMultiplier(affinity, str, int)
 *            × accuracy × critEV
 *            ÷ (effectiveCooldownMs / 1000)
 *            × encumbranceMult
 *
 *   encounterFitDps = rawDps × aoeFitMultiplier
 *
 * where critEV = 1 + critChance × (critMultiplier – 1)
 */
function computeEncounteredDps(
  snapshot: ActiveWeaponSnapshotV1,
  eff: Record<StatId, number>,
  encounterShape: EncounterShape,
  config: EvaluatorConfig,
  encumbranceMult: number,
): number {
  const affinity = weaponAffinity(snapshot);
  const typedMult = computeTypedPrimaryMultiplier(affinity, eff.strength, eff.intelligence);

  const attackSpeedBonus = eff.attackSpeed ?? 0;
  const cooldownReduction = eff.cooldownReduction ?? 0;
  const effectiveCooldownMs = applyAttackSpeedAndCooldownReduction(
    snapshot.cooldownMs,
    attackSpeedBonus,
    cooldownReduction,
  );
  const effectiveCooldownSec = Math.max(0.001, effectiveCooldownMs / 1000);

  // Accuracy: baseAccuracy from snapshot + accuracy stat bonus, clamped to [0,1]
  const accuracy = Math.min(1, Math.max(0, snapshot.baseAccuracy + (eff.accuracy ?? 0)));

  // Expected-value crit multiplier
  const critChance = Math.max(0, eff.critChance ?? 0);
  const critMultiplierStat = Math.max(1, eff.critMultiplier ?? 1.5);
  const critEV = 1 + critChance * (critMultiplierStat - 1);

  const damageBonus = eff.damageBonus ?? 0;
  const damagePercent = eff.damagePercent ?? 0;
  const baseDmg = snapshot.baseDamage + damageBonus;

  const rawDps =
    (baseDmg * (1 + damagePercent) * typedMult * accuracy * critEV * encumbranceMult) /
    effectiveCooldownSec;

  // AOE encounter-fit multiplier: linearly interpolate between 1 and the
  // configured max multiplier based on aoeRatio and whether this weapon is AOE.
  const aoeFitMult = isAoeWeapon(snapshot)
    ? 1 + encounterShape.aoeRatio * (config.aoeEncounterFitMultiplier - 1)
    : 1;

  return rawDps * aoeFitMult;
}

/**
 * Compute the effective-HP defense score for given stats.
 *
 * Uses flat armor reduction (`reducedHit = max(1, expectedHit - armor)`) to
 * derive an "armor reduction fraction", then computes eHP accordingly.
 *
 * The score is scaled by `config.defenseWeight` so it is comparable with DPS.
 */
function computeDefenseScore(eff: Record<StatId, number>, config: EvaluatorConfig): number {
  const armor = Math.max(0, eff.armor ?? 0);
  const maxHp = Math.max(0, eff.maxHp ?? 0);
  const expectedHit = Math.max(1, config.expectedEnemyHitDmg);
  const reducedHit = Math.max(1, expectedHit - armor);
  const armorReductionFraction = (expectedHit - reducedHit) / expectedHit;
  // eHP: at full reduction (fraction → 1) we clamp to avoid division by zero
  const eHP = armorReductionFraction >= 1 ? maxHp * 1000 : maxHp / (1 - armorReductionFraction);
  return eHP * config.defenseWeight;
}

/**
 * Internal description of a snapshot fed to the scorer.
 * Carries pre-computed items, weapon, and grant counts.
 */
interface InternalLoadoutSnapshot {
  readonly items: readonly EquippedLoadoutItem[];
  readonly activeWeaponSnapshot: ActiveWeaponSnapshotV1 | null;
  /** Abilities that ARE fully granted (count > 0) from equipment. */
  readonly equipmentActiveGrants: Map<string, number>;
  /** Combined configured active abilities (current + new grants, respecting slot cap). */
  readonly configuredActiveAbilityIds: ReadonlySet<string>;
  readonly totalGearWeightLb: number;
}

/**
 * Core scoring function.  Computes the three-component score for one complete
 * loadout snapshot and returns the per-component breakdown.
 */
function scoreLoadoutSnapshot(
  ctx: LoadoutEvalContext,
  snapshot: InternalLoadoutSnapshot,
): LoadoutScoreBreakdown {
  const statSources = toStatBonusSources(snapshot.items);
  const eff = computeEffectiveStatsFromLoadout(
    ctx.baseStats,
    ctx.coreStatPoints,
    statSources,
    ctx.nonEquipmentModifiers,
  );

  // Encumbrance multiplier (applied to DPS)
  const totalMassLb = snapshot.totalGearWeightLb + ctx.config.bodyWeightLb;
  const encumbranceMult = computeEncumbranceMultiplierForMass(
    totalMassLb,
    ctx.config.bodyWeightLb,
    eff.strength ?? 0,
  );

  // DPS component
  const dps =
    snapshot.activeWeaponSnapshot !== null
      ? computeEncounteredDps(
          snapshot.activeWeaponSnapshot,
          eff,
          ctx.encounterShape,
          ctx.config,
          encumbranceMult,
        )
      : 0;

  // Defense component
  const defense = computeDefenseScore(eff, ctx.config);

  // Ability-access component: number of configured active abilities × weight
  // × remaining-fraction discount (long-horizon only)
  const abilityCount = snapshot.configuredActiveAbilityIds.size;
  const abilityAccess =
    abilityCount * ctx.config.abilitySlotWeight * ctx.encounterShape.remainingFractionDiscount;

  const total = dps + defense + abilityAccess;
  return { dps, defense, encumbranceMultiplier: encumbranceMult, abilityAccess, total };
}

/**
 * Build a sort key that produces a deterministic ranking across reordered inputs.
 *
 * Format: `<sortable-totalERV>:<instanceId>`.
 * Lexicographic ascending sort correctly orders candidates: higher ERV first,
 * then `instanceId` ascending as the stable tie-breaker.
 */
function buildSortKey(totalERV: number, instanceId: string): string {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, totalERV, false);
  const bits = view.getBigUint64(0, false);
  const signMask = 0x8000000000000000n;
  const allBits = 0xffffffffffffffffn;
  const ascendingKey = (bits & signMask) !== 0n ? ~bits & allBits : bits | signMask;
  const descendingKey = (~ascendingKey & allBits).toString(16).padStart(16, '0');
  return `${descendingKey}:${instanceId}`;
}

/**
 * Identify which currently equipped items would be displaced by a candidate
 * that occupies `candidateSlots`.
 */
function findDisplacedItems(
  equippedItems: readonly EquippedLoadoutItem[],
  candidateSlots: readonly EquipmentSlotId[],
): readonly EquippedLoadoutItem[] {
  const slotSet = new Set(candidateSlots);
  return equippedItems.filter((item) => item.occupiedSlots.some((slot) => slotSet.has(slot)));
}

/**
 * Check whether a candidate's slots are legally acquirable: every slot the
 * candidate needs is either free or occupied by a displaceable item.
 */
function isLegalSlotTransition(
  equippedItems: readonly EquippedLoadoutItem[],
  candidateSlots: readonly EquipmentSlotId[],
): boolean {
  // A slot is coverable if it is unoccupied OR occupied by exactly one item
  // (single-source displacement).  Multi-slot items that only partially overlap
  // are still displaceable as a whole (the entire item is removed).
  // For H1, we accept any displacement: the displaced items are removed entirely.
  const occupied = new Map<EquipmentSlotId, EquippedLoadoutItem>();
  for (const item of equippedItems) {
    for (const slot of item.occupiedSlots) {
      occupied.set(slot, item);
    }
  }
  for (const slot of candidateSlots) {
    if (occupied.has(slot)) {
      // Slot is occupied — displacement is legal if the item was found above.
      // (All occupied slots are displaceable in this model.)
    }
    // Unoccupied slots are always legal.
  }
  return true; // All slots are coverable (occupied or free)
}

/**
 * Derive the hypothetical `configuredActiveAbilityIds` after equipping `candidate`
 * and displacing `displacedItems`.
 *
 * Algorithm:
 *   1. Start from `currentConfiguredActiveAbilityIds`.
 *   2. Subtract abilities whose grant count drops to 0 after removing displaced items.
 *   3. Add new abilities granted by the candidate (up to ACTIVE_ABILITY_SLOT_LIMIT).
 */
function deriveHypotheticalActiveAbilities(
  currentConfigured: readonly string[],
  currentGrantCounts: Map<string, number>,
  displacedGrantCounts: { active: Map<string, number> },
  candidateGrantCounts: { active: Map<string, number> },
): ReadonlySet<string> {
  // Remaining grants after displacement
  const remainingCounts = subtractGrantCounts(currentGrantCounts, displacedGrantCounts.active);

  // Remove only configured abilities whose equipment-granted source count drops
  // to zero. Non-equipment configured abilities are preserved.
  const surviving = new Set(
    currentConfigured.filter(
      (id) => !currentGrantCounts.has(id) || (remainingCounts.get(id) ?? 0) > 0,
    ),
  );

  // Add new abilities from candidate (that weren't already configured)
  for (const [abilityId] of candidateGrantCounts.active) {
    if (surviving.size >= ACTIVE_ABILITY_SLOT_LIMIT) break;
    if (!surviving.has(abilityId)) {
      surviving.add(abilityId);
    }
  }

  return surviving;
}

/**
 * Build the internal snapshot for the CURRENT loadout.
 */
function buildCurrentSnapshot(loadout: CurrentLoadoutState): InternalLoadoutSnapshot {
  const grantCounts = collectAbilityGrantCounts(loadout.equippedItems);
  const totalGearWeightLb = loadout.equippedItems.reduce(
    (sum, { instance }) => sum + instance.frozen.weightLb,
    0,
  );
  return {
    items: loadout.equippedItems,
    activeWeaponSnapshot: loadout.activeWeaponSnapshot,
    equipmentActiveGrants: grantCounts.active,
    configuredActiveAbilityIds: new Set(loadout.configuredActiveAbilityIds),
    totalGearWeightLb,
  };
}

/**
 * Build the internal snapshot for a HYPOTHETICAL loadout after equipping
 * `candidate` and displacing `displaced`.
 */
function buildHypotheticalSnapshot(
  loadout: CurrentLoadoutState,
  candidate: GeneratedEquipmentInstanceV1,
  displaced: readonly EquippedLoadoutItem[],
  currentGrantCounts: Map<string, number>,
): InternalLoadoutSnapshot {
  // Items after displacement + candidate added
  const remainingItems = loadout.equippedItems.filter(
    (item) => !displaced.some((d) => d.instance.instanceId === item.instance.instanceId),
  );
  const candidateItem: EquippedLoadoutItem = {
    instance: candidate,
    occupiedSlots: candidate.frozen.slots,
  };
  const hypotheticalItems = [...remainingItems, candidateItem];

  // Gear weight
  const totalGearWeightLb = hypotheticalItems.reduce(
    (sum, { instance }) => sum + instance.frozen.weightLb,
    0,
  );

  // Weapon snapshot: use candidate's weapon if it has one, otherwise
  // retain current (unless displaced)
  const candidateWeapon = candidate.frozen.activeWeaponSnapshot ?? null;
  let hypotheticalWeapon: ActiveWeaponSnapshotV1 | null;
  if (candidateWeapon !== null) {
    hypotheticalWeapon = candidateWeapon as ActiveWeaponSnapshotV1;
  } else if (
    loadout.activeWeaponSnapshot !== null &&
    displaced.some(
      (d) =>
        d.instance.frozen.activeWeaponSnapshot?.generatedEquipmentInstanceId ===
        loadout.activeWeaponSnapshot!.generatedEquipmentInstanceId,
    )
  ) {
    // Current weapon was displaced and candidate has no weapon
    hypotheticalWeapon = null;
  } else {
    hypotheticalWeapon = loadout.activeWeaponSnapshot;
  }

  // Ability grants
  const displacedGrantCounts = collectAbilityGrantCounts(displaced);
  const candidateGrantCounts = collectAbilityGrantCounts([candidateItem]);

  const hypotheticalActiveGrants = addGrantCounts(
    subtractGrantCounts(currentGrantCounts, displacedGrantCounts.active),
    candidateGrantCounts.active,
  );

  const configuredActiveAbilityIds = deriveHypotheticalActiveAbilities(
    loadout.configuredActiveAbilityIds,
    currentGrantCounts,
    displacedGrantCounts,
    candidateGrantCounts,
  );

  return {
    items: hypotheticalItems,
    activeWeaponSnapshot: hypotheticalWeapon,
    equipmentActiveGrants: hypotheticalActiveGrants,
    configuredActiveAbilityIds,
    totalGearWeightLb,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a single equipment candidate against the current loadout and return
 * the full ERV breakdown.
 *
 * This is the primary entry point for H1 AI decision logic.  Pure: does not
 * mutate world, inventory, or equipment state.
 *
 * @param ctx      Shared context (base stats, encounter shape, config).
 * @param loadout  Current equipped state.
 * @param candidate  The generated equipment instance to evaluate.
 */
export function scoreEquipmentCandidate(
  ctx: LoadoutEvalContext,
  loadout: CurrentLoadoutState,
  candidate: GeneratedEquipmentInstanceV1,
): EquipmentERVBreakdown {
  const currentSnapshot = buildCurrentSnapshot(loadout);
  const currentBreakdown = scoreLoadoutSnapshot(ctx, currentSnapshot);

  const displaced = findDisplacedItems(loadout.equippedItems, candidate.frozen.slots);
  const isLegalTransition = isLegalSlotTransition(loadout.equippedItems, candidate.frozen.slots);

  const hypotheticalSnapshot = buildHypotheticalSnapshot(
    loadout,
    candidate,
    displaced,
    currentSnapshot.equipmentActiveGrants,
  );
  const hypotheticalBreakdown = scoreLoadoutSnapshot(ctx, hypotheticalSnapshot);

  const totalERV = hypotheticalBreakdown.total - currentBreakdown.total;
  const dpsDelta = hypotheticalBreakdown.dps - currentBreakdown.dps;
  const defenseDelta = hypotheticalBreakdown.defense - currentBreakdown.defense;
  const abilityAccessDelta = hypotheticalBreakdown.abilityAccess - currentBreakdown.abilityAccess;

  return {
    totalERV,
    dpsDelta,
    defenseDelta,
    abilityAccessDelta,
    hypothetical: hypotheticalBreakdown,
    current: currentBreakdown,
    isLegalTransition,
    sortKey: buildSortKey(totalERV, candidate.instanceId),
  };
}

/**
 * Rank a collection of equipment candidates by descending ERV.
 *
 * - Scores each candidate against the SAME current loadout snapshot (not
 *   cascading — each candidate is evaluated independently).
 * - Tie-breaking is deterministic and stable across reordered inputs:
 *   candidates with equal ERV are sorted by instanceId lexicographically.
 * - Illegal transitions are scored and ranked normally; the `isLegalTransition`
 *   flag lets callers filter them.
 *
 * @returns Ranked candidates, best first.
 */
export function rankEquipmentCandidates(
  ctx: LoadoutEvalContext,
  loadout: CurrentLoadoutState,
  candidates: readonly GeneratedEquipmentInstanceV1[],
): RankedEquipmentCandidate[] {
  const ranked: RankedEquipmentCandidate[] = candidates.map((candidate) => ({
    candidate,
    breakdown: scoreEquipmentCandidate(ctx, loadout, candidate),
  }));

  // Sort descending by totalERV; tie-break by instanceId ascending
  ranked.sort((a, b) => {
    const delta = b.breakdown.totalERV - a.breakdown.totalERV;
    if (delta !== 0) return delta;
    return a.candidate.instanceId < b.candidate.instanceId ? -1 : 1;
  });

  return ranked;
}

/**
 * Extract `resolvedEffects` from an instance for external use (e.g. tests and
 * telemetry that want to inspect ability grants without importing the types
 * directly).
 */
export function extractEquipmentAbilityGrants(instance: GeneratedEquipmentInstanceV1): {
  active: readonly string[];
  passive: readonly string[];
} {
  const active: string[] = [];
  const passive: string[] = [];
  for (const effect of instance.resolvedEffects) {
    if (!('kind' in effect)) continue;
    if (effect.kind === 'abilityGrant') active.push(effect.grantId);
    else if (effect.kind === 'passiveGrant') passive.push(effect.grantId);
  }
  return { active, passive };
}

/**
 * Convenience re-export of the internal per-component scorer for tests and
 * external diagnostics that want a standalone `LoadoutScoreBreakdown` without
 * computing a delta.
 *
 * `items` must have unique instances (same contract as
 * `computeEffectiveStatsFromLoadout`).
 */
export function scoreLoadout(
  ctx: LoadoutEvalContext,
  items: readonly EquippedLoadoutItem[],
  activeWeaponSnapshot: ActiveWeaponSnapshotV1 | null,
  configuredActiveAbilityIds: readonly string[],
): LoadoutScoreBreakdown {
  const grantCounts = collectAbilityGrantCounts(items);
  const totalGearWeightLb = items.reduce((sum, { instance }) => sum + instance.frozen.weightLb, 0);
  const snapshot: InternalLoadoutSnapshot = {
    items,
    activeWeaponSnapshot,
    equipmentActiveGrants: grantCounts.active,
    configuredActiveAbilityIds: new Set(configuredActiveAbilityIds),
    totalGearWeightLb,
  };
  return scoreLoadoutSnapshot(ctx, snapshot);
}

// Re-export types used by callers to avoid import chains
export type { StatBonusSource } from '../../core/effective-stats.js';
export type {
  ActiveWeaponSnapshotV1,
  GeneratedEquipmentInstanceV1,
  ResolvedEquipmentEffectV1,
} from '../../shared/generated-equipment-types.js';
