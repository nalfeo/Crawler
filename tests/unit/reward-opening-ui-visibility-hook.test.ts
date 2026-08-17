import { describe, expect, it, vi } from 'vitest';
import {
  createRewardOpeningUI,
  type RewardOpeningUIHooks,
} from '../../src/engine/RewardOpeningUI.js';
import type { ResolvedRewardPresentation } from '../../src/shared/reward-presentation.js';

/**
 * Regression coverage for `RewardOpeningUI.close()`'s `wasOpen` guard
 * (code review round 1, finding 1): `destroy()` unconditionally calls
 * `close()` on every scene teardown, even when no reward was ever opened or
 * when this reward was already closed. Without the guard,
 * `onVisibilityChange(false)` fires non-idempotently, which would make the
 * audio layer schedule a spurious "close" cue (and a defensive `stopAll()`)
 * on every normal scene teardown — not just a genuine open→close transition.
 *
 * `RewardOpeningUI` (like the other Phaser-heavy UI classes in this codebase,
 * e.g. `LevelUpUI`) has no dedicated unit-test file elsewhere — its visual
 * rendering is exercised exclusively via `tests/e2e/reward-opening-ux.test.ts`
 * through a real Phaser scene. This file intentionally does NOT test
 * rendering; it uses a minimal chainable fake `Phaser.Scene` (every
 * `scene.add.*` call returns a self-returning proxy) so the `onVisibilityChange`
 * hook-firing contract — the thing code review flagged — can be verified
 * directly and fast, without a browser.
 */

/** A fake Phaser game object where every method call is chainable (returns itself). */
function createChainableFake(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  const proxy: Record<string, unknown> = new Proxy(target, {
    get(obj, prop) {
      if (prop === 'destroy') {
        if (!obj.destroy) obj.destroy = vi.fn();
        return obj.destroy;
      }
      if (!(prop in obj)) {
        obj[prop as string] = vi.fn(() => proxy);
      }
      return obj[prop as string];
    },
  });
  return proxy;
}

function createFakeScene(): import('phaser').Scene {
  return {
    add: {
      text: vi.fn(() => createChainableFake()),
      container: vi.fn(() => createChainableFake()),
      rectangle: vi.fn(() => createChainableFake()),
      circle: vi.fn(() => createChainableFake()),
    },
    scale: { width: 1280, height: 720 },
    input: { keyboard: { on: vi.fn(), off: vi.fn() } },
  } as unknown as import('phaser').Scene;
}

function createShutdownFakeScene(): {
  scene: import('phaser').Scene;
  detachDisplayObjects(): void;
} {
  const detachedObject = {
    active: true,
    setDepth: vi.fn(() => detachedObject),
    setVisible: vi.fn(() => {
      if (!detachedObject.active) {
        throw new Error('detached display object should not be updated');
      }
      return detachedObject;
    }),
    setScrollFactor: vi.fn(() => detachedObject),
    setInteractive: vi.fn(() => detachedObject),
    setOrigin: vi.fn(() => detachedObject),
    setResolution: vi.fn(() => detachedObject),
    add: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    scene: {
      add: {
        text: vi.fn(() => detachedObject),
        container: vi.fn(() => detachedObject),
        rectangle: vi.fn(() => detachedObject),
        circle: vi.fn(() => detachedObject),
      },
      scale: { width: 1280, height: 720 },
      input: { keyboard: { on: vi.fn(), off: vi.fn() } },
    } as unknown as import('phaser').Scene,
    detachDisplayObjects(): void {
      detachedObject.active = false;
    },
  };
}

const LOOT_BOX_PRESENTATION: ResolvedRewardPresentation = {
  kind: 'lootBox',
  tier: 'common',
  gold: 10,
  materials: [],
};

function createHooks(): RewardOpeningUIHooks & {
  onVisibilityChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
} {
  return {
    onVisibilityChange: vi.fn<(open: boolean) => void>(),
  };
}

describe('RewardOpeningUI close() visibility-hook guard', () => {
  it('does not fire onVisibilityChange(false) when destroy() runs without ever opening', () => {
    const hooks = createHooks();
    const ui = createRewardOpeningUI(createFakeScene(), hooks);

    ui.destroy();

    expect(hooks.onVisibilityChange).not.toHaveBeenCalled();
  });

  it('does not touch display objects already detached during scene shutdown', () => {
    const { scene, detachDisplayObjects } = createShutdownFakeScene();
    const ui = createRewardOpeningUI(scene, createHooks());
    detachDisplayObjects();

    expect(() => ui.destroy()).not.toThrow();
  });

  it('fires onVisibilityChange(true) then (false) exactly once each for a genuine open->destroy', () => {
    const hooks = createHooks();
    const ui = createRewardOpeningUI(createFakeScene(), hooks);

    ui.open({
      world: null as never,
      presentation: LOOT_BOX_PRESENTATION,
      reducedMotion: false,
      sourceLabel: 'Test Reward',
      onAcknowledge: vi.fn(),
    });
    ui.destroy();

    expect(hooks.onVisibilityChange).toHaveBeenNthCalledWith(1, true);
    expect(hooks.onVisibilityChange).toHaveBeenNthCalledWith(2, false);
    expect(hooks.onVisibilityChange).toHaveBeenCalledTimes(2);
  });

  it('does not fire a second onVisibilityChange(false) when destroy() runs after an already-closed session', () => {
    const hooks = createHooks();
    const ui = createRewardOpeningUI(createFakeScene(), hooks);
    const onAcknowledge = vi.fn();

    ui.open({
      world: null as never,
      presentation: LOOT_BOX_PRESENTATION,
      reducedMotion: false,
      sourceLabel: 'Test Reward',
      onAcknowledge,
    });
    ui.skip(); // anticipation -> summary
    ui.acknowledge(); // summary -> claimed, then close() fires onVisibilityChange(false) once
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(hooks.onVisibilityChange).toHaveBeenCalledTimes(2); // open(true) + acknowledge-close(false)

    ui.destroy(); // scene teardown moments later — must NOT fire a second close

    expect(hooks.onVisibilityChange).toHaveBeenCalledTimes(2);
    expect(hooks.onVisibilityChange).toHaveBeenNthCalledWith(2, false);
  });

  it('supports opening a second session after a full close (no stuck-closed state)', () => {
    const hooks = createHooks();
    const ui = createRewardOpeningUI(createFakeScene(), hooks);

    ui.open({
      world: null as never,
      presentation: LOOT_BOX_PRESENTATION,
      reducedMotion: false,
      sourceLabel: 'First',
      onAcknowledge: vi.fn(),
    });
    ui.skip();
    ui.acknowledge();
    expect(ui.isOpen()).toBe(false);

    ui.open({
      world: null as never,
      presentation: LOOT_BOX_PRESENTATION,
      reducedMotion: false,
      sourceLabel: 'Second',
      onAcknowledge: vi.fn(),
    });

    expect(ui.isOpen()).toBe(true);
    expect(hooks.onVisibilityChange).toHaveBeenNthCalledWith(3, true);
  });
});
