/**
 * reward-opening-audio — engine-layer glue that turns the reward-opening
 * presentation state into procedurally synthesized `AudioCueEngine` playback,
 * via the pure decision logic in `src/shared/reward-audio-cues.ts`.
 *
 * Ownership/cancellation model: each `RewardOpeningUI.open()` call starts a
 * fresh "session" (a `RewardAudioSessionState`, reset on
 * `onVisibilityChange(true)`). Both `onSkip` and `onVisibilityChange(false)`
 * call `engine.stopAll()` BEFORE playing their own cue, so:
 * - A skip mid-reveal always cuts off any still-ringing per-item reveal cue
 *   before playing its own whoosh — no overlap.
 * - Closing (acknowledge, or a scene teardown that calls `destroy()`) always
 *   silences everything in flight before the closing cue, so a duplicate
 *   acknowledge/close, or a scene transition while a cue is mid-flight, can
 *   never leak audio into whatever opens next.
 * - Opening ALSO defensively calls `stopAll()` first, in case a prior
 *   session's cleanup was somehow skipped, so a fresh open never inherits a
 *   stale ringing voice from a previous reward.
 *
 * Skip-vs-summary interplay (adversarial plan review finding): an earlier
 * design relied on `handleSkip()`'s `render()`-driven
 * `phaseChanged('summary')` and this module's `skipped()` (`stopAll()`)
 * running in the same synchronous JS call, so `stopAll()`'s graceful release
 * would cancel the just-scheduled summary voice's gain envelope before its
 * attack ramp ever had a chance to run. That was correct in practice — but
 * reviewers correctly flagged it as a fragile, non-obvious proof (it depends
 * on `AudioContext.currentTime` not advancing mid-callstack) rather than an
 * architectural guarantee. `RewardOpeningUI.handleSkip()` now instead calls
 * `render({ suppressPhaseChangeHook: true })`, so `onPhaseChange` — and thus
 * this module's `phaseChanged()` and the `reward:summary` cue — is NEVER
 * invoked for a skip-caused `summary` transition; `onSkip` is the sole audio
 * signal for that transition, and it still defensively `stopAll()`s first in
 * case some OTHER cue (a reveal/escalation cue from just before the skip
 * press) is mid-flight. `reward:summary` therefore never appears in the cue
 * log for a skipped session at all — a stronger, simpler guarantee than
 * "scheduled but provably silent".
 *
 * Reduced-intensity mixing reuses the same `reducedMotion` flag
 * `RewardOpeningUI.open()` already receives (from `prefersReducedMotion()`)
 * rather than inventing a second, audio-only setting — cues are shortened
 * and quieted, never muted, mirroring the shortened reduced-motion visual
 * timing. It is SNAPSHOTTED once per `open()` (mirroring
 * `RewardOpeningUI.open()`'s own `reducedMotion` snapshot into
 * `createRewardOpeningState`) rather than re-read live per cue — a session's
 * mix must not flip mid-sequence if the OS-level setting changes while the
 * overlay is already open (plan review finding).
 *
 * Reduced-motion reveal density (adversarial plan review finding): under
 * reduced motion, `RewardOpeningUI.tick()` can reveal every remaining item in
 * a single call. Firing one `itemRevealed()` per item in that batch would
 * stack N simultaneous reveal (+ escalation) cues — audibly the OPPOSITE of
 * "reduced intensity" even though each individual cue is quieter/shorter. So
 * `RewardOpeningUI` coalesces any same-tick reduced-motion batch of more
 * than one item into a SINGLE `onItemRevealed` call carrying the batch's
 * highest rarity weight, and this module's `itemRevealed()` sees exactly one
 * event for that batch (still correctly advancing the escalation
 * peak-rarity tracker). Non-reduced motion always reveals one item per
 * tick, so this never changes cue density outside reduced motion.
 */
import type { RewardExcitement } from '../shared/reward-presentation.js';
import type { RewardOpeningPhase } from '../shared/reward-opening-sequence.js';
import {
  createRewardAudioSessionState,
  cueForClose,
  cueForPhaseChange,
  cueForSkip,
  onItemRevealed as reduceItemRevealed,
  type RewardAudioCue,
  type RewardAudioSessionState,
} from '../shared/reward-audio-cues.js';
import type { AudioCueEngine, SynthCueSpec } from './audio/audio-cue-engine.js';

/** Reduced-intensity durations/gains are scaled by these shared factors — quieter and shorter, never silent. */
const REDUCED_DURATION_SCALE = 0.45;
const REDUCED_GAIN_SCALE = 0.65;

/**
 * Pure mapping from a decided cue to concrete oscillator/gain synth
 * parameters. Exported for direct unit testing without any `AudioContext`.
 */
