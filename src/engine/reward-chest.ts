/**
 * reward-chest — procedural rarity chest glyph for reward affordances.
 *
 * The sprite manifest has no chest art, so the chest is composed from
 * primitives instead. That keeps it deterministic, palette-locked to the loot
 * tier, and available for every tier without waiting on the art pipeline.
 *
 * Layer note: engine-only rendering helper. Imports shared types, never
 * game/labs.
 */
import type Phaser from 'phaser';
import type { AchievementReward, LootBoxTier } from '../shared/achievements.js';

/**
 * Rarity ramp for chest banding. Ordered cool→warm so a higher tier reads as
 * hotter at a glance without needing to read the label.
 */
export const LOOT_TIER_HEX: Readonly<Record<LootBoxTier, number>> = {
  trash: 0x6b7280,
  common: 0xcbd5e1,
  uncommon: 0x22c55e,
  rare: 0x3b82f6,
  epic: 0xa855f7,
  legendary: 0xf59e0b,
  divine: 0xfde68a,
};

const CHEST_WOOD = 0x2a1d14;
const CHEST_WOOD_LIT = 0x453022;
const CHEST_SHADOW = 0x14100c;

/**
 * The loot tier a reward should be chest-colored by. Non-box rewards have no
 * tier of their own, so they borrow a fixed band: an item reads as `uncommon`,
 * a Director message as `rare` (it is narrative, not loot), and `none` as
 * `trash`.
 */
export function rewardChestTier(reward: AchievementReward): LootBoxTier {
  switch (reward.type) {
    case 'lootBox':
      return reward.tier as LootBoxTier;
    case 'item':
      return 'uncommon';
    case 'directorMessage':
      return 'rare';
    case 'none':
      return 'trash';
    default:
      // A reward type added later must still draw a chest with a real accent
      // color rather than an undefined tier lookup.
      return 'trash';
  }
}

/**
 * The bounding box a chest of `size` occupies when anchored with its TOP edge
 * at `y` and centered on `x`. `createRewardChest` guarantees every drawn part
 * falls inside this box, so callers can reserve space and deterministic
 * geometry sensors can assert containment.
 */
export function rewardChestBounds(
  x: number,
  y: number,
  size: number,
): { x: number; y: number; width: number; height: number } {
  const bodyH = size * 0.5;
  const lidH = size * 0.34;
  const rawBodyCy = size * 0.2;
  // The OPEN lid hinges highest, so it defines the tallest variant; using it
  // for both states keeps the reserved footprint stable as a chest is claimed.
  const rawLidCy = rawBodyCy - bodyH / 2 - lidH * 1.55;
  const rawTop = rawLidCy - lidH * 0.58 - lidH * 0.13;
  const rawBottom = rawBodyCy + bodyH / 2 + size * 0.06 + size * 0.035;
  return { x: x - (size * 0.86) / 2 - 1, y, width: size * 0.86 + 2, height: rawBottom - rawTop };
}

export interface RewardChestOptions {
  /** Center x of the chest glyph. */
  readonly x: number;
  /** Center y of the chest glyph. */
  readonly y: number;
  /** Bounding square edge length in design pixels. */
  readonly size: number;
  readonly tier: LootBoxTier;
  /** Open chests read as already-claimed: lid lifted, contents glowing. */
  readonly open: boolean;
}

/**
 * Draws a chest and returns its parts, newest-last, so the caller can add them
 * to a container and track them for teardown. Nothing is parented here — the
 * caller owns lifetime.
 */
export function createRewardChest(
  scene: Phaser.Scene,
  options: RewardChestOptions,
): Phaser.GameObjects.Rectangle[] {
  const { x, y, size, tier, open } = options;
  const accent = LOOT_TIER_HEX[tier];
  const parts: Phaser.GameObjects.Rectangle[] = [];
  const add = (
    cx: number,
    cy: number,
    w: number,
    h: number,
    color: number,
    alpha = 1,
  ): Phaser.GameObjects.Rectangle => {
    const rect = scene.add.rectangle(
      Math.round(cx),
      Math.round(cy),
      Math.round(w),
      Math.round(h),
      color,
      alpha,
    );
    parts.push(rect);
    return rect;
  };

  // Layout is computed in units of `size` from a local origin, then shifted so
  // the union of every part starts exactly at `y`. Without this the lid (which
  // hinges upward, especially when open) renders above the caller's anchor and
  // leaks out of the row that reserved space for it.
  const bodyW = size * 0.86;
  const bodyH = size * 0.5;
  const lidH = size * 0.34;
  const rawBodyCy = size * 0.2;
  const rawLidCy = open ? rawBodyCy - bodyH / 2 - lidH * 1.55 : rawBodyCy - bodyH / 2 - lidH / 2;
  // Reserve the OPEN variant's footprint for BOTH states and align on the
  // shared bottom edge, so claiming a reward does not make the chest jump.
  const rawBottom = rawBodyCy + bodyH / 2 + size * 0.06 + size * 0.035;
  const reservedTop = rawBottom - rewardChestBounds(0, 0, size).height;
  const shift = y - reservedTop;
  const bodyCy = rawBodyCy + shift;
  const lidCy = rawLidCy + shift;

  // Ground shadow anchors the chest instead of letting it float in the row.
  add(x, bodyCy + bodyH / 2 + size * 0.06, bodyW * 0.9, size * 0.07, CHEST_SHADOW, 0.55);

  if (open) {
    // Interior glow reads as "already opened" from across the panel.
    add(x, bodyCy - bodyH / 2 - lidH * 0.45, bodyW * 0.72, lidH * 1.1, accent, 0.35);
    add(x, bodyCy - bodyH / 2 - lidH * 0.45, bodyW * 0.4, lidH * 0.7, accent, 0.6);
  }

  const body = add(x, bodyCy, bodyW, bodyH, CHEST_WOOD, 1);
  body.setStrokeStyle?.(1, accent, 0.9);
  // Iron band across the body, tinted by tier.
  add(x, bodyCy, bodyW, size * 0.1, accent, 0.9);
  // Vertical strap centers the body and reads as chest joinery, not a bar.
  add(x, bodyCy, size * 0.1, bodyH, accent, 0.55);
  add(x, bodyCy - bodyH / 2 + size * 0.05, bodyW - 2, size * 0.05, CHEST_WOOD_LIT, 0.8);

  const lid = add(x, lidCy, bodyW, lidH, CHEST_WOOD, 1);
  lid.setStrokeStyle?.(1, accent, 0.9);
  // Stepped cap: a narrower crown over a full-width lid reads as a domed chest
  // lid instead of a second stacked crate.
  add(x, lidCy - lidH * 0.42, bodyW * 0.78, lidH * 0.34, CHEST_WOOD_LIT, 1);
  add(x, lidCy - lidH * 0.58, bodyW * 0.52, lidH * 0.26, CHEST_WOOD_LIT, 1);
  add(x, lidCy - lidH / 2 + size * 0.04, bodyW - 2, size * 0.04, accent, 0.55);
  add(x, lidCy, size * 0.1, lidH, accent, 0.55);

  if (!open) {
    // Clasp + keyhole only read on a closed chest; an open one has no lock face.
    add(x, bodyCy - bodyH / 2, size * 0.2, lidH * 0.6, accent, 1);
    add(x, bodyCy - bodyH / 2 + size * 0.015, size * 0.06, size * 0.09, CHEST_SHADOW, 1);
  }

  return parts;
}
