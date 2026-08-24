/**
 * Multi-floor progression gate — proves a seed can actually get from Floor 1
 * THROUGH the floor transition and into Floor 2 as a carried-over player.
 *
 * ## Why this exists
 *
 * Every prior sweep measured single floors from a cold start. That could never
 * answer the question the release sweep now asks — "is the game completable
 * end-to-end?" — and it never exercised the transition at all: a Floor-2 run
 * began at level 1 with an empty inventory, which is not a state any real
 * player reaches Floor 2 in.
 *
 * This test runs the REAL headless pipeline (`runProgression` over
 * `runHeadless`), not a lab, satisfying AGENTS.md rules #9/#14: a lab
 * force-calls the system under test and can never prove the runner chains.
 *
 * ## What is asserted
 *
 * Deliberately NOT a win-rate gate. Floor 2's real chained win rate is unknown
 * until the report-only release leg measures it, and inventing a threshold here
 * would either be meaningless or would pressure someone into tuning Floor 1 to
 * satisfy it (AGENTS.md rule #12). What IS asserted is the mechanism: the chain
 * resolves in the right order, a cleared Floor 1 hands a carried-over player to
 * Floor 2, and the aggregate accounting is internally consistent.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runProgression, resolveFloorChain } from '../../src/game/ai/progression-runner.js';
import { GATE_MAX_FRAMES, GATE_SEEDS } from '../../scripts/agent/perf/floor1-gate-sample.js';
import { getFloorWinBudgetMs } from '../../src/shared/floor-registry.js';

/** A seed from the gated Floor-1 prefix, so Floor 1 is expected to clear. */
const PROGRESSION_SEED = GATE_SEEDS[1] ?? 2;
const BLOCKED_FAMILY_REPRO_SEED = 27;

const HOOK_TIMEOUT_MS = 6 * 180_000;

