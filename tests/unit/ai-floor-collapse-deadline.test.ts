import { describe, expect, it } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { resolveManifestFloorCollapseState } from '../../src/game/ai/collapse-deadline.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { GameWorld } from '../../src/core/world.js';
import type { Floor2State } from '../../src/core/faction-relations.js';

function floor2World(familyState: Partial<Floor2State> = {}): GameWorld {
  const world = createTestWorld({ seed: 4242, floor: 2 });
  world.floorId = 'floor2';
  world.floorScenario = null;
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [],
      contestedResource: 'ore',
      betrayerFlag: false,
      ...familyState,
    } as Floor2State,
  };
  return world;
}

describe('resolveManifestFloorCollapseState', () => {
  it('resolves the Floor 2 collapse deadline from the floor manifest timer', () => {
    const state = resolveManifestFloorCollapseState(floor2World());
    const durationMs = getFloorManifest('floor2')?.timer?.durationMs;

    expect(durationMs).toBeGreaterThan(0);
    expect(state).not.toBeNull();
    // Floor 2 grants no safe-room credit: `floor2ObjectiveTick` collapses the
    // run at raw `elapsedMs >= manifest.timer.durationMs`, so the AI's deadline
    // must be that literal wall, NOT a Floor-1-style planning-clamped value.
    expect(state?.deadlineMs).toBe(durationMs);
  });

  it('returns null for a Floor-1-style floor that owns its own objective deadline', () => {
    const world = floor2World();
    world.floorId = 'floor1';
    world.floorScenario = {
      objective: { deadlineMs: 123_456 },
    } as unknown as GameWorld['floorScenario'];

    expect(resolveManifestFloorCollapseState(world)).toBeNull();
  });

  it('returns null when the floor has no family state or no manifest timer', () => {
    const noFamilyState = createTestWorld({ seed: 1, floor: 2 });
    noFamilyState.floorId = 'floor2';
    noFamilyState.floorScenario = null;
    expect(resolveManifestFloorCollapseState(noFamilyState)).toBeNull();

    const unknownFloor = floor2World();
    unknownFloor.floorId = 'floor-does-not-exist';
    expect(resolveManifestFloorCollapseState(unknownFloor)).toBeNull();
  });

  it('reports the staircase as unlocked only once it is spawned, unlocked and positioned', () => {
    expect(resolveManifestFloorCollapseState(floor2World())?.staircaseUnlocked).toBe(false);

    // Every partial combination must read as still-locked: panic phase-gating
    // uses the same availability guard as `autoFloor2ProgressionSystem`, so a
    // half-initialized staircase must never escalate the beeline threshold
    // toward a target the player cannot actually descend.
    expect(
      resolveManifestFloorCollapseState(floor2World({ staircaseUnlocked: true }))
        ?.staircaseUnlocked,
    ).toBe(false);
    expect(
      resolveManifestFloorCollapseState(
        floor2World({ staircaseUnlocked: true, staircaseSpawned: true }),
      )?.staircaseUnlocked,
    ).toBe(false);
    expect(
      resolveManifestFloorCollapseState(
        floor2World({ staircaseSpawned: true, staircasePos: { x: 10, y: 20 } }),
      )?.staircaseUnlocked,
    ).toBe(false);

    const ready = resolveManifestFloorCollapseState(
      floor2World({
        staircaseUnlocked: true,
        staircaseSpawned: true,
        staircasePos: { x: 10, y: 20 },
      }),
    );
    expect(ready?.staircaseUnlocked).toBe(true);
    expect(ready?.staircasePos).toEqual({ x: 10, y: 20 });
    expect(ready?.staircaseDiscovered).toBe(false);
  });

  it('reports discovery once the descend has been confirmed', () => {
    const state = resolveManifestFloorCollapseState(
      floor2World({
        staircaseUnlocked: true,
        staircaseSpawned: true,
        staircasePos: { x: 1, y: 2 },
        staircaseDiscovered: true,
      }),
    );
    expect(state?.staircaseDiscovered).toBe(true);
  });
});
