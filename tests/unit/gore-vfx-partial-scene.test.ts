import { describe, expect, it, vi } from 'vitest';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { spawnProjectile } from '../../src/core/spawners/projectiles.js';
import {
  createGoreVfx,
  DEFAULT_IMPACT_DIRECTION,
  resolveImpactDirection,
} from '../../src/engine/GoreVfx.js';
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

describe('projectile-hit impact direction', () => {
  it.each([
    ['forward east', [10, 0, 0, 0], { x: 1, y: 0 }],
    ['diagonal', [10, 10, 0, 0], { x: Math.SQRT1_2, y: Math.SQRT1_2 }],
    ['zero-length', [10, 10, 10, 10], DEFAULT_IMPACT_DIRECTION],
    ['unavailable source', [10, 10, undefined, undefined], DEFAULT_IMPACT_DIRECTION],
  ] as const)('%s resolves to a normalized deterministic direction', (_name, args, expected) => {
    const [targetX, targetY, sourceX, sourceY] = args;
    const direction = resolveImpactDirection(targetX, targetY, sourceX, sourceY);

    expect(direction.x).toBeCloseTo(expected.x);
    expect(direction.y).toBeCloseTo(expected.y);
    expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1);
  });

  it('moves real hit particles beyond the target along the incoming vector', () => {
    const rectangles: Array<{ x: number; y: number }> = [];
    const scene = {
      add: {
        rectangle: vi.fn((x: number, y: number) => {
          const rectangle = {
            x,
            y,
            setX(nextX: number) {
              rectangle.x = nextX;
              return rectangle;
            },
            setY(nextY: number) {
              rectangle.y = nextY;
              return rectangle;
            },
            setDepth: vi.fn(() => rectangle),
            setAlpha: vi.fn(() => rectangle),
            setScale: vi.fn(() => rectangle),
            setSize: vi.fn(() => rectangle),
            destroy: vi.fn(),
          };
          rectangles.push(rectangle);
          return rectangle;
        }),
      },
      cameras: { getCamera: vi.fn(() => null) },
    } as unknown as GoreScene;
    const vfx = createGoreVfx(scene, { intensity: 1, hitGoreEnabled: true });
    const world = createTestWorld();
    spawnProjectile(world, 0, 0, 1, 0, 10);
    spawnEnemy(world, 1, 0, 25);
    damageSystem(world, collisionSystem(world));

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'hit',
      x: 1,
      y: 0,
      sourceX: 0,
      sourceY: 0,
    });

    vfx.update(world, 0, 0);
    const initialX = rectangles.map((rectangle) => rectangle.x);
    world.combatEvents.length = 0;
    vfx.update(world, 100, 100);

    expect(rectangles.length).toBeGreaterThan(0);
    expect(rectangles.every((rectangle, index) => rectangle.x > initialX[index]!)).toBe(true);
  });
});
