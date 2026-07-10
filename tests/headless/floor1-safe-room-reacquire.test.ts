import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../src/shared/quest-types.js';
import { GAME } from '../../src/shared/constants.js';
import type { RunStats } from '../../src/game/ai/types.js';

const SAFE_ROOM_REACQUIRE_CASES = [
  { seed: 1, weapon: 'pistol' },
  { seed: 1, weapon: 'throwing-knife' },
  { seed: 1, weapon: 'fireball' },
] as const;

const MAX_FRAMES = 24_000;

async function runSafeRoomReacquire(seed: number, weapon: string): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    forceWeaponId: weapon,
    floorId: 'floor1',
    maxFrames: MAX_FRAMES,
  });
}

describe('Floor 1 safe-room tutorial objective reacquisition', () => {
  for (const { seed, weapon } of SAFE_ROOM_REACQUIRE_CASES) {
    describe(`seed ${seed} · ${weapon}`, () => {
      let stats: RunStats;

      beforeAll(async () => {
        stats = await runSafeRoomReacquire(seed, weapon);
      });

      it('does not freeze on floor1-tutorial progression', () => {
        expect(stats.outcome).not.toBe('stalled');
        expect(
          stats.stallReason ?? '',
          `unexpected stall for seed=${seed}, weapon=${weapon}: ${stats.stallReason ?? '(none)'}`,
        ).not.toContain('floor1-tutorial');
      });

      it('completes tutorial progression and gains real XP', () => {
        expect(stats.quests.questLogCompletions[FLOOR1_TUTORIAL_QUEST_ID]).toBeTypeOf('number');
        expect(stats.finalLevel).toBeGreaterThanOrEqual(1);
        expect(stats.totalXp).toBeGreaterThan(0);
      });

      it('accrues a positive, frame-aligned safe-room deadline-pause credit', () => {
        // safeRoomMs is the wall of floor-collapse time the deadline was paused
        // while the agent rested in a safe room. The headless runner increments
        // one frame of dwell under the exact same `world.playerInSafeRoom`
        // condition (and on the same frame) that extends the collapse deadline,
        // then emits `safeRoomFrames * GAME.DELTA_MS` — so frame-alignment with
        // the deadline pause holds BY CONSTRUCTION (RunStats exposes no deadline
        // for an independent cross-check). These reacquire cases route the
        // tutorial through the safe room, so the credit must be a POSITIVE whole
        // number of frames. This guards the runner's counter against an
        // always-zero regression (which pure-helper tests can't catch) and
        // against a wall-clock-derived value (which would not be frame-aligned).
        // NB: assert frame-integer alignment, NOT `safeRoomMs % DELTA_MS === 0`
        // — DELTA_MS (1000/60) is a non-terminating float, so the modulo is
        // never exactly 0.
        const frames = Math.round(stats.safeRoomMs / GAME.DELTA_MS);
        expect(frames).toBeGreaterThan(0);
        expect(stats.safeRoomMs).toBeCloseTo(frames * GAME.DELTA_MS, 6);
        expect(stats.safeRoomMs).toBeLessThanOrEqual(stats.gameTimeMs);
      });
    });
  }
});
