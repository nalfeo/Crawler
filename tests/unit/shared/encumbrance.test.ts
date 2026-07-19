/**
 * Unit tests for `src/shared/encumbrance.ts`.
 *
 * Covers:
 *   - `getCarryThresholdLb` — STR-adjusted capacity
 *   - `getEncumbranceBand` — all four bands (pure function, explicit STR param)
 *   - `getEncumbranceMovePenalty` — penalty lookup per band
 *   - `computeEquippedWeightLb` — gear load accumulation + multi-slot dedup
 *   - catalog validation — every authored def has a finite non-negative weightLb
 *
 * NOTE on "representative loadout" tests:
 *   The `getEncumbranceBand` tests below call the *pure function* with an explicit
 *   `str = 1` parameter.  In a live game session, carry capacity uses the player's
 *   **effective** Strength (including equipment bonuses), so items like
 *   `steel-pauldrons` (+1 STR) would raise the threshold from 15 lb to 20 lb,
 *   changing which band applies.  The UI (`EquipmentUI.ts`) correctly queries
 *   effective STR; these unit tests verify the math in isolation with the exact
 *   STR value passed.
 */

import { describe, expect, it } from 'vitest';
import {
  computeEquippedWeightLb,
  ENCUMBRANCE_BASE_LB,
  ENCUMBRANCE_PER_STR_LB,
  getCarryThresholdLb,
  getEncumbranceBand,
  getEncumbranceMovePenalty,
  ENCUMBRANCE_MOVE_PENALTIES,
} from '../../../src/shared/encumbrance.js';
import { getEquipmentDefForItem, getEquippableItemIds } from '../../../src/shared/equipmentDefs.js';
import type {
  EquipmentInstance,
  EquipmentInstanceId,
  EquipmentState,
} from '../../../src/shared/equipment-types.js';
import type { EquipmentSlotId } from '../../../src/shared/equipment-slots.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal EquipmentState from a list of (slot, weightLb) pairs.
 *  Multi-slot items can be represented by repeating the same instanceId across slots. */
function makeState(
  slots: Array<{ slotId: EquipmentSlotId; instanceId: number; weightLb: number }>,
): EquipmentState {
  const equipped: Record<EquipmentSlotId, number | null> = {} as Record<
    EquipmentSlotId,
    number | null
  >;
  const instances = new Map<number, { instanceId: number; def: { weightLb: number } }>();
  for (const { slotId, instanceId, weightLb } of slots) {
    equipped[slotId] = instanceId;
    if (!instances.has(instanceId)) {
      instances.set(instanceId, {
        instanceId,
        def: { weightLb } as {
          weightLb: number;
          id: string;
          name: string;
          slots: never[];
          statBonuses: Record<string, never>;
          rarity: 'common';
        },
      });
    }
  }
  return { equipped, instances, disabledSlots: new Set() } as unknown as EquipmentState;
}

// ---------------------------------------------------------------------------
// getCarryThresholdLb
// ---------------------------------------------------------------------------

describe('getCarryThresholdLb', () => {
  it('computes BASE + PER_STR × 1 at STR 1', () => {
    expect(getCarryThresholdLb(1)).toBe(ENCUMBRANCE_BASE_LB + ENCUMBRANCE_PER_STR_LB * 1);
  });

  it('floors STR at 1 for STR 0 and negative values', () => {
    expect(getCarryThresholdLb(0)).toBe(getCarryThresholdLb(1));
    expect(getCarryThresholdLb(-5)).toBe(getCarryThresholdLb(1));
  });

  it('scales linearly with STR', () => {
    expect(getCarryThresholdLb(5)).toBe(ENCUMBRANCE_BASE_LB + ENCUMBRANCE_PER_STR_LB * 5);
    expect(getCarryThresholdLb(10)).toBe(ENCUMBRANCE_BASE_LB + ENCUMBRANCE_PER_STR_LB * 10);
  });

  it('floors fractional STR (uses Math.floor)', () => {
    // STR 1.9 floors to 1 → same as STR 1
    expect(getCarryThresholdLb(1.9)).toBe(getCarryThresholdLb(1));
    // STR 2.0 stays 2
    expect(getCarryThresholdLb(2.0)).toBe(ENCUMBRANCE_BASE_LB + ENCUMBRANCE_PER_STR_LB * 2);
  });
});

