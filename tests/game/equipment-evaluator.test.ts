/**
 * Fixed-fixture tests for src/game/ai/equipment-evaluator.ts (H1 ERV scorer).
 *
 * These tests validate the scoring logic using hand-crafted generated-equipment
 * instances with controlled combat stats, so expected-value outcomes are
 * predictable without running the full D1 generator pipeline.
 */

import { describe, expect, it } from 'vitest';
import {
  createActiveWeaponSnapshotV1,
  createGeneratedEquipmentInstance,
  createGeneratedEquipmentRegistry,
  generatedEquipmentInstanceKey,
} from '../../src/core/generated-equipment-registry.js';
import {
  DEFAULT_EVALUATOR_CONFIG,
  rankEquipmentCandidates,
  scoreEquipmentCandidate,
  scoreLoadout,
  extractEquipmentAbilityGrants,
  type CurrentLoadoutState,
  type EncounterShape,
  type EquippedLoadoutItem,
  type EvaluatorConfig,
  type LoadoutEvalContext,
} from '../../src/game/ai/equipment-evaluator.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type GeneratedEquipmentCreateInputV1,
  type GeneratedEquipmentInstanceV1,
  type ActiveWeaponSnapshotV1,
} from '../../src/shared/generated-equipment-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { DEFAULT_BASE_STATS } from '../../src/shared/stats.js';

// ---------------------------------------------------------------------------
// Test world factory
// ---------------------------------------------------------------------------

function makeWorld(runKey: string) {
  return { generatedEquipmentRegistry: createGeneratedEquipmentRegistry({ runKey }) };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeWeaponInstance(
  world: ReturnType<typeof makeWorld>,
  name: string,
  weaponDefId: string,
  overrides: Record<string, unknown>,
  weightLb = 2,
): GeneratedEquipmentInstanceV1 {
  const weaponDef = getWeaponDef(weaponDefId);
  if (!weaponDef) throw new Error(`Unknown weapon def: ${weaponDefId}`);
  const ordinal = getNextOrdinal(world);
  const instanceId = generatedEquipmentInstanceKey(
    world.generatedEquipmentRegistry.runKey!,
    ordinal,
  );
  const snapshot = createActiveWeaponSnapshotV1({ instanceId }, weaponDef, overrides);
  // Use 'common' rarity so 0 resolved effects are valid (common requires 0 effect units).
  return createGeneratedEquipmentInstance(world, {
    baseId: `${weaponDefId}-fixture`,
    itemLevel: 3,
    rarity: 'common',
    enhancementLevel: 0,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: name,
      artKey: `${weaponDefId}-art`,
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: snapshot,
    },
  } satisfies GeneratedEquipmentCreateInputV1);
}

const _ordinalCounters = new WeakMap<ReturnType<typeof makeWorld>, number>();
function getNextOrdinal(world: ReturnType<typeof makeWorld>): number {
  // createGeneratedEquipmentInstance increments ordinal internally; we just
  // need to predict the next one to build the snapshot beforehand.
  // The simplest approach: count how many instances the world's registry state
  // already has — which equals the next ordinal.
  const count = _ordinalCounters.get(world) ?? 0;
  _ordinalCounters.set(world, count + 1);
  return count;
}

function makeArmorInstance(
  world: ReturnType<typeof makeWorld>,
  name: string,
  armorBonus: number,
  weightLb: number,
): GeneratedEquipmentInstanceV1 {
  // Use 'uncommon' rarity (1 effect unit) since we provide one stat effect.
  return createGeneratedEquipmentInstance(world, {
    baseId: 'armor-fixture',
    itemLevel: 3,
    rarity: 'uncommon',
    enhancementLevel: 0,
    resolvedEffects: [
      {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: 'armor-bonus',
        effectOrdinal: 0,
        unitCost: 1,
        kind: 'stat',
        stat: 'armor',
        operation: 'add',
        value: armorBonus,
      },
    ],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: name,
      artKey: 'armor-art',
      slots: ['chest'],
      tags: ['armor'],
      weightLb,
      statBonuses: { armor: armorBonus },
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  } satisfies GeneratedEquipmentCreateInputV1);
}

