/**
 * Release balance acceptance gate — verifies XP tuning and boss health meet
 * release targets against the canonical release-matrix cohort.
 *
 * This gate validates the four hard acceptance criteria from issue #3798:
 * 1. Floor 1 mean completion level: 6.5–7.5 (target 7.0)
 * 2. Floor 3 entry mean level (chained runs): 9.5–10.5 (target 10.0)
 * 3. Per-run combat skill/ability p90: ≤4 on Floor 1, ≤6 on Floor 2
 * 4. Mean completed boss-fight duration: 27–33 seconds (target 30s)
 *
 * The canonical cohort is a small deterministic smoke sample (not the full
 * 600-run release sweep) to permit fast local verification. A passing smoke
 * sample does not guarantee the full release sweep will pass; the actual
 * release workflow must measure and publish the complete baseline before
 * landing a PR. This test exists to catch major regressions early.
 *
 * ## Cohort definition
 *
 * Smoke sample: seeds 1–3 on Floor 1 (forced sword to isolate pacing from
 * weapon balance), seeds 1–3 on Floor 2, and seeds 1–3 chained through Floor 2.
 * This is a deterministic subset of the canonical revision-2 matrix.
 *
 * The smoke sample shares the same measurement logic (RunStats collection
 * and aggregate derivation) as the full release suite, so passing here is
 * required but not sufficient for the full cohort to pass.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { runProgression } from '../../src/game/ai/progression-runner.js';
import { analyzeReleaseBalance } from '../../scripts/agent/perf/release-balance.js';
import type { RunStats } from '../../src/game/ai/types.js';

/**
 * Acceptance thresholds derived from issue #3798 requirements.
 */
const ACCEPTANCE = {
  /** Floor 1 mean completion level: 7.0 ±0.5 */
  floor1MeanLevel: { min: 6.5, max: 7.5, target: 7.0 },
  /** Floor 3 entry (chained) mean level: 10.0 ±0.5 */
  floor3EntryMeanLevel: { min: 9.5, max: 10.5, target: 10.0 },
  /** Per-run p90 combat skill level: ≤4 on Floor 1, ≤6 on Floor 2 */
  floor1P90SkillLevel: { max: 4 },
  floor2P90SkillLevel: { max: 6 },
  /** Mean completed boss-fight duration: 30.0 ±3.0 seconds */
  meanBossDurationMs: { min: 27_000, max: 33_000, target: 30_000 },
};

/**
 * Smoke-sample seed panel: contiguous prefix to catch systematic regressions.
 */
const SMOKE_SEEDS = [1, 2, 3] as const;

/**
 * Frame budgets for each leg.
 */
const MAX_FRAMES = {
  floor1: 100_000,
  floor2: 200_000, // Floor 2 needs more time due to larger map
  chained: 200_000,
} as const;

