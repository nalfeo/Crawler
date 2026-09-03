import { describe, expect, it } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnPlayer, type GameWorld } from '../../src/core/index.js';
import {
  getFloor5CaptureMarkerState,
  initializeFloor5Scenario,
  requestFloor5ThroneCapture,
  siegeFinaleSystem,
} from '../../src/game/floor5Scenario.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import type { Floor5SiegeState } from '../../src/shared/floor-types.js';
import floor5Manifest from '../../src/shared/data/floors/floor5.manifest.json' with { type: 'json' };

/**
 * Slice-6 capture-interaction contract (spec `FR7.4`/`FR7.5`).
 *
 * The headless gate proves the whole finale end to end; these cases pin the
 * legality matrix of the capture request itself, which the real game reaches
 * through the shared stair-descend seam.
 */
function createFloor5World(): { world: GameWorld; state: Floor5SiegeState } {
  const world = createTestWorld({ seed: 505 });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor5Scenario(world, playerEid);
  return { world, state: world.floorExtendedState!.floor5Siege! };
}

describe('Floor 5 throne capture interaction', () => {
  it('refuses capture before the courtyard and throne encounters resolve', () => {
    const { world, state } = createFloor5World();

    expect(requestFloor5ThroneCapture(world)).toBe('not-available');
    expect(state.finale.captured).toBe(false);
    expect(state.finale.rejectedCaptureAttempts).toBe(1);
    expect(state.finale.pendingCaptureFrame).toBeNull();

    // Regent fielded but still alive: the capture is a SEPARATE act, so the
    // request is still refused — and reports the Regent as the reason.
    state.finale.regentSpawnedFrame = world.frameCount;
    state.finale.throneActors.push({
      kind: 'regent-emeritus',
      eid: 0,
      health: 10,
      maxHealth: 10,
      spawnedFrame: world.frameCount,
      defeatedFrame: null,
      anchorX: 0,
      anchorY: 0,
    });
    expect(requestFloor5ThroneCapture(world)).toBe('regent-alive');
    expect(state.finale.captured).toBe(false);
    expect(state.finale.rejectedCaptureAttempts).toBe(2);
  });

  it('latches exactly one pending capture once the throne is available', () => {
    const { world, state } = createFloor5World();
    state.finale.captureAvailable = true;
    state.finale.captureAvailableFrame = world.frameCount;

    expect(requestFloor5ThroneCapture(world)).toBe('accepted');
    expect(state.finale.pendingCaptureFrame).toBe(world.frameCount);
    // A second interaction on the same latch is refused, not queued.
    expect(requestFloor5ThroneCapture(world)).toBe('already-pending');
    expect(state.finale.captureAttempts).toBe(2);
    expect(state.finale.rejectedCaptureAttempts).toBe(1);
  });

  it('refuses every interaction after the capture has landed', () => {
    const { world, state } = createFloor5World();
    state.finale.captured = true;
    state.finale.capturedFrame = world.frameCount;

    expect(requestFloor5ThroneCapture(world)).toBe('already-captured');
    expect(state.finale.pendingCaptureFrame).toBeNull();
  });

  it('withholds the capture marker until the throne is claimable', () => {
    const { world, state } = createFloor5World();
    // No capture point until the courtyard handoff derives it from the layout.
    expect(getFloor5CaptureMarkerState(world)).toBeNull();

    state.finale.capturePoint = { x: 10, y: 20 };
    const locked = getFloor5CaptureMarkerState(world)!;
    expect(locked.visible).toBe(false);
    expect(locked.locked).toBe(true);
    expect(locked.radiusFt).toBe(floor5Manifest.floor5.finale.capture.interactionRadiusFt);

    state.finale.captureAvailable = true;
    const unlocked = getFloor5CaptureMarkerState(world)!;
    expect(unlocked.visible).toBe(true);
    expect(unlocked.locked).toBe(false);

    state.finale.captured = true;
    const consumed = getFloor5CaptureMarkerState(world)!;
    expect(consumed.visible).toBe(false);
    expect(consumed.locked).toBe(true);
  });

  it('refuses the capture and hides the marker after a terminal defeat', () => {
    const { world, state } = createFloor5World();
    state.finale.capturePoint = { x: 10, y: 20 };
    state.finale.captureAvailable = true;
    state.finale.captureAvailableFrame = world.frameCount;
    // The Regent is down, but the run is already lost: the objective tick has
    // stopped advancing, so an accepted latch could never be committed.
    state.phase = { kind: 'DEFEAT' };

    expect(requestFloor5ThroneCapture(world)).toBe('not-available');
    expect(state.finale.pendingCaptureFrame).toBeNull();
    expect(state.finale.captured).toBe(false);
    expect(state.finale.rejectedCaptureAttempts).toBe(1);

    const marker = getFloor5CaptureMarkerState(world)!;
    expect(marker.visible).toBe(false);
    expect(marker.locked).toBe(true);
  });

  it('keeps the finale stance system inert until the breach latches', () => {
    const { world, state } = createFloor5World();
    expect(state.breach.latched).toBe(false);
    expect(() => siegeFinaleSystem(world)).not.toThrow();
    expect(state.finale.courtyardActors).toHaveLength(0);
  });

  it('seals the throne door and the Winner\u2019s Balcony at init', () => {
    const { state } = createFloor5World();
    expect(state.finale.throneDoorBarrierId).not.toBeNull();
    expect(state.finale.balconyBarrierId).not.toBeNull();
    expect(state.finale.throneDoorBarrierId).not.toBe(state.finale.balconyBarrierId);
  });

  it('wires the finale system and capture marker into the Floor 5 scenario', () => {
    const scenario = getScenarioDefinition('floor5');
    expect(scenario.beforeEnemyAISystems).toContain(siegeFinaleSystem);
    expect(scenario.getStairMarkerState).toBe(getFloor5CaptureMarkerState);
    expect(scenario.stairConfirmation?.confirmLabel).toBe('Yes, capture the castle');
  });
});
