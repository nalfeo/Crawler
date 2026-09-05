/**
 * Shared constants for the Floor 4 seed-404 completion contract (C1–C8 in
 * `.specify/specs/floor4-playable-completion.md`).
 *
 * Both halves of the contract — the headless gate
 * (`tests/headless/floor4-arena-completion.test.ts`) and the visual gate
 * (`tests/e2e/floor4-ai-completion.deterministic.test.ts`) — import from here
 * rather than each declaring their own copy: the spec requires the two gates to
 * assert the same criteria, and a duplicated literal edited in only one file
 * would silently loosen the other.
 */
import { getFloorManifest } from '../../src/shared/floor-registry.js';

/** The five authored Floor 4 acts, in order. */
export const FLOOR4_ACTS = [1, 2, 3, 4, 5];

/**
 * C3's bound: the manifest-authored wave count per act
 * (`floor4.waves.cadence.wavesPerAct`), read from the shipped manifest rather
 * than hard-coded. Each act builds its own wave-window manifests array of
 * exactly this length and starts its release cursor at 0
 * (`armFloor4WaveWindow` in `src/game/floor4Scenario.ts`), so a single act can
 * never release more than this many waves.
 *
 * `FLOOR4_ACTS.length * FLOOR4_WAVES_PER_ACT` is therefore a real full-release
 * ceiling: reaching it requires every act to release every one of its waves,
 * so an earlier act cannot satisfy it alone the way the cumulative
 * `wavesReleased` counter could.
 */
const FLOOR4_WAVES_PER_ACT: number = (() => {
  const wavesPerAct = getFloorManifest('floor4')?.floor4?.waves.cadence.wavesPerAct;
  if (typeof wavesPerAct !== 'number' || wavesPerAct <= 0) {
    throw new Error(
      'floor4 manifest has no positive waves.cadence.wavesPerAct — the Floor 4 wave-release ceiling (C3) cannot be asserted',
    );
  }
  return wavesPerAct;
})();

/** The full-release ceiling: every act releasing every one of its waves. */
export const FLOOR4_TOTAL_WAVES_RELEASED: number = FLOOR4_ACTS.length * FLOOR4_WAVES_PER_ACT;

/**
 * C8's bound: the real Floor 4 stall backstop (FR8.4). `floor4ObjectiveTick`
 * flips the run to `game_over` with the `floor4-stall-backstop` goal flag once
 * raw `world.elapsedMs` reaches the manifest timer, so this is read from the
 * shipped manifest — retuning the backstop retunes both gates with it.
 *
 * Throws at import time rather than defaulting: a silent `0` would turn the
 * "terminated under the backstop" assertion into an always-failing comparison
 * with a confusing message, far from the real cause.
 */
export const FLOOR4_STALL_BACKSTOP_MS: number = (() => {
  const durationMs = getFloorManifest('floor4')?.timer?.durationMs;
  if (typeof durationMs !== 'number' || durationMs <= 0) {
    throw new Error(
      'floor4 manifest has no positive timer.durationMs — the Floor 4 stall backstop (C8) cannot be asserted',
    );
  }
  return durationMs;
})();

/**
 * C5's public-interaction reasons: these are recorded only by
 * `confirmFloor4StairDescend`, the same scenario authority invoked by the real
 * MainGameScene confirmation modal and the headless runner's scenario exit
 * bridge. The old slice-2 timer reasons must never reappear in completion
 * gates.
 */
export const FLOOR4_PUBLIC_INTERMISSION_EXIT_REASONS = ['public-green-room-exit', 'public-stairs'];
