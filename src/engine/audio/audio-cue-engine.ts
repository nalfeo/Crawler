/**
 * audio-cue-engine — generic, reusable procedural WebAudio synth for short,
 * timed "cue" sounds (a percussive blip/chime/whoosh built purely from
 * oscillator waveforms + `GainNode` envelopes). No external audio files, no
 * copyrighted samples, no asset-generation pipeline, no Azure — every sound
 * is synthesized at playback time.
 *
 * Deliberately reward-opening-agnostic: any future UI slice needing short
 * synthesized stingers can construct its own `AudioCueEngine` and feed it
 * `SynthCueSpec`s without depending on reward-specific types. This is the
 * first audio infrastructure in the codebase — see
 * `docs/knowledge/adr/` for the pattern rationale.
 *
 * Safety:
 * - The underlying `AudioContext` is created lazily (first `play()` call)
 *   and only if the browser exposes it; every operation is wrapped so a
 *   missing/blocked context (headless test runner, autoplay policy, no audio
 *   hardware) degrades to a silent no-op and NEVER throws into the caller —
 *   gameplay must never break because audio failed.
 * - Every scheduled node is tracked in a live-voice set so `stopAll()` can
 *   immediately silence everything in flight — the cancellation primitive
 *   callers use to guarantee no overlap/leak across duplicate input or scene
 *   transitions. `stopAll()` releases each voice with a short gain ramp
 *   rather than an abrupt `stop(0)`, which would leave the gain node at a
 *   nonzero value and produce an audible click/pop every time a cue is cut
 *   short (plan review finding).
 * - `play()` never schedules against a `suspended` `AudioContext` — Web
 *   Audio's `currentTime` freezes while suspended, so a cue scheduled
 *   against it would silently queue and fire late (possibly out of order,
 *   in a burst) whenever an unrelated later user gesture resumes the
 *   context. The safe no-audio fallback contract means a cue offered while
 *   suspended is DROPPED, not deferred — `resume()` is still attempted
 *   best-effort for FUTURE cues (plan review finding).
 *
 * `AudioCueEngine` is engine-INSTANCE-scoped, not global: `stopAll()`/
 * `dispose()` only affect voices started through that one instance. One
 * logical audio "owner" (e.g. the reward-opening feature) should construct
 * and hold exactly one instance for its own lifetime; a future, unrelated
 * consumer should construct its own instance rather than sharing this one —
 * this module does not (yet) support multiplexing independently-scoped
 * `stopAll()` calls across unrelated consumers of a single shared instance.
 */

export interface SynthCueSpec {
  /** Oscillator waveform. */
  readonly waveform: OscillatorType;
  /** Base frequency in Hz. */
  readonly frequencyHz: number;
  /** Optional frequency glide target (Hz) — a short pitch ramp over the cue's duration. */
  readonly glideToHz?: number;
  /** Total cue duration in milliseconds. */
  readonly durationMs: number;
  /** 0..1 peak gain before the envelope's decay. */
  readonly gain: number;
  /** Human-readable label for logging/debugging only — never used for playback logic. */
  readonly label: string;
  /**
   * Optional scheduling offset in milliseconds — the cue starts this long
   * after the `play()` call instead of immediately. Used to stagger two
   * cues fired for the same event (e.g. reveal + escalation) so the second
   * reads as a distinct beat instead of a simultaneous chord that can mask
   * it. Never negative; defaults to 0 (immediate).
   */
  readonly delayMs?: number;
}

export interface AudioCueEngine {
  /** True if a usable `AudioContext` is available (feature-detected, not permanently blocked/disposed). */
  isAvailable(): boolean;
  /** Synthesize and play `spec`. No-op (never throws) if unavailable. */
  play(spec: SynthCueSpec): void;
  /** Immediately stop and disconnect every in-flight voice. Safe to call repeatedly/when idle. */
  stopAll(): void;
  /** Stop everything and release the underlying `AudioContext`. The engine is unusable after this. */
  dispose(): void;
}

type AudioContextCtor = new () => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

interface Voice {
  readonly osc: OscillatorNode;
  readonly gain: GainNode;
}

