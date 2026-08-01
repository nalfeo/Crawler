/**
 * Floor 2 boss level gate — verifies XP pacing delivers the intended fight level.
 *
 * The Floor 2 boss retune targets a **level-10 player** as the reference fight
 * level. This gate confirms that players actually arrive at the first Floor 2
 * boss encounter at ≥ level 10 so boss tuning is not anchored to the wrong
 * baseline.
 *
 * ## Why a contiguous seed prefix, not cherry-picked seeds
 *
 * Seeds 1–3 form a contiguous prefix; any failing seed in range drags the rate
 * down (AGENTS.md r13). The gate asserts that every boss encounter that starts
 * within the extended frame budget does so at the correct player level.
 *
 * ## Frame budget
 *
 * The default questStallFrames (21 600 ≈ 360 s) was too tight for Floor 2's
 * larger 200×200-tile map: runs were stalling before reaching a boss den. This
 * gate uses an extended stall budget (50 000 ≈ 833 s) so the measurement is not
 * confounded by premature termination. The frame cap (100 000 ≈ 28 min of game
 * time) is well above the 20-minute floor timer so a completed run always
 * terminates cleanly.
 *
 * ## How the pacing fix works
 *
 * Floor 2 previously had no floor-level loot bonus (unlike Floor 1 which applies
 * `FLOOR_1` for +1 XP/kill → 2 XP total). That left Floor 2 at 1 XP/kill from
 * `BASIC_MELEE` alone. Going from level 5 (66 XP) to level 10 (200 XP) requires
 * 134 XP, meaning 134 kills before the first boss — too many given the floor's
 * enemy density before a den unlock. The `FLOOR_2` floor loot table adds 1 XP
 * per kill (2 XP total, matching the FLOOR_1 pattern), so the same gap requires
 * ~67 kills, which is achievable before a den encounter.
 *
 * ## Acceptable level range at first boss
 *
 * The gate asserts `10 ≤ level ≤ MAX_LEVEL_AT_FIRST_BOSS`. The upper bound guards
 * against overcorrection: a floor-wide +1 XP bonus should not push players to
 * level 14+ before the first fight, which would under-tune bosses for most
 * players. The current cap is conservative (13) to accommodate natural encounter
 * timing variation; tighten it once more seeds are measured in CI.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

/**
 * Minimum player level required at first Floor 2 boss encounter.
 * This is the reference level for the boss retune (issue #2551).
 */
const MIN_LEVEL_AT_FIRST_BOSS = 10;

/**
 * Maximum acceptable player level at first Floor 2 boss encounter.
 * Prevents the floor-wide XP bonus from over-correcting and making bosses
 * trivial. Set conservatively; tighten once CI has measured more seeds.
 */
const MAX_LEVEL_AT_FIRST_BOSS = 13;

/**
 * Seeds under test — a contiguous prefix so no cherry-picking.
 */
const GATE_SEEDS = [1, 2, 3] as const;

/**
 * Frame budget: 100 000 ≈ 1 666 s ≈ 28 min of simulated game time.
 * Comfortably above the 20-min floor timer so the run terminates on outcome,
 * not on the frame cap.
 */
const MAX_FRAMES = 100_000;

/**
 * Extended quest-stall budget: 50 000 ≈ 833 s of frozen quest progress.
 * The default 21 600 (360 s) was too tight for Floor 2's 200×200-tile map.
 */
const QUEST_STALL_FRAMES = 50_000;

/**
 * Maximum simulated game time at which the first boss encounter should start.
 * Guards against a "grind to level 10 then boss" scenario where the AI farms
 * enemies far longer than intended before entering a den.
 * 900 000 ms = 15 min; the floor timer is 20 min (1 200 000 ms).
 */
const MAX_FIRST_ENCOUNTER_MS = 900_000;

