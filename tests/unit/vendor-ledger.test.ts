/**
 * Unit tests for the deterministic vendor ledger that feeds
 * `RunStats.vendors`: merchant visits with the inventory on offer, and the
 * shopping decisions made against them — including the ones that wanted an
 * item but could not pay for it.
 */
import { describe, expect, it } from 'vitest';
import {
  _VENDOR_LEDGER_MAX_ENTRIES,
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

    for (let i = 0; i < _VENDOR_LEDGER_MAX_ENTRIES + 10; i++) {
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
    expect(summary.visits).toHaveLength(_VENDOR_LEDGER_MAX_ENTRIES);
    expect(summary.decisions).toHaveLength(_VENDOR_LEDGER_MAX_ENTRIES);
    expect(summary.visitCount).toBe(_VENDOR_LEDGER_MAX_ENTRIES + 10);
    expect(summary.decisionCount).toBe(_VENDOR_LEDGER_MAX_ENTRIES + 10);
  });

  it('keeps deduping same-frame re-entry past the retention cap', () => {
    const world = createTestWorld({ seed: 1 });

    // Fill the ledger past the retention cap with distinct-frame visits and
    // decisions so the retained tail is full and stops growing.
    for (let i = 0; i < _VENDOR_LEDGER_MAX_ENTRIES + 5; i++) {
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
    const before = computeVendorInteractions(world);

    // A same-vendor/same-frame re-entry (meet + purchase in the same tick)
    // must still collapse into a single visit/decision even though the
    // retained arrays are already at their cap — it must not add another
    // dropped visit/decision on top of the one already counted this frame.
    world.frameCount += 1;
    recordVendorVisit(world, 'floor1-merchant', []);
    recordVendorVisit(world, 'floor1-merchant', []);
    recordVendorDecision(world, {
      vendorId: 'floor1-merchant',
      itemId: 'repeat-item',
      cost: 1,
      outcome: 'wanted',
      reason: 'weapon-class-switch',
    });
    recordVendorDecision(world, {
      vendorId: 'floor1-merchant',
      itemId: 'repeat-item',
      cost: 1,
      outcome: 'wanted',
      reason: 'weapon-class-switch',
    });

    const after = computeVendorInteractions(world);
    expect(after.visitCount).toBe(before.visitCount + 1);
    expect(after.decisionCount).toBe(before.decisionCount + 1);
  });
});
