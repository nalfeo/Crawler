import { describe, expect, it } from 'vitest';
import {
  buildFloor4ActWaveManifests,
  buildFloor4WaveManifest,
  computeFloor4WaveBudget,
  floor4ActRoster,
  floor4WaveReleaseAtActMs,
  floor4WaveStreamKey,
  type Floor4WaveScheduleConfig,
} from '../../src/shared/floor4-waves.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { Floor4ActIndex } from '../../src/shared/floor-types.js';

const waves = getFloorManifest('floor4')!.floor4!.waves as Floor4WaveScheduleConfig;
const GATE_COUNT = 4;
const ACTS: readonly Floor4ActIndex[] = [1, 2, 3, 4, 5];

describe('floor4 wave manifests', () => {
  it('derives one isolated stream per wave (FR7.1)', () => {
    expect(floor4WaveStreamKey(1234, 3, 5)).toBe('1234:floor4:waves:3:5');
    // Neighbouring waves/acts must not collide or the "cap pressure cannot
    // perturb a seed" guarantee collapses into one shared cursor.
    const keys = new Set<string>();
    for (const act of ACTS) {
      for (let waveIndex = 0; waveIndex < waves.cadence.wavesPerAct; waveIndex += 1) {
        keys.add(floor4WaveStreamKey(404, act, waveIndex));
      }
    }
    expect(keys.size).toBe(ACTS.length * waves.cadence.wavesPerAct);
  });

  it('is identical for the same seed and different for different seeds', () => {
    const left = buildFloor4ActWaveManifests(waves, 404, 3, GATE_COUNT);
    const right = buildFloor4ActWaveManifests(waves, 404, 3, GATE_COUNT);
    const other = buildFloor4ActWaveManifests(waves, 405, 3, GATE_COUNT);

    expect(left).toEqual(right);
    expect(left).not.toEqual(other);
  });

  it('freezes manifests so a released wave cannot be edited mid-window (FR3.2)', () => {
    const manifest = buildFloor4WaveManifest(waves, 404, 2, 1, GATE_COUNT);

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
  });

  it('releases waves on the authored cadence', () => {
    const manifests = buildFloor4ActWaveManifests(waves, 404, 1, GATE_COUNT);

    expect(manifests).toHaveLength(waves.cadence.wavesPerAct);
    expect(manifests.map((manifest) => manifest.releaseAtActMs)).toEqual(
      manifests.map((_, index) => index * waves.cadence.intervalMs),
    );
    expect(floor4WaveReleaseAtActMs(waves, 3)).toBe(3 * waves.cadence.intervalMs);
    // Every wave must land inside the act's wave window, or an act would arm
    // waves it can never release.
    const windowMs = getFloorManifest('floor4')!.floor4!.phase.waveWindowMs;
    expect(manifests[manifests.length - 1]!.releaseAtActMs).toBeLessThan(windowMs);
  });

  it('ramps the threat budget within and across acts (FR3.3)', () => {
    // Act 1 opens deliberately tiny so the first gates read as a tutorial.
    expect(computeFloor4WaveBudget(waves, 1, 0)).toBeLessThan(computeFloor4WaveBudget(waves, 1, 1));
    expect(computeFloor4WaveBudget(waves, 1, 0)).toBeCloseTo(
      waves.budget.base * waves.budget.actMultipliers[0]! * waves.budget.openingWaveMultiplier,
      6,
    );
    // Later waves in an act are heavier...
    expect(computeFloor4WaveBudget(waves, 3, 7)).toBeGreaterThan(
      computeFloor4WaveBudget(waves, 3, 0),
    );
    // ...and the same wave index is heavier in a later act.
    for (let act = 1; act < ACTS.length; act += 1) {
      expect(computeFloor4WaveBudget(waves, act + 1, 4)).toBeGreaterThan(
        computeFloor4WaveBudget(waves, act, 4),
      );
    }
    expect(() => computeFloor4WaveBudget(waves, 99, 0)).toThrow(/act multiplier/);
  });

  it('spends within budget, from the act roster, at real gates', () => {
    for (const act of ACTS) {
      const rosterIds = new Set(floor4ActRoster(waves, act).map((entry) => entry.archetypeId));
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
    expect(() => buildFloor4WaveManifest(waves, 404, 1, 0, 0)).toThrow(/feed gate/);
    expect(() => floor4ActRoster(waves, 42)).toThrow(/roster missing/);
  });
});