function makeAbilityGrantItem(
  world: ReturnType<typeof makeWorld>,
  name: string,
  abilityId: string,
): GeneratedEquipmentInstanceV1 {
  // Use 'uncommon' rarity (1 effect unit) for a single abilityGrant effect.
  return createGeneratedEquipmentInstance(world, {
    baseId: 'ability-accessory-fixture',
    itemLevel: 3,
    rarity: 'uncommon',
    enhancementLevel: 0,
    resolvedEffects: [
      {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: 'ability-grant',
        effectOrdinal: 0,
        unitCost: 1,
        kind: 'abilityGrant',
        grantId: abilityId,
      },
    ],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: name,
      artKey: 'accessory-art',
      slots: ['neck'],
      tags: ['accessory'],
      weightLb: 0.5,
      statBonuses: {},
      abilityGrants: [abilityId],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  } satisfies GeneratedEquipmentCreateInputV1);
}

function makePassiveGrantItem(
  world: ReturnType<typeof makeWorld>,
  name: string,
  passiveId: string,
): GeneratedEquipmentInstanceV1 {
  return createGeneratedEquipmentInstance(world, {
    baseId: 'passive-accessory-fixture',
    itemLevel: 3,
    rarity: 'uncommon',
    enhancementLevel: 0,
    resolvedEffects: [
      {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: 'passive-grant',
        effectOrdinal: 0,
        unitCost: 1,
        kind: 'passiveGrant',
        grantId: passiveId,
      },
    ],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: name,
      artKey: 'passive-accessory-art',
      slots: ['neck'],
      tags: ['accessory'],
      weightLb: 0.5,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [passiveId],
      activeWeaponSnapshot: null,
    },
  } satisfies GeneratedEquipmentCreateInputV1);
}

// ---------------------------------------------------------------------------
// Shared evaluation context builder
// ---------------------------------------------------------------------------

function makeCtx(
  encounterShape: EncounterShape = { aoeRatio: 0, remainingFractionDiscount: 1 },
  configOverrides: Partial<EvaluatorConfig> = {},
): LoadoutEvalContext {
  return {
    baseStats: DEFAULT_BASE_STATS,
    coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
    nonEquipmentModifiers: [],
    encounterShape,
    config: { ...DEFAULT_EVALUATOR_CONFIG, ...configOverrides },
  };
}

function emptyLoadout(weaponSnapshot: ActiveWeaponSnapshotV1 | null = null): CurrentLoadoutState {
  return {
    equippedItems: [],
    activeWeaponSnapshot: weaponSnapshot,
    configuredActiveAbilityIds: [],
    activePassiveAbilityIds: [],
  };
}

function equippedLoadout(
  items: EquippedLoadoutItem[],
  weaponSnapshot: ActiveWeaponSnapshotV1 | null = null,
): CurrentLoadoutState {
  return {
    equippedItems: items,
    activeWeaponSnapshot: weaponSnapshot,
    configuredActiveAbilityIds: [],
    activePassiveAbilityIds: [],
  };
}

// ---------------------------------------------------------------------------
// Fixture tests
// ---------------------------------------------------------------------------

