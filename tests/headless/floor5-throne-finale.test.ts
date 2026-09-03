import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import type { GameWorld } from '../../src/core/world.js';
import { Enemy, Health, applyDamage } from '../../src/core/index.js';
import {
  computeSiegeCastleLayout,
  siegeCastleOptionsFromConfig,
} from '../../src/core/map/generators/SiegeCastleGenerator.js';
import { findTilePath } from '../../src/core/map/pathfinding.js';
import type { InputState } from '../../src/shared/input.js';
import type { Floor5SiegeState } from '../../src/shared/floor-types.js';
import { requestFloor5ThroneCapture } from '../../src/game/floor5Scenario.js';
import floor5Manifest from '../../src/shared/data/floors/floor5.manifest.json' with { type: 'json' };

const FINALE_CONFIG = floor5Manifest.floor5.finale;
/** Frames between damage probes; keeps the encounter longer than a telegraph. */
const FINALE_CHIP_INTERVAL_FRAMES = 4;

/**
 * Idle provider: the finale must resolve under the REAL Floor 5 pipeline. The
 * only player influence is the explicit damage probe below, which lands through
 * the real `applyDamage` path — so the gate can never be satisfied by a lucky
 * AI run.
 */
class IdleFloor5Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor5 throne finale observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

/** Stand-in for player DPS: chip the lowest live finale actor every frame. */
function chipFinaleActors(world: GameWorld, state: Floor5SiegeState, damage: number): void {
  const live = [...state.finale.courtyardActors, ...state.finale.throneActors]
    .filter(
      (actor) =>
        actor.defeatedFrame === null &&
        actor.eid > 0 &&
        (world.stores.health.current[actor.eid] ?? 0) > 0,
    )
    .sort((a, b) => a.eid - b.eid);
  const target = live[0];
  if (!target) return;
  applyDamage(
    world,
    target.eid,
    damage,
    world.stores.position.x[target.eid] ?? 0,
    world.stores.position.y[target.eid] ?? 0,
    { origin: 'environment', affinity: 'physical', scaleWithPrimary: false, canCrit: false },
  );
}

function throneTiles(world: GameWorld) {
  const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(world.floorMap!.config));
  const laneY = layout.primaryLane.y + Math.floor(layout.primaryLane.height / 2);
  return {
    courtyard: {
      x: layout.courtyard.x + Math.floor(layout.courtyard.width / 2),
      y: laneY,
    },
    throne: {
      x: layout.throneRoom.x + Math.floor(layout.throneRoom.width / 2),
      y: laneY,
    },
    balcony: {
      x: layout.winnersBalcony.x + Math.floor(layout.winnersBalcony.width / 2),
      y: laneY,
    },
  };
}

function reachable(
  world: GameWorld,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return findTilePath(world.floorMap!, from, to).length > 1;
}

