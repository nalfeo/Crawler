import { describe, expect, it, vi } from 'vitest';
import { createGoreVfx } from '../../src/engine/GoreVfx.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { CombatEvent } from '../../src/shared/combat-events.js';

/**
 * Regression guard for GoreVfx on a partial Scene stub.
 *
 * `PhaserBridge` enables GoreVfx whenever `scene.add.rectangle` is a function —
 * it does NOT also require `scene.add.graphics`. But the death path
 * (`spawnBloodPool`) draws the persistent blood pool via `scene.add.graphics`.
 * A minimal rectangle-only Scene stub / headless scene would therefore throw at
 * the first kill. This asserts the defensive guard: death particles (rectangles)
 * still spawn, and `update()` does not throw when `add.graphics` is absent.
 */

type GoreScene = Parameters<typeof createGoreVfx>[0];

/** Minimal scene that provides `add.rectangle` but deliberately NOT `add.graphics`. */
function createRectangleOnlySceneStub(): {
  scene: GoreScene;
  rectangle: ReturnType<typeof vi.fn>;
} {
  const rectShape = {
    x: 0,
    y: 0,
    setX: vi.fn(() => rectShape),
    setY: vi.fn(() => rectShape),
    setDepth: vi.fn(() => rectShape),
    setAlpha: vi.fn(() => rectShape),
    setScale: vi.fn(() => rectShape),
    setSize: vi.fn(() => rectShape),
    destroy: vi.fn(),
  };
  const rectangle = vi.fn(() => rectShape);
  const scene = {
    add: {
      rectangle,
      // NOTE: no `graphics` — this is the whole point of the test.
    },
    cameras: { getCamera: vi.fn(() => null) },
  };
  return { scene: scene as unknown as GoreScene, rectangle };
}

function deathEvent(x: number, y: number): CombatEvent {
  return { type: 'death', x, y, amount: 10, targetType: 'enemy', timestamp: 0, overkill: 0 };
}

describe('GoreVfx on a scene without add.graphics', () => {
  it('does not throw on a death event and still spawns death particles', () => {
    const { scene, rectangle } = createRectangleOnlySceneStub();
    const vfx = createGoreVfx(scene, { intensity: 1, hitGoreEnabled: true });
    const world = createTestWorld();

    world.combatEvents.push(deathEvent(100, 50));

    // Without the guard, spawnBloodPool would call the missing
    // `scene.add.graphics(...)` and throw a TypeError here.
    expect(() => vfx.update(world, 1000, 16, 0)).not.toThrow();

    // Gore is not silently fully disabled: death particles (rectangles) still spawn.
    expect(rectangle).toHaveBeenCalled();
  });
});