describe('equipment-evaluator: DPS preference', () => {
  it('prefers the higher-damage weapon at a single-target encounter (aoeRatio=0)', () => {
    const world = makeWorld('test-dps-preference');
    const lowDmg = makeWeaponInstance(world, 'Weak Pistol', 'pistol', { baseDamage: 20 });
    const highDmg = makeWeaponInstance(world, 'Strong Pistol', 'pistol', { baseDamage: 60 });

    const lowSnap = lowDmg.frozen.activeWeaponSnapshot as ActiveWeaponSnapshotV1;

    const ctx = makeCtx({ aoeRatio: 0, remainingFractionDiscount: 1 });

    // Score the high-damage weapon from an empty loadout equipped with low-damage
    const loadout = equippedLoadout([{ instance: lowDmg, occupiedSlots: ['mainHand'] }], lowSnap);

    const lowERV = scoreEquipmentCandidate(ctx, loadout, lowDmg);
    const highERV = scoreEquipmentCandidate(ctx, loadout, highDmg);

    // High-damage should have higher ERV (positive delta from current)
    expect(highERV.totalERV).toBeGreaterThan(lowERV.totalERV);
    expect(highERV.dpsDelta).toBeGreaterThan(0);
  });

  it('scoreLoadout DPS is zero for a loadout with no weapon', () => {
    const world = makeWorld('test-no-weapon');
    const armor = makeArmorInstance(world, 'Iron Chest', 10, 15);
    const ctx = makeCtx();

    const score = scoreLoadout(ctx, [{ instance: armor, occupiedSlots: ['chest'] }], null, []);

    expect(score.dps).toBe(0);
    expect(score.defense).toBeGreaterThan(0);
  });
});

describe('equipment-evaluator: AOE encounter fit', () => {
  it('prefers AOE weapon at high aoeRatio when DPS is comparable', () => {
    const world = makeWorld('test-aoe-preference');
    // Fireball is MAGIC type → AOE
    const aoeMagic = makeWeaponInstance(world, 'Fireball', 'fireball', { baseDamage: 30 });
    // Pistol is RANGED → single-target
    const singleTarget = makeWeaponInstance(world, 'Pistol', 'pistol', { baseDamage: 30 });

    const ctxAoe = makeCtx(
      { aoeRatio: 1.0, remainingFractionDiscount: 1 },
      {
        aoeEncounterFitMultiplier: 2.0,
      },
    );
    const ctxSingle = makeCtx({ aoeRatio: 0.0, remainingFractionDiscount: 1 });

    const loadout = emptyLoadout();

    const aoeScoreHighRatio = scoreEquipmentCandidate(ctxAoe, loadout, aoeMagic);
    const singleScoreHighRatio = scoreEquipmentCandidate(ctxAoe, loadout, singleTarget);

    // At aoeRatio=1.0 with a 2x AOE multiplier, AOE weapon should score higher
    expect(aoeScoreHighRatio.totalERV).toBeGreaterThan(singleScoreHighRatio.totalERV);

    const aoeScoreLowRatio = scoreEquipmentCandidate(ctxSingle, loadout, aoeMagic);
    const singleScoreLowRatio = scoreEquipmentCandidate(ctxSingle, loadout, singleTarget);

    // At aoeRatio=0, single-target should win or tie (no AOE bonus)
    expect(singleScoreLowRatio.totalERV).toBeGreaterThanOrEqual(aoeScoreLowRatio.totalERV);
  });

  it('scales AOE bonus continuously between aoeRatio 0 and 1', () => {
    const world = makeWorld('test-aoe-scale');
    const magic = makeWeaponInstance(world, 'Ember Wand', 'ember-wand', {});
    const ctx0 = makeCtx({ aoeRatio: 0.0, remainingFractionDiscount: 1 });
    const ctx05 = makeCtx({ aoeRatio: 0.5, remainingFractionDiscount: 1 });
    const ctx1 = makeCtx({ aoeRatio: 1.0, remainingFractionDiscount: 1 });
    const loadout = emptyLoadout();

    const s0 = scoreEquipmentCandidate(ctx0, loadout, magic).totalERV;
    const s05 = scoreEquipmentCandidate(ctx05, loadout, magic).totalERV;
    const s1 = scoreEquipmentCandidate(ctx1, loadout, magic).totalERV;

    expect(s05).toBeGreaterThan(s0);
    expect(s1).toBeGreaterThan(s05);
  });
});

