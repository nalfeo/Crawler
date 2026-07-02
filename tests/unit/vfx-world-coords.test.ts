import { describe, expect, it, vi } from 'vitest';
import { createGoreVfx } from '../../src/engine/GoreVfx.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { SHATTER_COLS, SHATTER_ROWS } from '../../src/engine/corpse-shatter.js';
import { ftToPx } from '../../src/shared/units.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createSceneStub } from '../fixtures/phaser-bridge-harness.js';
import type { CombatEvent } from '../../src/shared/combat-events.js';

/**
 * Regression guards for the death-VFX coordinate space. World coordinates are
 * feet (`PIXELS_PER_FOOT = 8`); the render layer must call `ftToPx()`. The #366
 * "feet as the single internal unit" refactor added that conversion to the gore
 * particles but MISSED the blood-pool ellipse and the corpse-shatter hand-off,
 * so both drew at ~1/8 position near the top-left origin and appeared to vanish.
 * These tests assert both VFX land at the pixel death location, not raw feet.
 */

type GoreScene = Parameters<typeof createGoreVfx>[0];

interface EllipseArgs {
  x: number;
  y: number;
}

/** Minimal scene that records `add.ellipse` centres (the blood pool). */
function createGoreSceneStub(): { scene: GoreScene; ellipses: EllipseArgs[] } {
  const ellipses: EllipseArgs[] = [];
  // Superset of the GameObject API the gore animation loop drives (particles
  // read/write x/y; pools call setSize). Ellipse centres are captured at
  // creation, so sharing one mutable shape is harmless for the assertions.
  const shape = {
    x: 0,
    y: 0,
    setX: vi.fn(() => shape),
    setY: vi.fn(() => shape),
    setDepth: vi.fn(() => shape),
    setAlpha: vi.fn(() => shape),
    setScale: vi.fn(() => shape),
    setSize: vi.fn(() => shape),
    destroy: vi.fn(),
  };
  const scene = {
    add: {
      rectangle: vi.fn(() => shape),
      ellipse: vi.fn((x: number, y: number) => {
        ellipses.push({ x, y });
        return shape;
      }),
    },
    cameras: { getCamera: vi.fn(() => null) },
  };
  return { scene: scene as unknown as GoreScene, ellipses };
}

function deathEvent(x: number, y: number): CombatEvent {
  return { type: 'death', x, y, amount: 10, targetType: 'enemy', timestamp: 0, overkill: 0 };
}

function corpseExplodeEvent(x: number, y: number): CombatEvent {
  return {
    type: 'corpseExplode',
    x,
    y,
    amount: 12,
    targetType: 'enemy',
    timestamp: 0,
    spriteTextureId: 0,
    bloodColor: 0xcc0000,
    knockbackDirX: 1,
    knockbackDirY: 0,
  };
}

describe('death-VFX world→pixel coordinates', () => {
  it('spawns the blood-pool ellipse at ftToPx(death position), not raw feet', () => {
    const { scene, ellipses } = createGoreSceneStub();
    const vfx = createGoreVfx(scene, { intensity: 1, hitGoreEnabled: false });
    const world = createTestWorld();

    // Death at 100ft, 50ft (no targetEid → the event position is used as-is).
    world.combatEvents.push(deathEvent(100, 50));
    vfx.update(world, 1000, 16, 0);

    expect(ellipses).toHaveLength(1);
    // Only a small (<6px/<4px) organic jitter is added on top of the centre.
    expect(Math.abs(ellipses[0]!.x - ftToPx(100))).toBeLessThan(4);
    expect(Math.abs(ellipses[0]!.y - ftToPx(50))).toBeLessThan(3);
    // Guard against the regression: the centre must NOT be the raw feet value.
    expect(ellipses[0]!.x).toBeGreaterThan(100);
    expect(ellipses[0]!.y).toBeGreaterThan(50);
  });

  it('spawns corpse-shatter shards at ftToPx(corpse position), not raw feet', () => {
    // No `add.rectangle` → the bridge skips GoreVfx and blood specks, leaving the
    // 3x3 shard grid (created via `add.image`) as the only recorded images.
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    world.combatEvents.push(corpseExplodeEvent(100, 50));
    bridge.sync(world, 1000);

    expect(images).toHaveLength(SHATTER_COLS * SHATTER_ROWS);
    for (const shard of images) {
      // Shards are sprayed symmetrically around the corpse centre, so each one
      // must sit closer to the pixel death location than to the raw-feet value.
      expect(Math.abs(shard.x - ftToPx(100))).toBeLessThan(Math.abs(shard.x - 100));
      expect(Math.abs(shard.y - ftToPx(50))).toBeLessThan(Math.abs(shard.y - 50));
    }
  });
});