export function createAudioCueEngine(): AudioCueEngine {
  let ctx: AudioContext | null = null;
  let disposed = false;
  const activeVoices = new Set<Voice>();

  function ensureContext(): AudioContext | null {
    if (disposed) return null;
    if (ctx) return ctx;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function disconnectVoice(voice: Voice): void {
    try {
      voice.osc.disconnect();
      voice.gain.disconnect();
    } catch {
      // Already disconnected — safe to ignore.
    }
  }

  /** Short fade used to release a voice early without an audible click. */
  const GRACEFUL_RELEASE_SEC = 0.02;

  function clearAllVoices(): void {
    const now = ctx?.currentTime ?? 0;
    for (const voice of activeVoices) {
      try {
        // Ramp from wherever the envelope currently sits down to
        // near-silent, then stop the oscillator once the ramp completes —
        // never an abrupt `stop(0)`, which leaves the gain node at whatever
        // nonzero value it was mid-envelope and produces an audible
        // click/pop. `disconnectVoice()` is deferred to the existing
        // `onended` handler below rather than run synchronously here, so
        // the graceful release is allowed to actually play out.
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0.0001, now + GRACEFUL_RELEASE_SEC);
        voice.osc.stop(now + GRACEFUL_RELEASE_SEC);
      } catch {
        // Already stopped.
      }
    }
    activeVoices.clear();
  }

  return {
    isAvailable(): boolean {
      return !disposed && resolveAudioContextCtor() !== null;
    },
    play(spec: SynthCueSpec): void {
      if (disposed) return;
      const audioCtx = ensureContext();
      if (!audioCtx) return;
      if (audioCtx.state !== 'running') {
        // Never schedule against a non-running context: `currentTime`
        // freezes while suspended, so this cue would silently queue and
        // fire late (possibly out of order, in a burst) whenever an
        // unrelated later user gesture resumes it. The safe no-audio
        // fallback contract means DROP this cue, not defer it. Still
        // attempt a best-effort resume so a FUTURE cue can play normally.
        if (audioCtx.state === 'suspended') {
          void audioCtx.resume().catch(() => {
            // Autoplay-blocked contexts stay suspended; playback silently no-ops.
          });
        }
        return;
      }
      try {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.type = spec.waveform;
        const now = audioCtx.currentTime;
        const delaySec = Math.max(0, spec.delayMs ?? 0) / 1000;
        const startAt = now + delaySec;
        const durationSec = Math.max(0.01, spec.durationMs / 1000);
        osc.frequency.setValueAtTime(Math.max(1, spec.frequencyHz), startAt);
        if (spec.glideToHz !== undefined) {
          osc.frequency.linearRampToValueAtTime(Math.max(1, spec.glideToHz), startAt + durationSec);
        }
        const peakGain = Math.min(1, Math.max(0, spec.gain));
        // Pin the gain floor at `now` (the play() call time), not just at the
        // future `startAt`. A `delayMs`-scheduled cue (e.g. the escalation
        // stagger) would otherwise leave the AudioParam at its GainNode
        // default (1.0, i.e. full volume) for the entire delay window, since
        // an AudioParam holds its prior/default value until its FIRST
        // scheduled event executes. `clearAllVoices()` (stopAll()) snapshots
        // `gain.value` at cancellation time to ramp-release gracefully — if
        // that snapshot happens before `startAt`, it would read back the
        // unity-gain default and ramp the release down FROM full volume
        // instead of from near-silent, producing an audible blip for a cue
        // that was supposed to be cancelled inaudibly (code-review finding).
        // Explicitly flooring `now` guarantees the resting value is always
        // near-silent regardless of when a cancel lands.
        gainNode.gain.setValueAtTime(0.0001, now);
        if (startAt > now) {
          gainNode.gain.setValueAtTime(0.0001, startAt);
        }
        gainNode.gain.linearRampToValueAtTime(peakGain, startAt + Math.min(0.02, durationSec / 4));
        gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        const voice: Voice = { osc, gain: gainNode };
        activeVoices.add(voice);
        osc.onended = () => {
          activeVoices.delete(voice);
          disconnectVoice(voice);
        };
        osc.start(startAt);
        osc.stop(startAt + durationSec + 0.05);
      } catch {
        // Never let a synth failure break gameplay.
      }
    },
    stopAll(): void {
      clearAllVoices();
    },
    dispose(): void {
      if (disposed) return;
      clearAllVoices();
      disposed = true;
      const closingCtx = ctx;
      ctx = null;
      if (closingCtx) {
        void closingCtx.close().catch(() => {
          // Already closed/closing — safe to ignore.
        });
      }
    },
  };
}