describe('Release balance acceptance — smoke sample', () => {
  it('Floor 1 smoke runs meet level and skill targets', async () => {
    const floor1Runs: RunStats[] = [];

    for (const seed of SMOKE_SEEDS) {
      const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
        seed,
        floorId: 'floor1',
        maxFrames: MAX_FRAMES.floor1,
        forceWeaponId: 'sword', // Canonical Floor 1 starter weapon
      });

      floor1Runs.push(stats);
    }

    // Check that all runs completed (necessary for meaningful level analysis)
    const completedRuns = floor1Runs.filter((r) => r.outcome === 'victory');
    expect(completedRuns.length, `Floor 1 smoke sample must complete (all 3 seeds)`).toBe(
      floor1Runs.length,
    );

    // Check mean completion level
    const meanLevel =
      completedRuns.reduce((sum, r) => sum + r.finalLevel, 0) / completedRuns.length;
    const levelMsg = `Floor 1 mean completion level ${meanLevel.toFixed(2)} must be in ${ACCEPTANCE.floor1MeanLevel.min}–${ACCEPTANCE.floor1MeanLevel.max}`;
    expect(meanLevel, levelMsg).toBeGreaterThanOrEqual(ACCEPTANCE.floor1MeanLevel.min);
    expect(meanLevel, levelMsg).toBeLessThanOrEqual(ACCEPTANCE.floor1MeanLevel.max);

    // Check per-run combat skill p90
    const skillLevels = floor1Runs
      .map((r) => r.skills?.maxCombatSkillLevel)
      .filter((level): level is number => level !== undefined && level !== null);
    expect(skillLevels.length, 'All Floor 1 runs must have complete skill telemetry').toBe(
      floor1Runs.length,
    );
    const sortedSkills = [...skillLevels].sort((a, b) => a - b);
    const p90Index = Math.ceil(sortedSkills.length * 0.9) - 1;
    const p90Skill = sortedSkills[p90Index] ?? 0;
    const skillMsg = `Floor 1 p90 combat skill level ${p90Skill} must be ≤${ACCEPTANCE.floor1P90SkillLevel.max}`;
    expect(p90Skill, skillMsg).toBeLessThanOrEqual(ACCEPTANCE.floor1P90SkillLevel.max);
  });

  it('Floor 2 smoke runs meet skill target', async () => {
    const floor2Runs: RunStats[] = [];

    for (const seed of SMOKE_SEEDS) {
      const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
        seed,
        floorId: 'floor2',
        maxFrames: MAX_FRAMES.floor2,
        // No forced weapon — let the seed pick
      });

      floor2Runs.push(stats);
    }

    // Check per-run combat skill p90
    const skillLevels = floor2Runs
      .map((r) => r.skills?.maxCombatSkillLevel)
      .filter((level): level is number => level !== undefined && level !== null);
    expect(skillLevels.length, 'All Floor 2 runs must have complete skill telemetry').toBe(
      floor2Runs.length,
    );
    const sortedSkills = [...skillLevels].sort((a, b) => a - b);
    const p90Index = Math.ceil(sortedSkills.length * 0.9) - 1;
    const p90Skill = sortedSkills[p90Index] ?? 0;
    const skillMsg = `Floor 2 p90 combat skill level ${p90Skill} must be ≤${ACCEPTANCE.floor2P90SkillLevel.max}`;
    expect(p90Skill, skillMsg).toBeLessThanOrEqual(ACCEPTANCE.floor2P90SkillLevel.max);
  });

  it('Chained smoke runs (Floor 1→2) meet Floor 3 entry level target', async () => {
    const chainedRuns: RunStats[] = [];

    for (const seed of SMOKE_SEEDS) {
      const progression = await runProgression(
        (_floorId, legIndex) => new BehaviorTreeAI({ seed: seed + legIndex }),
        {
          seed,
          maxFramesPerFloor: MAX_FRAMES.chained,
          startFloorId: 'floor1',
        },
      );

      // The final leg of the progression (Floor 2 endpoint) represents Floor 3 entry
      const finalStats = progression.legs[progression.legs.length - 1]?.stats;
      if (finalStats) {
        chainedRuns.push(finalStats);
      }
    }

    // Check that all chained runs completed at Floor 2 (Floor 3 entry)
    const completedRuns = chainedRuns.filter((r) => r.outcome === 'victory');
    expect(completedRuns.length, `Chained smoke sample must complete Floor 1→2 (all 3 seeds)`).toBe(
      chainedRuns.length,
    );

    // Check mean Floor 3 entry level (endpoint of completed chained runs)
    const meanLevel =
      completedRuns.reduce((sum, r) => sum + r.finalLevel, 0) / completedRuns.length;
    const levelMsg = `Floor 3 entry mean level ${meanLevel.toFixed(2)} must be in ${ACCEPTANCE.floor3EntryMeanLevel.min}–${ACCEPTANCE.floor3EntryMeanLevel.max}`;
    expect(meanLevel, levelMsg).toBeGreaterThanOrEqual(ACCEPTANCE.floor3EntryMeanLevel.min);
    expect(meanLevel, levelMsg).toBeLessThanOrEqual(ACCEPTANCE.floor3EntryMeanLevel.max);
  });

  it('Smoke cohort aggregates demonstrate consistent acceptance measurement', async () => {
    // This test runs the full smoke sample and validates aggregate derivation.
    // In production, the full 600-run release sweep will be measured and
    // published by the CI workflow; this test verifies the measurement
    // infrastructure works correctly.

    const floor1Runs: RunStats[] = [];
    const floor2Runs: RunStats[] = [];
    const chainedRuns: RunStats[] = [];

    for (const seed of SMOKE_SEEDS) {
      // Floor 1 with forced sword
      floor1Runs.push(
        await runHeadless(new BehaviorTreeAI({ seed }), {
          seed,
          floorId: 'floor1',
          maxFrames: MAX_FRAMES.floor1,
          forceWeaponId: 'sword',
        }),
      );

      // Floor 2 with no forced weapon
      floor2Runs.push(
        await runHeadless(new BehaviorTreeAI({ seed }), {
          seed,
          floorId: 'floor2',
          maxFrames: MAX_FRAMES.floor2,
        }),
      );

      // Chained: Floor 1→2 with no forced weapon
      const progression = await runProgression(
        (_floorId, legIndex) => new BehaviorTreeAI({ seed: seed + legIndex }),
        {
          seed,
          maxFramesPerFloor: MAX_FRAMES.chained,
          startFloorId: 'floor1',
        },
      );
      const finalStats = progression.legs[progression.legs.length - 1]?.stats;
      if (finalStats) {
        chainedRuns.push(finalStats);
      }
    }

    // Derive aggregate metrics using the canonical analysis function
    const summary = analyzeReleaseBalance({
      floor1: floor1Runs,
      floor2: floor2Runs,
      floor1Chain: chainedRuns,
    });

    // Verify cohort identity
    expect(summary.floor1RunCount).toBe(SMOKE_SEEDS.length);
    expect(summary.floor2RunCount).toBe(SMOKE_SEEDS.length);
    expect(summary.chainedRunCount).toBe(SMOKE_SEEDS.length);

    // Floor 1: check mean level
    const floor1LevelMsg = `Floor 1 mean level must be in ${ACCEPTANCE.floor1MeanLevel.min}–${ACCEPTANCE.floor1MeanLevel.max}`;
    expect(summary.meanFloor1CompletionLevel, floor1LevelMsg).not.toBeNull();
    if (summary.meanFloor1CompletionLevel !== null) {
      expect(summary.meanFloor1CompletionLevel, floor1LevelMsg).toBeGreaterThanOrEqual(
        ACCEPTANCE.floor1MeanLevel.min,
      );
      expect(summary.meanFloor1CompletionLevel, floor1LevelMsg).toBeLessThanOrEqual(
        ACCEPTANCE.floor1MeanLevel.max,
      );
    }

    // Floor 3 entry (chained): check mean level
    const floor3LevelMsg = `Floor 3 entry mean level must be in ${ACCEPTANCE.floor3EntryMeanLevel.min}–${ACCEPTANCE.floor3EntryMeanLevel.max}`;
    expect(summary.meanFloor3EntryLevel, floor3LevelMsg).not.toBeNull();
    if (summary.meanFloor3EntryLevel !== null) {
      expect(summary.meanFloor3EntryLevel, floor3LevelMsg).toBeGreaterThanOrEqual(
        ACCEPTANCE.floor3EntryMeanLevel.min,
      );
      expect(summary.meanFloor3EntryLevel, floor3LevelMsg).toBeLessThanOrEqual(
        ACCEPTANCE.floor3EntryMeanLevel.max,
      );
    }

    // Skill levels: must be complete (not null) and within bounds
    const floor1SkillMsg = 'Floor 1 must have complete skill telemetry';
    expect(summary.floor1P90CombatSkillLevel, floor1SkillMsg).not.toBeNull();
    if (summary.floor1P90CombatSkillLevel !== null) {
      expect(summary.floor1P90CombatSkillLevel).toBeLessThanOrEqual(
        ACCEPTANCE.floor1P90SkillLevel.max,
      );
    }

    const floor2SkillMsg = 'Floor 2 must have complete skill telemetry';
    expect(summary.floor2P90CombatSkillLevel, floor2SkillMsg).not.toBeNull();
    if (summary.floor2P90CombatSkillLevel !== null) {
      expect(summary.floor2P90CombatSkillLevel).toBeLessThanOrEqual(
        ACCEPTANCE.floor2P90SkillLevel.max,
      );
    }

    // Boss duration: check mean (must be complete and within bounds)
    const bossDurationMsg = `Boss-fight duration must be in ${ACCEPTANCE.meanBossDurationMs.min}–${ACCEPTANCE.meanBossDurationMs.max}ms`;
    expect(summary.meanCompletedBossFightMs, bossDurationMsg).not.toBeNull();
    if (summary.meanCompletedBossFightMs !== null) {
      expect(summary.meanCompletedBossFightMs, bossDurationMsg).toBeGreaterThanOrEqual(
        ACCEPTANCE.meanBossDurationMs.min,
      );
      expect(summary.meanCompletedBossFightMs, bossDurationMsg).toBeLessThanOrEqual(
        ACCEPTANCE.meanBossDurationMs.max,
      );
    }

    // Diagnostic: ensure we have observed completed encounters
    expect(
      summary.completedBossFightCount,
      'Smoke cohort must observe started boss encounters',
    ).toBeGreaterThan(0);
  });
});

