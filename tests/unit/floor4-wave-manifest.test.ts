import { describe, expect, it } from 'vitest';
import {
  buildFloor4ActWaveManifests,
  floor4WaveBudget,
  floor4WaveManifestFingerprint,
  type Floor4WaveConfig,
} from '../../src/game/floor4/wave-manifest.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { Floor4ActIndex } from '../../src/shared/floor-types.js';

const authoredConfig = getFloorManifest('floor4')!.floor4!.waves! as Floor4WaveConfig;
const GATE_SLOT_COUNTS = [5, 5, 5, 5];

describe('floor4 wave budget', () => {
  it('scales with the act multiplier and ramps inside the act', () => {
    for (const act of [1, 2, 3, 4, 5] as const) {
      for (let waveIndex = 1; waveIndex < authoredConfig.wavesPerAct; waveIndex += 1) {
        expect(floor4WaveBudget(authoredConfig, act, waveIndex)).toBeGreaterThanOrEqual(
          floor4WaveBudget(authoredConfig, act, waveIndex - 1),
        );
      }
    }
    for (const waveIndex of [1, 4, 7]) {
      expect(floor4WaveBudget(authoredConfig, 5, waveIndex)).toBeGreaterThan(
        floor4WaveBudget(authoredConfig, 1, waveIndex),
      );
    }
  });

  it('makes act 1 wave 0 the smallest wave of the floor', () => {
    const opener = floor4WaveBudget(authoredConfig, 1, 0);
    expect(opener).toBeGreaterThan(0);
    expect(opener).toBeLessThan(floor4WaveBudget(authoredConfig, 1, 1));
  });

  it('always yields a positive integer budget', () => {
    const tiny: Floor4WaveConfig = {
      ...authoredConfig,
      baseBudget: 1,
      openingWaveBudgetScale: 0.01,
    };
    const budget = floor4WaveBudget(tiny, 1, 0);
    expect(Number.isInteger(budget)).toBe(true);
    expect(budget).toBeGreaterThanOrEqual(1);
  });
});

describe('floor4 wave manifests', () => {
  it('schedules one wave per interval with a clamped opening telegraph', () => {
    const manifests = buildFloor4ActWaveManifests(authoredConfig, 1, 'seed-a', GATE_SLOT_COUNTS);

    expect(manifests).toHaveLength(authoredConfig.wavesPerAct);
    manifests.forEach((wave, index) => {
      expect(wave.waveIndex).toBe(index);
      expect(wave.releaseAtMs).toBe(index * authoredConfig.waveIntervalMs);
      // Wave 0 releases at act-relative t=0, so its flare cannot be scheduled
      // before the act starts — it fires with the release instead.
      const expectedTelegraph = Math.max(0, wave.releaseAtMs - authoredConfig.gateTelegraphMs);
      expect(wave.telegraphAtMs).toBe(expectedTelegraph);
    });
    expect(manifests[0]!.telegraphAtMs).toBe(0);
  });

  it('spends the wave budget without exceeding it', () => {
    for (const act of [1, 3, 5] as const) {
      const manifests = buildFloor4ActWaveManifests(authoredConfig, act, 99, GATE_SLOT_COUNTS);
      for (const wave of manifests) {
        const spent = wave.spawns.reduce((sum, spawn) => sum + spawn.threatCost, 0);
        expect(spent).toBeLessThanOrEqual(wave.budget);
        expect(wave.spawns.length).toBeGreaterThan(0);
        // Termination invariant: nothing affordable is left over.
        const cheapest = Math.min(
          ...authoredConfig.acts[act - 1]!.roster.map((entry) => entry.threatCost),
        );
        expect(wave.budget - spent).toBeLessThan(cheapest);
      }
    }
  });

  it('only draws archetypes from the act roster and targets valid fixed gate slots', () => {
    for (const act of [1, 2, 3, 4, 5] as const) {
      const rosterIds = authoredConfig.acts[act - 1]!.roster.map((entry) => entry.archetypeId);
      for (const wave of buildFloor4ActWaveManifests(authoredConfig, act, 7, GATE_SLOT_COUNTS)) {
        for (const spawn of wave.spawns) {
          expect(rosterIds).toContain(spawn.archetypeId);
          expect(GATE_SLOT_COUNTS[spawn.gateIndex]).toBeDefined();
          expect(spawn.slotIndex).toBeLessThan(GATE_SLOT_COUNTS[spawn.gateIndex]!);
        }
      }
    }
  });

  it('is a pure function of (seed, act, waveIndex)', () => {
    const left = buildFloor4ActWaveManifests(authoredConfig, 3, 'seed-a', GATE_SLOT_COUNTS);
    const right = buildFloor4ActWaveManifests(authoredConfig, 3, 'seed-a', GATE_SLOT_COUNTS);
    const other = buildFloor4ActWaveManifests(authoredConfig, 3, 'seed-b', GATE_SLOT_COUNTS);

    expect(left).toEqual(right);
    expect(floor4WaveManifestFingerprint(left)).toBe(floor4WaveManifestFingerprint(right));
    expect(floor4WaveManifestFingerprint(left)).not.toBe(floor4WaveManifestFingerprint(other));
  });

  it('derives a distinct stream per act so acts never mirror each other', () => {
    const fingerprints = new Set(
      ([1, 2, 3, 4, 5] as const).map((act: Floor4ActIndex) =>
        floor4WaveManifestFingerprint(
          buildFloor4ActWaveManifests(authoredConfig, act, 'seed-a', GATE_SLOT_COUNTS),
        ),
      ),
    );
    expect(fingerprints.size).toBe(5);
  });

  it('skips feed gates that have no usable spawn slot', () => {
    const manifests = buildFloor4ActWaveManifests(authoredConfig, 2, 5, [0, 3, 0, 0]);
    for (const wave of manifests) {
      for (const spawn of wave.spawns) {
        expect(spawn.gateIndex).toBe(1);
      }
    }
  });

  it('refuses to plan waves when no gate is usable', () => {
    expect(() => buildFloor4ActWaveManifests(authoredConfig, 1, 5, [0, 0, 0, 0])).toThrow(
      /feed gate/i,
    );
  });
});
