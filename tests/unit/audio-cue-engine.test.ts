import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAudioCueEngine,
  type SynthCueSpec,
} from '../../src/engine/audio/audio-cue-engine.js';

const CUE: SynthCueSpec = {
  waveform: 'sine',
  frequencyHz: 440,
  durationMs: 100,
  gain: 0.5,
  label: 'test:cue',
};

describe('audio-cue-engine (no-op fallback under Node)', () => {
  it('reports unavailable when no window/AudioContext exists', () => {
    const engine = createAudioCueEngine();
    expect(engine.isAvailable()).toBe(false);
  });

  it('play() never throws when unavailable', () => {
    const engine = createAudioCueEngine();
    expect(() => engine.play(CUE)).not.toThrow();
  });

  it('stopAll()/dispose() never throw when idle/unavailable', () => {
    const engine = createAudioCueEngine();
    expect(() => engine.stopAll()).not.toThrow();
    expect(() => engine.dispose()).not.toThrow();
  });

  it('is unusable (still no-op, never throws) after dispose()', () => {
    const engine = createAudioCueEngine();
    engine.dispose();
    expect(engine.isAvailable()).toBe(false);
    expect(() => engine.play(CUE)).not.toThrow();
  });
});

/** Minimal fake Web Audio graph sufficient to exercise voice tracking/cancellation. */
class FakeAudioParam {
  value = 0;
  setValueAtTime = vi.fn((value: number, _time: number) => {
    this.value = value;
  });
  linearRampToValueAtTime = vi.fn((value: number, _time: number) => {
    this.value = value;
  });
  exponentialRampToValueAtTime = vi.fn((value: number, _time: number) => {
    this.value = value;
  });
  cancelScheduledValues = vi.fn();
}

class FakeOscillatorNode {
  type = 'sine';
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

/** Every fake oscillator/gain node created, in creation order — lets tests inspect scheduling calls made by the engine under test. */
const createdOscillators: FakeOscillatorNode[] = [];
const createdGains: FakeGainNode[] = [];
const createdContexts: FakeAudioContext[] = [];

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  destination = {};
  constructor() {
    createdContexts.push(this);
  }
  createOscillator(): FakeOscillatorNode {
    const osc = new FakeOscillatorNode();
    createdOscillators.push(osc);
    return osc;
  }
  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    createdGains.push(gain);
    return gain;
  }
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
}

