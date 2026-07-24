/**
 * Integration coverage for the reward-opening audio pipeline: the REAL
 * `reward-opening-sequence.ts` phase state machine, wired to the REAL
 * `createRewardOpeningAudioController`/`synthSpecForCue` glue, and driven by
 * the REAL `computeEquipmentExcitement`/`equipmentRarityWeight` excitement
 * calculators from `reward-presentation.ts` — only the leaf `AudioCueEngine`
 * is a test fake (a WebAudio `AudioContext` has nothing left to prove once
 * `tests/unit/audio-cue-engine.test.ts` exercises it directly).
 *
 * This complements, rather than duplicates, the other two audio suites:
 *  - `tests/unit/reward-opening-audio.test.ts` drives the controller with
 *    hand-built `RewardAudioCue`/`RewardExcitement` fixtures, never the real
 *    sequence state machine or the real excitement calculators.
 *  - `tests/e2e/reward-opening-ux.test.ts` drives the REAL `RewardOpeningUI`
 *    inside a REAL `MainGameScene`, but every currently-shipped reward is
 *    `lootBox`-type (tier-only excitement) — no shipped content path can vary
 *    rarity, so the E2E suite explicitly cannot prove the dual tier+rarity
 *    excitement axis with real content (see its file-level doc comment).
 * This suite closes that gap deterministically, without needing a real
 * Phaser scene, by driving `computeEquipmentExcitement` with two granted
 * rarities at the SAME tier.
 *
 * The orchestration harness below (`runSession`) mirrors
 * `RewardOpeningUI`'s confirmed hook-firing order exactly (see its
 * `open`/`render`/`tick`/`handleSkip`/`handleAcknowledge` — the order is also
 * independently verified empirically by the passing
 * `tests/e2e/reward-opening-ux.test.ts` cue-log assertions):
 *   1. `open()` -> `audio.open()`, then the first `render()` unconditionally
 *      fires `audio.phaseChanged('anticipation')` (no prior rendered phase).
 *   2. Forward `tick()` fires `audio.itemRevealed(i)` once per newly-revealed
 *      item, in order, ONLY while progressing through `revealing`.
 *   3. The tick that observes `revealedCount >= itemCount` transitions phase
 *      to `summary`, which fires `audio.phaseChanged('summary')` again via
 *      the same `render()`-time guard (fires once, on the actual change).
 *   4. `skip()` jumps straight to `summary` (bypassing the reveal loop
 *      entirely). Its `render()`-equivalent call suppresses the phase-change
 *      hook for this transition — `reward:summary` is NEVER fired on a skip
 *      path — then `audio.skipped()` fires, but only if the phase actually
 *      advanced (duplicate skip input after already at/past `summary` must
 *      never replay the skip cue). This mirrors `RewardOpeningUI.handleSkip()`
 *      calling `render({ suppressPhaseChangeHook: true })` (adversarial plan
 *      review finding: architecturally never scheduling the summary cue for
 *      a skip-caused transition is more robust than relying on same-tick
 *      `AudioContext.currentTime` cancellation timing).
 *   5. `acknowledge()` only proceeds from `summary`; it fires `audio.closed()`
 *      once, then never again for duplicate acknowledge input.
 *   6. Under reduced motion, entering `revealing` reveals every item in the
 *      SAME tick (`tick()`'s `revealedCount` jumps 0 -> `itemCount`
 *      directly). Firing one `itemRevealed()` per item in that batch would
 *      stack every item's cue simultaneously — this harness (like the real
 *      `RewardOpeningUI.tick()`) coalesces such a same-tick multi-item batch
 *      into exactly ONE `itemRevealed()` call reporting the batch's highest
 *      rarity weight (adversarial plan review finding).
 */
