/**
 * reward-audio-cues — pure, deterministic mapping from the reward-opening
 * presentation state (`reward-opening-sequence.ts` phases + per-item rarity +
 * `reward-presentation.ts` excitement) to a sequence of audio "cue" events.
 *
 * This module NEVER touches Web Audio, the DOM, `Date.now()`, or
 * `Math.random()` — it is pure data-in/data-out so the engine-layer synth
 * (`src/engine/audio/audio-cue-engine.ts`) can stay a thin, swappable
 * renderer of these cues, and so ordering/intensity/escalation behavior is
 * 100% unit-testable in Node without any browser/audio environment.
 *
 * Six cue kinds cover the hard UX contract: `anticipation` (box opens),
 * `reveal` (each item shown), `escalation` (a NEW running-max rarity is
 * reached mid-reveal), `summary` (all items shown), `skip` (fast-forward
 * input), and `close` (overlay dismissed). Intensity always derives from
 * `RewardExcitement` (tier + actual granted rarity) so audio excitement
 * scales exactly like the visual glow styling in `RewardOpeningUI.ts` — the
 * same signal, never a second guessed scale.
 */
import type { RewardExcitement } from './reward-presentation.js';
import type { RewardOpeningPhase } from './reward-opening-sequence.js';

export const REWARD_AUDIO_CUE_KINDS = [
  'anticipation',
  'reveal',
  'escalation',
  'summary',
  'skip',
  'close',
] as const;
export type RewardAudioCueKind = (typeof REWARD_AUDIO_CUE_KINDS)[number];

export interface RewardAudioCue {
  readonly kind: RewardAudioCueKind;
  /** 0..1 excitement-driven intensity for this specific cue instance. */
  readonly intensity: number;
  /**
   * Mirrors the caller's `prefersReducedMotion()`/reduced-intensity signal —
   * the engine-layer synth uses this to shorten/quiet (never mute) the cue,
   * matching the reduced-motion visual timing instead of inventing a
   * separate audio-only setting.
   */
  readonly reducedIntensity: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 0..1 intensity for a single item-reveal cue. Monotonic non-decreasing in
 * BOTH `excitement.score` (box tier + reward-level rarity axis) and the
 * specific item's own `rarityWeight` (0..1, `null` when the item has no
 * discrete rarity axis — e.g. a lootBox's gold/material beats) — this is the
 * testable cash-out of "excitement scales with both box tier and actual item
 * rarity, consistent with the visual UX" bucket scoring in
 * `reward-presentation.ts`. Never fully silent, even for a `modest` bucket,
 * so every reveal still has an audible beat.
 */
export function computeRevealCueIntensity(
  excitement: RewardExcitement,
  itemRarityWeight: number | null,
): number {
  const base = 0.35 + 0.65 * clamp01(excitement.score);
  if (itemRarityWeight === null) {
    return clamp01(base);
  }
  return clamp01(base * (0.6 + 0.4 * clamp01(itemRarityWeight)));
}

/** Per-open() session bookkeeping for the escalation reducer below. */
export interface RewardAudioSessionState {
  /** Highest item `rarityWeight` revealed so far this session; `-1` = none yet. */
  readonly runningMaxRarityWeight: number;
}

export function createRewardAudioSessionState(): RewardAudioSessionState {
  return { runningMaxRarityWeight: -1 };
}

export interface RewardItemRevealResult {
  readonly nextState: RewardAudioSessionState;
  /** Always contains a `reveal` cue; additionally an `escalation` cue when this item set a new running-max rarity. */
  readonly cues: readonly RewardAudioCue[];
}

/**
 * Pure reducer: given the just-revealed item's `rarityWeight` (or `null` for
 * an item with no discrete rarity axis) and this reward's `excitement`,
 * returns the `reveal` cue (always) plus an `escalation` cue IFF this item's
 * rarity weight is a strictly NEW running-max within THIS open() session —
 * i.e. the escalation sting fires only the first time an item at least this
 * rare has been shown in the current reveal, giving a genuine "things just
 * got better" moment instead of restating the same sting on every later item
 * of equal-or-lower rarity. Call once per item, in reveal order, only from
 * the state machine's own forward `tick()` progression — never from a
 * skip/fast-forward jump, which should use {@link cueForSkip} instead.
 */
export function onItemRevealed(
  state: RewardAudioSessionState,
  itemRarityWeight: number | null,
  excitement: RewardExcitement,
  reducedIntensity: boolean,
): RewardItemRevealResult {
  const intensity = computeRevealCueIntensity(excitement, itemRarityWeight);
  const cues: RewardAudioCue[] = [{ kind: 'reveal', intensity, reducedIntensity }];

  let nextRunningMax = state.runningMaxRarityWeight;
  if (itemRarityWeight !== null && itemRarityWeight > state.runningMaxRarityWeight) {
    nextRunningMax = itemRarityWeight;
    cues.push({ kind: 'escalation', intensity: clamp01(intensity + 0.2), reducedIntensity });
  }
  return { nextState: { runningMaxRarityWeight: nextRunningMax }, cues };
}

/**
 * Cue for an actual phase transition (fired only when the phase truly
 * changes — mirrors `RewardOpeningUI`'s own `onPhaseChange` guard). Returns
 * `null` for `revealing` (driven per-item by {@link onItemRevealed} instead)
 * and `claimed` (no distinct cue; the overlay's `close` cue below covers the
 * exit beat for every closing path, acknowledged or otherwise).
 */
export function cueForPhaseChange(
  phase: RewardOpeningPhase,
  excitement: RewardExcitement,
  reducedIntensity: boolean,
): RewardAudioCue | null {
  switch (phase) {
    case 'anticipation':
      return {
        kind: 'anticipation',
        intensity: clamp01(0.3 + 0.4 * excitement.score),
        reducedIntensity,
      };
    case 'summary':
      return {
        kind: 'summary',
        intensity: clamp01(0.5 + 0.5 * excitement.score),
        reducedIntensity,
      };
    case 'revealing':
    case 'claimed':
      return null;
    default:
      return null;
  }
}

/**
 * Cue for a skip/fast-forward input that actually advanced the sequence
 * (never fire this for a no-op duplicate skip once already at/past
 * `summary` — the caller guards that the same way `RewardOpeningUI` already
 * guards its own `onPhaseChange`).
 */
export function cueForSkip(
  excitement: RewardExcitement,
  reducedIntensity: boolean,
): RewardAudioCue {
  return { kind: 'skip', intensity: clamp01(0.4 + 0.3 * excitement.score), reducedIntensity };
}

/** Cue for the overlay closing — fired for every close path (ack, skip-to-close, teardown). */
export function cueForClose(reducedIntensity: boolean): RewardAudioCue {
  return { kind: 'close', intensity: 0.3, reducedIntensity };
}
