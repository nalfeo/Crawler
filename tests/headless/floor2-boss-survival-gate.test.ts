/**
 * Floor 2 boss survival gate (issue #4291) — every den boss must live long
 * enough to play at least one complete signature-ability cycle, and Floor 2
 * must stay completable at that durability.
 *
 * ## What this measures, and why it is not a spawn-time HP assertion
 *
 * `tests/unit/floor2-boss-spawn.test.ts` only proves the spawn contract (the
 * live path no longer uses the arena lab's debug HP shrink). It cannot show
 * that the resulting fight is long enough to be readable. This gate runs the
 * REAL headless pipeline to completion and measures, per den, the game time
 * between the production encounter starting and the boss being defeated
 * (`RunStats.floor2Progression.families[*].encounterStartedMs` →
 * `encounterDefeatedMs`).
 *
 * ## Duration target
 *
 * Each boss's target comes from its own catalog row in
 * `src/shared/data/boss-abilities.floor2.json`: one complete signature cycle is
 * `timing.firstEligibleAfterMs + telegraph.durationMs` (9.25 s – 12.5 s across
 * the roster). The target is read from the catalog rather than hard-coded, so
 * re-timing an ability automatically re-times this gate.
 *
 * Note the scope: production Floor 2 does not yet *execute* these abilities
 * (`floor2-boss-production-enable` in
 * `scripts/agent/data/boss-abilities.floor2.status.json` is `not-started`).
 * This gate enforces the durability half of the acceptance criteria — the fight
 * window is long enough for the authored cycle — so the production activation
 * slice cannot silently land on bosses that die before their own telegraph.
 *
 * ## Completion viability
 *
 * The same runs assert `outcome === 'victory'` with the Floor 2 exit completed,
 * so raising boss durability cannot be traded against Floor 2 remaining
 * beatable. Seeds 1–3 are a contiguous prefix (AGENTS.md r12): a single bad
 * seed fails the gate rather than being dropped.
 *
 * ## Upper bound
 *
 * Fights are also capped so a future durability bump cannot turn a den boss
 * into a damage sponge; measured runs land at 12.1–27.0 s.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { FLOOR2_BOSS_ABILITY_CATALOG } from '../../src/shared/boss-abilities.js';

/** Contiguous seed prefix — no cherry-picking. */
const GATE_SEEDS = [1, 2, 3] as const;

/**
 * Frame budget: 100 000 frames ≈ 1 666 s of game time. Measured victories land
 * at 863 s – 1 173 s, so a run terminates on outcome, not on the cap.
 */
const MAX_FRAMES = 100_000;

/** Extended stall budget, matching `floor2-boss-level-gate` for the 200×200 map. */
const QUEST_STALL_FRAMES = 50_000;

/**
 * Slog ceiling for a single den boss. Measured worst case is 27.0 s (seed 3,
 * cactusfolk); 45 s leaves headroom for seed variance while still failing if a
 * boss becomes a sponge.
 */
const MAX_BOSS_FIGHT_MS = 45_000;

/**
 * One complete signature-ability cycle per family: the ability becomes eligible
 * after `firstEligibleAfterMs` and resolves after its telegraph.
 *
 * Keying by family is unambiguous: the catalog loader rejects a second row for
 * a family (`duplicate family` in `src/shared/boss-abilities.ts`), so each
 * family has exactly one signature ability and this map is order-independent.
 */
const SIGNATURE_CYCLE_MS_BY_FAMILY = new Map<string, number>(
  FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) => [
    ability.familyId,
    ability.timing.firstEligibleAfterMs + ability.telegraph.durationMs,
  ]),
);

describe('Floor 2 boss survival gate — bosses outlive one signature cycle', () => {
  for (const seed of GATE_SEEDS) {
    it(
      `seed ${seed}: every defeated den boss survives its signature cycle and Floor 2 still completes`,
      async () => {
        const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
          seed,
          floorId: 'floor2',
          maxFrames: MAX_FRAMES,
          questStallFrames: QUEST_STALL_FRAMES,
        });

        const floor2 = stats.floor2Progression;
        expect(floor2, 'floor2Progression must be present on a floor2 run').toBeDefined();

        // Completion viability: tougher bosses must not cost the floor's win.
        const outcomeMsg = [
          `Seed ${seed}: outcome='${stats.outcome}' (stallReason='${stats.stallReason ?? 'n/a'}',`,
          `gameTimeMs=${Math.round(stats.gameTimeMs)}, finalLevel=${stats.finalLevel}).`,
          'Floor 2 must remain completable at the shipped boss durability.',
        ].join(' ');
        expect(stats.outcome, outcomeMsg).toBe('victory');
        expect(floor2!.exitCompleted, `Seed ${seed}: Floor 2 exit was not completed`).toBe(true);

        const startedFamilies = Object.entries(floor2!.families).filter(
          ([, fam]) => fam.encounterStarted,
        );
        expect(
          startedFamilies.length,
          `Seed ${seed}: no boss encounter started, so boss duration is unmeasured`,
        ).toBeGreaterThan(0);

        for (const [familyId, fam] of startedFamilies) {
          const requiredMs = SIGNATURE_CYCLE_MS_BY_FAMILY.get(familyId);
          if (requiredMs === undefined) {
            throw new Error(
              `Seed ${seed}: family '${familyId}' has no signature ability row in boss-abilities.floor2.json`,
            );
          }

          expect(
            fam.encounterDefeated,
            `Seed ${seed}: '${familyId}' boss encounter started but was never defeated on a victory run`,
          ).toBe(true);

          const startedMs = fam.encounterStartedMs;
          const defeatedMs = fam.encounterDefeatedMs;
          expect(startedMs).not.toBeNull();
          expect(defeatedMs).not.toBeNull();

          const durationMs = defeatedMs! - startedMs!;
          const ctx = [
            `(seed=${seed}, family=${familyId}, startedMs=${Math.round(startedMs!)},`,
            `defeatedMs=${Math.round(defeatedMs!)}, levelAtStart=${fam.levelAtEncounterStart})`,
          ].join(' ');

          expect(
            durationMs,
            `Boss died in ${Math.round(durationMs)}ms, before one ${requiredMs}ms signature cycle ${ctx}`,
          ).toBeGreaterThanOrEqual(requiredMs);

          expect(
            durationMs,
            `Boss fight ran ${Math.round(durationMs)}ms > ${MAX_BOSS_FIGHT_MS}ms — durability has become a slog ${ctx}`,
          ).toBeLessThanOrEqual(MAX_BOSS_FIGHT_MS);
        }
      },
      // Wall-time guard — a full Floor 2 victory measures ~2 min per seed.
      10 * 60 * 1000,
    );
  }
});
