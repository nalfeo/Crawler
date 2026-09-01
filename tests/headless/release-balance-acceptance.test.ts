import { describe, expect, it } from 'vitest';
import { getCanonicalBaselineMetadata } from '../../scripts/agent/perf/load-canonical-baseline.js';
import { assertReleaseBalanceSummary } from '../../scripts/agent/perf/release-balance.js';

describe('Release balance acceptance — canonical cohort gate', () => {
  it('requires the canonical 300/150/150 release cohort before evaluating bounds', () => {
    const metadata = getCanonicalBaselineMetadata();

    expect(metadata.expectedRunCounts.floor1).toBe(300);
    expect(metadata.expectedRunCounts.floor2).toBe(150);
    expect(metadata.expectedRunCounts.chained).toBe(150);

    const summary = {
      revision: metadata.revision,
      floor1RunCount: 299,
      floor2RunCount: metadata.expectedRunCounts.floor2,
      chainedRunCount: metadata.expectedRunCounts.chained,
      meanFloor1CompletionLevel: 7,
      meanFloor3EntryLevel: 10,
      floor1P90CombatSkillLevel: 4,
      floor2P90CombatSkillLevel: 6,
      completedBossFightCount: 1,
      incompleteBossFightCount: 0,
      meanCompletedBossFightMs: 30_000,
    };

    expect(() => assertReleaseBalanceSummary(summary)).toThrow(/Expected 300 Floor 1 runs/i);
  });

  it('accepts a deterministic canonical release summary when complete observations are in range', () => {
    const summary = {
      revision: 2,
      floor1RunCount: 300,
      floor2RunCount: 150,
      chainedRunCount: 150,
      meanFloor1CompletionLevel: 7,
      meanFloor3EntryLevel: 10,
      floor1P90CombatSkillLevel: 4,
      floor2P90CombatSkillLevel: 6,
      completedBossFightCount: 300,
      incompleteBossFightCount: 0,
      meanCompletedBossFightMs: 30_000,
    };

    expect(() => assertReleaseBalanceSummary(summary)).not.toThrow();
  });

  it('fails the canonical gate when the published baseline is missing complete observations', () => {
    const metadata = getCanonicalBaselineMetadata();
    const summary = {
      revision: metadata.revision,
      floor1RunCount: metadata.expectedRunCounts.floor1,
      floor2RunCount: metadata.expectedRunCounts.floor2,
      chainedRunCount: metadata.expectedRunCounts.chained,
      meanFloor1CompletionLevel: 7,
      meanFloor3EntryLevel: 10,
      floor1P90CombatSkillLevel: null,
      floor2P90CombatSkillLevel: null,
      completedBossFightCount: 0,
      incompleteBossFightCount: 0,
      meanCompletedBossFightMs: null,
    };

    expect(() => assertReleaseBalanceSummary(summary)).toThrow(
      /skill telemetry is incomplete|Boss-fight duration telemetry is incomplete/i,
    );
  });
});
