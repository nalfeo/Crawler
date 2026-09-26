import { describe, expect, it } from 'vitest';
import {
  diagnoseCrafting,
  type CraftingEvidence,
} from '../../scripts/agent/health/crafting-diagnostics.js';

function fixture(): CraftingEvidence {
  return {
    source: 'synthetic',
    endActiveTimeMs: 1000,
    transactions: [
      {
        transactionId: 'tx-1',
        recipeId: 'recipe-sword',
        activeTimeMs: 300,
        costs: [
          { resourceId: 'iron', quantity: 2, acquiredActiveTimeMs: 100 },
          { resourceId: 'iron', quantity: 1, acquiredActiveTimeMs: 200 },
          { resourceId: 'gold', quantity: 5, acquiredActiveTimeMs: 0 },
        ],
      },
    ],
    items: [
      {
        instanceId: 'starting-sword',
        itemId: 'sword',
        provenance: { kind: 'starting' },
        equippedWindows: [{ startActiveTimeMs: 0, endActiveTimeMs: 400 }],
        usesActiveTimeMs: [100],
        effectiveness: null,
      },
      {
        instanceId: 'crafted-sword-1',
        itemId: 'sword',
        provenance: { kind: 'crafted', transactionId: 'tx-1' },
        equippedWindows: [
          { startActiveTimeMs: 400, endActiveTimeMs: 700 },
          { startActiveTimeMs: 800, endActiveTimeMs: 1000 },
        ],
        usesActiveTimeMs: [500, 600, 900],
        effectiveness: {
          before: {
            startActiveTimeMs: 300,
            endActiveTimeMs: 400,
            metric: 'damage-per-second',
            unit: 'hp/s',
            value: 0,
          },
          after: {
            startActiveTimeMs: 400,
            endActiveTimeMs: 500,
            metric: 'damage-per-second',
            unit: 'hp/s',
            value: 12,
          },
        },
      },
      {
        instanceId: 'crafted-sword-2',
        itemId: 'sword',
        provenance: { kind: 'crafted', transactionId: 'tx-1' },
        equippedWindows: [],
        usesActiveTimeMs: [],
        effectiveness: null,
      },
    ],
    opportunities: [],
  };
}

