import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { InputState } from '../../src/shared/input.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';

/**
 * A contestant with no plan: it never picks a target or a destination, so the
 * run observes the wave window itself rather than a competent clear. (The
 * runner's baseline reflexes still land occasional hits, so a handful of real
 * kills happen — those are rewarded normally, unlike the cut.)
 */
class IdleFloor4Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor4 wave observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

describe('Floor 4 wave window (real headless pipeline)', () => {
  const floor4Phase = getFloorManifest('floor4')!.floor4!.phase;
  const floor4Waves = getFloorManifest('floor4')!.floor4!.waves;
  // Countdown + the whole act-1 wave window + a beat of the headline window, so
  // the run observes every act-1 release AND the cut at the window boundary.
  const horizonMs = floor4Phase.countdownMs + floor4Phase.waveWindowMs + 3_000;

  const run = () =>
    runHeadless(new IdleFloor4Provider(), {
      floorId: 'floor4',
      seed: 404,
      maxFrames: Math.ceil(horizonMs / GAME.DELTA_MS),
    });

  it('releases every act-1 wave and cuts the survivors at the window boundary', async () => {
    const first = await run();
    const telemetry = first.floor4Arena?.waveTelemetry;

    // The window ran to its boundary and handed off to the headline window.
    expect(first.floor4Arena?.phase).toEqual({ kind: 'HEADLINE', act: 1, cleared: true });
    expect(telemetry?.wavesReleased).toBe(floor4Waves.cadence.wavesPerAct);
    expect(telemetry?.enemiesSpawned).toBeGreaterThan(0);
    expect(telemetry?.gateTelegraphsArmed).toBeGreaterThanOrEqual(floor4Waves.cadence.wavesPerAct);

    // The cut fired, and it is disjoint from the normal death path: every
    // spawned enemy is either a real (rewarded) kill or a cut, never both.
    // That the cut itself pays nothing is proven exactly in
    // tests/unit/floor4-arena-waves.test.ts, where kills are held at zero.
    expect(telemetry?.enemiesCut).toBeGreaterThan(0);
    expect(first.combat.totalKills + (telemetry?.enemiesCut ?? 0)).toBeLessThanOrEqual(
      telemetry?.enemiesSpawned ?? 0,
    );
    // If the 20-odd cut enemies had paid out, XP would scale with everything
    // spawned rather than with the handful actually killed.
    expect(first.totalXp - (first.runStartXp ?? 0)).toBeLessThan(telemetry?.enemiesSpawned ?? 0);
  });

  it('is deterministic across two runs of the same seed', async () => {
    const first = await run();
    const second = await run();

    expect(first.floor4Arena?.waveTelemetry).toEqual(second.floor4Arena?.waveTelemetry);
    expect(first.floor4Arena?.timeline).toEqual(second.floor4Arena?.timeline);
    expect(first.floor4Arena?.arenaElapsedMs).toBe(second.floor4Arena?.arenaElapsedMs);
    expect(first.outcome).toBe(second.outcome);
    // Retained from the slice-2 empty-arena run: the countdown is safe-room time,
    // so it never burns the collapse-relevant active-time budget (FR8.4).
    expect(first.safeRoomMs).toBeGreaterThanOrEqual(floor4Phase.countdownMs);
    expect(first.safeRoomMs).toBe(second.safeRoomMs);
  });
});
