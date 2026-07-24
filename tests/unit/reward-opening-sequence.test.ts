import { describe, expect, it } from 'vitest';
import {
  acknowledge,
  createRewardOpeningState,
  DEFAULT_ANTICIPATION_MS,
  DEFAULT_PER_ITEM_REVEAL_MS,
  isRewardOpeningComplete,
  REDUCED_MOTION_ANTICIPATION_MS,
  REDUCED_MOTION_REVEAL_MS,
  revealProgress,
  skip,
  tick,
} from '../../src/shared/reward-opening-sequence.js';

describe('reward-opening-sequence (pure phase reducer)', () => {
  it('starts in anticipation with zero revealed items', () => {
    const state = createRewardOpeningState(3);
    expect(state.phase).toBe('anticipation');
    expect(state.itemCount).toBe(3);
    expect(state.revealedCount).toBe(0);
    expect(state.elapsedInPhaseMs).toBe(0);
    expect(revealProgress(state)).toBe(0);
  });

  it('floors and clamps a non-finite/non-positive item count to at least 1', () => {
    expect(createRewardOpeningState(0).itemCount).toBe(1);
    expect(createRewardOpeningState(-5).itemCount).toBe(1);
    expect(createRewardOpeningState(2.9).itemCount).toBe(2);
    expect(createRewardOpeningState(Number.NaN).itemCount).toBe(1);
  });

  it('advances anticipation -> revealing -> summary -> claimed in strict order, never skipping a phase', () => {
    let state = createRewardOpeningState(2);
    const phasesSeen: string[] = [state.phase];

    // Anticipation: not yet elapsed.
    state = tick(state, DEFAULT_ANTICIPATION_MS - 1);
    expect(state.phase).toBe('anticipation');

    // Crosses into revealing.
    state = tick(state, 1);
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('revealing');
    expect(state.revealedCount).toBe(0);

    // First item reveals.
    state = tick(state, DEFAULT_PER_ITEM_REVEAL_MS);
    expect(state.phase).toBe('revealing');
    expect(state.revealedCount).toBe(1);

    // Second (final) item reveals -> summary.
    state = tick(state, DEFAULT_PER_ITEM_REVEAL_MS);
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('summary');
    expect(state.revealedCount).toBe(2);
    expect(revealProgress(state)).toBe(1);

    // Summary never advances by time alone.
    const beforeAck = state;
    state = tick(state, 10_000);
    expect(state).toBe(beforeAck);

    state = acknowledge(state);
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('claimed');
    expect(isRewardOpeningComplete(state)).toBe(true);

    expect(phasesSeen).toEqual(['anticipation', 'revealing', 'summary', 'claimed']);
  });

  it('reveals items one at a time, never jumping ahead of elapsed time', () => {
    let state = createRewardOpeningState(3);
    state = tick(state, DEFAULT_ANTICIPATION_MS);
    expect(state.phase).toBe('revealing');
    expect(state.revealedCount).toBe(0);

    state = tick(state, DEFAULT_PER_ITEM_REVEAL_MS - 1);
    expect(state.revealedCount).toBe(0);

    state = tick(state, 1);
    expect(state.revealedCount).toBe(1);
  });

  it('skip() jumps straight to summary with every item revealed, from any earlier phase', () => {
    const fromAnticipation = skip(createRewardOpeningState(4));
    expect(fromAnticipation.phase).toBe('summary');
    expect(fromAnticipation.revealedCount).toBe(4);

    let midReveal = tick(createRewardOpeningState(4), DEFAULT_ANTICIPATION_MS);
    midReveal = tick(midReveal, DEFAULT_PER_ITEM_REVEAL_MS);
    expect(midReveal.revealedCount).toBe(1);
    const skipped = skip(midReveal);
    expect(skipped.phase).toBe('summary');
    expect(skipped.revealedCount).toBe(4);
  });

  it('skip() is a no-op once already at summary/claimed (duplicate skip input is safe)', () => {
    const summary = skip(createRewardOpeningState(2));
    const skippedAgain = skip(summary);
    expect(skippedAgain).toBe(summary);

    const claimed = acknowledge(summary);
    const skippedAfterClaim = skip(claimed);
    expect(skippedAfterClaim).toBe(claimed);
  });

  it('acknowledge() is only valid from summary and is idempotent everywhere else (duplicate claim input is safe)', () => {
    const anticipating = createRewardOpeningState(1);
    expect(acknowledge(anticipating)).toBe(anticipating);

    const revealing = tick(anticipating, DEFAULT_ANTICIPATION_MS);
    expect(acknowledge(revealing)).toBe(revealing);

    const summary = skip(anticipating);
    const claimed = acknowledge(summary);
    expect(claimed.phase).toBe('claimed');

    // Duplicate acknowledge after already claimed is a no-op.
    const claimedAgain = acknowledge(claimed);
    expect(claimedAgain).toBe(claimed);
  });

  it('reduced motion visits every phase (never skips summary) but collapses timing to near-instant', () => {
    let state = createRewardOpeningState(5, { reducedMotion: true });
    expect(state.config.anticipationMs).toBe(REDUCED_MOTION_ANTICIPATION_MS);
    expect(state.config.perItemRevealMs).toBe(REDUCED_MOTION_REVEAL_MS);

    state = tick(state, REDUCED_MOTION_ANTICIPATION_MS);
    expect(state.phase).toBe('revealing');
    // All items reveal together on entry to `revealing` under reduced motion.
    expect(state.revealedCount).toBe(5);

    state = tick(state, 1);
    expect(state.phase).toBe('summary');

    const claimed = acknowledge(state);
    expect(claimed.phase).toBe('claimed');
  });

  it('does not mutate its input state (every transition returns a new object)', () => {
    const initial = createRewardOpeningState(2);
    const afterTick = tick(initial, 10);
    expect(initial.elapsedInPhaseMs).toBe(0);
    expect(afterTick).not.toBe(initial);

    const afterSkip = skip(initial);
    expect(initial.phase).toBe('anticipation');
    expect(afterSkip).not.toBe(initial);
  });

  it('revealProgress reports 0..1 fraction of items revealed', () => {
    let state = createRewardOpeningState(4);
    expect(revealProgress(state)).toBe(0);
    state = tick(state, DEFAULT_ANTICIPATION_MS);
    state = tick(state, DEFAULT_PER_ITEM_REVEAL_MS);
    expect(revealProgress(state)).toBe(0.25);
    state = skip(state);
    expect(revealProgress(state)).toBe(1);
  });

  it('ignores non-positive/non-finite tick deltas as no-ops', () => {
    const state = createRewardOpeningState(2);
    expect(tick(state, 0)).toBe(state);
    expect(tick(state, -50)).toBe(state);
    expect(tick(state, Number.NaN)).toBe(state);
  });
});
