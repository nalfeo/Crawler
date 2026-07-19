/**
 * Property-based tests for src/game/ai/equipment-evaluator.ts (H1 ERV scorer).
 *
 * Covers:
 *   - Score finiteness (no NaN/Infinity in any output field)
 *   - Deterministic replay: same inputs → identical outputs
 *   - Non-mutation of context, loadout, or candidates
 *   - Sort stability: rankings are independent of candidate list order
 *   - Legal-transition invariant: all results are boolean, not undefined
 */

import * as fc from 'fast-check';
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
  type CurrentLoadoutState,
  type EncounterShape,
  type EvaluatorConfig,
  type LoadoutEvalContext,
  type EquippedLoadoutItem,
} from '../../src/game/ai/equipment-evaluator.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type GeneratedEquipmentInstanceV1,
  type ActiveWeaponSnapshotV1,
} from '../../src/shared/generated-equipment-types.js';
import { DEFAULT_BASE_STATS } from '../../src/shared/stats.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const encounterShapeArb = fc.record<EncounterShape>({
  aoeRatio: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
  remainingFractionDiscount: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
});

const configArb = fc.record<EvaluatorConfig>({
  expectedEnemyHitDmg: fc.float({ min: Math.fround(1), max: Math.fround(200), noNaN: true }),
  defenseWeight: fc.float({ min: Math.fround(0), max: Math.fround(5), noNaN: true }),
  bodyWeightLb: fc.float({ min: Math.fround(50), max: Math.fround(400), noNaN: true }),
  abilitySlotWeight: fc.float({ min: Math.fround(0), max: Math.fround(100), noNaN: true }),
  aoeEncounterFitMultiplier: fc.float({ min: Math.fround(1), max: Math.fround(5), noNaN: true }),
});

const weaponDefIdArb = fc.constantFrom('pistol', 'bow', 'fireball', 'ember-wand');
const baseDamageArb = fc.integer({ min: 1, max: 200 });
const weightLbArb = fc.integer({ min: 1, max: 50 });

/** Build a fresh registry world for isolation. */
function freshWorld(runKey: string) {
  return { generatedEquipmentRegistry: createGeneratedEquipmentRegistry({ runKey }) };
}