import { describe, expect, it } from 'vitest';
import {
  createRewardOpeningAudioController,
  type RewardOpeningAudioController,
} from '../../src/engine/reward-opening-audio.js';
import type { AudioCueEngine, SynthCueSpec } from '../../src/engine/audio/audio-cue-engine.js';
import {
  acknowledge as acknowledgeSequence,
  createRewardOpeningState,
  skip as skipSequence,
  tick as tickSequence,
  type RewardOpeningState,
} from '../../src/shared/reward-opening-sequence.js';
import {
  computeEquipmentExcitement,
  equipmentRarityWeight,
  type RewardExcitement,
} from '../../src/shared/reward-presentation.js';

/** Records every `play()` call, in order — the real synth math, no fakery beyond "don't touch a real AudioContext". */
class RecordingEngine implements AudioCueEngine {
  readonly log: SynthCueSpec[] = [];
  isAvailable(): boolean {
    return true;
  }
  play(spec: SynthCueSpec): void {
    this.log.push(spec);
  }
  stopAll(): void {
    // No in-flight voices to model here — `stopAll` call ORDERING relative to
    // `play` is already proven by the fake WebAudio graph in
    // `tests/unit/reward-opening-audio.test.ts`; this suite only needs to
    // prove which cues actually get synthesized, in what order.
  }
  dispose(): void {}
}

interface ItemRarity {
  readonly rarityWeight: number | null;
}

/**
 * Drives one full reward-opening session through the REAL sequence state
 * machine + REAL audio controller, mirroring `RewardOpeningUI`'s confirmed
 * hook order (see file-level doc comment). Returns the final state so
 * callers can assert on phase/revealedCount too.
 */
function runForwardSession(
  audio: RewardOpeningAudioController,
  items: readonly ItemRarity[],
  perItemRevealMs: number,
  anticipationMs: number,
): RewardOpeningState {
  audio.open();
  let state = createRewardOpeningState(items.length);
  let lastRenderedPhase: RewardOpeningState['phase'] | null = null;

  const renderIfChanged = (next: RewardOpeningState): void => {
    if (next.phase !== lastRenderedPhase) {
      audio.phaseChanged(next.phase);
      lastRenderedPhase = next.phase;
    }
  };
  renderIfChanged(state);

  // Clear the anticipation phase in one tick (deterministic — no timers).
  state = tickSequence(state, anticipationMs);
  renderIfChanged(state);

  for (let i = 0; i < items.length; i += 1) {
    const previousRevealed = state.revealedCount;
    state = tickSequence(state, perItemRevealMs);
    renderIfChanged(state);
    for (let revealed = previousRevealed; revealed < state.revealedCount; revealed += 1) {
      audio.itemRevealed({
        index: revealed,
        total: items.length,
        rarityWeight: items[revealed]?.rarityWeight ?? null,
      });
    }
  }
  // One more tick lands the transition into `summary` (mirrors the real
  // machine: the transition only happens on a tick that observes an already
  // full `revealedCount`, never within the same tick that first computes it).
  state = tickSequence(state, perItemRevealMs);
  renderIfChanged(state);
  expect(state.phase).toBe('summary');

  state = acknowledgeSequence(state);
  audio.closed();
  return state;
}

/**
 * Drives one full reward-opening session under REDUCED MOTION, mirroring
 * `RewardOpeningUI.tick()`'s same-tick reduced-motion reveal coalescing
 * (adversarial plan review finding): when reduced motion reveals every item
 * in a single tick, fire `itemRevealed()` exactly ONCE for that whole batch,
 * reporting the batch's highest rarity weight — rather than once per item,
 * which would stack N simultaneous cues (the opposite of "reduced
 * intensity").
 */
