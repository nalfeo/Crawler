import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { unlockAchievement } from '../../src/game/systems/achievementSystem.js';
import { claimAchievementReward } from '../../src/core/systems/achievementRewards.js';
import { createAchievementsUI } from '../../src/engine/AchievementsUI.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Regression coverage for the Awards panel's row order: unopened (unclaimed)
 * loot-box rewards must sort to the top of the list, ahead of already-claimed
 * rows, regardless of catalog order.
 */

function makeGameObjectStub(): unknown {
  const stub: unknown = new Proxy(function () {} as unknown as object, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;
      if (prop === 'width' || prop === 'height') return 64;
      if (prop === 'x' || prop === 'y' || prop === 'depth') return 0;
      if (prop === 'visible') return true;
      return () => stub;
    },
    set() {
      return true;
    },
    apply() {
      return stub;
    },
  });
  return stub;
}

function makeRecordingScene(titles: string[]): unknown {
  const stub = makeGameObjectStub();
  return {
    cameras: { main: { roundPixels: false } },
    add: {
      container: () => stub,
      rectangle: () => stub,
      circle: () => stub,
      image: () => stub,
      text: (_x: number, _y: number, text: string, style: { fontSize?: string }) => {
        // Row titles are the only text calls rendered at 15px, so this
        // isolates the achievement-title text calls in render order (the
        // reward button also uses fontStyle: 'bold', so that alone can't
        // distinguish them).
        if (style?.fontSize === '15px') titles.push(text);
        return stub;
      },
      particles: () => stub,
    },
    game: { registry: { get: () => undefined } },
    input: { on: () => {}, off: () => {}, keyboard: { on: () => {}, off: () => {} } },
    scale: { displaySize: { width: 1280, height: 720 }, on: () => {}, off: () => {} },
    textures: { exists: () => false },
    tweens: { add: () => stub },
    time: { delayedCall: () => stub },
  };
}

/**
 * `first-bonk` sorts before `room-sweeper` in catalog order, so claiming
 * `first-bonk` while leaving `room-sweeper` unclaimed sets up the exact case
 * the naive catalog-order render would get wrong.
 */
const CLAIMED_FIRST = 'first-bonk';
const UNCLAIMED_SECOND = 'room-sweeper';

describe('AchievementsUI row order', () => {
  it('sorts an unopened loot box ahead of an already-claimed one earlier in catalog order', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, CLAIMED_FIRST);
    unlockAchievement(world, UNCLAIMED_SECOND);
    expect(claimAchievementReward(world, CLAIMED_FIRST).ok).toBe(true);

    const titles: string[] = [];
    const scene = makeRecordingScene(titles);
    const achievementsUI = createAchievementsUI(
      scene as never,
      { open: () => {}, isOpen: () => false } as never,
    );
    achievementsUI.toggle(world);

    expect(titles).toEqual(['Room Sweeper', 'First Bonk']);

    achievementsUI.destroy();
  });

  it('keeps unclaimed boxes in catalog order relative to each other', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, CLAIMED_FIRST);
    unlockAchievement(world, UNCLAIMED_SECOND);

    const titles: string[] = [];
    const scene = makeRecordingScene(titles);
    const achievementsUI = createAchievementsUI(
      scene as never,
      { open: () => {}, isOpen: () => false } as never,
    );
    achievementsUI.toggle(world);

    expect(titles).toEqual(['First Bonk', 'Room Sweeper']);

    achievementsUI.destroy();
  });
});