describe('equipment-evaluator: defense tradeoffs', () => {
  it('prefers heavy armor when defenseWeight is high and enemy hit damage is large', () => {
    const world = makeWorld('test-defense');
    const lightArmor = makeArmorInstance(world, 'Leather Vest', 5, 5);
    const heavyArmor = makeArmorInstance(world, 'Plate Armor', 40, 25);

    const ctxDefenseFocused = makeCtx(
      { aoeRatio: 0, remainingFractionDiscount: 1 },
      { defenseWeight: 2.0, expectedEnemyHitDmg: 50 },
    );

    const loadout = emptyLoadout();
    const lightScore = scoreEquipmentCandidate(ctxDefenseFocused, loadout, lightArmor);
    const heavyScore = scoreEquipmentCandidate(ctxDefenseFocused, loadout, heavyArmor);

    expect(heavyScore.defenseDelta).toBeGreaterThan(lightScore.defenseDelta);
    expect(heavyScore.totalERV).toBeGreaterThan(lightScore.totalERV);
  });

  it('prefers lighter armor when DPS matters more than defense', () => {
    const world = makeWorld('test-dps-vs-armor');
    const weapon = makeWeaponInstance(world, 'Pistol', 'pistol', { baseDamage: 50 });
    // 50lb armor pushes total mass above the unburdened threshold when STR is low.
    // With effectiveStr=1 (baseStats=1 + coreStr=0) and bodyWeightLb=120:
    //   unburdenedMaxLb = 120 + 40 + 1*5 = 165
    //   Hypothetical mass = 120 (body) + 2 (weapon) + 50 (armor) = 172 > 165 → encumbered
    const armor = makeArmorInstance(world, 'Plate', 50, 50);

    const wSnap = weapon.frozen.activeWeaponSnapshot as ActiveWeaponSnapshotV1;
    const loadoutWithWeapon = equippedLoadout(
      [{ instance: weapon, occupiedSlots: ['mainHand'] }],
      wSnap,
    );

    // Explicitly pass strength: 0 so effectiveStr = DEFAULT_BASE_STATS.strength(1) + 0 = 1
    const ctxDpsFocused: LoadoutEvalContext = {
      baseStats: DEFAULT_BASE_STATS,
      coreStatPoints: { strength: 0, dexterity: 0, constitution: 0 },
      nonEquipmentModifiers: [],
      encounterShape: { aoeRatio: 0, remainingFractionDiscount: 1 },
      config: { ...DEFAULT_EVALUATOR_CONFIG, defenseWeight: 0.01, bodyWeightLb: 120 },
    };

    const armorScore = scoreEquipmentCandidate(ctxDpsFocused, loadoutWithWeapon, armor);

    // Equipping heavy armor crosses the encumbrance threshold and drops DPS
    expect(armorScore.dpsDelta).toBeLessThan(0);
  });
});

describe('equipment-evaluator: encumbrance penalty', () => {
  it('scores a heavy weapon lower than a lighter equivalent when STR is low', () => {
    const world = makeWorld('test-encumbrance');
    // Two pistols with same baseDamage but very different weights.
    // Light (2lb): total mass = bodyWeight(120) + 2 = 122 → unburdened (mult=1.0)
    // Heavy (50lb): total mass = bodyWeight(120) + 50 = 170 → encumbered (mult=0.85)
    //   because unburdenedMaxLb = 120 + 40 + str*5 = 165 with effectiveStr=1.
    const lightPistol = makeWeaponInstance(world, 'Light Pistol', 'pistol', { baseDamage: 40 }, 2);
    const heavyPistol = makeWeaponInstance(world, 'Heavy Pistol', 'pistol', { baseDamage: 40 }, 50);

    // Low core-stat STR (0 allocated) so effectiveStr = DEFAULT_BASE_STATS.strength(1) + 0 = 1
    const ctx: LoadoutEvalContext = {
      baseStats: DEFAULT_BASE_STATS,
      coreStatPoints: { strength: 0, dexterity: 0, constitution: 0 },
      nonEquipmentModifiers: [],
      encounterShape: { aoeRatio: 0, remainingFractionDiscount: 1 },
      config: { ...DEFAULT_EVALUATOR_CONFIG, bodyWeightLb: 120 },
    };

    const loadout = emptyLoadout();
    const lightBreakdown = scoreEquipmentCandidate(ctx, loadout, lightPistol);
    const heavyBreakdown = scoreEquipmentCandidate(ctx, loadout, heavyPistol);

    expect(lightBreakdown.totalERV).toBeGreaterThan(heavyBreakdown.totalERV);
    // The encumbrance multiplier in the hypothetical loadout should be lower for heavy
    expect(heavyBreakdown.hypothetical.encumbranceMultiplier).toBeLessThan(
      lightBreakdown.hypothetical.encumbranceMultiplier,
    );
  });
});

