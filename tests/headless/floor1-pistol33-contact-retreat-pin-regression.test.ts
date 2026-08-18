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

async function runPistol33(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 33 }), {
    seed: 33,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: 90_000,
    forceWeaponId: 'pistol',
    enemyDamageMultiplier: 1,
  });
}

// Release sweep regression (#2994): PR #2992 narrowed Retreat's ranged-shooter
// bail-out so a long-`attackRange` boss that has closed to contact no longer
// hands the fight to Engage. That is right only while the retreat can create
// separation. On seed 33 with a forced pistol the runner was cornered in the
// boss room: `pickRetreatTarget` ran out of A*-reachable escape tiles and fell
// back to a raw away-vector into geometry, so the AI stood frozen on one tile
// for ~250 frames (pathLen 0, netDisp 0) while contact damage took it from
// 110 HP to 12 HP, and it died shortly after. Fixed by releasing the contact
// carve-out once it has provably failed to move the player.
describe('Floor 1 release sweep pistol-33 contact-retreat pin regression', () => {
  it('clears the reported forced-pistol seed with deterministic paired reruns', async () => {
    const first = await runPistol33();
    const second = await runPistol33();

    expect(first.startingWeapon).toBe('pistol');
    expect(first.outcome).toBe('victory');
    expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
    expect(deterministicStats(second)).toEqual(deterministicStats(first));
  }, 200_000);
});
