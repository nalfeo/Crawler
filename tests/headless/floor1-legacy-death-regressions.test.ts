import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import { AIDecisionMode, AIPathingMode } from '../../src/game/ai/types.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';
import { GAME } from '../../src/shared/constants.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';

const MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;
const BOSS_LOCKIN_MAX_FRAMES = 19_800;
const BOSS_LOCKIN_MAX_GAME_TIME_MS = BOSS_LOCKIN_MAX_FRAMES * GAME.DELTA_MS;
const BOSS_LOCKIN_MAX_FIGHT_FRAMES = Math.ceil((60_000 / 1000) * 60);
/**
 * Default boss-entry health floor for the lock-in panel.
 *
 * This is a **guard rounded down from observation**, not a designer-set
 * readiness requirement: when the panel was introduced (PR #2827) the three
 * adopted cases entered the staircase at 62.7% / 66.8% / 92.8% HP, and 50% was
 * picked as a round number safely under all of them. A sibling session
 * (`docs/knowledge/handoffs/2026-08-15-floor1-wounded-npc-threat-clear.md`)
 * explicitly *rejected* turning boss-entry readiness into actual AI behavior,
 * so nothing in the simulation targets this number.
 */
const BOSS_ENTRY_MIN_HEALTH_FRACTION = 0.5;
const BOSS_ENTRY_MIN_LEVEL = 2;
const MAX_WALL_TIME_MS = 170_000;
const CASES = [
  { weapon: 'bow', seed: 35 },
  { weapon: 'baseball-bat', seed: 34 },
  { weapon: 'pistol', seed: 30 },
  { weapon: 'throwing-knife', seed: 2 },
  { weapon: 'throwing-knife', seed: 6 },
  { weapon: 'throwing-knife', seed: 29 },
  { weapon: 'throwing-knife', seed: 44 },
  { weapon: 'throwing-knife', seed: 81 },
  { weapon: 'throwing-knife', seed: 84 },
] as const;
const BOSS_LOCKIN_CASES = [
  { weapon: 'baseball-bat', seed: 2 },
  { weapon: 'baseball-bat', seed: 25 },
  { weapon: 'sword', seed: 44 },
  { weapon: 'baseball-bat', seed: 67 },
] as const;
/**
 * Per-case, per-boss deviations from {@link BOSS_ENTRY_MIN_HEALTH_FRACTION}.
 *
 * A case may only appear here with a measured reason and a removal condition.
 * Every other assertion (official victory, both encounters started/defeated,
 * level >= 2, fight length, explicit lock-in target) still runs unchanged for
 * the case, so this narrows exactly one number instead of dropping the seed
 * (which would be the cherry-picking AGENTS.md r12 forbids).
 *
 * - `sword:44 / staircase` → **0.45** (observed 0.4613).
 *   Cause: Floor 1's Gear unlock used to latch at frame 1 off the starter
 *   weapon, which satisfied the `equipmentUnlocked` fact behind the
 *   `merchant-customer` ("Buy your first piece of gear") achievement and paid
 *   out its loot box before the player bought anything. Issue #3310 removed
 *   that unearned frame-1 income, so this run now reaches the Spell Broker
 *   with 267 gold against a 350 gold offer and enters the staircase without a
 *   spell. Measured, not guessed: the charm is still bought at essentially the
 *   same frame (9998 → 10098), the AI's abandoned→returning broker recovery is
 *   working correctly (the run simply never holds the asking price), and gear
 *   equipping is unchanged (`equippedGeneratedCount: 0` on both sides). Over a
 *   10-seed sword A/B the panel stayed at 10/10 official victories and 9/10
 *   seeds remained above the default bar; seed 44 was the only mover.
 *   Removal condition: delete this entry once Floor 1's economy is rebalanced
 *   to restore mid-floor spendable income (the loss is systematic — median
 *   spendable income fell ~29% on that panel), at which point this seed should
 *   clear the 0.5 default again.
 *   Evidence: `docs/knowledge/handoffs/2026-08-22-floor1-gear-unlock-charm-gate.md`.
 */
const BOSS_ENTRY_MIN_HEALTH_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ['sword:44:staircase', 0.45],
]);

function bossEntryMinHealth(weapon: string, seed: number, bossId: string): number {
  return (
    BOSS_ENTRY_MIN_HEALTH_OVERRIDES.get(`${weapon}:${seed}:${bossId}`) ??
    BOSS_ENTRY_MIN_HEALTH_FRACTION
  );
}

const FLOOR1_BOSS_IDS = ['slime-rat', 'staircase'] as const;

