/**
 * Floor 1 release-sweep regression: the cleared boss arena must not become a
 * safe space.
 *
 * `d143f15a` promoted a cleared boss arena to a full `isPointInSafeSpace`
 * member. Floor 1's cleared arena is the room that OWNS the staircase, and that
 * predicate is the engine's combat-suppression contract: it disables the
 * player's weapon, keeps enemies from pathing in, pauses the floor-collapse
 * deadline, and switches the AI into its leave-the-safe-room regime — including
 * suspending the anti-wedge dwell/engage watchdogs that exist to break exactly
 * the "player vibrates in place forever" livelock.
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
    maxWallTimeMs: 300_000,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
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
  }, 120_000);
});