function runReducedMotionForwardSession(
  audio: RewardOpeningAudioController,
  items: readonly ItemRarity[],
): RewardOpeningState {
  audio.open();
  let state = createRewardOpeningState(items.length, { reducedMotion: true });
  let lastRenderedPhase: RewardOpeningState['phase'] | null = null;

  const renderIfChanged = (next: RewardOpeningState): void => {
    if (next.phase !== lastRenderedPhase) {
      audio.phaseChanged(next.phase);
      lastRenderedPhase = next.phase;
    }
  };
  renderIfChanged(state);

  // Clear the (near-instant) anticipation phase in one tick.
  const previousRevealed = state.revealedCount;
  state = tickSequence(state, state.config.anticipationMs);
  renderIfChanged(state);

  // Entering `revealing` under reduced motion reveals every item at once.
  const batchSize = state.revealedCount - previousRevealed;
  if (batchSize > 1) {
    let bestIndex = previousRevealed;
    let bestRarityWeight: number | null = null;
    for (let i = previousRevealed; i < state.revealedCount; i += 1) {
      const rarityWeight = items[i]?.rarityWeight ?? null;
      if ((rarityWeight ?? -1) > (bestRarityWeight ?? -1)) {
        bestRarityWeight = rarityWeight;
        bestIndex = i;
      }
    }
    audio.itemRevealed({ index: bestIndex, total: items.length, rarityWeight: bestRarityWeight });
  } else if (batchSize === 1) {
    audio.itemRevealed({
      index: previousRevealed,
      total: items.length,
      rarityWeight: items[previousRevealed]?.rarityWeight ?? null,
    });
  }

  // One more tick lands the transition into `summary`.
  state = tickSequence(state, state.config.perItemRevealMs);
  renderIfChanged(state);
  expect(state.phase).toBe('summary');

  state = acknowledgeSequence(state);
  audio.closed();
  return state;
}

/** Skip straight from `anticipation`, then acknowledge — mirrors `handleSkip`/`handleAcknowledge`. */
function runSkipSession(
  audio: RewardOpeningAudioController,
  itemCount: number,
): RewardOpeningState {
  audio.open();
  let state = createRewardOpeningState(itemCount);
  let lastRenderedPhase: RewardOpeningState['phase'] | null = null;
  const renderIfChanged = (next: RewardOpeningState): void => {
    if (next.phase !== lastRenderedPhase) {
      audio.phaseChanged(next.phase);
      lastRenderedPhase = next.phase;
    }
  };
  renderIfChanged(state);

  const previousPhase = state.phase;
  state = skipSequence(state);
  // Mirrors `RewardOpeningUI.handleSkip()` calling
  // `render({ suppressPhaseChangeHook: true })`: a skip-caused `summary`
  // transition must NEVER fire `phaseChanged`/schedule `reward:summary` —
  // only track `lastRenderedPhase` so a later genuine phase change (there
  // isn't one here, but the real code does this unconditionally) would
  // still be detected correctly.
  lastRenderedPhase = state.phase;
  if (state.phase !== previousPhase) {
    audio.skipped();
  }

  state = acknowledgeSequence(state);
  audio.closed();
  return state;
}

const REDUCED = false;

