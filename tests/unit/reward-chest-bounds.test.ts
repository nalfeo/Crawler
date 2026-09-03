import { describe, expect, it } from 'vitest';
import {
  rewardChestBounds,
  rewardChestTier,
  LOOT_TIER_HEX,
} from '../../src/engine/reward-chest.js';

/**
 * The Awards pane reserves space for a reward chest using `rewardChestBounds`
 * and publishes that same box to the visual-review sensors. If the bounds ever
 * under-report the drawn footprint, the chest visibly leaks out of its row
 * (observed 2026-08-28), so the contract is pinned here.
 */
describe('rewardChestBounds', () => {
  it('anchors the box at the requested top edge and centers it on x', () => {
    const box = rewardChestBounds(100, 40, 58);
    expect(box.y).toBe(40);
    expect(box.x + box.width / 2).toBeCloseTo(100, 5);
  });

  it('scales with size', () => {
    const small = rewardChestBounds(0, 0, 30);
    const large = rewardChestBounds(0, 0, 60);
    // Height is purely proportional; width carries a constant stroke allowance.
    expect(large.height / small.height).toBeCloseTo(2, 5);
    expect(large.width).toBeGreaterThan(small.width);
  });

  it('reserves the same footprint whether the chest is open or closed', () => {
    // The open lid hinges higher than the closed one; both states must occupy
    // one stable box so claiming a reward never shifts the row layout.
    const box = rewardChestBounds(0, 0, 58);
    expect(box.height).toBeGreaterThan(58 * 0.5);
  });

  it('is tall enough to contain the open lid stack', () => {
    const size = 58;
    const box = rewardChestBounds(0, 0, size);
    const bodyH = size * 0.5;
    const lidH = size * 0.34;
    const rawBodyCy = size * 0.2;
    const openLidCy = rawBodyCy - bodyH / 2 - lidH * 1.55;
    const highestDrawnEdge = openLidCy - lidH * 0.58 - lidH * 0.13;
    const lowestDrawnEdge = rawBodyCy + bodyH / 2 + size * 0.06 + size * 0.035;
    expect(box.height).toBeGreaterThanOrEqual(lowestDrawnEdge - highestDrawnEdge - 1e-6);
  });
});

describe('rewardChestTier', () => {
  it('maps loot-box rewards to their own tier', () => {
    expect(rewardChestTier({ type: 'lootBox', lootTable: 'floor1-materials', tier: 'rare' })).toBe(
      'rare',
    );
    expect(rewardChestTier({ type: 'lootBox', lootTable: 'floor1-materials', tier: 'trash' })).toBe(
      'trash',
    );
  });

  it('falls back to a defined tier for non-lootBox rewards', () => {
    const tier = rewardChestTier({ type: 'cosmetic' } as never);
    expect(LOOT_TIER_HEX[tier]).toBeTypeOf('number');
  });
});