describe('equipment-evaluator: ability access', () => {
  it('prefers an item granting a new ability when ability slots are available', () => {
    const world = makeWorld('test-ability-grant');
    const plainRing = makeArmorInstance(world, 'Plain Ring', 1, 0.1); // use chest slot for simplicity
    // Override to use 'neck' slot
    const abilityItem = makeAbilityGrantItem(world, 'Power Amulet', 'power-blast');

    const ctxHighAbilityWeight = makeCtx(
      { aoeRatio: 0, remainingFractionDiscount: 1 },
      { abilitySlotWeight: 50 }, // heavy weight on ability access
    );

    const loadout = emptyLoadout();
    const plainScore = scoreEquipmentCandidate(ctxHighAbilityWeight, loadout, plainRing);
    const abilityScore = scoreEquipmentCandidate(ctxHighAbilityWeight, loadout, abilityItem);

    // The ability-granting item adds abilityAccess score; plain ring only adds tiny defense
    expect(abilityScore.abilityAccessDelta).toBeGreaterThan(0);
    expect(abilityScore.totalERV).toBeGreaterThan(plainScore.totalERV);
  });

  it('discounts ability access by remainingFractionDiscount', () => {
    const world = makeWorld('test-ability-discount');
    const abilityItem = makeAbilityGrantItem(world, 'Power Amulet', 'power-blast');

    const ctxFullFuture = makeCtx({ aoeRatio: 0, remainingFractionDiscount: 1 });
    const ctxNoFuture = makeCtx({ aoeRatio: 0, remainingFractionDiscount: 0 });
    const loadout = emptyLoadout();

    const fullScore = scoreEquipmentCandidate(ctxFullFuture, loadout, abilityItem);
    const noFutureScore = scoreEquipmentCandidate(ctxNoFuture, loadout, abilityItem);

    expect(fullScore.abilityAccessDelta).toBeGreaterThan(noFutureScore.abilityAccessDelta);
  });

  it('extracts ability grants correctly from resolved effects', () => {
    const world = makeWorld('test-extract-grants');
    const item = makeAbilityGrantItem(world, 'Power Amulet', 'power-blast');
    const grants = extractEquipmentAbilityGrants(item);
    expect(grants.active).toContain('power-blast');
    expect(grants.passive).toHaveLength(0);
  });

  it('preserves non-equipment configured actives when scoring unrelated candidates', () => {
    const world = makeWorld('test-non-equipment-active-retained');
    const plainRing = makeArmorInstance(world, 'Plain Ring', 1, 0.1);
    const ctx = makeCtx({ aoeRatio: 0, remainingFractionDiscount: 1 }, { abilitySlotWeight: 5 });
    const loadout: CurrentLoadoutState = {
      equippedItems: [],
      activeWeaponSnapshot: null,
      configuredActiveAbilityIds: ['fireball'],
      activePassiveAbilityIds: [],
    };

    const breakdown = scoreEquipmentCandidate(ctx, loadout, plainRing);

    expect(breakdown.current.abilityAccess).toBe(5);
    expect(breakdown.hypothetical.abilityAccess).toBe(5);
    expect(breakdown.abilityAccessDelta).toBe(0);
  });

  it('scores passive-grant accessories above inert accessories when the passive changes stats', () => {
    const world = makeWorld('test-passive-grant-score');
    const plainRing = makeArmorInstance(world, 'Plain Ring', 1, 0.5);
    const passiveRing = makePassiveGrantItem(world, 'Veteran Ring', 'veteran-instinct');
    const ctx = makeCtx(
      { aoeRatio: 0, remainingFractionDiscount: 1 },
      { defenseWeight: 10, expectedEnemyHitDmg: 10 },
    );
    const loadout = emptyLoadout();

    const plainScore = scoreEquipmentCandidate(ctx, loadout, plainRing);
    const passiveScore = scoreEquipmentCandidate(ctx, loadout, passiveRing);

    expect(passiveScore.totalERV).toBeGreaterThan(plainScore.totalERV);
    expect(passiveScore.defenseDelta).toBeGreaterThan(plainScore.defenseDelta);
  });
});

