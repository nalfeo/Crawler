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

/**
 * Upper bound on 2000ms advance steps for a two-box sequence. Generous enough
 * for the real reveal timings, small enough that a regression that never
 * settles fails fast instead of hanging until the runner timeout.
 */
const MAX_TICK_STEPS = 100;

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
    expect(rewardOpeningUI.getNextRewardLabel()).toBe('rare');

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

  it('opens all pending loot boxes back to back without extra clicks', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, FIRST_ACHIEVEMENT);
    unlockAchievement(world, SECOND_ACHIEVEMENT);

    const scene = makeScene();
    const rewardOpeningUI = createRewardOpeningUI(scene, {});
    const achievementsUI = createAchievementsUI(scene, rewardOpeningUI);
    achievementsUI.refresh(world);

    achievementsUI.openAllPendingRewards();
    expect(rewardOpeningUI.isOpen()).toBe(true);
    expect(world.achievements.claimedIds.has(FIRST_ACHIEVEMENT)).toBe(true);

    // Each individual box auto-advances, but the final aggregate summary must
    // remain visible until the player acknowledges it instead of closing on the
    // first tick after the phase flips to `summary`.
    let reachedAggregateSummary = false;
    let steps = 0;
    while (rewardOpeningUI.isOpen() && steps < MAX_TICK_STEPS) {
      steps += 1;
      const phaseBefore = rewardOpeningUI.getPhase();
      rewardOpeningUI.tick(2000);
      const phaseAfter = rewardOpeningUI.getPhase();
      if (phaseBefore !== 'summary' && phaseAfter === 'summary') {
        reachedAggregateSummary = true;
        expect(rewardOpeningUI.isOpen()).toBe(true);
      }
      if (reachedAggregateSummary && phaseAfter === 'summary') {
        rewardOpeningUI.acknowledge();
      }
    }
    expect(steps).toBeLessThan(MAX_TICK_STEPS);
    expect(reachedAggregateSummary).toBe(true);
    expect(world.achievements.claimedIds.has(FIRST_ACHIEVEMENT)).toBe(true);
    expect(world.achievements.claimedIds.has(SECOND_ACHIEVEMENT)).toBe(true);
    expect(world.achievements.pendingPresentations.size).toBe(0);
    expect(rewardOpeningUI.isOpen()).toBe(false);

    achievementsUI.destroy();
    rewardOpeningUI.destroy();
  });

  it('continues open-all after skipping each intermediate reveal', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, FIRST_ACHIEVEMENT);
    unlockAchievement(world, SECOND_ACHIEVEMENT);

    const scene = makeScene();
    const rewardOpeningUI = createRewardOpeningUI(scene, {});
    const achievementsUI = createAchievementsUI(scene, rewardOpeningUI);
    achievementsUI.refresh(world);

    achievementsUI.openAllPendingRewards();
    rewardOpeningUI.skip();

    // Skipping the first box must acknowledge it and immediately present the
    // second box without requiring another input.
    expect(rewardOpeningUI.isOpen()).toBe(true);
    expect(rewardOpeningUI.getPhase()).toBe('anticipation');
    expect(world.achievements.claimedIds.has(SECOND_ACHIEVEMENT)).toBe(true);

    rewardOpeningUI.skip();

    // The last intermediate skip immediately opens the aggregate presentation
    // without requiring another click between boxes.
    expect(rewardOpeningUI.isOpen()).toBe(true);
    expect(rewardOpeningUI.getPhase()).toBe('anticipation');
    expect(world.achievements.pendingPresentations.size).toBe(0);

    let steps = 0;
    while (rewardOpeningUI.getPhase() !== 'summary' && steps < MAX_TICK_STEPS) {
      steps += 1;
      rewardOpeningUI.tick(2000);
    }
    expect(steps).toBeLessThan(MAX_TICK_STEPS);

    // The aggregate summary is intentionally player-acknowledged rather than
    // auto-closed.
    expect(rewardOpeningUI.getPhase()).toBe('summary');

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

  it('opens pending boxes even when the active filter shows no boxes', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, FIRST_ACHIEVEMENT);
    unlockAchievement(world, SECOND_ACHIEVEMENT);

    const scene = makeScene();
    const rewardOpeningUI = createRewardOpeningUI(scene, {});
    const achievementsUI = createAchievementsUI(scene, rewardOpeningUI);
    achievementsUI.refresh(world);
    achievementsUI.setFilterForProbe('floor:2');

    achievementsUI.openAllPendingRewards();
    expect(world.achievements.claimedIds.has(FIRST_ACHIEVEMENT)).toBe(true);

    let steps = 0;
    while (rewardOpeningUI.getPhase() !== 'summary' && steps < MAX_TICK_STEPS) {
      steps += 1;
      rewardOpeningUI.tick(2000);
    }
    expect(steps).toBeLessThan(MAX_TICK_STEPS);
    rewardOpeningUI.acknowledge();

    expect(world.achievements.claimedIds.has(SECOND_ACHIEVEMENT)).toBe(true);
    expect(rewardOpeningUI.isOpen()).toBe(false);
    expect(world.achievements.pendingPresentations.size).toBe(0);

    achievementsUI.destroy();
    rewardOpeningUI.destroy();
  });
});
