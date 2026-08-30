import { describe, expect, it } from 'vitest';
import { floor4Manifest, floorManifestDefSchema } from '../../src/shared/floor-manifest.js';

type ManifestWithFloor4 = typeof floor4Manifest & {
  floor4: NonNullable<typeof floor4Manifest.floor4>;
};

function cloneFloor4Manifest(): ManifestWithFloor4 {
  return structuredClone(floor4Manifest) as ManifestWithFloor4;
}

describe('floor4 manifest schema cross-field geometry rules', () => {
  it('accepts the authored floor4 manifest geometry', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor4Manifest()).success).toBe(true);
  });

  it('rejects a tunnel wider than the Green Room height', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.tunnel.widthTiles = bad.floor4.greenRoom.heightTiles + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects pillars that would meet in the middle of the arena', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.arena.pillarInsetTiles = 19;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a Green Room taller than the arena', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.greenRoom.heightTiles = bad.floor4.arena.heightTiles + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects tunnel geometry whose mouth collides with the east feed gate', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.arena.heightTiles = 40;
    bad.floor4.tunnel.widthTiles = 20;
    bad.floor4.greenRoom.heightTiles = 20;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects phase timing whose windows do not add up to the act duration', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.phase.headlineWindowMs += 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('floor4 manifest schema Green Room shop rules', () => {
  it('accepts the authored Green Room shop config', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor4Manifest()).success).toBe(true);
  });

  it('rejects duplicate sponsor-table identities', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.greenRoom.tables[1]!.id = bad.floor4.greenRoom.tables[0]!.id;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects fewer than two or more than three tables', () => {
    const tooFew = cloneFloor4Manifest();
    tooFew.floor4.greenRoom.tables = tooFew.floor4.greenRoom.tables.slice(0, 1);
    expect(floorManifestDefSchema.safeParse(tooFew).success).toBe(false);

    const tooMany = cloneFloor4Manifest();
    const tables = tooMany.floor4.greenRoom.tables;
    tooMany.floor4.greenRoom.tables = [
      ...tables,
      { id: 'extra-a', archetypeId: tables[0]!.archetypeId },
    ];
    expect(floorManifestDefSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects a price tier curve that does not cover every act', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.greenRoom.priceTierByVisit = bad.floor4.greenRoom.priceTierByVisit.slice(0, -1);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an affordability budget curve that does not cover every act', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.greenRoom.affordabilityBudgetByVisit =
      bad.floor4.greenRoom.affordabilityBudgetByVisit.slice(0, -1);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an affordability budget that drifts from the Headliner appearance fee', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.greenRoom.affordabilityBudgetByVisit[0] =
      bad.floor4.headliners.slots[0]!.appearanceFeeGold + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('floor4 manifest schema economy rules', () => {
  it('rejects an income-budget act list that is incomplete', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.economy.actIncomeBudgetGold = bad.floor4.economy.actIncomeBudgetGold.slice(0, -1);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an income-budget act list that is reordered', () => {
    const bad = cloneFloor4Manifest();
    const [first, second] = bad.floor4.economy.actIncomeBudgetGold;
    if (!first || !second) {
      throw new Error('expected authored income budget entries');
    }
    bad.floor4.economy.actIncomeBudgetGold[0] = second;
    bad.floor4.economy.actIncomeBudgetGold[1] = first;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an inverted act income budget range', () => {
    const bad = cloneFloor4Manifest();
    const budget = bad.floor4.economy.actIncomeBudgetGold[0];
    if (!budget) {
      throw new Error('expected authored income budget entries');
    }
    budget.minWaveGold = budget.maxWaveGold + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a visit-price band list that is incomplete or reordered', () => {
    const incomplete = cloneFloor4Manifest();
    incomplete.floor4.economy.visitPriceBandGold =
      incomplete.floor4.economy.visitPriceBandGold.slice(0, -1);
    expect(floorManifestDefSchema.safeParse(incomplete).success).toBe(false);

    const reordered = cloneFloor4Manifest();
    const [first, second] = reordered.floor4.economy.visitPriceBandGold;
    if (!first || !second) {
      throw new Error('expected authored visit price band entries');
    }
    reordered.floor4.economy.visitPriceBandGold[0] = second;
    reordered.floor4.economy.visitPriceBandGold[1] = first;
    expect(floorManifestDefSchema.safeParse(reordered).success).toBe(false);
  });

  it('rejects an inverted visit price band range', () => {
    const bad = cloneFloor4Manifest();
    const band = bad.floor4.economy.visitPriceBandGold[0];
    if (!band) {
      throw new Error('expected authored visit price band entries');
    }
    band.minGold = band.maxGold + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a visit price band whose minimum exceeds the affordability budget', () => {
    const bad = cloneFloor4Manifest();
    const budget = bad.floor4.greenRoom.affordabilityBudgetByVisit[0];
    const band = bad.floor4.economy.visitPriceBandGold[0];
    if (budget === undefined || !band) {
      throw new Error('expected authored visit budget and price band entries');
    }
    band.minGold = budget + 1;
    band.maxGold = Math.max(band.maxGold, band.minGold);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('floor4 manifest schema wave rules', () => {
  it('rejects a wave pack that is not registered', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.enemyPackId = 'not-a-real-pack';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a budget curve that does not cover every act', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.budget.actMultipliers = bad.floor4.waves.budget.actMultipliers.slice(0, -1);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a cadence whose last wave releases after the wave window closes', () => {
    const bad = cloneFloor4Manifest();
    // Eight waves 20s apart need 140s of window; the authored window is shorter,
    // so the final waves could never release before the cut.
    bad.floor4.waves.cadence.intervalMs = 20_000;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a live cap above what the wave pack allows on screen', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.concurrency.liveCap = 500;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a roster that skips an act', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.rosters = bad.floor4.waves.rosters.filter((roster) => roster.act !== 3);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a roster archetype that is not in the wave pack', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.rosters[0]!.entries[0]!.archetypeId = 'goblin-that-never-was';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('floor4 manifest schema Headliner rules', () => {
  it('accepts the authored Headliner pool and overtime ramp', () => {
    const manifest = cloneFloor4Manifest();
    const headliners = manifest.floor4.headliners;

    expect(headliners.pool).toHaveLength(9);
    expect(headliners.slots.map((slot) => slot.act)).toEqual([1, 2, 3, 4, 5]);
    expect(manifest.floor4.overtime.capMs).toBe(manifest.floor4.phase.overtimeCapMs);
    expect(floorManifestDefSchema.safeParse(manifest).success).toBe(true);
  });

  it('rejects a Headliner pool archetype that is not in the arena pack', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.headliners.pool[0]!.archetypeId = 'floor4-unbooked-act';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a finale slot whose fixed Headliner is not eligible', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.headliners.slots[4]!.eligibleGrades = ['warmup'];
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a random slot exhausted by a reserved fixed Headliner', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.headliners.slots[0]!.eligibleGrades = ['finale'];
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a fixed Headliner booked for multiple acts', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.headliners.slots[3]!.fixedArchetypeId =
      bad.floor4.headliners.slots[4]!.fixedArchetypeId;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects overtime ramps that outlive the overtime cap', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.overtime.rampSteps[0]!.atMs = bad.floor4.overtime.capMs;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});