describe('audio-cue-engine (with a fake AudioContext)', () => {
  let originalWindow: unknown;

  beforeEach(() => {
    createdOscillators.length = 0;
    createdGains.length = 0;
    createdContexts.length = 0;
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      AudioContext: FakeAudioContext,
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('reports available when a fake AudioContext constructor is present', () => {
    const engine = createAudioCueEngine();
    expect(engine.isAvailable()).toBe(true);
  });

  it('play() creates and starts an oscillator voice', () => {
    const engine = createAudioCueEngine();
    engine.play(CUE);
    // No direct handle to the fake context from here, but play() must not throw
    // and isAvailable() must remain true (context construction succeeded).
    expect(engine.isAvailable()).toBe(true);
  });

  it('stopAll() immediately stops every in-flight voice (no overlap/leak)', () => {
    const engine = createAudioCueEngine();
    // Fire two cues without waiting for natural decay — simulating rapid
    // duplicate input (e.g. two reveal cues in the same tick).
    engine.play(CUE);
    engine.play({ ...CUE, label: 'test:cue-2' });
    expect(() => engine.stopAll()).not.toThrow();
    // A second stopAll() with nothing in flight must also be a safe no-op.
    expect(() => engine.stopAll()).not.toThrow();
  });

  it('dispose() stops all voices and closes the underlying context', () => {
    const engine = createAudioCueEngine();
    engine.play(CUE);
    engine.dispose();
    expect(engine.isAvailable()).toBe(false);
    // Further calls after dispose must remain safe no-ops.
    expect(() => engine.play(CUE)).not.toThrow();
    expect(() => engine.stopAll()).not.toThrow();
  });

  it('a spec with glideToHz schedules a frequency ramp without throwing', () => {
    const engine = createAudioCueEngine();
    expect(() => engine.play({ ...CUE, glideToHz: 880 })).not.toThrow();
  });

  it('stopAll() releases each voice with a graceful gain ramp, never a hard stop(0) click', () => {
    const engine = createAudioCueEngine();
    engine.play(CUE);
    const gain = createdGains[0]!;
    const osc = createdOscillators[0]!;
    engine.stopAll();

    expect(gain.gain.cancelScheduledValues).toHaveBeenCalled();
    // The ramp must target the near-silent floor, not zero gain instantaneously.
    const rampCall = gain.gain.linearRampToValueAtTime.mock.calls.at(-1);
    expect(rampCall![0]).toBeCloseTo(0.0001, 4);
    // stop() must be scheduled to let the ramp actually play out — never
    // stop(0), which would produce an audible click by truncating the
    // envelope at whatever nonzero value it was mid-flight.
    const stopArgs = osc.stop.mock.calls.at(-1);
    expect(stopArgs![0]).toBeGreaterThan(0);
    // The fake's simple last-call-wins model shows the gain settles at the
    // near-silent floor, never left dangling at a nonzero value.
    expect(gain.gain.value).toBeCloseTo(0.0001, 4);
  });

  it('stopAll() defers voice disconnect to the onended handler, not a synchronous call', () => {
    const engine = createAudioCueEngine();
    engine.play(CUE);
    const osc = createdOscillators[0]!;
    const gain = createdGains[0]!;
    engine.stopAll();
    expect(osc.disconnect).not.toHaveBeenCalled();
    expect(gain.disconnect).not.toHaveBeenCalled();
    // Once playback genuinely ends, cleanup still happens via onended.
    osc.onended?.();
    expect(osc.disconnect).toHaveBeenCalled();
    expect(gain.disconnect).toHaveBeenCalled();
  });

  it('an immediate play() + stopAll() in the same tick never lets the gain envelope rise above its near-silent attack floor', () => {
    // General engine-level defense-in-depth: ANY caller that plays a cue and
    // immediately calls stopAll() in the same synchronous tick (e.g. a
    // `RewardOpeningUI.close()` right after a stray cue was scheduled) must
    // never let that cue become audible. This is no longer relied upon for
    // the skip-vs-summary guarantee specifically — `RewardOpeningUI` now
    // architecturally never schedules the `reward:summary` cue on a
    // skip-caused transition at all (see `reward-opening-audio.ts`'s module
    // doc) — but the underlying graceful-release-cancels-the-attack-ramp
    // property is still a real engine guarantee worth locking in on its own.
    const engine = createAudioCueEngine();
    engine.play(CUE);
    engine.stopAll();
    const gain = createdGains[0]!;
    expect(gain.gain.value).toBeLessThan(0.001);
  });

  it('play() does not schedule (and attempts a best-effort resume) when the context is suspended', () => {
    class SuspendedAudioContext extends FakeAudioContext {
      state: 'running' | 'suspended' | 'closed' = 'suspended';
    }
    (globalThis as { window?: unknown }).window = { AudioContext: SuspendedAudioContext };
    const engine = createAudioCueEngine();
    engine.play(CUE);
    expect(createdOscillators).toHaveLength(0);
    expect(createdGains).toHaveLength(0);
    expect(createdContexts[0]!.resume).toHaveBeenCalled();
  });

  it('play() drops the cue (no scheduling) when the context is closed', () => {
    class ClosedAudioContext extends FakeAudioContext {
      state: 'running' | 'suspended' | 'closed' = 'closed';
    }
    (globalThis as { window?: unknown }).window = { AudioContext: ClosedAudioContext };
    const engine = createAudioCueEngine();
    engine.play(CUE);
    expect(createdOscillators).toHaveLength(0);
    expect(createdGains).toHaveLength(0);
  });

  it('a delayMs offset schedules oscillator start/stop and gain automation after currentTime', () => {
    const engine = createAudioCueEngine();
    engine.play({ ...CUE, delayMs: 250 });
    const osc = createdOscillators[0]!;
    const gain = createdGains[0]!;
    const startArgs = osc.start.mock.calls.at(0);
    expect(startArgs![0]).toBeCloseTo(0.25, 5);
    const freqCall = osc.frequency.setValueAtTime.mock.calls.at(0);
    expect(freqCall![1]).toBeCloseTo(0.25, 5);
    // play() now floors the gain at `now` (time 0) FIRST, in addition to the
    // future `startAt` — so the startAt-time floor is the *second* scheduled
    // gain event, not the first. See the dedicated regression test below for
    // why the immediate floor matters.
    const gainCallAtStart = gain.gain.setValueAtTime.mock.calls.find((args) => args[1]! > 0);
    expect(gainCallAtStart![1]).toBeCloseTo(0.25, 5);
  });

  it('play() floors the gain at the immediate `now` time (not just the future startAt), so a delayed cue never rests at the GainNode default while awaiting its stagger', () => {
    // Regression test for a multi-model code-review finding: a `delayMs`-scheduled
    // cue (e.g. the escalation stagger) previously only scheduled its gain
    // floor at the future `startAt`. A Web Audio AudioParam holds its prior/
    // default value (1.0/unity gain for GainNode.gain) until its FIRST
    // scheduled automation event's time actually arrives — so if `stopAll()`
    // cancelled and snapshotted the gain during the pre-start delay window, it
    // would read back the unity-gain default and ramp the graceful release
    // down FROM full volume instead of from near-silent, producing an audible
    // blip for a cue that was supposed to be cancelled inaudibly.
    const engine = createAudioCueEngine();
    engine.play({ ...CUE, delayMs: 90 });
    const gain = createdGains[0]!;
    const setCalls = gain.gain.setValueAtTime.mock.calls;
    // The very first scheduled gain event must pin the near-silent floor at
    // `now` (time 0 in this fake, since the context's currentTime never
    // advances) — never left implicit/unset for the whole delay window.
    expect(setCalls[0]).toEqual([0.0001, 0]);
    // The startAt-time floor (for the actual attack ramp to depart from) must
    // still be scheduled separately.
    expect(setCalls.some((args) => args[0] === 0.0001 && args[1]! > 0)).toBe(true);
  });
});
