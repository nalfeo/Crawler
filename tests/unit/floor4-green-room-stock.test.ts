import { describe, expect, it } from 'vitest';
import { createTestWorld } from '../helpers/world-factory';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry';
import {
  openFloor4GreenRoomVisit,
  retireFloor4GreenRoomVisit,
} from '../../src/game/floor4GreenRoom';
import type { Floor4GreenRoomVisitStock } from '../../src/shared/floor-types';
import { floor4Manifest } from '../../src/shared/floor-manifest';

const ACT_COUNT = 5;

function visitSignature(visit: Floor4GreenRoomVisitStock): string {
  return visit.tables
    .map(
      (table) =>
        `${table.tableId}|${table.streamKey}|` +
        table.offers.map((o) => `${o.itemId}@${o.unitPrice}x${o.stock}`).join(','),
    )
    .join('||');
}

function currentVisit(world: ReturnType<typeof createTestWorld>): Floor4GreenRoomVisitStock {
  const visit = world.floorExtendedState?.floor4GreenRoom?.currentVisit;
  if (!visit) throw new Error('expected an open Green Room visit');
  return visit;
}

function openVisit(world: ReturnType<typeof createTestWorld>, visitIndex: number) {
  const opened = openFloor4GreenRoomVisit(world, visitIndex);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.message);
  return opened.visit;
}

function openSequentialVisit(world: ReturnType<typeof createTestWorld>, visitIndex: number) {
  for (let v = 0; v < visitIndex; v += 1) {
    openVisit(world, v);
    retireFloor4GreenRoomVisit(world);
  }
  return openVisit(world, visitIndex);
}

function cheapestOfferPrice(visit: Floor4GreenRoomVisitStock): number {
  return Math.min(...visit.tables.flatMap((table) => table.offers.map((offer) => offer.unitPrice)));
}