describe('Floor 5 courtyard → throne finale in the real headless pipeline', () => {
  it('crosses the latched breach, clears both encounters, refuses early capture, and captures exactly once', async () => {
    let throneReachableBeforeCourtyardCleared: boolean | null = null;
    let throneReachableAfterCourtyardCleared: boolean | null = null;
    let balconyReachableBeforeCapture: boolean | null = null;
    let balconyReachableAtEnd = false;
    let earlyCaptureResult: string | null = null;
    let earlyCaptureCaptured: boolean | null = null;
    let liveFinaleEnemiesAtEnd = 0;
    let peakLiveSummons = 0;
    let firstTelegraphFrame: number | null = null;
    let summonsReleasedAtFirstTelegraph: number | null = null;
    let firstSummonReleaseFrame: number | null = null;

    const stats = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 12_000,
      questStallFrames: 1_200,
      simulationOptions: {
        postSystems: [
          (world) => {
            const state = world.floorExtendedState?.floor5Siege;
            if (!state) return;
            const finale = state.finale;
            const tiles = throneTiles(world);

            if (finale.courtyardEnteredFrame !== null && !finale.courtyardCleared) {
              // Spec FR7.2: the throne door is shut while the courtyard fight is live.
              throneReachableBeforeCourtyardCleared ??= reachable(
                world,
                tiles.courtyard,
                tiles.throne,
              );
              // Spec FR7.4: capturing is refused while Regent Emeritus still
              // holds the throne (here, before it has even been fielded).
              if (earlyCaptureResult === null) {
                earlyCaptureResult = requestFloor5ThroneCapture(world);
                earlyCaptureCaptured = finale.captured;
              }
            }
            if (finale.courtyardCleared && throneReachableAfterCourtyardCleared === null) {
              throneReachableAfterCourtyardCleared = reachable(
                world,
                tiles.courtyard,
                tiles.throne,
              );
            }
            if (!finale.captured) {
              balconyReachableBeforeCapture ??= reachable(world, tiles.throne, tiles.balcony);
            }
            // Spec FR7.3: every summon wave is telegraphed before it lands.
            if (firstTelegraphFrame === null && finale.summonsTelegraphed > 0) {
              firstTelegraphFrame = world.frameCount;
              summonsReleasedAtFirstTelegraph = finale.summonsReleased;
            }
            if (firstSummonReleaseFrame === null && finale.summonsReleased > 0) {
              firstSummonReleaseFrame = world.frameCount;
            }
            peakLiveSummons = Math.max(
              peakLiveSummons,
              finale.throneActors.filter(
                (actor) => actor.kind === 'regent-summon' && actor.defeatedFrame === null,
              ).length,
            );
            // Chip on a fixed cadence so the encounter lasts long enough for
            // the authored telegraph windows to resolve inside the real run.
            if (world.frameCount % FINALE_CHIP_INTERVAL_FRAMES === 0) {
              chipFinaleActors(world, state, 12);
            }
          },
        ],
      },
      onFinish: (world) => {
        const tiles = throneTiles(world);
        balconyReachableAtEnd = reachable(world, tiles.throne, tiles.balcony);
        liveFinaleEnemiesAtEnd = Array.from(query(world.ecs, [Enemy, Health])).filter(
          (eid) => (world.stores.health.current[eid] ?? 0) > 0,
        ).length;
      },
    });

    const siege = stats.floor5Siege;
    expect(siege).toBeDefined();
    const finale = siege!.finale;

    // --- FR7.1: the breach latch is what opens the courtyard ---------------
    expect(siege!.breach.latched).toBe(true);
    expect(finale.courtyardEnteredFrame).not.toBeNull();
    expect(finale.courtyardEnteredFrame!).toBeGreaterThan(siege!.breach.committedFrame!);

    // --- FR7.1: the fixed courtyard encounter was cleared ------------------
    expect(finale.auditorDefeatedFrame).not.toBeNull();
    expect(finale.defendersSpawned).toBe(FINALE_CONFIG.courtyardDefenders.count);
    expect(finale.defendersDefeated).toBe(finale.defendersSpawned);
    expect(finale.courtyardCleared).toBe(true);

    // --- FR7.2: the throne door is a real gate, opened exactly once --------
    expect(throneReachableBeforeCourtyardCleared).toBe(false);
    expect(throneReachableAfterCourtyardCleared).toBe(true);
    expect(finale.throneDoorOpen).toBe(true);
    expect(finale.throneDoorOpenedFrame).not.toBeNull();
    expect(finale.throneDoorOpenedFrame!).toBeGreaterThanOrEqual(finale.courtyardClearedFrame!);
    expect(siege!.trace.filter((entry) => entry.phase.kind === 'COURTYARD')).toHaveLength(1);
    expect(siege!.trace.filter((entry) => entry.phase.kind === 'THRONE')).toHaveLength(1);

    // --- FR7.3: Regent Emeritus and BOUNDED summons ------------------------
    expect(finale.regentSpawnedFrame).not.toBeNull();
    expect(finale.regentDefeatedFrame).not.toBeNull();
    expect(finale.summonsReleased).toBeGreaterThan(0);
    expect(finale.summonCap).toBe(FINALE_CONFIG.summons.maxTotal);
    expect(finale.summonsReleased).toBeLessThanOrEqual(finale.summonCap);
    expect(peakLiveSummons).toBeLessThanOrEqual(finale.summonCap);
    expect(finale.summonsReleased).toBeLessThanOrEqual(finale.summonsTelegraphed);
    // No summon appears on the frame its wave is telegraphed, and the first
    // wave lands no earlier than the authored telegraph window.
    expect(firstTelegraphFrame).not.toBeNull();
    expect(summonsReleasedAtFirstTelegraph).toBe(0);
    expect(firstSummonReleaseFrame).not.toBeNull();
    expect(firstSummonReleaseFrame! - firstTelegraphFrame!).toBeGreaterThanOrEqual(
      FINALE_CONFIG.summons.telegraphFrames,
    );
    // Waves still queued when the Regent falls retire with the encounter.
    expect(finale.pendingSummonWaves).toBe(0);

    // --- FR7.4: capture is SEPARATE from the Regent kill and refused early -
    expect(earlyCaptureResult).not.toBe('accepted');
    expect(earlyCaptureCaptured).toBe(false);
    expect(finale.rejectedCaptureAttempts).toBeGreaterThan(0);
    expect(finale.captureAvailableFrame).not.toBeNull();
    expect(finale.captureAvailableFrame!).toBeGreaterThanOrEqual(finale.regentDefeatedFrame!);

    // --- FR7.5: exactly one capture, one terminal outcome, full cleanup ----
    expect(finale.captured).toBe(true);
    expect(finale.capturedFrame!).toBeGreaterThanOrEqual(finale.captureAvailableFrame!);
    expect(siege!.trace.filter((entry) => entry.phase.kind === 'CAPTURED')).toHaveLength(1);
    expect(siege!.trace.filter((entry) => entry.phase.kind === 'DEFEAT')).toHaveLength(0);
    expect(siege!.phase.kind).toBe('CAPTURED');
    expect(finale.royalAuthorityDisabled).toBe(true);
    expect(liveFinaleEnemiesAtEnd).toBe(0);

    // --- Winner's Balcony only opens as part of the capture ----------------
    expect(balconyReachableBeforeCapture).toBe(false);
    expect(balconyReachableAtEnd).toBe(true);
    expect(finale.balconyOpen).toBe(true);
    expect(finale.balconyOpenedFrame).toBe(finale.capturedFrame);

    // --- One terminal outcome for the whole run ----------------------------
    expect(stats.outcome).toBe('victory');
    expect(stats.stallReason).toBeUndefined();
  }, 300_000);
});