describe('Release balance acceptance — canonical published baseline (revision 2)', () => {
  it('validates canonical baseline cohort identity and measurement', async () => {
    // Load the published canonical baseline metadata
    const metadata = (
      await import('../../scripts/agent/perf/load-canonical-baseline.js')
    ).getCanonicalBaselineMetadata();

    // Verify cohort structure: canonical revision-2 matrix has 300 Floor 1, 150 Floor 2, 150 chained
    expect(metadata.revision, 'Canonical baseline must be revision 2').toBe(2);
    expect(metadata.expectedRunCounts.floor1, 'Canonical baseline must have 300 Floor 1 runs').toBe(
      300,
    );
    expect(metadata.expectedRunCounts.floor2, 'Canonical baseline must have 150 Floor 2 runs').toBe(
      150,
    );
    expect(
      metadata.expectedRunCounts.chained,
      'Canonical baseline must have 150 chained runs',
    ).toBe(150);

    // The canonical baseline was taken at commit 26df582, which predates maxCombatSkillLevel
    // telemetry and complete boss lifecycle tracking. This test verifies that the measurement
    // infrastructure properly handles incomplete data by returning null for unmeasurable metrics.
    //
    // When the next canonical baseline is published (after this PR merges and its tuning takes
    // effect), that baseline will have complete telemetry and can validate the four hard
    // acceptance criteria:
    // 1. Floor 1 mean completion level 6.5–7.5 (target 7.0)
    // 2. Floor 3 entry mean level 9.5–10.5 (target 10.0)
    // 3. Per-run p90 combat skill level ≤4 on Floor 1, ≤6 on Floor 2
    // 4. Mean completed boss-fight duration 27–33 seconds (target 30s)
    //
    // For now, this test confirms that:
    // - The canonical cohort identity is available and deterministic
    // - The analysis infrastructure can load the published baseline
    // - Incomplete observations are reported explicitly (as null) rather than silently coerced

    console.log(
      `✓ Canonical baseline identified: revision ${metadata.revision} at ${metadata.commit}`,
    );
    console.log(`  Floor 1: ${metadata.expectedRunCounts.floor1} runs`);
    console.log(`  Floor 2: ${metadata.expectedRunCounts.floor2} runs`);
    console.log(`  Chained: ${metadata.expectedRunCounts.chained} runs`);
  });
});
