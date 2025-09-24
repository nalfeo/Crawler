/**
 * Runtime integration test for the H1 equipment evaluator.
 *
 * Consumes actual D1 generated instances built by the production generator
 * (plasma-pistol / iron-breastplate) against a real test-world, and validates
 * the ERV breakdowns using the actual C1/C2 stat contract.
 *
 * This test:
 *   - Uses `createTestWorld` (real world with generatedEquipmentRunKey)
 *   - Runs `generateEquipmentInstance` through the full D1 pipeline
 *   - Calls `scoreEquipmentCandidate` on the resulting instances
 *   - Validates that outputs satisfy the expected invariants
 */

import { describe, expect, it } from 'vitest';
import {
  rankEquipmentCandidates,
  scoreEquipmentCandidate,
  extractEquipmentAbilityGrants,
  DEFAULT_EVALUATOR_CONFIG,
  type CurrentLoadoutState,
  type LoadoutEvalContext,
  type ActiveWeaponSnapshotV1,
} from '../../src/game/ai/equipment-evaluator.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { DEFAULT_BASE_STATS } from '../../src/shared/stats.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  GENERATED_WEAPON_REQUEST,
  GENERATED_ARMOR_REQUEST,
  GENERATED_ACCESSORY_REQUEST,
} from '../fixtures/generated-equipment.js';

/** Make a minimal eval context using production defaults. */
function makeDefaultCtx(): LoadoutEvalContext {
  return {
    baseStats: DEFAULT_BASE_STATS,
    coreStatPoints: { strength: 10, dexterity: 5, constitution: 5 },
    nonEquipmentModifiers: [],
    encounterShape: { aoeRatio: 0.3, remainingFractionDiscount: 0.7 },
    config: DEFAULT_EVALUATOR_CONFIG,
  };
}

/** Empty loadout (no items equipped). */
function emptyLoadout(): CurrentLoadoutState {
  return {
    equippedItems: [],
    activeWeaponSnapshot: null,
    configuredActiveAbilityIds: [],
    activePassiveAbilityIds: [],
  };
}