describe('equipment-evaluator: displacement cost', () => {
  it('captures the opportunity cost of displacing a good weapon automatically', () => {
    const world = makeWorld('test-displacement');
    const strongWeapon = makeWeaponInstance(world, 'Strong Pistol', 'pistol', { baseDamage: 80 });
    const weakReplacement = makeWeaponInstance(world, 'Weak Pistol', 'pistol', { baseDamage: 15 });

    const strongSnap = strongWeapon.frozen.activeWeaponSnapshot as ActiveWeaponSnapshotV1;
    const loadout = equippedLoadout(
      [{ instance: strongWeapon, occupiedSlots: ['mainHand'] }],
      strongSnap,
    );
    const ctx = makeCtx({ aoeRatio: 0, remainingFractionDiscount: 1 });

    const breakdown = scoreEquipmentCandidate(ctx, loadout, weakReplacement);

    // Replacing a strong weapon with a weak one: ERV must be negative
    expect(breakdown.totalERV).toBeLessThan(0);
    expect(breakdown.dpsDelta).toBeLessThan(0);
  });
});

describe('equipment-evaluator: rankEquipmentCandidates', () => {
  it('sorts candidates by descending totalERV', () => {
    const world = makeWorld('test-rank');
    const weak = makeWeaponInstance(world, 'Weak', 'pistol', { baseDamage: 10 });
    const mid = makeWeaponInstance(world, 'Mid', 'pistol', { baseDamage: 30 });
    const strong = makeWeaponInstance(world, 'Strong', 'pistol', { baseDamage: 60 });

    const ctx = makeCtx();
    const loadout = emptyLoadout();

    const ranked = rankEquipmentCandidates(ctx, loadout, [weak, mid, strong]);

    // Strong should be first, weak last
    expect(ranked.at(0)?.candidate.instanceId).toBe(strong.instanceId);
    expect(ranked.at(-1)?.candidate.instanceId).toBe(weak.instanceId);
  });

  it('produces deterministic rankings regardless of input order', () => {
    const world = makeWorld('test-rank-determinism');
    const a = makeWeaponInstance(world, 'PistolA', 'pistol', { baseDamage: 40 });
    const b = makeWeaponInstance(world, 'PistolB', 'pistol', { baseDamage: 40 });

    const ctx = makeCtx();
    const loadout = emptyLoadout();

    const ranked1 = rankEquipmentCandidates(ctx, loadout, [a, b]);
    const ranked2 = rankEquipmentCandidates(ctx, loadout, [b, a]);

    // Same ERV (identical stats) → tie-break by instanceId should produce same order
    expect(ranked1.map((r) => r.candidate.instanceId)).toEqual(
      ranked2.map((r) => r.candidate.instanceId),
    );
  });

  it('sortKey orders negative ERVs correctly with ascending lexicographic sort', () => {
    const world = makeWorld('test-negative-sort-key');
    const currentWeapon = makeWeaponInstance(world, 'Current', 'pistol', { baseDamage: 80 });
    const lessBad = makeWeaponInstance(world, 'Less Bad', 'pistol', { baseDamage: 30 });
    const worse = makeWeaponInstance(world, 'Worse', 'pistol', { baseDamage: 10 });

    const currentSnap = currentWeapon.frozen.activeWeaponSnapshot as ActiveWeaponSnapshotV1;
    const loadout = equippedLoadout(
      [{ instance: currentWeapon, occupiedSlots: ['mainHand'] }],
      currentSnap,
    );
    const ctx = makeCtx();

    const breakdowns = [lessBad, worse].map((candidate) => ({
      candidate,
      breakdown: scoreEquipmentCandidate(ctx, loadout, candidate),
    }));
    const [lessBadBreakdown, worseBreakdown] = breakdowns;

    expect(lessBadBreakdown!.breakdown.totalERV).toBeGreaterThan(
      worseBreakdown!.breakdown.totalERV,
    );

    const bySortKey = [...breakdowns]
      .sort((a, b) => a.breakdown.sortKey.localeCompare(b.breakdown.sortKey))
      .map((entry) => entry.candidate.instanceId);
    const byRank = rankEquipmentCandidates(
      ctx,
      loadout,
      breakdowns.map((entry) => entry.candidate),
    ).map((entry) => entry.candidate.instanceId);

    expect(bySortKey).toEqual(byRank);
  });

  it('flags all transitions as legal for non-conflicting items', () => {
    const world = makeWorld('test-legal');
    const weapon = makeWeaponInstance(world, 'Pistol', 'pistol', { baseDamage: 30 });
    const armor = makeArmorInstance(world, 'Vest', 5, 5); // chest slot

    const ctx = makeCtx();
    const loadout = emptyLoadout(); // no items equipped yet

    const ranked = rankEquipmentCandidates(ctx, loadout, [weapon, armor]);
    for (const { breakdown } of ranked) {
      expect(breakdown.isLegalTransition).toBe(true);
    }
  });
});

