import { describe, expect, it } from 'vitest';
import {
  computeRevealCueIntensity,
  createRewardAudioSessionState,
  cueForClose,
  cueForPhaseChange,
  cueForSkip,
  onItemRevealed,
} from '../../src/shared/reward-audio-cues.js';
import type { RewardExcitement } from '../../src/shared/reward-presentation.js';

function excitement(score: number): RewardExcitement {
  return { tierWeight: score, rarityWeight: score, score, bucket: 'modest' };
}

describe('reward-audio-cues', () => {
  describe('computeRevealCueIntensity', () => {
    it('is monotonic non-decreasing in excitement.score', () => {
      const low = computeRevealCueIntensity(excitement(0), 0.5);
      const mid = computeRevealCueIntensity(excitement(0.5), 0.5);
      const high = computeRevealCueIntensity(excitement(1), 0.5);
      expect(low).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(high);
    });

    it('is monotonic non-decreasing in itemRarityWeight', () => {
      const low = computeRevealCueIntensity(excitement(0.5), 0);
      const mid = computeRevealCueIntensity(excitement(0.5), 0.5);
      const high = computeRevealCueIntensity(excitement(0.5), 1);
      expect(low).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(high);
    });

    it('never returns a fully silent (0) intensity, even at modest excitement/rarity', () => {
      expect(computeRevealCueIntensity(excitement(0), 0)).toBeGreaterThan(0);
    });

    it('treats a null rarityWeight (no discrete rarity axis) as excitement-only', () => {
      const withNull = computeRevealCueIntensity(excitement(0.5), null);
      const withZero = computeRevealCueIntensity(excitement(0.5), 0);
      // null skips the rarity multiplier entirely, so it should be >= the zero-rarity case.
      expect(withNull).toBeGreaterThanOrEqual(withZero);
    });

    it('always stays within [0, 1]', () => {
      for (const score of [0, 0.25, 0.5, 0.75, 1]) {
        for (const rarity of [null, 0, 0.5, 1]) {
          const intensity = computeRevealCueIntensity(excitement(score), rarity);
          expect(intensity).toBeGreaterThanOrEqual(0);
          expect(intensity).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('onItemRevealed (escalation reducer)', () => {
    it('always includes a reveal cue', () => {
      const state = createRewardAudioSessionState();
      const result = onItemRevealed(state, 0.5, excitement(0.5), false);
      expect(result.cues.some((cue) => cue.kind === 'reveal')).toBe(true);
    });

    it('fires an escalation cue the first time an item sets a new running-max rarity', () => {
      const state = createRewardAudioSessionState();
      const result = onItemRevealed(state, 0.5, excitement(0.5), false);
      expect(result.cues.map((cue) => cue.kind)).toEqual(['reveal', 'escalation']);
      expect(result.nextState.runningMaxRarityWeight).toBe(0.5);
    });

    it('does NOT re-fire escalation for an equal-or-lower rarity item later in the same session', () => {
      let state = createRewardAudioSessionState();
      state = onItemRevealed(state, 0.5, excitement(0.5), false).nextState;
      const second = onItemRevealed(state, 0.5, excitement(0.5), false);
      expect(second.cues.map((cue) => cue.kind)).toEqual(['reveal']);
      const third = onItemRevealed(second.nextState, 0.2, excitement(0.5), false);
      expect(third.cues.map((cue) => cue.kind)).toEqual(['reveal']);
    });

    it('fires escalation again when a strictly higher rarity item appears later', () => {
      let state = createRewardAudioSessionState();
      state = onItemRevealed(state, 0.2, excitement(0.5), false).nextState;
      const escalated = onItemRevealed(state, 0.8, excitement(0.5), false);
      expect(escalated.cues.map((cue) => cue.kind)).toEqual(['reveal', 'escalation']);
      expect(escalated.nextState.runningMaxRarityWeight).toBe(0.8);
    });

    it('never escalates for a null rarityWeight item (no discrete rarity axis)', () => {
      const state = createRewardAudioSessionState();
      const result = onItemRevealed(state, null, excitement(0.9), false);
      expect(result.cues.map((cue) => cue.kind)).toEqual(['reveal']);
      expect(result.nextState.runningMaxRarityWeight).toBe(-1);
    });

    it('escalation intensity is >= the reveal intensity for the same item', () => {
      const state = createRewardAudioSessionState();
      const result = onItemRevealed(state, 0.9, excitement(0.9), false);
      const reveal = result.cues.find((cue) => cue.kind === 'reveal');
      const escalation = result.cues.find((cue) => cue.kind === 'escalation');
      expect(reveal).toBeDefined();
      expect(escalation).toBeDefined();
      expect(escalation!.intensity).toBeGreaterThanOrEqual(reveal!.intensity);
    });

    it('propagates reducedIntensity onto every emitted cue', () => {
      const state = createRewardAudioSessionState();
      const result = onItemRevealed(state, 0.9, excitement(0.9), true);
      for (const cue of result.cues) {
        expect(cue.reducedIntensity).toBe(true);
      }
    });
  });

  describe('cueForPhaseChange', () => {
    it('returns an anticipation cue for the anticipation phase', () => {
      const cue = cueForPhaseChange('anticipation', excitement(0.5), false);
      expect(cue?.kind).toBe('anticipation');
    });

    it('returns a summary cue for the summary phase', () => {
      const cue = cueForPhaseChange('summary', excitement(0.5), false);
      expect(cue?.kind).toBe('summary');
    });

    it('returns null for revealing (driven per-item instead)', () => {
      expect(cueForPhaseChange('revealing', excitement(0.5), false)).toBeNull();
    });

    it('returns null for claimed (the close cue covers every exit path)', () => {
      expect(cueForPhaseChange('claimed', excitement(0.5), false)).toBeNull();
    });

    it('summary intensity is monotonic non-decreasing in excitement.score', () => {
      const low = cueForPhaseChange('summary', excitement(0), false)!;
      const high = cueForPhaseChange('summary', excitement(1), false)!;
      expect(high.intensity).toBeGreaterThanOrEqual(low.intensity);
    });
  });

  describe('cueForSkip / cueForClose', () => {
    it('cueForSkip returns a skip cue scaled by excitement', () => {
      const low = cueForSkip(excitement(0), false);
      const high = cueForSkip(excitement(1), false);
      expect(low.kind).toBe('skip');
      expect(high.intensity).toBeGreaterThanOrEqual(low.intensity);
    });

    it('cueForClose returns a fixed close cue regardless of excitement, respecting reducedIntensity', () => {
      const normal = cueForClose(false);
      const reduced = cueForClose(true);
      expect(normal.kind).toBe('close');
      expect(reduced.kind).toBe('close');
      expect(normal.reducedIntensity).toBe(false);
      expect(reduced.reducedIntensity).toBe(true);
    });
  });
});