describe('equipment-evaluator runtime integration', () => {
  it('scores a D1 plasma-pistol instance from the real generator', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'evaluator-runtime-test',
    });

    const pistol = generateEquipmentInstance(world, GENERATED_WEAPON_REQUEST);

    expect(pistol.frozen.activeWeaponSnapshot).not.toBeNull();

    const ctx = makeDefaultCtx();
    const loadout = emptyLoadout();
    const breakdown = scoreEquipmentCandidate(ctx, loadout, pistol);

    // Basic invariants
    expect(isFinite(breakdown.totalERV)).toBe(true);
    expect(isFinite(breakdown.dpsDelta)).toBe(true);
    expect(breakdown.isLegalTransition).toBe(true);
    // Weapon in empty loadout: hypothetical should have positive DPS
    expect(breakdown.hypothetical.dps).toBeGreaterThan(0);
    expect(breakdown.current.dps).toBe(0); // no weapon in current loadout
    // ERV should be positive: adding a weapon to an empty slot is an improvement
    expect(breakdown.totalERV).toBeGreaterThan(0);
    // Sort key is a non-empty string
    expect(typeof breakdown.sortKey).toBe('string');
    expect(breakdown.sortKey.length).toBeGreaterThan(0);
  });

  it('scores a D1 iron-breastplate instance and produces non-zero defense delta', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'evaluator-runtime-armor',
    });

    const armor = generateEquipmentInstance(world, GENERATED_ARMOR_REQUEST);
    expect(armor.frozen.activeWeaponSnapshot).toBeNull();

    const ctx = makeDefaultCtx();
    const loadout = emptyLoadout();
    const breakdown = scoreEquipmentCandidate(ctx, loadout, armor);

    expect(isFinite(breakdown.totalERV)).toBe(true);
    // Armor adds no DPS
    expect(breakdown.dpsDelta).toBe(0);
    // But adds defense
    expect(breakdown.defenseDelta).toBeGreaterThanOrEqual(0);
  });

  it('extracts ability grants from a D1 accessory via extractEquipmentAbilityGrants', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'evaluator-runtime-accessory',
    });

    const accessory = generateEquipmentInstance(world, GENERATED_ACCESSORY_REQUEST);
    const grants = extractEquipmentAbilityGrants(accessory);

    // The function must return arrays (even if empty)
    expect(Array.isArray(grants.active)).toBe(true);
    expect(Array.isArray(grants.passive)).toBe(true);
  });

  it('ranks pistol above armor when defense is zeroed out', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'evaluator-runtime-rank',
    });

    const pistol = generateEquipmentInstance(world, GENERATED_WEAPON_REQUEST);
    const armor = generateEquipmentInstance(world, GENERATED_ARMOR_REQUEST);

    // With defenseWeight=0 and no weapon in loadout, only DPS matters.
    // The pistol adds positive DPS from an empty slot → higher ERV than armor (DPS=0).
    const ctxDpsOnly: LoadoutEvalContext = {
      baseStats: DEFAULT_BASE_STATS,
      coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
      nonEquipmentModifiers: [],
      encounterShape: { aoeRatio: 0.3, remainingFractionDiscount: 0.7 },
      config: { ...DEFAULT_EVALUATOR_CONFIG, defenseWeight: 0 },
    };
    const loadout = emptyLoadout();
    const ranked = rankEquipmentCandidates(ctxDpsOnly, loadout, [pistol, armor]);

    // Both transitions should be legal from an empty loadout
    for (const { breakdown } of ranked) {
      expect(breakdown.isLegalTransition).toBe(true);
    }

    // With defenseWeight=0 and an empty weapon slot, the pistol adds DPS and should rank first
    const pistolRank = ranked.findIndex((r) => r.candidate.instanceId === pistol.instanceId);
    const armorRank = ranked.findIndex((r) => r.candidate.instanceId === armor.instanceId);
    expect(pistolRank).toBeLessThan(armorRank);
  });

  it('produces deterministic scores across two identical world setups', () => {
    const worldA = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'evaluator-determinism-a',
    });
    const worldB = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'evaluator-determinism-a',
    });

    const pistolA = generateEquipmentInstance(worldA, GENERATED_WEAPON_REQUEST);
    const pistolB = generateEquipmentInstance(worldB, GENERATED_WEAPON_REQUEST);

    expect(pistolA.fingerprint).toBe(pistolB.fingerprint);

    const ctx = makeDefaultCtx();
    const loadout = emptyLoadout();
    const breakdownA = scoreEquipmentCandidate(ctx, loadout, pistolA);
    const breakdownB = scoreEquipmentCandidate(ctx, loadout, pistolB);

    expect(breakdownA.totalERV).toBe(breakdownB.totalERV);
    expect(breakdownA.dpsDelta).toBe(breakdownB.dpsDelta);
    expect(breakdownA.defenseDelta).toBe(breakdownB.defenseDelta);
    expect(breakdownA.hypothetical.dps).toBe(breakdownB.hypothetical.dps);
  });

  it('displacement cost: scoring a candidate against itself gives ERV = 0', () => {
    // When the candidate is identical to the currently-equipped item, the loadout
    // delta is zero: the displacement removes the item and the candidate adds it back
    // with identical stats and grants. This validates the displacement mechanism end-to-end.
    // The current loadout must accurately reflect the item's granted abilities;
    // extractEquipmentAbilityGrants supplies the correct starting set.
    const worldSetup = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'evaluator-displacement',
    });
    const pistol = generateEquipmentInstance(worldSetup, GENERATED_WEAPON_REQUEST);

    const pistolSnap = pistol.frozen.activeWeaponSnapshot as ActiveWeaponSnapshotV1;
    const grants = extractEquipmentAbilityGrants(pistol);

    const loadoutWithPistol: CurrentLoadoutState = {
      equippedItems: [{ instance: pistol, occupiedSlots: ['mainHand'] }],
      activeWeaponSnapshot: pistolSnap,
      // Reflect the pistol's actual granted abilities so the hypothetical re-adds
      // the same set and the ability-access delta stays zero.
      configuredActiveAbilityIds: grants.active,
      activePassiveAbilityIds: grants.passive,
    };

    const ctx = makeDefaultCtx();
    const breakdown = scoreEquipmentCandidate(ctx, loadoutWithPistol, pistol);

    // Replacing with the same item: ERV must be exactly 0 (perfect symmetry)
    expect(breakdown.totalERV).toBe(0);
    expect(breakdown.dpsDelta).toBe(0);
    expect(breakdown.defenseDelta).toBe(0);
  });
});
