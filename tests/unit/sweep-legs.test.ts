import { describe, expect, it } from 'vitest';
import {
  PR_SWEEP_LEGS,
  RELEASE_SWEEP_LEGS,
  legCliArgs,
  totalRuns,
  uncoveredImplementedFloors,
  type SweepLeg,
} from '../../scripts/agent/perf/sweep-legs.js';
import { isFloorImplemented } from '../../src/shared/floor-registry.js';

function seedCountOf(spec: string): number {
  const [startToken, endToken] = spec.split('-');
  const start = Number(startToken);
  const end = endToken === undefined ? undefined : Number(endToken);
  return end === undefined ? 1 : end - start + 1;
}

describe('sweep leg matrix', () => {
  it('PR tier runs exactly 50 runs', () => {
    // The PR tier's cost is a hard budget: it replaced a 24-run serial gate and
    // must stay small enough to shard inside the prior wall-clock envelope.
    // A careless edit that multiplies this is a CI-cost regression.
    expect(totalRuns(PR_SWEEP_LEGS)).toBe(50);
  });

  it('release tier runs exactly 600 runs (unchanged total)', () => {
    // Same total the Floor-1-only baseline cost, now spread across three legs,
    // so release wall time stays roughly neutral.
    expect(totalRuns(RELEASE_SWEEP_LEGS)).toBe(600);
    expect(RELEASE_SWEEP_LEGS.find((l) => l.id === 'floor1')!.runs).toBe(300);
  });

  it('PR tier gates on Floor 1 only; every other leg is report-only', () => {
    const blocking = PR_SWEEP_LEGS.filter((l) => l.blocking);
    expect(blocking.map((l) => l.id)).toEqual(['floor1']);
  });

  it('release tier gates on Floor 1 only', () => {
    expect(RELEASE_SWEEP_LEGS.filter((l) => l.blocking).map((l) => l.id)).toEqual(['floor1']);
  });

  it('PR chained seeds are a strict subset of the PR Floor-1 seed panel', () => {
    // A chained failure must be attributable against that same seed's
    // standalone Floor-1 result; different panels would confound the two.
    const floor1 = PR_SWEEP_LEGS.find((l) => l.id === 'floor1')!;
    const chain = PR_SWEEP_LEGS.find((l) => l.id === 'floor1-chain')!;
    expect(floor1.seeds).toBe('1-25');
    expect(chain.seeds).toBe('1-10');
    expect(chain.seedCount).toBeLessThan(floor1.seedCount);
  });

  it('PR tier never forces a weapon; release Floor 1 always does', () => {
    for (const l of PR_SWEEP_LEGS) expect(l.weapons).toBeNull();
    expect(RELEASE_SWEEP_LEGS.find((l) => l.id === 'floor1')!.weapons).toHaveLength(6);
  });

  it('every leg covers an implemented floor', () => {
    for (const l of [...PR_SWEEP_LEGS, ...RELEASE_SWEEP_LEGS]) {
      expect(isFloorImplemented(l.floorId), `${l.id} starts on an unimplemented floor`).toBe(true);
    }
  });

  it('both tiers cover every implemented floor', () => {
    // This is the regression this whole methodology exists to prevent: a floor
    // becomes finishable and is then silently never swept.
    expect(uncoveredImplementedFloors(PR_SWEEP_LEGS)).toEqual([]);
    expect(uncoveredImplementedFloors(RELEASE_SWEEP_LEGS)).toEqual([]);
  });

  it('declared seedCount matches the seed spec it will expand to', () => {
    for (const l of [...PR_SWEEP_LEGS, ...RELEASE_SWEEP_LEGS]) {
      expect(seedCountOf(l.seeds), `${l.id} seedCount disagrees with "${l.seeds}"`).toBe(
        l.seedCount,
      );
    }
  });

  it('leg ids are unique within a tier', () => {
    for (const legs of [PR_SWEEP_LEGS, RELEASE_SWEEP_LEGS]) {
      expect(new Set(legs.map((l) => l.id)).size).toBe(legs.length);
    }
  });

  it('builds CLI args that match the leg definition', () => {
    const chain: SweepLeg = PR_SWEEP_LEGS.find((l) => l.id === 'floor1-chain')!;
    expect(legCliArgs(chain, 'out.json')).toEqual([
      '--floor',
      'floor1',
      '--seeds',
      '1-10',
      '--out',
      'out.json',
      '--no-force-weapon',
      '--chain',
    ]);
    const releaseFloor1 = RELEASE_SWEEP_LEGS.find((l) => l.id === 'floor1')!;
    const args = legCliArgs(releaseFloor1, 'r.json');
    expect(args).toContain('--weapons');
    expect(args).not.toContain('--no-force-weapon');
    expect(args).not.toContain('--chain');
  });

  it('reports an implemented floor that no leg covers', () => {
    const onlyFloor1: SweepLeg[] = [
      {
        id: 'floor1',
        floorId: 'floor1',
        seeds: '1-5',
        seedCount: 5,
        weapons: null,
        chain: false,
        blocking: true,
        runs: 5,
      },
    ];
    expect(uncoveredImplementedFloors(onlyFloor1)).toContain('floor2');
  });
});