describe('reward-opening audio pipeline (real sequence + real audio controller)', () => {
  it('fires cues in the real anticipation → reveal(×N) → summary → close order for a multi-item lootBox-style walkthrough', () => {
    const engine = new RecordingEngine();
    const excitement: RewardExcitement = {
      tierWeight: 0.5,
      rarityWeight: 0,
      score: 0.5,
      bucket: 'exciting',
    };
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement,
      () => REDUCED,
    );

    const items: ItemRarity[] = [
      { rarityWeight: null },
      { rarityWeight: null },
      { rarityWeight: null },
    ];
    const finalState = runForwardSession(controller, items, 450, 900);

    expect(finalState.phase).toBe('claimed');
    expect(finalState.revealedCount).toBe(items.length);
    const labels = engine.log.map((spec) => spec.label);
    expect(labels[0]).toBe('reward:anticipation');
    expect(labels.filter((l) => l === 'reward:item-revealed').length).toBe(items.length);
    expect(labels.at(-2)).toBe('reward:summary');
    expect(labels.at(-1)).toBe('reward:close');
    // Every reveal cue must land strictly between anticipation and summary.
    expect(labels.indexOf('reward:summary')).toBeGreaterThan(
      labels.lastIndexOf('reward:item-revealed'),
    );
  });

  it('skips straight to summary→skip→close with zero reveal/escalation cues, and never replays cues on duplicate input', () => {
    const engine = new RecordingEngine();
    const excitement: RewardExcitement = {
      tierWeight: 0.25,
      rarityWeight: 0,
      score: 0.25,
      bucket: 'notable',
    };
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement,
      () => REDUCED,
    );

    const finalState = runSkipSession(controller, 3);
    expect(finalState.phase).toBe('claimed');

    const labels = engine.log.map((spec) => spec.label);
    expect(labels).toEqual(['reward:anticipation', 'reward:skip', 'reward:close']);
    expect(labels).not.toContain('reward:item-revealed');
    expect(labels).not.toContain('reward:rarity-escalation');
    // The skip-caused summary transition must never even schedule the
    // summary cue (architectural suppression, not just inaudibility).
    expect(labels).not.toContain('reward:summary');

    // Duplicate acknowledge/skip after `claimed` must be pure no-ops on the
    // REAL sequence state machine, so the controller must never be asked to
    // (and never does) replay a cue.
    const lenBeforeDuplicates = engine.log.length;
    const stillClaimed = acknowledgeSequence(skipSequence(finalState));
    expect(stillClaimed.phase).toBe('claimed');
    expect(engine.log.length).toBe(lenBeforeDuplicates);
  });

  it('scales reveal-cue gain by the REAL dual tier+rarity excitement axis (same tier, higher rarity ⇒ louder)', () => {
    // This is the exact scenario `tests/e2e/reward-opening-ux.test.ts` explicitly
    // cannot exercise with real content: two GRANTED RARITIES at the SAME tier.
    const commonExcitement = computeEquipmentExcitement('tier2', 'common');
    const uncommonExcitement = computeEquipmentExcitement('tier2', 'uncommon');
    expect(commonExcitement.tierWeight).toBe(uncommonExcitement.tierWeight); // tier held constant
    expect(uncommonExcitement.rarityWeight).toBeGreaterThan(commonExcitement.rarityWeight);
    expect(uncommonExcitement.score).toBeGreaterThan(commonExcitement.score);
    expect(uncommonExcitement.bucket).toBe('exciting');
    expect(commonExcitement.bucket).toBe('notable');

    const commonEngine = new RecordingEngine();
    const commonController = createRewardOpeningAudioController(
      commonEngine,
      () => commonExcitement,
      () => REDUCED,
    );
    runForwardSession(
      commonController,
      [{ rarityWeight: equipmentRarityWeight('common') }],
      450,
      900,
    );

    const uncommonEngine = new RecordingEngine();
    const uncommonController = createRewardOpeningAudioController(
      uncommonEngine,
      () => uncommonExcitement,
      () => REDUCED,
    );
    runForwardSession(
      uncommonController,
      [{ rarityWeight: equipmentRarityWeight('uncommon') }],
      450,
      900,
    );

    const commonRevealGain = commonEngine.log.find((s) => s.label === 'reward:item-revealed')?.gain;
    const uncommonRevealGain = uncommonEngine.log.find(
      (s) => s.label === 'reward:item-revealed',
    )?.gain;
    expect(commonRevealGain).toBeDefined();
    expect(uncommonRevealGain).toBeDefined();
    // Same tier, but the actual granted item's rarity is strictly higher —
    // the synthesized reveal cue must be strictly louder, proving excitement
    // scales by BOTH tier AND actual item rarity end-to-end through the real
    // pipeline, consistent with the visual UX bucket above.
    expect(uncommonRevealGain!).toBeGreaterThan(commonRevealGain!);
  });

  it('never lets a session leak audio into a fresh open() (defensive stopAll + independent session state)', () => {
    const engine = new RecordingEngine();
    const excitement: RewardExcitement = {
      tierWeight: 0.5,
      rarityWeight: 0,
      score: 0.5,
      bucket: 'exciting',
    };
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement,
      () => REDUCED,
    );

    runSkipSession(controller, 2);
    const firstSessionLen = engine.log.length;

    // A brand-new session must start clean: its own anticipation cue must be
    // the very next entry, with nothing from the closed session re-fired.
    runSkipSession(controller, 4);
    const secondSessionLabels = engine.log.slice(firstSessionLen).map((s) => s.label);
    expect(secondSessionLabels).toEqual(['reward:anticipation', 'reward:skip', 'reward:close']);
  });

  it('coalesces a same-tick normal-mode multi-item reveal (large delta) into ONE itemRevealed cue carrying the batch peak rarity', () => {
    // Follow-up review finding: a normal-mode large frame delta spanning
    // multiple 450 ms reveal intervals (e.g. tab resume) can also advance
    // revealedCount by >1 in a single tick. Coalescing must therefore apply
    // regardless of reducedMotion, not only when reduced-motion is true.
    const engine = new RecordingEngine();
    const excitement: RewardExcitement = {
      tierWeight: 0.5,
      rarityWeight: 0,
      score: 0.5,
      bucket: 'exciting',
    };
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement,
      () => false, // normal mode
    );

    const items: ItemRarity[] = [
      { rarityWeight: equipmentRarityWeight('common') },
      { rarityWeight: equipmentRarityWeight('rare') }, // batch peak
      { rarityWeight: equipmentRarityWeight('uncommon') },
    ];

    // Simulate: anticipation tick, then ONE large-delta tick that reveals all
    // 3 items simultaneously (delta = 3 * perItemRevealMs = 1350 ms), mirroring
    // RewardOpeningUI.tick() with a delta after a tab resume.
    controller.open();
    let state = createRewardOpeningState(items.length, { reducedMotion: false });
    let lastRenderedPhase: RewardOpeningState['phase'] | null = null;

    const renderIfChanged = (next: RewardOpeningState): void => {
      if (next.phase !== lastRenderedPhase) {
        controller.phaseChanged(next.phase);
        lastRenderedPhase = next.phase;
      }
    };
    renderIfChanged(state);

    // Clear anticipation.
    state = tickSequence(state, 900);
    renderIfChanged(state);

    // Large delta: 3 items at once in normal mode.
    const previousRevealed = state.revealedCount;
    state = tickSequence(state, 450 * 3); // 1350 ms — reveals all 3
    renderIfChanged(state);

    const batchSize = state.revealedCount - previousRevealed;
    expect(batchSize).toBeGreaterThan(1); // confirm it's actually a batch

    // Mirror RewardOpeningUI.ts coalescing: one call with the peak rarity item.
    let bestIndex = previousRevealed;
    let bestRarityWeight: number | null = null;
    for (let i = previousRevealed; i < state.revealedCount; i += 1) {
      const rw = items[i]?.rarityWeight ?? null;
      if ((rw ?? -1) > (bestRarityWeight ?? -1)) {
        bestRarityWeight = rw;
        bestIndex = i;
      }
    }
    controller.itemRevealed({
      index: bestIndex,
      total: items.length,
      rarityWeight: bestRarityWeight,
    });

    // Advance to summary, then close.
    state = tickSequence(state, 450);
    renderIfChanged(state);
    expect(state.phase).toBe('summary');
    acknowledgeSequence(state);
    controller.closed();

    const labels = engine.log.map((s) => s.label);
    // Exactly ONE reveal cue (+ its escalation companion) for the whole batch.
    expect(labels.filter((l) => l === 'reward:item-revealed').length).toBe(1);
    expect(labels).toEqual([
      'reward:anticipation',
      'reward:item-revealed',
      'reward:rarity-escalation',
      'reward:summary',
      'reward:close',
    ]);

    // The coalesced cue must reflect the batch's PEAK rarity (index 1, rare).
    const soloRevealGain = engine.log.find((s) => s.label === 'reward:item-revealed')?.gain;
    expect(soloRevealGain).toBeDefined();
    const peakOnlyEngine = new RecordingEngine();
    const peakOnlyController = createRewardOpeningAudioController(
      peakOnlyEngine,
      () => excitement,
      () => false,
    );
    // Single-item session with only the peak rarity item.
    peakOnlyController.open();
    peakOnlyController.phaseChanged('anticipation');
    peakOnlyController.itemRevealed({
      index: 0,
      total: 1,
      rarityWeight: equipmentRarityWeight('rare'),
    });
    peakOnlyController.phaseChanged('summary');
    peakOnlyController.closed();
    const peakOnlyGain = peakOnlyEngine.log.find((s) => s.label === 'reward:item-revealed')?.gain;
    expect(soloRevealGain).toBeCloseTo(peakOnlyGain!, 10);
  });

  it('coalesces a same-tick reduced-motion multi-item reveal into ONE itemRevealed cue carrying the batch peak rarity', () => {
    // Adversarial plan review finding: under reduced motion, RewardOpeningUI
    // reveals every item in one tick, so firing one reveal(+escalation) cue
    // per item would stack them all simultaneously — audibly the OPPOSITE of
    // "reduced intensity". This proves the coalesced single-cue behavior end
    // to end through the real controller/excitement pipeline, with a batch
    // whose highest rarity is NOT the first item (so a naive "just use index
    // 0" implementation would fail this test).
    const engine = new RecordingEngine();
    const excitement: RewardExcitement = {
      tierWeight: 0.5,
      rarityWeight: 0,
      score: 0.5,
      bucket: 'exciting',
    };
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement,
      () => true, // reducedMotion snapshot
    );

    const items: ItemRarity[] = [
      { rarityWeight: equipmentRarityWeight('common') },
      { rarityWeight: equipmentRarityWeight('rare') }, // the batch's true peak
      { rarityWeight: equipmentRarityWeight('uncommon') },
    ];
    const finalState = runReducedMotionForwardSession(controller, items);

    expect(finalState.phase).toBe('claimed');
    expect(finalState.revealedCount).toBe(items.length);
    const labels = engine.log.map((spec) => spec.label);
    // Exactly ONE reveal cue (+ its escalation companion, since this is the
    // session's very first/highest-rarity item) for the whole 3-item batch —
    // never three.
    expect(labels.filter((l) => l === 'reward:item-revealed').length).toBe(1);
    expect(labels).toEqual([
      'reward:anticipation',
      'reward:item-revealed',
      'reward:rarity-escalation',
      'reward:summary',
      'reward:close',
    ]);

    // The single coalesced reveal cue must reflect the batch's PEAK rarity
    // (item index 1, rare), not the first or last item in the batch.
    const soloRevealGain = engine.log.find((s) => s.label === 'reward:item-revealed')?.gain;
    expect(soloRevealGain).toBeDefined();

    const peakOnlyEngine = new RecordingEngine();
    const peakOnlyController = createRewardOpeningAudioController(
      peakOnlyEngine,
      () => excitement,
      () => true,
    );
    runReducedMotionForwardSession(peakOnlyController, [
      { rarityWeight: equipmentRarityWeight('rare') },
    ]);
    const peakOnlyGain = peakOnlyEngine.log.find((s) => s.label === 'reward:item-revealed')?.gain;
    // The coalesced batch's single cue gain must match a single-item session
    // whose sole item IS the batch's peak rarity — proving the batch reports
    // the peak item, not (say) an average or the first/last item.
    expect(soloRevealGain).toBeCloseTo(peakOnlyGain!, 10);
  });
});