// ---------------------------------------------------------------------------
// getEncumbranceBand — representative authored loadouts
// ---------------------------------------------------------------------------

describe('getEncumbranceBand (STR 1, threshold = 15 lb)', () => {
  const str = 1;
  // cap = 15

  it('unburdened: iron-sword only (3 lb) ≤ 15 lb', () => {
    expect(getEncumbranceBand(3, str)).toBe('unburdened');
  });

  it('unburdened: exactly at threshold (15 lb)', () => {
    expect(getEncumbranceBand(15, str)).toBe('unburdened');
  });

  it('encumbered: iron-breastplate + iron-sword (15 + 3 = 18 lb) in (15, 30]', () => {
    expect(getEncumbranceBand(18, str)).toBe('encumbered');
  });

  it('encumbered: exactly at 2× threshold (30 lb)', () => {
    expect(getEncumbranceBand(30, str)).toBe('encumbered');
  });

  it('heavy: chest+legs+helm+pauldrons+sword (15+8+5+6+3 = 37 lb) in (30, 45]', () => {
    expect(getEncumbranceBand(37, str)).toBe('heavy');
  });

  it('heavy: exactly at 3× threshold (45 lb)', () => {
    expect(getEncumbranceBand(45, str)).toBe('heavy');
  });

  it('overloaded: full plate + frost-bow (~52 lb) > 45 lb', () => {
    expect(getEncumbranceBand(52, str)).toBe('overloaded');
  });

  it('overloaded: just above 3× threshold (45.1 lb)', () => {
    expect(getEncumbranceBand(45.1, str)).toBe('overloaded');
  });
});

describe('getEncumbranceBand — STR scaling', () => {
  it('STR 5 shifts thresholds to 35/70/105 lb', () => {
    // cap = 10 + 5*5 = 35
    expect(getEncumbranceBand(35, 5)).toBe('unburdened');
    expect(getEncumbranceBand(36, 5)).toBe('encumbered');
    expect(getEncumbranceBand(70, 5)).toBe('encumbered');
    expect(getEncumbranceBand(71, 5)).toBe('heavy');
    expect(getEncumbranceBand(105, 5)).toBe('heavy');
    expect(getEncumbranceBand(106, 5)).toBe('overloaded');
  });

  it('STR 0 is treated as STR 1 (same threshold)', () => {
    expect(getEncumbranceBand(15, 0)).toBe('unburdened');
    expect(getEncumbranceBand(16, 0)).toBe('encumbered');
  });
});

// ---------------------------------------------------------------------------
// getEncumbranceMovePenalty
// ---------------------------------------------------------------------------

describe('getEncumbranceMovePenalty', () => {
  it('unburdened has zero penalty', () => {
    expect(getEncumbranceMovePenalty('unburdened')).toBe(0);
  });

  it('encumbered has a negative penalty', () => {
    expect(getEncumbranceMovePenalty('encumbered')).toBeLessThan(0);
  });

  it('heavy penalty is more severe than encumbered', () => {
    expect(getEncumbranceMovePenalty('heavy')).toBeLessThan(
      getEncumbranceMovePenalty('encumbered'),
    );
  });

  it('overloaded has the highest (most negative) penalty', () => {
    expect(getEncumbranceMovePenalty('overloaded')).toBeLessThan(
      getEncumbranceMovePenalty('heavy'),
    );
  });

  it('matches the ENCUMBRANCE_MOVE_PENALTIES constant table', () => {
    for (const band of ['unburdened', 'encumbered', 'heavy', 'overloaded'] as const) {
      expect(getEncumbranceMovePenalty(band)).toBe(ENCUMBRANCE_MOVE_PENALTIES[band]);
    }
  });
});

// ---------------------------------------------------------------------------
// computeEquippedWeightLb
// ---------------------------------------------------------------------------