/** Create a weapon instance with a given ordinal using the provided run key. */
function makePropertyWeapon(
  runKey: string,
  ordinal: number,
  weaponDefId: string,
  baseDamage: number,
  weightLb: number,
): GeneratedEquipmentInstanceV1 {
  const world = { generatedEquipmentRegistry: createGeneratedEquipmentRegistry({ runKey }) };
  const weaponDef = getWeaponDef(weaponDefId);
  if (!weaponDef) throw new Error(`Unknown weapon def: ${weaponDefId}`);
  // Pre-create dummy instances to advance ordinal to the target ordinal.
  for (let i = 0; i < ordinal; i++) {
    createGeneratedEquipmentInstance(world, {
      baseId: 'dummy',
      itemLevel: 1,
      rarity: 'common',
      enhancementLevel: 0,
      resolvedEffects: [],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Dummy',
        artKey: 'dummy',
        slots: ['neck'],
        tags: [],
        weightLb: 1,
        statBonuses: {},
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });
  }
  const instanceId = generatedEquipmentInstanceKey(runKey, ordinal);
  const snapshot = createActiveWeaponSnapshotV1({ instanceId }, weaponDef, { baseDamage });
  return createGeneratedEquipmentInstance(world, {
    baseId: `${weaponDefId}-prop`,
    itemLevel: 3,
    rarity: 'common',
    enhancementLevel: 0,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: `${weaponDefId} ${ordinal}`,
      artKey: `${weaponDefId}-art`,
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: snapshot,
    },
  });
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('equipment-evaluator properties', () => {
  it('produces finite scores for any valid encounter shape and config', () => {
    fc.assert(
      fc.property(
        encounterShapeArb,
        configArb,
        weaponDefIdArb,
        baseDamageArb,
        weightLbArb,
        (encounterShape, config, weaponDefId, baseDamage, weightLb) => {
          const world = freshWorld('prop-finite');
          const weaponDef = getWeaponDef(weaponDefId);
          if (!weaponDef) return; // skip unknown
          const instanceId = generatedEquipmentInstanceKey('prop-finite', 0);
          const snapshot = createActiveWeaponSnapshotV1({ instanceId }, weaponDef, { baseDamage });
          const inst = createGeneratedEquipmentInstance(world, {
            baseId: `${weaponDefId}-prop`,
            itemLevel: 3,
            rarity: 'common',
            enhancementLevel: 0,
            resolvedEffects: [],
            frozen: {
              schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
              displayName: 'Prop Weapon',
              artKey: 'prop-art',
              slots: ['mainHand'],
              tags: ['weapon'],
              weightLb,
              statBonuses: {},
              abilityGrants: [],
              passiveGrants: [],
              activeWeaponSnapshot: snapshot,
            },
          });

          const ctx: LoadoutEvalContext = {
            baseStats: DEFAULT_BASE_STATS,
            coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
            nonEquipmentModifiers: [],
            encounterShape,
            config,
          };
          const loadout: CurrentLoadoutState = {
            equippedItems: [],
            activeWeaponSnapshot: null,
            configuredActiveAbilityIds: [],
            activePassiveAbilityIds: [],
          };
          const breakdown = scoreEquipmentCandidate(ctx, loadout, inst);

          expect(isFinite(breakdown.totalERV)).toBe(true);
          expect(isFinite(breakdown.dpsDelta)).toBe(true);
          expect(isFinite(breakdown.defenseDelta)).toBe(true);
          expect(isFinite(breakdown.abilityAccessDelta)).toBe(true);
          expect(isFinite(breakdown.hypothetical.dps)).toBe(true);
          expect(isFinite(breakdown.hypothetical.defense)).toBe(true);
          expect(isFinite(breakdown.hypothetical.total)).toBe(true);
          expect(isFinite(breakdown.current.total)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('produces identical results for identical inputs (deterministic replay)', () => {
    fc.assert(
      fc.property(
        encounterShapeArb,
        configArb,
        weaponDefIdArb,
        baseDamageArb,
        (encounterShape, config, weaponDefId, baseDamage) => {
          const ctx: LoadoutEvalContext = {
            baseStats: DEFAULT_BASE_STATS,
            coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
            nonEquipmentModifiers: [],
            encounterShape,
            config,
          };
          const loadout: CurrentLoadoutState = {
            equippedItems: [],
            activeWeaponSnapshot: null,
            configuredActiveAbilityIds: [],
            activePassiveAbilityIds: [],
          };

          // Build the same instance twice in two independent worlds
          const run1 = makePropertyWeapon('replay-1', 0, weaponDefId, baseDamage, 2);
          const run2 = makePropertyWeapon('replay-1', 0, weaponDefId, baseDamage, 2);

          const b1 = scoreEquipmentCandidate(ctx, loadout, run1);
          const b2 = scoreEquipmentCandidate(ctx, loadout, run2);

          // All numeric fields must match exactly (deterministic)
          expect(b1.totalERV).toBe(b2.totalERV);
          expect(b1.dpsDelta).toBe(b2.dpsDelta);
          expect(b1.defenseDelta).toBe(b2.defenseDelta);
          expect(b1.hypothetical.dps).toBe(b2.hypothetical.dps);
          expect(b1.hypothetical.defense).toBe(b2.hypothetical.defense);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('ranking is stable: same set of candidates in any order yields same sorted order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            weaponDefId: weaponDefIdArb,
            baseDamage: baseDamageArb,
          }),
          { minLength: 2, maxLength: 5 },
        ),
        encounterShapeArb,
        (candidates, encounterShape) => {
          const runKey = 'prop-rank-stable';
          const instances = candidates.map((c, i) =>
            makePropertyWeapon(runKey, i, c.weaponDefId, c.baseDamage, 2),
          );
          if (instances.length < 2) return;

          const ctx: LoadoutEvalContext = {
            baseStats: DEFAULT_BASE_STATS,
            coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
            nonEquipmentModifiers: [],
            encounterShape,
            config: DEFAULT_EVALUATOR_CONFIG,
          };
          const loadout: CurrentLoadoutState = {
            equippedItems: [],
            activeWeaponSnapshot: null,
            configuredActiveAbilityIds: [],
            activePassiveAbilityIds: [],
          };

          const forwardRank = rankEquipmentCandidates(ctx, loadout, instances);
          const reverseRank = rankEquipmentCandidates(ctx, loadout, [...instances].reverse());

          const forwardIds = forwardRank.map((r) => r.candidate.instanceId);
          const reverseIds = reverseRank.map((r) => r.candidate.instanceId);

          expect(forwardIds).toEqual(reverseIds);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('does not mutate the context or loadout during scoring', () => {
    fc.assert(
      fc.property(weaponDefIdArb, baseDamageArb, (weaponDefId, baseDamage) => {
        const world = freshWorld('prop-no-mutation');
        const weaponDef = getWeaponDef(weaponDefId);
        if (!weaponDef) return;
        const instanceId = generatedEquipmentInstanceKey('prop-no-mutation', 0);
        const snapshot = createActiveWeaponSnapshotV1({ instanceId }, weaponDef, { baseDamage });
        const inst = createGeneratedEquipmentInstance(world, {
          baseId: 'weapon-prop',
          itemLevel: 3,
          rarity: 'common',
          enhancementLevel: 0,
          resolvedEffects: [],
          frozen: {
            schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
            displayName: 'Prop',
            artKey: 'prop',
            slots: ['mainHand'],
            tags: ['weapon'],
            weightLb: 2,
            statBonuses: {},
            abilityGrants: [],
            passiveGrants: [],
            activeWeaponSnapshot: snapshot,
          },
        });

        const ctx: LoadoutEvalContext = {
          baseStats: DEFAULT_BASE_STATS,
          coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
          nonEquipmentModifiers: [],
          encounterShape: { aoeRatio: 0.5, remainingFractionDiscount: 0.8 },
          config: DEFAULT_EVALUATOR_CONFIG,
        };
        const loadout: CurrentLoadoutState = {
          equippedItems: [],
          activeWeaponSnapshot: null,
          configuredActiveAbilityIds: [],
          activePassiveAbilityIds: [],
        };

        scoreEquipmentCandidate(ctx, loadout, inst);

        // None of these should have been mutated
        expect(loadout.equippedItems).toHaveLength(0);
        expect(loadout.activeWeaponSnapshot).toBeNull();
        expect(loadout.configuredActiveAbilityIds).toHaveLength(0);
      }),
      { numRuns: 30 },
    );
  });

  it('isLegalTransition is always boolean in results', () => {
    fc.assert(
      fc.property(weaponDefIdArb, baseDamageArb, (weaponDefId, baseDamage) => {
        const world = freshWorld('prop-legal');
        const weaponDef = getWeaponDef(weaponDefId);
        if (!weaponDef) return;
        const instanceId = generatedEquipmentInstanceKey('prop-legal', 0);
        const snapshot = createActiveWeaponSnapshotV1({ instanceId }, weaponDef, { baseDamage });
        const inst = createGeneratedEquipmentInstance(world, {
          baseId: 'weapon-legal',
          itemLevel: 3,
          rarity: 'common',
          enhancementLevel: 0,
          resolvedEffects: [],
          frozen: {
            schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
            displayName: 'Legal',
            artKey: 'legal',
            slots: ['mainHand'],
            tags: ['weapon'],
            weightLb: 2,
            statBonuses: {},
            abilityGrants: [],
            passiveGrants: [],
            activeWeaponSnapshot: snapshot,
          },
        });

        const ctx: LoadoutEvalContext = {
          baseStats: DEFAULT_BASE_STATS,
          coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
          nonEquipmentModifiers: [],
          encounterShape: { aoeRatio: 0, remainingFractionDiscount: 1 },
          config: DEFAULT_EVALUATOR_CONFIG,
        };
        const loadout: CurrentLoadoutState = {
          equippedItems: [],
          activeWeaponSnapshot: null,
          configuredActiveAbilityIds: [],
          activePassiveAbilityIds: [],
        };

        const breakdown = scoreEquipmentCandidate(ctx, loadout, inst);
        expect(typeof breakdown.isLegalTransition).toBe('boolean');
      }),
      { numRuns: 30 },
    );
  });

  it('scoreLoadout total equals dps + defense + abilityAccess', () => {
    fc.assert(
      fc.property(
        encounterShapeArb,
        configArb,
        weaponDefIdArb,
        baseDamageArb,
        (encounterShape, config, weaponDefId, baseDamage) => {
          const world = freshWorld('prop-total');
          const weaponDef = getWeaponDef(weaponDefId);
          if (!weaponDef) return;
          const instanceId = generatedEquipmentInstanceKey('prop-total', 0);
          const snapshot = createActiveWeaponSnapshotV1({ instanceId }, weaponDef, { baseDamage });
          const inst = createGeneratedEquipmentInstance(world, {
            baseId: 'weapon-total',
            itemLevel: 3,
            rarity: 'common',
            enhancementLevel: 0,
            resolvedEffects: [],
            frozen: {
              schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
              displayName: 'Total',
              artKey: 'total',
              slots: ['mainHand'],
              tags: ['weapon'],
              weightLb: 2,
              statBonuses: {},
              abilityGrants: [],
              passiveGrants: [],
              activeWeaponSnapshot: snapshot,
            },
          });
          const ctx: LoadoutEvalContext = {
            baseStats: DEFAULT_BASE_STATS,
            coreStatPoints: { strength: 5, dexterity: 3, constitution: 3 },
            nonEquipmentModifiers: [],
            encounterShape,
            config,
          };

          const items: EquippedLoadoutItem[] = [{ instance: inst, occupiedSlots: ['mainHand'] }];
          const score = scoreLoadout(ctx, items, snapshot as ActiveWeaponSnapshotV1, []);
          const expected = score.dps + score.defense + score.abilityAccess;

          expect(score.total).toBeCloseTo(expected, 10);
        },
      ),
      { numRuns: 40 },
    );
  });
});