describe('Floor 2 boss level gate — XP pacing delivers level 10 at first boss', () => {
  for (const seed of GATE_SEEDS) {
    it(
      `seed ${seed}: every started boss encounter begins at level ${MIN_LEVEL_AT_FIRST_BOSS}–${MAX_LEVEL_AT_FIRST_BOSS}`,
      async () => {
        const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
          seed,
          floorId: 'floor2',
          maxFrames: MAX_FRAMES,
          questStallFrames: QUEST_STALL_FRAMES,
          stopWhen: (world) => {
            const encounters = world.floorExtendedState?.familyState?.bossEncounters;
            if (!encounters) return false;
            for (const encounter of encounters.values()) {
              if (encounter.started) return true;
            }
            return false;
          },
        });

        const floor2 = stats.floor2Progression;
        expect(floor2, 'floor2Progression must be present on a floor2 run').toBeDefined();

        // The run must not have stalled — a stall outcome means the AI never made
        // quest progress for 833 s and is a navigation regression, not a pacing
        // issue. Call it out explicitly so the failure message is diagnostic.
        const stallMsg = [
          `Seed ${seed}: run ended with outcome='${stats.outcome}' (stallReason='${stats.stallReason ?? 'n/a'}').`,
          `A stall before any boss encounter indicates an AI navigation regression,`,
          `not an XP pacing issue. finalLevel=${stats.finalLevel}, gameTimeMs=${stats.gameTimeMs}.`,
        ].join(' ');
        expect(stats.outcome, stallMsg).not.toBe('stalled');

        const startedFamilies = Object.entries(floor2!.families).filter(
          ([, fam]) => fam.encounterStarted,
        );

        // At least one boss encounter must start within the extended budget.
        const noEncounterMsg = [
          `Seed ${seed}: no boss encounter started within ${MAX_FRAMES} frames`,
          `(outcome=${stats.outcome}, finalLevel=${stats.finalLevel}, gameTimeMs=${stats.gameTimeMs}).`,
          `This indicates an AI navigation regression, not an XP pacing issue.`,
        ].join(' ');
        expect(startedFamilies.length, noEncounterMsg).toBeGreaterThan(0);

        // Pacing bound: the *first* encounter (minimum start time) must begin
        // within 15 min of game time. Subsequent encounters (2nd–4th den on a
        // total-war win path) naturally start later and are not constrained here.
        const firstEncounterMs = Math.min(
          ...startedFamilies.map(([, fam]) => fam.encounterStartedMs ?? Infinity),
        );
        const firstFamilyIdForTiming = startedFamilies.find(
          ([, fam]) => fam.encounterStartedMs === firstEncounterMs,
        )?.[0];
        const pacingCtx = `(seed=${seed}, family=${firstFamilyIdForTiming}, encounterStartedMs=${firstEncounterMs}, finalLevel=${stats.finalLevel}, totalXp=${stats.totalXp})`;
        const tooLateMsg = `First boss encounter at ${firstEncounterMs}ms > ${MAX_FIRST_ENCOUNTER_MS}ms ${pacingCtx}`;
        expect(firstEncounterMs, tooLateMsg).toBeLessThanOrEqual(MAX_FIRST_ENCOUNTER_MS);

        const firstFamilyEntry = startedFamilies.find(
          ([, fam]) => fam.encounterStartedMs === firstEncounterMs,
        );
        expect(firstFamilyEntry, `Missing first-encounter family for seed ${seed}`).toBeDefined();

        const [firstFamilyId, firstFam] = firstFamilyEntry!;
        const level = firstFam.levelAtEncounterStart;
        const ctx = `(seed=${seed}, family=${firstFamilyId}, encounterStartedMs=${firstFam.encounterStartedMs}, finalLevel=${stats.finalLevel}, totalXp=${stats.totalXp})`;

        // Lower bound: XP pacing must deliver level 10 before the fight.
        const lowMsg = `Boss encounter started at level ${level} < ${MIN_LEVEL_AT_FIRST_BOSS} ${ctx}`;
        expect(level, lowMsg).toBeGreaterThanOrEqual(MIN_LEVEL_AT_FIRST_BOSS);

        // Upper bound: the floor-wide XP bonus must not push the player far
        // above the reference fight level, which would under-tune bosses.
        const highMsg = `Boss encounter started at level ${level} > ${MAX_LEVEL_AT_FIRST_BOSS} ${ctx} — XP pacing may be overcorrected`;
        expect(level, highMsg).toBeLessThanOrEqual(MAX_LEVEL_AT_FIRST_BOSS);
      },
      // Wall-time guard — three seeds × ~2 min/seed in CI
      10 * 60 * 1000,
    );
  }
});
