import { describe, expect, it } from 'vitest';
import {
  buildFloor4ActWaveManifests,
  type Floor4WaveScheduleConfig,
} from '../../src/shared/floor4-waves.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { Floor4ActIndex } from '../../src/shared/floor-types.js';

const waves = getFloorManifest('floor4')!.floor4!.waves as Floor4WaveScheduleConfig;
const GATE_COUNT = 4;
const ACTS: readonly Floor4ActIndex[] = [1, 2, 3, 4, 5];

function rosterIdsForAct(act: number): Set<string> {
  const roster = waves.rosters.find((candidate) => candidate.act === act);
  return new Set((roster?.entries ?? []).map((entry) => entry.archetypeId));
}

describe('floor4 wave manifests', () => {
  it('derives one isolated stream per wave (FR7.1)', () => {
    // Each wave draws from its own `<seed>:floor4:waves:<act>:<wave>` stream, so
    // truncating the schedule must not shift the waves that remain — if waves
    // shared one cursor, wave N's content would depend on how many waves ran
    // before it, and cap pressure could perturb a seed's card.
    const short: Floor4WaveScheduleConfig = {
      ...waves,
      cadence: { ...waves.cadence, wavesPerAct: 3 },
    };
    const full = buildFloor4ActWaveManifests(waves, 404, 3, GATE_COUNT);
    const truncated = buildFloor4ActWaveManifests(short, 404, 3, GATE_COUNT);

    expect(truncated).toHaveLength(3);
    expect(truncated).toEqual(full.slice(0, 3));

    // Acts are isolated from each other too.
    const otherAct = buildFloor4ActWaveManifests(waves, 404, 2, GATE_COUNT);
    expect(otherAct.map((manifest) => manifest.entries)).not.toEqual(
      full.map((manifest) => manifest.entries),
    );
  });

  it('is identical for the same seed and different for different seeds', () => {
    const left = buildFloor4ActWaveManifests(waves, 404, 3, GATE_COUNT);
    const right = buildFloor4ActWaveManifests(waves, 404, 3, GATE_COUNT);
    const other = buildFloor4ActWaveManifests(waves, 405, 3, GATE_COUNT);

    expect(left).toEqual(right);
    expect(left).not.toEqual(other);
  });

  it('deep-freezes manifests so a released wave cannot be edited mid-window (FR3.2)', () => {
    const manifests = buildFloor4ActWaveManifests(waves, 404, 2, GATE_COUNT);
    const manifest = manifests[1]!;

    expect(Object.isFrozen(manifests)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    // A shallow freeze would still let a consumer rewrite an entry in place.
    for (const entry of manifest.entries) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    const entry = manifest.entries[0]!;
    expect(() => {
      (entry as { archetypeId: string }).archetypeId = 'tampered';
    }).toThrow(TypeError);
    expect(entry.archetypeId).not.toBe('tampered');
  });

  it('releases waves on the authored cadence', () => {
    const manifests = buildFloor4ActWaveManifests(waves, 404, 1, GATE_COUNT);

    expect(waves.cadence.wavesPerAct).toBe(10);
    expect(waves.cadence.intervalMs).toBe(9000);
    expect(manifests).toHaveLength(waves.cadence.wavesPerAct);
    expect(manifests.map((manifest) => manifest.releaseAtActMs)).toEqual(
      manifests.map((_, index) => index * waves.cadence.intervalMs),
    );
    // Every wave must land inside the act's wave window, or an act would arm
    // waves it can never release.
    const windowMs = getFloorManifest('floor4')!.floor4!.phase.waveWindowMs;
    expect(manifests[manifests.length - 1]!.releaseAtActMs).toBeLessThan(windowMs);
    expect(manifests[manifests.length - 1]!.releaseAtActMs).toBeGreaterThanOrEqual(
      windowMs - waves.cadence.intervalMs,
    );
  });

  it('ramps the threat budget within and across acts (FR3.3)', () => {
    const budgets = new Map<number, readonly number[]>(
      ACTS.map((act) => [
        act,
        buildFloor4ActWaveManifests(waves, 404, act, GATE_COUNT).map((manifest) => manifest.budget),
      ]),
    );

    // Act 1 opens deliberately tiny so the first gates read as a tutorial.
    expect(budgets.get(1)![0]!).toBeLessThan(budgets.get(1)![1]!);
    expect(budgets.get(1)![0]!).toBeCloseTo(
      waves.budget.base * waves.budget.actMultipliers[0]! * waves.budget.openingWaveMultiplier,
      6,
    );
    // Later waves in an act are heavier...
    expect(budgets.get(3)![7]!).toBeGreaterThan(budgets.get(3)![0]!);
    // ...and the same wave index is heavier in a later act.
    for (let act = 1; act < ACTS.length; act += 1) {
      expect(budgets.get(act + 1)![4]!).toBeGreaterThan(budgets.get(act)![4]!);
    }
    // An act with a roster but no authored multiplier must fail loudly rather
    // than composing a budget-less wave.
    const missingMultiplier: Floor4WaveScheduleConfig = {
      ...waves,
      budget: { ...waves.budget, actMultipliers: waves.budget.actMultipliers.slice(0, 1) },
    };
    expect(() => buildFloor4ActWaveManifests(missingMultiplier, 404, 3, GATE_COUNT)).toThrow(
      /act multiplier/,
    );
  });

  it('spends within budget, from the act roster, at real gates', () => {
    for (const act of ACTS) {
      const rosterIds = rosterIdsForAct(act);
      for (const manifest of buildFloor4ActWaveManifests(waves, 909, act, GATE_COUNT)) {
        expect(manifest.entries.length).toBeGreaterThan(0);
        expect(manifest.entries.length).toBeLessThanOrEqual(waves.budget.maxEntriesPerWave);
        const spent = manifest.entries.reduce((total, entry) => total + entry.threatCost, 0);
        expect(spent).toBeLessThanOrEqual(manifest.budget);
        for (const entry of manifest.entries) {
          expect(rosterIds).toContain(entry.archetypeId);
          expect(entry.gateIndex).toBeGreaterThanOrEqual(0);
          expect(entry.gateIndex).toBeLessThan(GATE_COUNT);
          expect(Number.isInteger(entry.gateIndex)).toBe(true);
        }
      }
    }
  });

  it('refuses to compose a wave with no gates or no roster', () => {
    expect(() => buildFloor4ActWaveManifests(waves, 404, 1, 0)).toThrow(/feed gate/);

    const rosterless: Floor4WaveScheduleConfig = {
      ...waves,
      rosters: waves.rosters.filter((roster) => roster.act !== 1),
    };
    expect(() => buildFloor4ActWaveManifests(rosterless, 404, 1, GATE_COUNT)).toThrow(
      /roster missing/,
    );
  });
});
