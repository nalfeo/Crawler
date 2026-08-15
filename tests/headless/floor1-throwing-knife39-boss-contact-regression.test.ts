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

async function runThrowingKnife39(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 39 }), {
    seed: 39,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: 90_000,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
  });
}

// Release sweep regression (#2991): the Floor 1 stair boss (`slime-rat` /
// `ratSlime`) is configured with attackRange=280 so its acid-projectile
// ability can fire from long range, in addition to normal melee contact
// damage once it closes in. Retreat's ranged-shooter bail-out
// (`attackRange > retreatEscapeRadius`) fired on that stat alone, with no
// check on the threat's CURRENT distance — so once the boss had actually
// closed to melee contact, Retreat still deferred to Engage's boss-room
// kite, which could not create separation fast enough (HP 20% -> 8% -> 0%
// in about half a second). Fixed by only bailing out of Retreat while the
// threat is still outside melee/contact distance (CONTACT_SAFE_ORBIT_FT).
describe('Floor 1 release sweep throwing-knife-39 boss-contact regression', () => {
  it('clears the reported forced-throwing-knife seed with deterministic paired reruns', async () => {
    const first = await runThrowingKnife39();
    const second = await runThrowingKnife39();

    expect(first.startingWeapon).toBe('throwing-knife');
    expect(first.outcome).toBe('victory');
    expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
    expect(deterministicStats(second)).toEqual(deterministicStats(first));
  }, 120_000);
});