describe('Floor 1 legacy weapon-sweep death regressions', () => {
  for (const { weapon, seed } of CASES) {
    it(`${weapon} seed ${seed} is an official victory`, async () => {
      const stats = await runHeadless(
        new BehaviorTreeAI({
          seed,
          pathingMode: AIPathingMode.RISK_REWARD_FUSED,
          decisionMode: AIDecisionMode.LEGACY,
        }),
        {
          seed,
          maxFrames: MAX_FRAMES,
          maxWallTimeMs: MAX_WALL_TIME_MS,
          forceWeaponId: weapon,
        },
      );

      expect(stats.startingWeapon).toBe(weapon);
      expect(stats.outcome).toBe('victory');
      expect(isOfficialWin(stats, FLOOR1_ACTIVE_TIME_BUDGET_MS)).toBe(true);
    });
  }
});

describe('Floor 1 boss-entry readiness and arena lock-in regressions', () => {
  it('declares boss-entry health overrides only for cases and bosses on this panel', () => {
    // A stale override is a silently-defanged guard: if a case is renamed or
    // dropped, its exception must not survive and quietly loosen a *different*
    // future case that happens to reuse the key.
    const validKeys = new Set(
      BOSS_LOCKIN_CASES.flatMap(({ weapon, seed }) =>
        FLOOR1_BOSS_IDS.map((bossId) => `${weapon}:${seed}:${bossId}`),
      ),
    );
    for (const [key, value] of BOSS_ENTRY_MIN_HEALTH_OVERRIDES) {
      expect(validKeys.has(key), `override "${key}" does not match any panel case/boss`).toBe(true);
      // An override may only ever narrow the default, never raise it above the
      // shared bar under the guise of an exception.
      expect(value, `override "${key}" must be below the default bar`).toBeLessThan(
        BOSS_ENTRY_MIN_HEALTH_FRACTION,
      );
    }
  });

  for (const { weapon, seed } of BOSS_LOCKIN_CASES) {
    it(
      `${weapon} seed ${seed} enters ready, locks onto both bosses, and wins within the sweep budget`,
      async () => {
        const events: SimEvent[] = [];
        const stats = await runHeadless(
          new BehaviorTreeAI({
            seed,
            pathingMode: AIPathingMode.RISK_REWARD_FUSED,
            decisionMode: AIDecisionMode.LEGACY,
          }),
          {
            seed,
            maxFrames: BOSS_LOCKIN_MAX_FRAMES,
            maxWallTimeMs: MAX_WALL_TIME_MS,
            forceWeaponId: weapon,
            // Record every decision frame: the lock-in assertion below needs the
            // exact frame a boss becomes the target, which the default 15-frame
            // sample interval can skip.
            eventSampleInterval: 1,
            recordEvent: (event) => events.push(event),
          },
        );

        expect(stats.startingWeapon).toBe(weapon);
        expect(stats.outcome).toBe('victory');
        expect(isOfficialWin(stats, BOSS_LOCKIN_MAX_GAME_TIME_MS)).toBe(true);

        const progression = stats.floor1BossProgression;
        expect(progression, 'floor1BossProgression must be present on Floor 1').toBeDefined();
        for (const bossId of FLOOR1_BOSS_IDS) {
          const encounter = progression!.encounters[bossId];
          if (!encounter) {
            throw new Error(`Missing ${bossId} encounter telemetry`);
          }
          expect(encounter.encounterStarted, `${bossId} never started`).toBe(true);
          expect(encounter.encounterDefeated, `${bossId} never completed`).toBe(true);
          expect(encounter.bossEid, `${bossId} did not capture its boss eid`).not.toBeNull();
          expect(
            encounter.playerLevelAtStart,
            `${bossId} started below the minimum readiness level`,
          ).toBeGreaterThanOrEqual(BOSS_ENTRY_MIN_LEVEL);
          const minEntryHealth = bossEntryMinHealth(weapon, seed, bossId);
          expect(
            encounter.playerHealthFractionAtStart,
            `${bossId} started below the minimum readiness health`,
          ).toBeGreaterThanOrEqual(minEntryHealth);

          const fightFrames =
            (encounter.encounterDefeatedFrame ?? Number.POSITIVE_INFINITY) -
            (encounter.encounterStartedFrame ?? 0);
          expect(
            fightFrames,
            `${bossId} remained locked for ${fightFrames} frames`,
          ).toBeLessThanOrEqual(BOSS_LOCKIN_MAX_FIGHT_FRAMES);

          const bossTargetEvents = events.filter(
            (event) =>
              event.reason.startsWith('Boss-room lock-in') && event.targetEid === encounter.bossEid,
          );
          expect(
            bossTargetEvents.length,
            `${bossId} never became the explicit arena lock-in target`,
          ).toBeGreaterThan(0);
        }
      },
      10 * 60 * 1000,
    );
  }
});
