import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { unlockAchievement } from '../../src/game/systems/achievementSystem.js';
import { createAchievementsUI } from '../../src/engine/AchievementsUI.js';
import { createRewardOpeningUI } from '../../src/engine/RewardOpeningUI.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Back-to-back loot-box opening: the REAL `AchievementsUI` wired to the REAL
 * shared `RewardOpeningUI` (the same pairing `MainGameScene` builds), driven
 * headlessly through a stub Phaser scene.
 *
 * Proves the whole chain — `AchievementsUI` resolves the next unlocked,
 * unclaimed loot-box achievement, `RewardOpeningUI` offers it on the summary
 * screen, and `openNext()` acknowledges the current reward then claims + opens
 * that next one — without ever returning to the panel.
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

function makeScene(): import('phaser').Scene {
  const stub = makeGameObjectStub();
  return {
    cameras: { main: { roundPixels: false } },
    add: {
      container: () => stub,
      rectangle: () => stub,
      circle: () => stub,
      image: () => stub,
      text: () => stub,
      particles: () => stub,
    },
    game: { registry: { get: () => undefined } },
    input: { on: () => {}, off: () => {}, keyboard: { on: () => {}, off: () => {} } },
    scale: { displaySize: { width: 1280, height: 720 }, on: () => {}, off: () => {} },
    textures: { exists: () => false },
    tweens: { add: () => stub },
    time: { delayedCall: () => stub },
  } as unknown as import('phaser').Scene;
}

/** Two floor-1 `lootBox` achievements of different tiers (trash / rare). */
const FIRST_ACHIEVEMENT = 'first-bonk';
const SECOND_ACHIEVEMENT = 'room-sweeper';

describe('achievement loot boxes opened back to back', () => {
  it('chains from one summary straight into the next unclaimed box', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, FIRST_ACHIEVEMENT);
    unlockAchievement(world, SECOND_ACHIEVEMENT);

    const scene = makeScene();
    const rewardOpeningUI = createRewardOpeningUI(scene, {});
    const achievementsUI = createAchievementsUI(scene, rewardOpeningUI);
    achievementsUI.refresh(world);

    achievementsUI.claimReward(FIRST_ACHIEVEMENT);
    rewardOpeningUI.skip();
    expect(rewardOpeningUI.getPhase()).toBe('summary');
    // The second box is offered by label, so the player can see what's next.
    expect(rewardOpeningUI.getNextRewardLabel()).toBe('rare box');

    const goldAfterFirst = world.playerGold;
    rewardOpeningUI.openNext();

    // First box acknowledged (presentation consumed) AND the second one is now
    // claimed + presenting, with no panel interaction in between.
    expect(world.achievements.pendingPresentations.has(FIRST_ACHIEVEMENT)).toBe(false);
    expect(world.achievements.claimedIds.has(SECOND_ACHIEVEMENT)).toBe(true);
    expect(world.playerGold).toBeGreaterThan(goldAfterFirst);
    expect(rewardOpeningUI.isOpen()).toBe(true);
    expect(rewardOpeningUI.getPhase()).toBe('anticipation');

    // Nothing left to chain into once the last unlocked box is open.
    rewardOpeningUI.skip();
    expect(rewardOpeningUI.getNextRewardLabel()).toBeNull();

    rewardOpeningUI.acknowledge();
    expect(rewardOpeningUI.isOpen()).toBe(false);
    expect(world.achievements.pendingPresentations.size).toBe(0);

    achievementsUI.destroy();
    rewardOpeningUI.destroy();
  });

  it('offers no chain when the only other unlocked achievement is already claimed', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, FIRST_ACHIEVEMENT);
    unlockAchievement(world, SECOND_ACHIEVEMENT);

    const scene = makeScene();
    const rewardOpeningUI = createRewardOpeningUI(scene, {});
    const achievementsUI = createAchievementsUI(scene, rewardOpeningUI);
    achievementsUI.refresh(world);

    achievementsUI.claimReward(SECOND_ACHIEVEMENT);
    rewardOpeningUI.skip();
    rewardOpeningUI.acknowledge();

    achievementsUI.claimReward(FIRST_ACHIEVEMENT);
    rewardOpeningUI.skip();
    expect(rewardOpeningUI.getNextRewardLabel()).toBeNull();

    achievementsUI.destroy();
    rewardOpeningUI.destroy();
  });
});
