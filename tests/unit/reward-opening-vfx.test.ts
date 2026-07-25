import { describe, expect, it, vi } from 'vitest';
import { createRewardOpeningVfx } from '../../src/engine/RewardOpeningVfx.js';

type VfxScene = Parameters<typeof createRewardOpeningVfx>[0];

/** Shape stub that records calls — returned by add.circle/add.rectangle. */
function createShapeStub() {
  return {
    x: 0,
    y: 0,
    alpha: 1,
    scale: 1,
    angle: 0,
    setScrollFactor: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setBlendMode: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

/** Graphics stub — returned by add.graphics. */
function createGraphicsStub() {
  return {
    alpha: 0.9,
    setScrollFactor: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setBlendMode: vi.fn().mockReturnThis(),
    lineStyle: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    strokePath: vi.fn(),
    destroy: vi.fn(),
  };
}

/**
 * Creates a minimal fake scene that passes the capability guard so VFX are
 * enabled. `tweens.add` immediately invokes `onComplete` so objects are
 * synchronously released, which allows us to test lifecycle without timers.
 * The `completedImmediately` flag can be set to false to keep tweens running
 * (simulating long-lived animation).
 */
function createEnabledScene(opts: { completedImmediately?: boolean } = {}) {
  const { completedImmediately = true } = opts;
  const shapes: ReturnType<typeof createShapeStub>[] = [];
  const graphicsObjects: ReturnType<typeof createGraphicsStub>[] = [];

  const scene = {
    add: {
      circle: vi.fn(() => {
        const s = createShapeStub();
        shapes.push(s);
        return s;
      }),
      rectangle: vi.fn(() => {
        const s = createShapeStub();
        shapes.push(s);
        return s;
      }),
      graphics: vi.fn(() => {
        const g = createGraphicsStub();
        graphicsObjects.push(g);
        return g;
      }),
    },
    tweens: {
      add: vi.fn((config: { onComplete?: () => void }) => {
        if (completedImmediately) config.onComplete?.();
        return {};
      }),
      killTweensOf: vi.fn(),
    },
  };
  return { scene: scene as unknown as VfxScene, shapes, graphicsObjects };
}

/** Scene that fails the capability guard — all VFX must be no-ops. */
function createDisabledScene() {
  const scene = {
    add: {},
    tweens: {},
  };
  return { scene: scene as unknown as VfxScene };
}

describe('createRewardOpeningVfx — capability guard / reduced-motion no-ops', () => {
  it('is a no-op when the scene lacks Phaser shape factories (headless)', () => {
    const { scene } = createDisabledScene();
    const vfx = createRewardOpeningVfx(scene);
    // None of these should throw.
    expect(() => vfx.onAnticipationStart(320, 240, 'legendary', false)).not.toThrow();
    expect(() => vfx.onItemRevealed(320, 240, 0xff0000, 'legendary', false)).not.toThrow();
    expect(() => vfx.onSummaryBurst(320, 240, 'legendary', false)).not.toThrow();
    expect(() => vfx.destroy()).not.toThrow();
  });

  it('is a no-op for all phases when reducedMotion=true even on an enabled scene', () => {
    const { scene, shapes } = createEnabledScene();
    const vfx = createRewardOpeningVfx(scene);
    vfx.onAnticipationStart(320, 240, 'legendary', true);
    vfx.onItemRevealed(320, 240, 0xff0000, 'legendary', true);
    vfx.onSummaryBurst(320, 240, 'legendary', true);
    expect(shapes).toHaveLength(0);
  });
});

describe('createRewardOpeningVfx — tier-specific spawning', () => {
  it('spawns at least one shape/graphic for every tier during anticipation', () => {
    for (const bucket of ['modest', 'notable', 'exciting', 'legendary'] as const) {
      const { scene, shapes } = createEnabledScene({ completedImmediately: false });
      const vfx = createRewardOpeningVfx(scene);
      vfx.onAnticipationStart(320, 240, bucket, false);
      expect(shapes.length).toBeGreaterThan(0);
      vfx.destroy();
    }
  });

  it('spawns at least one shape for every tier during reveal', () => {
    for (const bucket of ['modest', 'notable', 'exciting', 'legendary'] as const) {
      const { scene, shapes } = createEnabledScene({ completedImmediately: false });
      const vfx = createRewardOpeningVfx(scene);
      vfx.onItemRevealed(320, 240, 0xffc107, bucket, false);
      expect(shapes.length).toBeGreaterThan(0);
      vfx.destroy();
    }
  });

  it('spawns more shapes/graphics for higher excitement tiers on summary burst', () => {
    const counts: number[] = [];
    for (const bucket of ['modest', 'notable', 'exciting', 'legendary'] as const) {
      const { scene, shapes, graphicsObjects } = createEnabledScene({
        completedImmediately: false,
      });
      const vfx = createRewardOpeningVfx(scene);
      vfx.onSummaryBurst(320, 240, bucket, false);
      counts.push(shapes.length + graphicsObjects.length);
      vfx.destroy();
    }
    // Each higher tier should spawn at least as many objects as the tier below.
    expect(counts[1]).toBeGreaterThanOrEqual(counts[0]!);
    expect(counts[2]).toBeGreaterThanOrEqual(counts[1]!);
    expect(counts[3]).toBeGreaterThanOrEqual(counts[2]!);
  });

  it('spawns laser beams (graphics) only for exciting/legendary on summary burst', () => {
    const { scene: modestScene, graphicsObjects: modestGraphics } = createEnabledScene({
      completedImmediately: false,
    });
    createRewardOpeningVfx(modestScene).onSummaryBurst(320, 240, 'modest', false);
    expect(modestGraphics).toHaveLength(0);

    const { scene: excitingScene, graphicsObjects: excitingGraphics } = createEnabledScene({
      completedImmediately: false,
    });
    createRewardOpeningVfx(excitingScene).onSummaryBurst(320, 240, 'exciting', false);
    expect(excitingGraphics.length).toBeGreaterThan(0);
  });
});

describe('createRewardOpeningVfx — lifecycle / cleanup', () => {
  it('destroys all spawned objects when tweens complete synchronously (via onComplete)', () => {
    const { scene, shapes } = createEnabledScene({ completedImmediately: true });
    const vfx = createRewardOpeningVfx(scene);
    vfx.onItemRevealed(320, 240, 0xffffff, 'notable', false);
    // With completedImmediately=true the tween onComplete fires immediately,
    // so every shape should have been destroyed by now.
    for (const shape of shapes) {
      expect(shape.destroy).toHaveBeenCalled();
    }
  });

  it('destroy() calls killTweensOf before destroying still-live objects', () => {
    const { scene, shapes } = createEnabledScene({ completedImmediately: false });
    const vfx = createRewardOpeningVfx(scene);
    vfx.onSummaryBurst(320, 240, 'legendary', false);
    expect(shapes.length).toBeGreaterThan(0);

    const killTweensOf = (
      scene as unknown as { tweens: { killTweensOf: ReturnType<typeof vi.fn> } }
    ).tweens.killTweensOf;
    vfx.destroy();

    expect(killTweensOf).toHaveBeenCalledTimes(1);
    for (const shape of shapes) {
      expect(shape.destroy).toHaveBeenCalled();
    }
  });

  it('destroy() is idempotent — second call does not throw or double-destroy', () => {
    const { scene, shapes } = createEnabledScene({ completedImmediately: false });
    const vfx = createRewardOpeningVfx(scene);
    vfx.onItemRevealed(320, 240, 0xff0000, 'exciting', false);
    vfx.destroy();
    expect(() => vfx.destroy()).not.toThrow();
    for (const shape of shapes) {
      expect(shape.destroy).toHaveBeenCalledTimes(1);
    }
  });
});

describe('createRewardOpeningVfx — blend mode', () => {
  it('applies ADD blend mode to laser beams', () => {
    const { scene, graphicsObjects } = createEnabledScene({ completedImmediately: false });
    const vfx = createRewardOpeningVfx(scene);
    vfx.onSummaryBurst(320, 240, 'exciting', false);
    expect(graphicsObjects.length).toBeGreaterThan(0);
    for (const gfx of graphicsObjects) {
      expect(gfx.setBlendMode).toHaveBeenCalledWith('ADD');
    }
    vfx.destroy();
  });
});
