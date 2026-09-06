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

function makeGameObjectStub(onDestroy?: () => void): unknown {
  const stub: unknown = new Proxy(function () {} as unknown as object, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;
      if (prop === 'width' || prop === 'height') return 64;
      if (prop === 'x' || prop === 'y' || prop === 'depth') return 0;
      if (prop === 'visible') return true;
      if (prop === 'destroy') return () => onDestroy?.();
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

function makeRecordingScene(titles: string[]): { scene: unknown; collectTitles: () => void } {
  const stub = makeGameObjectStub();
  const titleEntries: { text: string; destroyed: boolean }[] = [];
  const scene = {
    cameras: { main: { roundPixels: false } },
    add: {
      container: () => stub,
      rectangle: () => stub,
      circle: () => stub,
      image: () => stub,
      text: (_x: number, _y: number, text: string, style: { fontSize?: string }) => {
        // Row titles are the only text rendered at 15px that is NOT the reward
        // CTA. The CTA's label is a fixed string, so excluding it keeps this
        // probe isolated to achievement titles in render order.
        if (style?.fontSize === '15px' && text !== 'OPEN') {
          const entry = { text, destroyed: false };
          titleEntries.push(entry);
          return makeGameObjectStub(() => {
            entry.destroyed = true;
          });
        }
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
  const collectTitles = () => {
    titles.length = 0;
    titles.push(...titleEntries.filter((entry) => !entry.destroyed).map((entry) => entry.text));
  };
  return { scene, collectTitles };
}

/**
 * `first-bonk` sorts before `room-sweeper` in catalog order, so claiming
 * `first-bonk` while leaving `room-sweeper` unclaimed sets up the exact case
 * the naive catalog-order render would get wrong.
 */
const FIRST_CATALOG_ID = 'first-bonk';
const SECOND_CATALOG_ID = 'room-sweeper';
/** Catalog-adjacent to `first-bonk`, used for the three-way interleave case. */
const CATALOG_MIDDLE_ID = 'slime-no-more';
/** Must be tall enough to render three full achievement rows in probe mode. */
const PROBE_PANEL_HEIGHT = 900;

describe('AchievementsUI row order', () => {
  it('sorts an unopened loot box ahead of an already-claimed one earlier in catalog order', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, FIRST_CATALOG_ID);
    unlockAchievement(world, SECOND_CATALOG_ID);
    expect(claimAchievementReward(world, FIRST_CATALOG_ID).ok).toBe(true);

    const titles: string[] = [];
    const { scene, collectTitles } = makeRecordingScene(titles);
    const achievementsUI = createAchievementsUI(
      scene as never,
      { open: () => {}, isOpen: () => false } as never,
      { height: PROBE_PANEL_HEIGHT },
    );
    achievementsUI.toggle(world);
    collectTitles();

    expect(titles).toEqual(['Room Sweeper', 'First Bonk']);

    achievementsUI.destroy();
  });

  it('keeps unclaimed boxes in catalog order relative to each other', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, FIRST_CATALOG_ID);
    unlockAchievement(world, SECOND_CATALOG_ID);

    const titles: string[] = [];
    const { scene, collectTitles } = makeRecordingScene(titles);
    const achievementsUI = createAchievementsUI(
      scene as never,
      { open: () => {}, isOpen: () => false } as never,
      { height: PROBE_PANEL_HEIGHT },
    );
    achievementsUI.toggle(world);
    collectTitles();

    expect(titles).toEqual(['First Bonk', 'Room Sweeper']);

    achievementsUI.destroy();
  });

  it('sinks a claimed box below two catalog-non-adjacent unclaimed boxes, preserving their order', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    // Catalog order is: first-bonk, slime-no-more, room-sweeper (unlocked
    // out of catalog order below to prove sort doesn't depend on unlock
    // sequence either). Only the catalog-middle one is claimed.
    unlockAchievement(world, SECOND_CATALOG_ID);
    unlockAchievement(world, CATALOG_MIDDLE_ID);
    unlockAchievement(world, FIRST_CATALOG_ID);
    expect(claimAchievementReward(world, CATALOG_MIDDLE_ID).ok).toBe(true);

    const titles: string[] = [];
    const { scene, collectTitles } = makeRecordingScene(titles);
    const achievementsUI = createAchievementsUI(
      scene as never,
      { open: () => {}, isOpen: () => false } as never,
      { height: PROBE_PANEL_HEIGHT },
    );
    achievementsUI.toggle(world);
    collectTitles();

    expect(titles).toEqual(['First Bonk', 'Room Sweeper', 'Gel Exit']);

    achievementsUI.destroy();
  });
});