export function synthSpecForCue(cue: RewardAudioCue): SynthCueSpec {
  const scale = cue.reducedIntensity
    ? { duration: REDUCED_DURATION_SCALE, gain: REDUCED_GAIN_SCALE }
    : { duration: 1, gain: 1 };
  const intensity = cue.intensity;

  switch (cue.kind) {
    case 'anticipation':
      return {
        waveform: 'sine',
        frequencyHz: 220 + intensity * 90,
        glideToHz: 260 + intensity * 140,
        durationMs: 280 * scale.duration,
        gain: (0.12 + intensity * 0.15) * scale.gain,
        label: 'reward:anticipation',
      };
    case 'reveal':
      return {
        waveform: 'triangle',
        frequencyHz: 440 + intensity * 260,
        durationMs: 140 * scale.duration,
        gain: (0.1 + intensity * 0.18) * scale.gain,
        label: 'reward:reveal',
      };
    case 'escalation':
      return {
        waveform: 'square',
        frequencyHz: 660 + intensity * 320,
        glideToHz: 880 + intensity * 400,
        durationMs: 220 * scale.duration,
        gain: (0.14 + intensity * 0.2) * scale.gain,
        label: 'reward:escalation',
      };
    case 'summary':
      return {
        waveform: 'sine',
        frequencyHz: 330 + intensity * 220,
        glideToHz: 440 + intensity * 320,
        durationMs: 420 * scale.duration,
        gain: (0.16 + intensity * 0.22) * scale.gain,
        label: 'reward:summary',
      };
    case 'skip':
      return {
        waveform: 'sawtooth',
        frequencyHz: 520 + intensity * 140,
        glideToHz: 200,
        durationMs: 180 * scale.duration,
        gain: (0.1 + intensity * 0.12) * scale.gain,
        label: 'reward:skip',
      };
    case 'close':
      return {
        waveform: 'sine',
        frequencyHz: 300,
        glideToHz: 180,
        durationMs: 160 * scale.duration,
        gain: 0.1 * scale.gain,
        label: 'reward:close',
      };
  }
}

/** Per-item data the caller supplies to {@link RewardOpeningAudioController.itemRevealed}. */
export interface RewardAudioItemContext {
  readonly index: number;
  readonly total: number;
  /** 0..1 rarity weight (e.g. `equipmentRarityWeight(rarity)`), or `null` when the item has no discrete rarity axis. */
  readonly rarityWeight: number | null;
}

export interface RewardOpeningAudioController {
  /** Start a fresh session for a newly-opened reward. Cancels any stale leftover voices first. */
  open(): void;
  /** Fired only on an ACTUAL phase transition — mirrors `RewardOpeningUIHooks.onPhaseChange`'s own guard. */
  phaseChanged(phase: RewardOpeningPhase): void;
  /** Fired once per item, in reveal order, ONLY from forward `tick()` progression (never from skip). */
  itemRevealed(item: RewardAudioItemContext): void;
  /** Fired for a skip/fast-forward input that actually advanced the sequence. Cuts off in-flight cues first. */
  skipped(): void;
  /** Fired on close (acknowledge or teardown). Cuts off in-flight cues first, then plays the close cue. */
  closed(): void;
}

/**
 * Creates a controller bound to one `AudioCueEngine` + a live `excitement`
 * getter (read fresh on every call, since `RewardOpeningUI` computes
 * excitement once per `open()` and never mutates it mid-sequence) and the
 * current `reducedMotion` getter, SNAPSHOTTED into the session at `open()`
 * time (see module doc comment). Safe no-audio fallback: every method is a
 * plain function call into `engine.play()`, which itself never throws when
 * unavailable — this controller adds no additional fallible state.
 */
export function createRewardOpeningAudioController(
  engine: AudioCueEngine,
  getExcitement: () => RewardExcitement,
  getReducedMotion: () => boolean,
): RewardOpeningAudioController {
  let session: RewardAudioSessionState = createRewardAudioSessionState();
  let reducedMotion = false;

  /**
   * Stagger applied to a second cue fired for the same event (currently:
   * `escalation` following `reveal`) so it reads as a distinct second beat
   * instead of a simultaneous chord that can mask the "things just got
   * better" moment (plan review finding). The reveal cue itself always
   * plays with zero delay.
   */
  const ESCALATION_STAGGER_MS = 90;

  function play(cue: RewardAudioCue | null, delayMs = 0): void {
    if (!cue) return;
    engine.play({ ...synthSpecForCue(cue), delayMs });
  }

  return {
    open(): void {
      // Defensive: guarantee no stale voice from a prior session survives
      // into this one, even if a previous close() was somehow skipped.
      engine.stopAll();
      session = createRewardAudioSessionState();
      reducedMotion = getReducedMotion();
    },
    phaseChanged(phase: RewardOpeningPhase): void {
      play(cueForPhaseChange(phase, getExcitement(), reducedMotion));
    },
    itemRevealed(item: RewardAudioItemContext): void {
      const result = reduceItemRevealed(session, item.rarityWeight, getExcitement(), reducedMotion);
      session = result.nextState;
      result.cues.forEach((cue, index) => {
        play(cue, index === 0 ? 0 : ESCALATION_STAGGER_MS);
      });
    },
    skipped(): void {
      engine.stopAll();
      play(cueForSkip(getExcitement(), reducedMotion));
    },
    closed(): void {
      engine.stopAll();
      play(cueForClose(reducedMotion));
    },
  };
}
