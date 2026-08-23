/**
 * Floor 1 release-sweep regression: a cleared boss arena becomes a safe room,
 * but the post-boss farm window must still close so the AI takes the stairs.
 *
 * `d143f15a` promoted a cleared boss arena to a full `isPointInSafeSpace`
 * member. Floor 1's cleared arena is the room that OWNS the staircase, so the
 * post-boss farm window must be bounded against the authored floor budget
 * instead of the pause-inflated collapse deadline.
 *
 * On `seed=1 --weapon throwing-knife` the run then killed the staircase boss at
 * ~392s and vibrated ~20ft from the staircase — same room, no wall between —
 * for the remaining 570s, until the quest-stall detector fired with
 * `floor1-leave-floor` incomplete. That was one of the four Floor-1 losses in
 * the release sweep for that commit.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_LEAVE_FLOOR_QUEST_ID } from '../../src/shared/quest-types.js';

function deterministicStats(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

async function runThrowingKnife1(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 1 }), {
    seed: 1,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: 180_000,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
    enemyTelegraphMs: 250,
    floorId: 'floor1',
    settlementReturnRouting: false,
  });
}

describe('Floor 1 release sweep cleared-arena stall regression', () => {
  it('takes the stairs on the reported forced-throwing-knife seed', async () => {
    const first = await runThrowingKnife1();
    const second = await runThrowingKnife1();

    expect(first.startingWeapon).toBe('throwing-knife');
    // The reported failure was `outcome === 'stalled'`, not a death — assert the
    // outcome directly so a future stall cannot hide behind a frame-budget win.
    expect(first.outcome).toBe('victory');
    expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
    expect(deterministicStats(second)).toEqual(deterministicStats(first));
    // Two full Floor 1 runs, each capped at `maxWallTimeMs`. On a contended
    // CI box a single run has been observed at ~80s, so the vitest timeout has
    // to clear 2x the per-run wall cap or the test reports a false regression.
  }, 420_000);
});
