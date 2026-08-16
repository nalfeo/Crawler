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

async function runThrowingKnife25(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 25 }), {
    seed: 25,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: 90_000,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
  });
}

// Release sweep regression (#2993): retreat scans a ±120° arc away from the
// swarm centroid for a reachable escape tile. Wedged into a room corner
// (tile 24,10 — wall on both the -x and -y side) with the pack occupying the
// only open quadrant, every arc candidate was wall, so retreat fell through to
// the naive away-from-threat vector — which points into the corner the player
// is already pressed against. Collision cancelled both movement axes, so the
// runner held exactly one position for ~500 frames at full throttle while
// contact damage took it from 67% HP to 0. Fixed by widening the scan to the
// remaining rearward directions once a retreat is measurably wedged.
describe('Floor 1 release sweep throwing-knife-25 cornered-retreat regression', () => {
  it('clears the reported forced-throwing-knife seed with deterministic paired reruns', async () => {
    const first = await runThrowingKnife25();
    const second = await runThrowingKnife25();

    expect(first.startingWeapon).toBe('throwing-knife');
    expect(first.outcome).toBe('victory');
    expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
    expect(deterministicStats(second)).toEqual(deterministicStats(first));
  }, 200_000);
});
