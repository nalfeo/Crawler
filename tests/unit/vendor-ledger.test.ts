/**
 * Unit tests for the deterministic vendor ledger that feeds
 * `RunStats.vendors`: merchant visits with the inventory on offer, and the
 * shopping decisions made against them — including the ones that wanted an
 * item but could not pay for it.
 */
import { describe, expect, it } from 'vitest';
import {
  VENDOR_LEDGER_MAX_ENTRIES,
  recordVendorDecision,
  recordVendorVisit,
} from '../../src/core/world.js';
import { collectHumanRunStats } from '../../src/game/ai/run-stats-collector.js';
import { computeVendorInteractions } from '../../src/game/ai/vendor-interactions.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('vendor ledger', () => {
  it('starts empty and summarizes to zero counts', () => {
    const world = createTestWorld({ seed: 1 });

    const summary = computeVendorInteractions(world);

    expect(summary.visits).toEqual([]);
    expect(summary.decisions).toEqual([]);
    expect(summary.visitCount).toBe(0);
    expect(summary.decisionCount).toBe(0);
    expect(summary.outcomeCounts).toEqual({
      wanted: 0,
      purchased: 0,
      unaffordable: 0,
      declined: 0,
      abandoned: 0,
    });
  });

  it('records the vendor inventory and budget at each visit', () => {
    const world = createTestWorld({ seed: 1 });
    world.playerGold = 120;
    world.elapsedMs = 5_000;

    recordVendorVisit(world, 'floor1-merchant', [{ itemId: 'iron-sword', cost: 185 }]);

    const summary = computeVendorInteractions(world);
    expect(summary.visits).toEqual([
      {
        vendorId: 'floor1-merchant',
        gameTimeMs: 5_000,
        playerGold: 120,
        stock: [{ itemId: 'iron-sword', cost: 185 }],
      },
    ]);
    expect(summary.visitsByVendor).toEqual({ 'floor1-merchant': 1 });
  });

  it('collapses same-vendor re-entry inside one frame but keeps later frames', () => {
    const world = createTestWorld({ seed: 1 });

    recordVendorVisit(world, 'floor1-merchant', []);
    recordVendorVisit(world, 'floor1-merchant', []);
    recordVendorVisit(world, 'floor1-spell-broker', []);
    world.frameCount += 1;
    recordVendorVisit(world, 'floor1-merchant', []);

    expect(computeVendorInteractions(world).visitsByVendor).toEqual({
      'floor1-merchant': 2,
      'floor1-spell-broker': 1,
    });
  });

  it('records a wanted-but-unaffordable decision distinctly from a purchase', () => {
    const world = createTestWorld({ seed: 1 });
    world.playerGold = 10;

    recordVendorDecision(world, {
      vendorId: 'floor1-merchant',
      itemId: 'iron-sword',
      cost: 185,
      outcome: 'unaffordable',
      reason: 'insufficient-gold',
    });
    world.playerGold = 200;
    recordVendorDecision(world, {
      vendorId: 'floor1-merchant',
      itemId: 'iron-sword',
      cost: 185,
      outcome: 'purchased',
      reason: 'weapon-switch',
    });

    const summary = computeVendorInteractions(world);
    expect(summary.decisions.map((entry) => [entry.outcome, entry.playerGold])).toEqual([
      ['unaffordable', 10],
      ['purchased', 200],
    ]);
    expect(summary.outcomeCounts.unaffordable).toBe(1);
    expect(summary.outcomeCounts.purchased).toBe(1);
  });

  it('collapses a repeated identical decision so re-polling is not counted', () => {
    const world = createTestWorld({ seed: 1 });

    for (let i = 0; i < 5; i++) {
      world.frameCount += 1;
      recordVendorDecision(world, {
        vendorId: 'floor1-merchant',
        itemId: 'iron-sword',
        cost: 185,
        outcome: 'unaffordable',
        reason: 'insufficient-gold',
      });
    }

    expect(computeVendorInteractions(world).decisionCount).toBe(1);
  });

  it('reaches RunStats for a human run', () => {
    const world = createTestWorld({ seed: 1 });
    recordVendorVisit(world, 'floor1-merchant', [{ itemId: 'iron-sword', cost: 185 }]);
    recordVendorDecision(world, {
      vendorId: 'floor1-merchant',
      itemId: 'iron-sword',
      cost: 185,
      outcome: 'unaffordable',
      reason: 'insufficient-gold',
    });

    const stats = collectHumanRunStats(world, 0, 'quit');

    expect(stats.vendors?.visitCount).toBe(1);
    expect(stats.vendors?.visits[0]?.stock).toEqual([{ itemId: 'iron-sword', cost: 185 }]);
    expect(stats.vendors?.outcomeCounts.unaffordable).toBe(1);
  });

  it('caps retained records but keeps counting the overflow', () => {
    const world = createTestWorld({ seed: 1 });

    for (let i = 0; i < VENDOR_LEDGER_MAX_ENTRIES + 10; i++) {
      world.frameCount += 1;
      recordVendorVisit(world, 'floor1-merchant', []);
      recordVendorDecision(world, {
        vendorId: 'floor1-merchant',
        itemId: `item-${i}`,
        cost: i,
        outcome: 'wanted',
        reason: 'weapon-class-switch',
      });
    }

    const summary = computeVendorInteractions(world);
    expect(summary.visits).toHaveLength(VENDOR_LEDGER_MAX_ENTRIES);
    expect(summary.decisions).toHaveLength(VENDOR_LEDGER_MAX_ENTRIES);
    expect(summary.visitCount).toBe(VENDOR_LEDGER_MAX_ENTRIES + 10);
    expect(summary.decisionCount).toBe(VENDOR_LEDGER_MAX_ENTRIES + 10);
  });
});