describe('floor4 Green Room stock — derived streams', () => {
  it('rolls each table from the documented per-visit stream key', () => {
    const world = createTestWorld({ seed: 42 });
    const visit = openVisit(world, 0);
    expect(visit.tables.length).toBeGreaterThanOrEqual(2);
    for (const table of visit.tables) {
      expect(table.streamKey).toBe(`${world.seed}:floor4:stock:0:${table.tableId}`);
    }
  });

  it('is deterministic: same seed + visit ⇒ identical stock', () => {
    const a = openSequentialVisit(createTestWorld({ seed: 7 }), 2);
    const b = openSequentialVisit(createTestWorld({ seed: 7 }), 2);
    expect(visitSignature(a)).toBe(visitSignature(b));
  });

  it('is path-independent: visit N does not consume or depend on world rng', () => {
    const quiet = createTestWorld({ seed: 99 });
    const noisy = createTestWorld({ seed: 99 });
    noisy.rng.next();
    noisy.rng.nextInt(0, 100);

    const quietVisit = openSequentialVisit(quiet, 3);
    noisy.rng.next();
    const noisyVisit = openSequentialVisit(noisy, 3);

    expect(visitSignature(noisyVisit)).toBe(visitSignature(quietVisit));
  });

  it('scales prices per visit: later breaks are strictly pricier for the same rolled item', () => {
    // Same table id + seed rolls the same weighted draw order; only the tier
    // multiplier changes, so any item present in two visits must cost more later.
    const early = openVisit(createTestWorld({ seed: 3 }), 0);
    const late = openSequentialVisit(createTestWorld({ seed: 3 }), ACT_COUNT - 1);
    let compared = 0;
    for (const lateTable of late.tables) {
      const earlyTable = early.tables.find((t) => t.tableId === lateTable.tableId)!;
      for (const lateOffer of lateTable.offers) {
        const earlyOffer = earlyTable.offers.find((o) => o.itemId === lateOffer.itemId);
        if (earlyOffer) {
          expect(lateOffer.unitPrice).toBeGreaterThan(earlyOffer.unitPrice);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('rejects an out-of-range visit index', () => {
    const world = createTestWorld({ seed: 42 });
    expect(() => openFloor4GreenRoomVisit(world, -1)).toThrow();
    expect(() => openFloor4GreenRoomVisit(world, ACT_COUNT)).toThrow();
  });
});

describe('floor4 Green Room stock — visit lifecycle', () => {
  it('creates run-scoped state lazily on first open', () => {
    const world = createTestWorld({ seed: 42 });
    expect(world.floorExtendedState?.floor4GreenRoom).toBeUndefined();
    const result = openFloor4GreenRoomVisit(world, 0);
    expect(result.ok).toBe(true);
    expect(world.floorExtendedState?.floor4GreenRoom?.lastOpenedVisitIndex).toBe(0);
    expect(currentVisit(world).visitIndex).toBe(0);
  });

  it('is immutable within a visit: re-opening returns identical stock without re-rolling', () => {
    const world = createTestWorld({ seed: 42 });
    const first = openFloor4GreenRoomVisit(world, 0);
    const again = openFloor4GreenRoomVisit(world, 0);
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(again.changed).toBe(false);
      expect(again.visit).toBe(first.visit);
    }
  });

  it('refuses to open a new visit while one is still open (retire first)', () => {
    const world = createTestWorld({ seed: 42 });
    openFloor4GreenRoomVisit(world, 0);
    const result = openFloor4GreenRoomVisit(world, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('visit-already-open');
  });

  it('advances one visit at a time and never reopens a retired visit', () => {
    const world = createTestWorld({ seed: 42 });
    openFloor4GreenRoomVisit(world, 0);
    expect(retireFloor4GreenRoomVisit(world).changed).toBe(true);
    // Skipping ahead fails...
    const skip = openFloor4GreenRoomVisit(world, 2);
    expect(skip.ok).toBe(false);
    // ...reopening the retired visit 0 fails...
    const reopen = openFloor4GreenRoomVisit(world, 0);
    expect(reopen.ok).toBe(false);
    // ...only the next visit is allowed.
    expect(openFloor4GreenRoomVisit(world, 1).ok).toBe(true);
  });

  it('retirement clears the offer and is a no-op when nothing is open', () => {
    const world = createTestWorld({ seed: 42 });
    expect(retireFloor4GreenRoomVisit(world).changed).toBe(false);
    openFloor4GreenRoomVisit(world, 0);
    const retired = retireFloor4GreenRoomVisit(world);
    expect(retired.changed).toBe(true);
    expect(world.floorExtendedState?.floor4GreenRoom?.currentVisit).toBeUndefined();
    expect(world.floorExtendedState?.floor4GreenRoom?.retiredVisitCount).toBe(1);
  });
});

describe('floor4 Green Room stock — orphan-free retirement', () => {
  it('never creates generated-equipment registry instances, so retirement leaves no orphans', () => {
    const world = createTestWorld({ seed: 42 });
    const before = listGeneratedEquipmentInstances(world).length;
    for (let v = 0; v < ACT_COUNT; v += 1) {
      openFloor4GreenRoomVisit(world, v);
      const retired = retireFloor4GreenRoomVisit(world);
      expect(retired.retiredGeneratedInstances).toBe(0);
    }
    expect(listGeneratedEquipmentInstances(world).length).toBe(before);
  });
});

describe('floor4 Green Room stock — affordability invariant (spec §8)', () => {
  it('every visit always offers something at or below its guaranteed gold budget', () => {
    // Prices are tuned against the actual Headliner appearance fees, so the
    // invariant must hold for every seed in this sample, not just friendly rolls.
    for (let seed = 0; seed < 400; seed += 1) {
      const world = createTestWorld({ seed });
      for (let v = 0; v < ACT_COUNT; v += 1) {
        const visit = openVisit(world, v);
        const cheapest = cheapestOfferPrice(visit);
        const budget = floor4Manifest.floor4!.greenRoom.affordabilityBudgetByVisit[v]!;
        expect(budget).toBe(floor4Manifest.floor4!.headliners.slots[v]!.appearanceFeeGold);
        expect(cheapest).toBeLessThanOrEqual(budget);
        retireFloor4GreenRoomVisit(world);
      }
    }
  });
});
