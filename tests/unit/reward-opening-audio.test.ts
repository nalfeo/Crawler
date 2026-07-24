import { describe, expect, it } from 'vitest';
import {
  createRewardOpeningAudioController,
  synthSpecForCue,
} from '../../src/engine/reward-opening-audio.js';
import type { AudioCueEngine, SynthCueSpec } from '../../src/engine/audio/audio-cue-engine.js';
import type { RewardAudioCue, RewardAudioCueKind } from '../../src/shared/reward-audio-cues.js';
import type { RewardExcitement } from '../../src/shared/reward-presentation.js';

function cue(
  kind: RewardAudioCueKind,
  intensity: number,
  reducedIntensity = false,
): RewardAudioCue {
  return { kind, intensity, reducedIntensity };
}

function excitement(score: number): RewardExcitement {
  return { tierWeight: score, rarityWeight: score, score, bucket: 'modest' };
}

const ALL_KINDS: readonly RewardAudioCueKind[] = [
  'anticipation',
  'reveal',
  'escalation',
  'summary',
  'skip',
  'close',
];

describe('synthSpecForCue', () => {
  it('produces a valid SynthCueSpec for every cue kind', () => {
    for (const kind of ALL_KINDS) {
      const spec = synthSpecForCue(cue(kind, 0.5));
      expect(spec.durationMs).toBeGreaterThan(0);
      expect(spec.gain).toBeGreaterThan(0);
      expect(spec.gain).toBeLessThanOrEqual(1);
      expect(spec.frequencyHz).toBeGreaterThan(0);
      expect(spec.label).toContain('reward:');
    }
  });

  it('scales duration and gain down (never to zero) under reducedIntensity, for every kind', () => {
    for (const kind of ALL_KINDS) {
      const normal = synthSpecForCue(cue(kind, 0.8, false));
      const reduced = synthSpecForCue(cue(kind, 0.8, true));
      expect(reduced.durationMs).toBeLessThan(normal.durationMs);
      expect(reduced.durationMs).toBeGreaterThan(0);
      expect(reduced.gain).toBeLessThan(normal.gain);
      expect(reduced.gain).toBeGreaterThan(0);
    }
  });

  it('higher intensity yields a louder (or equal) gain for intensity-scaled kinds', () => {
    for (const kind of ['anticipation', 'reveal', 'escalation', 'summary'] as const) {
      const low = synthSpecForCue(cue(kind, 0));
      const high = synthSpecForCue(cue(kind, 1));
      expect(high.gain).toBeGreaterThanOrEqual(low.gain);
    }
  });
});

function createFakeEngine(): AudioCueEngine & { calls: string[]; specs: SynthCueSpec[] } {
  const calls: string[] = [];
  const specs: SynthCueSpec[] = [];
  return {
    calls,
    specs,
    isAvailable: () => true,
    play: (spec: SynthCueSpec) => {
      calls.push(`play:${spec.label}`);
      specs.push(spec);
    },
    stopAll: () => {
      calls.push('stopAll');
    },
    dispose: () => {
      calls.push('dispose');
    },
  };
}

describe('createRewardOpeningAudioController', () => {
  it('open() defensively calls stopAll() before starting a fresh session', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    expect(engine.calls).toEqual(['stopAll']);
  });

  it('phaseChanged(anticipation) and phaseChanged(summary) play a cue; revealing/claimed play nothing', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    controller.phaseChanged('anticipation');
    controller.phaseChanged('revealing');
    controller.phaseChanged('summary');
    controller.phaseChanged('claimed');
    expect(engine.calls).toEqual(['stopAll', 'play:reward:anticipation', 'play:reward:summary']);
  });

  it('itemRevealed() plays a reveal cue, and an escalation cue on a new running-max rarity', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    controller.itemRevealed({ index: 0, total: 2, rarityWeight: 0.5 });
    controller.itemRevealed({ index: 1, total: 2, rarityWeight: 0.2 });
    expect(engine.calls).toEqual([
      'stopAll',
      'play:reward:reveal',
      'play:reward:escalation',
      'play:reward:reveal',
    ]);
  });

  it('skipped() cuts off in-flight voices (stopAll) BEFORE playing its own cue', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    controller.itemRevealed({ index: 0, total: 3, rarityWeight: 0.5 });
    controller.skipped();
    const stopAllIndex = engine.calls.lastIndexOf('stopAll');
    const skipPlayIndex = engine.calls.indexOf('play:reward:skip');
    expect(skipPlayIndex).toBeGreaterThan(stopAllIndex);
  });

  it('closed() cuts off in-flight voices (stopAll) BEFORE playing the close cue', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    controller.itemRevealed({ index: 0, total: 1, rarityWeight: 0.9 });
    controller.closed();
    const stopAllIndex = engine.calls.lastIndexOf('stopAll');
    const closePlayIndex = engine.calls.indexOf('play:reward:close');
    expect(closePlayIndex).toBeGreaterThan(stopAllIndex);
  });

  it('a duplicate close() call is safe and cannot leak/overlap audio (stopAll every time)', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    controller.closed();
    controller.closed();
    const stopAllCount = engine.calls.filter((call) => call === 'stopAll').length;
    expect(stopAllCount).toBe(3); // open() + 2x closed()
  });

  it('a fresh open() after a skip resets escalation state (no stale running-max carries over)', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    controller.itemRevealed({ index: 0, total: 1, rarityWeight: 0.9 });
    controller.skipped();
    controller.open();
    engine.calls.length = 0;
    // A low-rarity item after a fresh open() must escalate again (running-max reset to -1).
    controller.itemRevealed({ index: 0, total: 1, rarityWeight: 0.1 });
    expect(engine.calls).toEqual(['play:reward:reveal', 'play:reward:escalation']);
  });

  it('snapshots getReducedMotion() once at open() — a runtime toggle mid-session does not affect already-open cues', () => {
    const engine = createFakeEngine();
    let reducedMotion = false;
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => reducedMotion,
    );
    controller.open();
    controller.itemRevealed({ index: 0, total: 2, rarityWeight: null });
    const normalDuration = engine.specs[0]!.durationMs;
    // Flip the OS-level setting mid-session — must NOT affect this session's
    // mix (matches RewardOpeningUI's own reducedMotion snapshot-at-open()
    // semantics; plan review finding).
    reducedMotion = true;
    controller.itemRevealed({ index: 1, total: 2, rarityWeight: null });
    const stillNormalDuration = engine.specs[1]!.durationMs;
    expect(stillNormalDuration).toBe(normalDuration);

    // A fresh open() picks up the new value.
    controller.open();
    engine.specs.length = 0;
    controller.itemRevealed({ index: 0, total: 1, rarityWeight: null });
    expect(engine.specs[0]!.durationMs).toBeLessThan(normalDuration);
  });

  it('itemRevealed() staggers an escalation cue after its reveal cue (zero delay for reveal)', () => {
    const engine = createFakeEngine();
    const controller = createRewardOpeningAudioController(
      engine,
      () => excitement(0.5),
      () => false,
    );
    controller.open();
    controller.itemRevealed({ index: 0, total: 1, rarityWeight: 0.9 });
    expect(engine.specs).toHaveLength(2);
    expect(engine.specs[0]!.label).toBe('reward:reveal');
    expect(engine.specs[0]!.delayMs).toBe(0);
    expect(engine.specs[1]!.label).toBe('reward:escalation');
    expect(engine.specs[1]!.delayMs).toBeGreaterThan(0);
  });
});
