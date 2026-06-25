/**
 * Unit tests for {@link computeFloorProgressScore} — the pure scoring function
 * behind the AI's quest-progress stall watchdog. The watchdog forces a
 * relocation when this score is frozen for ~100s, recovering from the
 * knockback/kite deadlock (seed 22 + baseball-bat) where the player jitters in
 * place landing no killing blows. The score must therefore (a) advance on any
 * real objective tick / completion / gold payout and (b) weight quest signal
 * far above gold so a shop purchase's one-frame gold dip still reads as forward
 * progress. These tests pin those invariants without constructing a full world.
 */
import { describe, it, expect } from 'vitest';
import { computeFloorProgressScore } from '../../src/game/ai/bt-ai-provider.js';
import type { QuestState } from '../../src/shared/quest-types.js';

function quest(partial: Partial<QuestState> = {}): QuestState {
  return {
    questId: partial.questId ?? 'q',
    status: partial.status ?? 'active',
    tracked: partial.tracked ?? false,
    progress: partial.progress ?? {},
    done: partial.done ?? {},
  };
}

describe('computeFloorProgressScore', () => {
  // Derive the per-quest weight from the function itself so these tests do not
  // hard-code the internal tuning constant: one accepted quest, zero gold.
  const WEIGHT = computeFloorProgressScore([quest()], 0);

  it('returns only gold when there are no quests', () => {
    expect(computeFloorProgressScore([], 0)).toBe(0);
    expect(computeFloorProgressScore([], 37)).toBe(37);
  });

  it('counts each accepted quest', () => {
    expect(computeFloorProgressScore([quest(), quest({ questId: 'q2' })], 0)).toBe(2 * WEIGHT);
  });

  it('adds a large completion bonus that dominates gold', () => {
    const active = computeFloorProgressScore([quest()], 0);
    const complete = computeFloorProgressScore([quest({ status: 'complete' })], 0);
    expect(complete - active).toBe(100 * WEIGHT);
  });

  it('sums counter-objective progress (kills, fetch pickups)', () => {
    const base = computeFloorProgressScore([quest()], 0);
    const withProgress = computeFloorProgressScore([quest({ progress: { rats: 3, coins: 2 } })], 0);
    expect(withProgress - base).toBe(5 * WEIGHT);
  });

  it('adds a latch bonus per true done flag and ignores false flags', () => {
    const base = computeFloorProgressScore([quest()], 0);
    const withDone = computeFloorProgressScore(
      [quest({ done: { talk: true, goal: true, pending: false } })],
      0,
    );
    expect(withDone - base).toBe(20 * WEIGHT);
  });

  it('weights gold below quest signal so a shop purchase still reads as progress', () => {
    // Before: ready-to-buy, holding 50 gold, the fetch objective not yet latched.
    const before = computeFloorProgressScore([quest({ done: { fetch: false } })], 50);
    // After: bought the item — the fetch objective latches (+1 done) and gold drops.
    const after = computeFloorProgressScore([quest({ done: { fetch: true } })], 20);
    expect(after).toBeGreaterThan(before);
  });

  it('lets gold re-anchor a stage where quest counters are static', () => {
    const poorer = computeFloorProgressScore([quest()], 4);
    const richer = computeFloorProgressScore([quest()], 11);
    expect(richer).toBeGreaterThan(poorer);
  });

  it('is order-independent and deterministic', () => {
    const q1 = quest({ questId: 'a', progress: { x: 2 } });
    const q2 = quest({ questId: 'b', status: 'complete', done: { d: true } });
    const s1 = computeFloorProgressScore([q1, q2], 9);
    const s2 = computeFloorProgressScore([q2, q1], 9);
    expect(s1).toBe(s2);
    // Re-running with identical inputs yields an identical score (no hidden state).
    expect(computeFloorProgressScore([q1, q2], 9)).toBe(s1);
  });

  it('strictly increases as objectives advance (monotonic progress signal)', () => {
    const stages = [
      computeFloorProgressScore([quest()], 0),
      computeFloorProgressScore([quest({ progress: { rats: 1 } })], 0),
      computeFloorProgressScore([quest({ progress: { rats: 2 } })], 0),
      computeFloorProgressScore([quest({ progress: { rats: 2 }, done: { talk: true } })], 0),
      computeFloorProgressScore(
        [quest({ status: 'complete', progress: { rats: 2 }, done: { talk: true } })],
        0,
      ),
    ];
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i]!).toBeGreaterThan(stages[i - 1]!);
    }
  });
});