describe('crafting descriptive diagnostics', () => {
  it('explicitly reports the runtime producer gap', () => {
    expect(diagnoseCrafting()).toEqual({
      status: 'unavailable',
      reason: 'No runtime recipe/craft transaction producer exists.',
      transactions: null,
      items: null,
      opportunities: null,
    });
  });

  it('preserves instance/provenance identity and charges multi-output costs only once', () => {
    const report = diagnoseCrafting(fixture());
    expect(report.status).toBe('observed');
    expect(report.transactions).toEqual([
      {
        transactionId: 'tx-1',
        recipeId: 'recipe-sword',
        activeTimeMs: 300,
        costs: [
          { resourceId: 'iron', quantity: 2, acquiredActiveTimeMs: 100, acquisitionToCraftMs: 200 },
          { resourceId: 'iron', quantity: 1, acquiredActiveTimeMs: 200, acquisitionToCraftMs: 100 },
          { resourceId: 'gold', quantity: 5, acquiredActiveTimeMs: 0, acquisitionToCraftMs: 300 },
        ],
        outputInstanceIds: ['crafted-sword-1', 'crafted-sword-2'],
      },
    ]);
    expect(report.items?.[0]).toMatchObject({
      instanceId: 'starting-sword',
      recipeId: null,
      provenance: { kind: 'starting' },
      acquiredActiveTimeMs: 0,
      useCount: 1,
    });
    expect(report.items?.[1]).toMatchObject({
      instanceId: 'crafted-sword-1',
      recipeId: 'recipe-sword',
      acquiredActiveTimeMs: 300,
      firstEquipActiveTimeMs: 400,
      firstUseActiveTimeMs: 500,
      acquisitionToEquipMs: 100,
      acquisitionToUseMs: 200,
      equipToUseMs: 100,
      observedLifetimeMs: 700,
      equippedDurationMs: 500,
      useCount: 3,
      unused: false,
    });
    expect(diagnoseCrafting(fixture())).toEqual(report);
  });

  it('distinguishes an unused output from incomplete observations', () => {
    const input = fixture();
    expect(diagnoseCrafting(input).items?.[2]).toMatchObject({
      equippedDurationMs: 0,
      useCount: 0,
      unused: true,
      firstUseActiveTimeMs: null,
      acquisitionToUseMs: null,
    });
    input.items[2]!.equippedWindows = null;
    input.items[2]!.usesActiveTimeMs = null;
    expect(diagnoseCrafting(input).items?.[2]).toMatchObject({
      equippedDurationMs: null,
      useCount: null,
      unused: null,
      firstUseActiveTimeMs: null,
    });
  });

  it('separates opportunity absence, sensor absence, and explicit rejection', () => {
    const input = fixture();
    expect(diagnoseCrafting(input).opportunities).toMatchObject({
      count: 0,
      explicitRejections: 0,
    });
    input.opportunities = null;
    expect(diagnoseCrafting(input).opportunities).toBeNull();
    input.opportunities = [
      { opportunityId: 'o1', recipeId: 'recipe-sword', activeTimeMs: 100, decision: 'rejected' },
      { opportunityId: 'o2', recipeId: 'recipe-sword', activeTimeMs: 200, decision: 'unresolved' },
    ];
    expect(diagnoseCrafting(input).opportunities).toMatchObject({
      count: 2,
      explicitRejections: 1,
    });
  });

  it('retains measured zero windows and labels effectiveness as association', () => {
    const input = fixture();
    expect(diagnoseCrafting(input).items?.[1]?.effectiveness).toMatchObject({
      before: { value: 0 },
      after: { value: 12 },
      delta: 12,
      interpretation: 'observed association, not causation',
    });
    input.items[1]!.effectiveness = null;
    expect(diagnoseCrafting(input).items?.[1]?.effectiveness).toBeNull();
  });

  it.each([
    [
      'duplicate transaction',
      (input: CraftingEvidence) => {
        input.transactions = [...input.transactions, input.transactions[0]!];
      },
    ],
    [
      'duplicate instance',
      (input: CraftingEvidence) => {
        input.items[2]!.instanceId = 'crafted-sword-1';
      },
    ],
    [
      'unknown transaction',
      (input: CraftingEvidence) => {
        input.items[2]!.provenance = { kind: 'crafted', transactionId: 'missing' };
      },
    ],
    [
      'late acquisition',
      (input: CraftingEvidence) => {
        input.transactions[0]!.costs[0]!.acquiredActiveTimeMs = 301;
      },
    ],
    [
      'negative quantity',
      (input: CraftingEvidence) => {
        input.transactions[0]!.costs[0]!.quantity = -1;
      },
    ],
    [
      'nonfinite time',
      (input: CraftingEvidence) => {
        input.endActiveTimeMs = Number.NaN;
      },
    ],
    [
      'early equip',
      (input: CraftingEvidence) => {
        input.items[1]!.equippedWindows![0]!.startActiveTimeMs = 299;
      },
    ],
    [
      'overlapping equip',
      (input: CraftingEvidence) => {
        input.items[1]!.equippedWindows![1]!.startActiveTimeMs = 699;
      },
    ],
    [
      'unequipped use',
      (input: CraftingEvidence) => {
        input.items[1]!.usesActiveTimeMs = [750];
      },
    ],
    [
      'unordered uses',
      (input: CraftingEvidence) => {
        input.items[1]!.usesActiveTimeMs = [600, 500];
      },
    ],
    [
      'mismatched metric',
      (input: CraftingEvidence) => {
        input.items[1]!.effectiveness!.after.metric = 'kills';
      },
    ],
    [
      'misaligned window',
      (input: CraftingEvidence) => {
        input.items[1]!.effectiveness!.before.endActiveTimeMs = 399;
      },
    ],
  ])('rejects contradictory evidence: %s', (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => diagnoseCrafting(input)).toThrow('Invalid crafting evidence:');
  });
});