describe('equipment-evaluator: score finiteness', () => {
  it('produces finite scores for canonical weapon types', () => {
    const weapons: Array<[string, string]> = [
      ['pistol', 'pistol'],
      ['fireball', 'fireball'],
      ['ember-wand', 'ember-wand'],
    ];
    const world = makeWorld('test-finite');

    for (const [name, defId] of weapons) {
      const inst = makeWeaponInstance(world, name, defId, {});
      const ctx = makeCtx();
      const loadout = emptyLoadout();
      const breakdown = scoreEquipmentCandidate(ctx, loadout, inst);

      expect(isFinite(breakdown.totalERV)).toBe(true);
      expect(isFinite(breakdown.hypothetical.dps)).toBe(true);
      expect(isFinite(breakdown.hypothetical.defense)).toBe(true);
      expect(isFinite(breakdown.hypothetical.abilityAccess)).toBe(true);
    }
  });

  it('handles minimum-cooldown edge case without NaN or Infinity', () => {
    // cooldownMs must be >= 1 (registry enforces integer >= 1); the evaluator
    // additionally clamps to 0.001s to guard against any future edge case.
    const world = makeWorld('test-min-cooldown');
    const weapon = makeWeaponInstance(world, 'Fast Pistol', 'pistol', { cooldownMs: 1 });
    const ctx = makeCtx();
    const breakdown = scoreEquipmentCandidate(ctx, emptyLoadout(), weapon);
    expect(isFinite(breakdown.totalERV)).toBe(true);
  });
});

describe('equipment-evaluator: non-mutation', () => {
  it('does not mutate the loadout or candidates after scoring', () => {
    const world = makeWorld('test-no-mutation');
    const weapon = makeWeaponInstance(world, 'Pistol', 'pistol', { baseDamage: 40 });
    const armor = makeArmorInstance(world, 'Vest', 10, 8);

    const snap = weapon.frozen.activeWeaponSnapshot as ActiveWeaponSnapshotV1;
    const loadout: CurrentLoadoutState = {
      equippedItems: [{ instance: weapon, occupiedSlots: ['mainHand'] }],
      activeWeaponSnapshot: snap,
      configuredActiveAbilityIds: [],
      activePassiveAbilityIds: [],
    };
    const ctx = makeCtx();

    const originalEquippedLength = loadout.equippedItems.length;
    const originalSnap = loadout.activeWeaponSnapshot;

    scoreEquipmentCandidate(ctx, loadout, armor);

    expect(loadout.equippedItems).toHaveLength(originalEquippedLength);
    expect(loadout.activeWeaponSnapshot).toBe(originalSnap);
    expect(Object.isFrozen(weapon.frozen)).toBe(true);
  });
});
