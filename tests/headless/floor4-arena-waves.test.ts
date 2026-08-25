import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { GAME } from '../../src/shared/constants.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';

/**
 * Floor 4 slice 3 — real-pipeline wave coverage (spec R3/R7).
 *
 * **Slice-3 deviation, deliberate:** slice 2 asserted an end-to-end idle-player
 * victory over the empty rehearsal arena. Slice 3 fills that arena with real
 * combat waves, so an idle contestant now (correctly) dies and a full five-act
 * clear depends on Headliners, Green Room economy and balance that land in
 * slices 4–7. Manufacturing a victory here — invulnerability, empty manifests,
 * a hand-picked seed — would weaken the gate to protect the assertion
 * (AGENTS.md rules #11/#12), so this test instead gates the part of the
 * contract slice 3 actually owns: waves really release into the shipped
 * headless pipeline, under the concurrency cap, identically across two runs of
 * a seed. The end-to-end clear returns with slice 7's win-rate gate.
 */
describe('Floor 4 arena waves (headless pipeline)', () => {
  const floor4 = getFloorManifest('floor4')!.floor4!;
  const waves = floor4.waves!;
  // Bounded: the countdown plus act 1's wave window, and nothing beyond it.
  const maxFrames = Math.ceil(
    (floor4.phase.countdownMs + floor4.phase.waveWindowMs) / GAME.DELTA_MS,
  );

  const run = () => runHeadless(new BehaviorTreeAI(), { floorId: 'floor4', seed: 404, maxFrames });

  it('releases act 1 waves deterministically and respects the concurrency cap', async () => {
    const first = await run();
    const second = await run();

    const stats = first.floor4Arena?.waves;
    expect(stats).toBeDefined();
    // Every wave whose release offset the arena clock passed must have fired
    // (spec FR3.1). Expressing it against the clock the run actually reached
    // keeps this a wave-scheduling gate rather than an accidental
    // "can the AI survive 90 seconds" gate, which slices 4-7 own.
    const arenaMs = Math.min(first.floor4Arena!.arenaElapsedMs, floor4.phase.waveWindowMs);
    const expectedReleases = Math.min(
      waves.wavesPerAct,
      Math.floor(arenaMs / waves.waveIntervalMs) + 1,
    );
    expect(expectedReleases).toBeGreaterThan(0);
    expect(stats!.wavesReleased).toBe(expectedReleases);
    expect(stats!.enemiesScheduled).toBeGreaterThan(0);
    expect(stats!.gateTelegraphsFired).toBeGreaterThanOrEqual(expectedReleases);
    // The real pipeline samples the live hostile peak exposed by RunStats, so
    // this gates the actual concurrency cap rather than only aggregate totals.
    expect(stats!.peakLiveHostiles).toBeGreaterThan(0);
    expect(stats!.peakLiveHostiles).toBeLessThanOrEqual(waves.concurrencyCap);
    // Spawns can be deferred but never exceed what the manifests scheduled.
    expect(stats!.enemiesSpawned).toBeLessThanOrEqual(stats!.enemiesScheduled);
    expect(
      stats!.enemiesSpawned + stats!.spawnsDiscarded + first.floor4Arena!.waves.debtCleared,
    ).toBeGreaterThan(0);

    // FR7.1/FR7.2 — the manifests are seeded plans, so the same seed schedules
    // the same waves in the same order regardless of how the fight goes.
    expect(first.floor4Arena?.waveManifestFingerprints).toEqual(
      second.floor4Arena?.waveManifestFingerprints,
    );
    expect(first.floor4Arena?.waveManifestFingerprints.length).toBeGreaterThan(0);
    expect(first.floor4Arena?.waves).toEqual(second.floor4Arena?.waves);
  });
});
