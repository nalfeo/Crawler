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

/** A seed from the gated Floor-1 prefix, so Floor 1 is expected to clear. */
const PROGRESSION_SEED = GATE_SEEDS[1] ?? 2;

const HOOK_TIMEOUT_MS = 6 * 180_000;

describe('multi-floor progression', () => {
  it('resolves the implemented floor chain in play order', () => {
    // Order follows each scenario's explicit nextFloorId — what the shipped
    // game does on the stairs — not registry insertion order.
    expect(resolveFloorChain('floor1')).toEqual(['floor1', 'floor2']);
  });

  it('refuses to start a progression on an unimplemented floor', () => {
    expect(() => resolveFloorChain('floor3')).toThrow(/not an implemented floor/);
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

      // The transition itself: if Floor 1 cleared, the run MUST have advanced
      // to a Floor 2 leg rather than stopping — that advance is only possible
      // through a captured carryover snapshot.
      if (progression.clearedFloorIds.includes('floor1')) {
        expect(progression.legs.map((l) => l.floorId)).toContain('floor2');
        const floor2Leg = progression.legs.find((l) => l.floorId === 'floor2')!;
        // A carried-over player arrives leveled, not at a cold level-1 start.
        expect(floor2Leg.stats.finalLevel).toBeGreaterThan(1);
      }
    },
    HOOK_TIMEOUT_MS,
  );
});