describe('computeEquippedWeightLb', () => {
  it('returns 0 for undefined equipment state', () => {
    expect(computeEquippedWeightLb(undefined)).toBe(0);
  });

  it('returns 0 for an empty equipment state (no items equipped)', () => {
    const state = makeState([]);
    expect(computeEquippedWeightLb(state)).toBe(0);
  });

  it('sums weights across single-slot items', () => {
    // helm 5 + boots 2 = 7 lb
    const state = makeState([
      { slotId: 'head', instanceId: 1, weightLb: 5 },
      { slotId: 'feet', instanceId: 2, weightLb: 2 },
    ]);
    expect(computeEquippedWeightLb(state)).toBe(7);
  });

  it('counts a two-handed weapon ONCE despite filling both hand slots', () => {
    // frost-bow (5 lb) fills mainHand + offHand with the same instanceId
    const state = makeState([
      { slotId: 'mainHand', instanceId: 10, weightLb: 5 },
      { slotId: 'offHand', instanceId: 10, weightLb: 5 }, // same instance, same weightLb
    ]);
    expect(computeEquippedWeightLb(state)).toBe(5); // counted once
  });

  it('fails closed for generated-equipped ids when no explicit resolver is provided', () => {
    const state = {
      equipped: { head: 'gei:v1:test-run:0' },
      instances: new Map(),
      disabledSlots: new Set(),
    } as unknown as EquipmentState;

    expect(() => computeEquippedWeightLb(state)).toThrow(
      'computeEquippedWeightLb requires an explicit resolveInstance for generated instance id',
    );
  });

  it('supports generated-equipped ids when callers provide an explicit resolver', () => {
    const generatedId = 'gei:v1:test-run:0' as EquipmentInstanceId;
    const state = {
      equipped: { head: generatedId },
      instances: new Map(),
      disabledSlots: new Set(),
    } as unknown as EquipmentState;
    const resolver = new Map<EquipmentInstanceId, EquipmentInstance>([
      [generatedId, { instanceId: generatedId, def: { weightLb: 9 } as EquipmentInstance['def'] }],
    ]);

    expect(computeEquippedWeightLb(state, (instanceId) => resolver.get(instanceId))).toBe(9);
  });

  it('representative "light" loadout: iron-sword only (3 lb) → unburdened at STR 1', () => {
    const state = makeState([{ slotId: 'mainHand', instanceId: 1, weightLb: 3 }]);
    const gearWeight = computeEquippedWeightLb(state);
    expect(gearWeight).toBe(3);
    expect(getEncumbranceBand(gearWeight, 1)).toBe('unburdened');
  });

  it('representative "encumbered" loadout: breastplate (15) + sword (3) = 18 lb', () => {
    const state = makeState([
      { slotId: 'chest', instanceId: 1, weightLb: 15 },
      { slotId: 'mainHand', instanceId: 2, weightLb: 3 },
    ]);
    const gearWeight = computeEquippedWeightLb(state);
    expect(gearWeight).toBe(18);
    expect(getEncumbranceBand(gearWeight, 1)).toBe('encumbered');
  });

  it('representative "heavy" loadout: chest+legs+helm+pauldrons+sword = 37 lb', () => {
    const state = makeState([
      { slotId: 'chest', instanceId: 1, weightLb: 15 },
      { slotId: 'legs', instanceId: 2, weightLb: 8 },
      { slotId: 'head', instanceId: 3, weightLb: 5 },
      { slotId: 'shoulders', instanceId: 4, weightLb: 6 },
      { slotId: 'mainHand', instanceId: 5, weightLb: 3 },
    ]);
    const gearWeight = computeEquippedWeightLb(state);
    expect(gearWeight).toBe(37);
    expect(getEncumbranceBand(gearWeight, 1)).toBe('heavy');
  });

  it('representative "overloaded" loadout: full plate + frost-bow (2H) → > 45 lb', () => {
    // Full plate subset (chest 15 + legs 8 + head 5 + shoulders 6 + back 2 + gloves 1
    //   + boots 2 + belt 1 + left arm 2 + right arm 2 + left wrist 0.5 + right wrist 0.25
    //   + ring 0.25 + ring 0.25 + neck 0.25) = 45.5 lb
    // + frost-bow 5 lb (2H, same instance in both hand slots)
    // Total: 50.5 lb (well above 45 lb overloaded threshold at STR 1)
    const state = makeState([
      { slotId: 'chest', instanceId: 1, weightLb: 15 },
      { slotId: 'legs', instanceId: 2, weightLb: 8 },
      { slotId: 'head', instanceId: 3, weightLb: 5 },
      { slotId: 'shoulders', instanceId: 4, weightLb: 6 },
      { slotId: 'back', instanceId: 5, weightLb: 2 },
      { slotId: 'gloves', instanceId: 6, weightLb: 1 },
      { slotId: 'feet', instanceId: 7, weightLb: 2 },
      { slotId: 'belt', instanceId: 8, weightLb: 1 },
      { slotId: 'leftArm', instanceId: 9, weightLb: 2 },
      { slotId: 'rightArm', instanceId: 10, weightLb: 2 },
      { slotId: 'leftWrist', instanceId: 11, weightLb: 0.5 },
      { slotId: 'rightWrist', instanceId: 12, weightLb: 0.25 },
      { slotId: 'ringLeft', instanceId: 13, weightLb: 0.25 },
      { slotId: 'ringRight', instanceId: 14, weightLb: 0.25 },
      { slotId: 'neck', instanceId: 15, weightLb: 0.25 },
      // frost-bow (2H): one instance filling both hand slots
      { slotId: 'mainHand', instanceId: 20, weightLb: 5 },
      { slotId: 'offHand', instanceId: 20, weightLb: 5 }, // deduped
    ]);
    const gearWeight = computeEquippedWeightLb(state);
    // Multi-slot dedup: bow counted once → 45.5 + 5 = 50.5 lb
    expect(gearWeight).toBeCloseTo(50.5, 5);
    expect(getEncumbranceBand(gearWeight, 1)).toBe('overloaded');
  });

  describe('defensive guard for invalid weightLb values', () => {
    it('treats NaN weightLb as 0 lb (no contribution)', () => {
      const state = makeState([
        { slotId: 'mainHand', instanceId: 1, weightLb: NaN },
        { slotId: 'feet', instanceId: 2, weightLb: 2 },
      ]);
      expect(computeEquippedWeightLb(state)).toBe(2);
    });

    it('treats Infinity weightLb as 0 lb (no contribution)', () => {
      const state = makeState([
        { slotId: 'mainHand', instanceId: 1, weightLb: Infinity },
        { slotId: 'feet', instanceId: 2, weightLb: 3 },
      ]);
      expect(computeEquippedWeightLb(state)).toBe(3);
    });

    it('clamps negative weightLb to 0 lb (no negative contribution)', () => {
      const state = makeState([
        { slotId: 'mainHand', instanceId: 1, weightLb: -5 },
        { slotId: 'feet', instanceId: 2, weightLb: 2 },
      ]);
      expect(computeEquippedWeightLb(state)).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Catalog validation — every authored EquipmentItemDef has a valid weightLb
// ---------------------------------------------------------------------------

describe('catalog: all equipment defs have intentional weightLb values', () => {
  it('every equippable item def has a finite, non-negative weightLb', () => {
    const ids = getEquippableItemIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const def = getEquipmentDefForItem(id);
      if (!def) continue;
      expect(Number.isFinite(def.weightLb), `${id}: weightLb=${def.weightLb} must be finite`).toBe(
        true,
      );
      expect(def.weightLb >= 0, `${id}: weightLb=${def.weightLb} must be non-negative`).toBe(true);
    }
  });

  it('every equippable item def has a non-zero weightLb (no placeholder zeros)', () => {
    const ids = getEquippableItemIds();
    for (const id of ids) {
      const def = getEquipmentDefForItem(id);
      if (!def) continue;
      expect(def.weightLb, `${id}: weightLb must be > 0 (non-placeholder)`).toBeGreaterThan(0);
    }
  });
});