describe('multi-floor progression', () => {
  it('resolves the implemented floor chain in play order', () => {
    // Order follows each scenario's explicit nextFloorId — what the shipped
    // game does on the stairs — not registry insertion order.
    expect(resolveFloorChain('floor1')).toEqual(['floor1', 'floor2']);
  });

  it('refuses to start a progression on an unimplemented floor', () => {
    expect(() => resolveFloorChain('floor3')).toThrow(/not an implemented floor/);
    // Even the playable-tail opt-in may not START on a floor that cannot be
    // won: a progression whose first floor is unwinnable measures nothing.
    expect(() => resolveFloorChain('floor3', { includePlayableTail: true })).toThrow(
      /not an implemented floor/,
    );
  });

  it('chains into the playable-but-unwinnable Floor 3 only when asked', () => {
    // Floor 3 is authored and playable (map, wilds, timer) but has no victory
    // yet, so it must stay out of the default win chain every sweep and gate
    // measures — and be reachable explicitly for a real chained playthrough.
    expect(resolveFloorChain('floor1', { includePlayableTail: true })).toEqual([
      'floor1',
      'floor2',
      'floor3',
    ]);
    expect(resolveFloorChain('floor1')).toEqual(['floor1', 'floor2']);
  });

  it(
    'chains Floor 1 into Floor 2 with a carried-over player',
    async () => {
      const progression = await runProgression(
        (_floorId, legIndex) => new BehaviorTreeAI({ seed: PROGRESSION_SEED + legIndex }),
        {
          seed: PROGRESSION_SEED,
          maxFramesPerFloor: GATE_MAX_FRAMES,
          startFloorId: 'floor1',
        },
      );

      // Always at least the starting leg, and legs are in chain order.
      expect(progression.legs.length).toBeGreaterThanOrEqual(1);
      expect(progression.legs[0]!.floorId).toBe('floor1');

      // Aggregate accounting must be internally consistent regardless of how
      // far the run got, otherwise the reported progression win-rate is not
      // measuring what it claims.
      const summedGameTime = progression.legs.reduce((s, l) => s + l.stats.gameTimeMs, 0);
      expect(progression.totalGameTimeMs).toBe(summedGameTime);
      expect(progression.totalActiveTimeMs).toBeLessThanOrEqual(progression.totalGameTimeMs);
      expect(progression.clearedFloorIds.length).toBeLessThanOrEqual(progression.legs.length);
      expect(progression.finalFloorId).toBe(progression.legs[progression.legs.length - 1]!.floorId);

      // A progression that did not clear every floor can never be an official
      // win, and reachedFinalVictory must agree with the per-leg outcomes.
      const allLegsWon = progression.legs.every((l) => l.stats.outcome === 'victory');
      expect(progression.reachedFinalVictory).toBe(
        allLegsWon && progression.legs.length === resolveFloorChain('floor1').length,
      );
      if (!progression.reachedFinalVictory) {
        expect(progression.officialWin).toBe(false);
      }

      // The transition itself. Asserted UNCONDITIONALLY: a gated Floor-1 seed
      // that fails to clear must fail this test rather than silently skipping
      // every transition assertion and leaving a broken handoff undetected.
      expect(
        progression.clearedFloorIds,
        `seed ${PROGRESSION_SEED} must clear Floor 1 for the transition to be exercised`,
      ).toContain('floor1');
      expect(progression.legs.map((l) => l.floorId)).toContain('floor2');

      const floor1Leg = progression.legs.find((l) => l.floorId === 'floor1')!;
      const floor2Leg = progression.legs.find((l) => l.floorId === 'floor2')!;
      const captured = floor1Leg.captured;
      expect(captured, 'a cleared Floor 1 captures a carryover snapshot').toBeDefined();
      // The Floor-2 leg must START from exactly that snapshot, not a cold boot.
      expect(floor2Leg.startedFrom).toBe(captured);

      // Concrete carried values are actually restored in the Floor-2 world.
      // `finalLevel > 1` alone proves nothing: a cold Floor-2 start already
      // begins at level 5 (applyFloor2DirectStartPlayerState). The level ledger
      // is decisive — its first entry is recorded on the first simulated frame,
      // so it IS the level the Floor-2 world booted at. A dropped carryover
      // boots the cold Floor-2 baseline instead of the carried level.
      const carriedLevel = captured!.playerLevel.level;
      const bootLevelUp = floor2Leg.stats.levelUps[0];
      expect(bootLevelUp, 'Floor 2 records its boot level on frame 1').toBeDefined();
      expect(bootLevelUp!.frame).toBeLessThanOrEqual(1);
      expect(bootLevelUp!.level).toBe(carriedLevel);

      // Gold is a second, independent carried value: it is never reset by the
      // Floor-2 boot, so the run cannot end below what Floor 1 handed over.
      expect(floor2Leg.stats.totalGold).toBeGreaterThanOrEqual(captured!.playerGold);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    'seed 27 descends from a cleared Floor 2 into Floor 3 with the carried-over player',
    async () => {
      // The real headless pipeline, not a lab: Floor 1 → Floor 2 → Floor 3 in
      // one run. The Floor 3 leg is an EXHIBITION leg (Floor 3 has no victory
      // yet), so it is stopped deterministically after a short slice rather
      // than burning its 20-minute authored timer.
      const FLOOR3_OBSERVATION_MS = 20_000;
      const progression = await runProgression(
        (_floorId, legIndex) => new BehaviorTreeAI({ seed: BLOCKED_FAMILY_REPRO_SEED + legIndex }),
        {
          seed: BLOCKED_FAMILY_REPRO_SEED,
          startFloorId: 'floor1',
          includePlayableTail: true,
          // Floor-scoped so the Floor 1 and Floor 2 legs play out in full.
          stopWhen: (world) =>
            world.floorId === 'floor3' && world.elapsedMs >= FLOOR3_OBSERVATION_MS,
        },
      );

      expect(progression.clearedFloorIds).toEqual(['floor1', 'floor2']);
      expect(progression.legs.map((leg) => leg.floorId)).toEqual(['floor1', 'floor2', 'floor3']);
      expect(progression.winnableFloorIds).toEqual(['floor1', 'floor2']);
      expect(progression.exhibitionFloorIds).toEqual(['floor3']);

      // The handoff itself: Floor 3 STARTED from the snapshot Floor 2 captured.
      const floor2Leg = progression.legs.find((leg) => leg.floorId === 'floor2')!;
      const floor3Leg = progression.legs.find((leg) => leg.floorId === 'floor3')!;
      expect(floor2Leg.captured).toBeDefined();
      expect(floor3Leg.startedFrom).toBe(floor2Leg.captured);
      // A carried player boots Floor 3 at the level Floor 2 handed over, not at
      // a cold level 1 — the level ledger's first entry is the boot level.
      const bootLevelUp = floor3Leg.stats.levelUps[0];
      expect(bootLevelUp).toBeDefined();
      expect(bootLevelUp!.frame).toBeLessThanOrEqual(1);
      expect(bootLevelUp!.level).toBe(floor2Leg.captured!.playerLevel.level);
      // Floor 3 actually simulated (the leg is a real run, not a zero-frame boot).
      expect(floor3Leg.stats.totalFrames).toBeGreaterThan(0);

      // The exhibition leg must not touch the win verdict: Floor 3 can never be
      // cleared, yet the Floor 1+2 progression still reads as a full victory,
      // and Floor 3's missing budget must not null out the summed budget.
      expect(progression.reachedFinalVictory).toBe(true);
      expect(progression.officialWin).toBe(true);
      // Budget is summed over the WINNABLE chain only. Floor 3 declares no
      // budget, so consulting it would force `budgetMs` to null and silently
      // degrade `officialWin` to raw victory for every chained run.
      expect(getFloorWinBudgetMs('floor3')).toBeNull();
      const winnableBudgets = progression.winnableFloorIds.map((floorId) =>
        getFloorWinBudgetMs(floorId),
      );
      expect(progression.budgetMs).toBe(
        winnableBudgets.some((budget) => budget === null)
          ? null
          : winnableBudgets.reduce((sum: number, budget) => sum + (budget ?? 0), 0),
      );
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    'seed 27 clears the chained Floor 2 family hunt',
    async () => {
      const progression = await runProgression(
        (_floorId, legIndex) => new BehaviorTreeAI({ seed: BLOCKED_FAMILY_REPRO_SEED + legIndex }),
        {
          seed: BLOCKED_FAMILY_REPRO_SEED,
          startFloorId: 'floor1',
        },
      );

      expect(progression.reachedFinalVictory).toBe(true);
      expect(progression.clearedFloorIds).toEqual(['floor1', 'floor2']);
      const families = Object.values(
        progression.legs.at(-1)?.stats.floor2Progression?.families ?? {},
      );
      expect(families).toHaveLength(4);
      expect(families.every((family) => family.encounterDefeated)).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );
});
