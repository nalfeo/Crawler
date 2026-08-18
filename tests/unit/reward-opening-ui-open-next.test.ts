import { describe, expect, it, vi } from 'vitest';
import { createRewardOpeningUI, type RewardOpeningUI } from '../../src/engine/RewardOpeningUI.js';
import type { ResolvedRewardPresentation } from '../../src/shared/reward-presentation.js';

/**
 * Coverage for the "open next box" chain affordance on the reward-opening
 * summary screen: acknowledging the current reward and immediately opening the
 * next one, so achievement loot boxes can be opened back to back without
 * reopening the achievements panel.
 *
 * Uses the same minimal chainable fake `Phaser.Scene` as
 * `reward-opening-ui-visibility-hook.test.ts` (rendering is proven in
 * `tests/e2e/reward-opening-ux.test.ts` against a real scene); this file only
 * asserts the chain's ordering and no-op contracts.
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

const LOOT_BOX_PRESENTATION: ResolvedRewardPresentation = {
  kind: 'lootBox',
  tier: 'common',
  gold: 10,
  materials: [],
};

function openReward(
  ui: RewardOpeningUI,
  overrides: {
    onAcknowledge?: () => void;
    nextReward?: { label: string; open: () => void };
    sourceLabel?: string;
  } = {},
): void {
  ui.open({
    world: null as never,
    presentation: LOOT_BOX_PRESENTATION,
    reducedMotion: false,
    sourceLabel: overrides.sourceLabel ?? 'Achievement: Test',
    onAcknowledge: overrides.onAcknowledge ?? vi.fn(),
    ...(overrides.nextReward ? { nextReward: overrides.nextReward } : {}),
  });
}

describe('RewardOpeningUI "open next box" chain', () => {
  it('acknowledges the current reward and opens the next one', () => {
    const ui = createRewardOpeningUI(createFakeScene(), {});
    const onAcknowledge = vi.fn();
    const openNextReward = vi.fn();

    openReward(ui, {
      onAcknowledge,
      nextReward: { label: 'rare box', open: openNextReward },
    });
    ui.skip(); // anticipation -> summary
    ui.openNext();

    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(openNextReward).toHaveBeenCalledTimes(1);
    expect(onAcknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      openNextReward.mock.invocationCallOrder[0] as number,
    );
    expect(ui.isOpen()).toBe(false);
  });

  it('exposes the next reward label only while at summary', () => {
    const ui = createRewardOpeningUI(createFakeScene(), {});

    openReward(ui, { nextReward: { label: 'rare box', open: vi.fn() } });
    expect(ui.getNextRewardLabel()).toBeNull(); // anticipation

    ui.skip();
    expect(ui.getNextRewardLabel()).toBe('rare box');

    ui.acknowledge();
    expect(ui.getNextRewardLabel()).toBeNull(); // closed
  });

  it('is a no-op before the summary phase', () => {
    const ui = createRewardOpeningUI(createFakeScene(), {});
    const onAcknowledge = vi.fn();
    const openNextReward = vi.fn();

    openReward(ui, {
      onAcknowledge,
      nextReward: { label: 'rare box', open: openNextReward },
    });
    ui.openNext(); // still in anticipation

    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(openNextReward).not.toHaveBeenCalled();
    expect(ui.isOpen()).toBe(true);
    expect(ui.getPhase()).toBe('anticipation');
  });

  it('is a no-op when no next reward was supplied (last box)', () => {
    const ui = createRewardOpeningUI(createFakeScene(), {});
    const onAcknowledge = vi.fn();

    openReward(ui, { onAcknowledge });
    ui.skip();
    expect(ui.getNextRewardLabel()).toBeNull();
    ui.openNext();

    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(ui.isOpen()).toBe(true);
    expect(ui.getPhase()).toBe('summary');
  });

  it('never double-opens the next box on duplicate input', () => {
    const ui = createRewardOpeningUI(createFakeScene(), {});
    const onAcknowledge = vi.fn();
    const openNextReward = vi.fn();

    openReward(ui, {
      onAcknowledge,
      nextReward: { label: 'rare box', open: openNextReward },
    });
    ui.skip();
    ui.openNext();
    ui.openNext(); // duplicate press once already closed/chained

    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(openNextReward).toHaveBeenCalledTimes(1);
  });

  it('yields to a pending presentation that acknowledging already reopened', () => {
    const ui = createRewardOpeningUI(createFakeScene(), {});
    const openNextReward = vi.fn();
    // Mirrors AchievementsUI's onAcknowledge, which drains its own pending
    // (already-granted) presentation queue before anything else can open.
    const onAcknowledge = vi.fn(() => {
      openReward(ui, { sourceLabel: 'Achievement: Resumed' });
    });

    openReward(ui, {
      onAcknowledge,
      nextReward: { label: 'rare box', open: openNextReward },
    });
    ui.skip();
    ui.openNext();

    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(openNextReward).not.toHaveBeenCalled();
    expect(ui.isOpen()).toBe(true);
  });
});
