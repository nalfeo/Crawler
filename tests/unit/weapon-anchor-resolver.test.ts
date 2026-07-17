import { describe, expect, it } from 'vitest';
import {
  resolveWeaponAnchorWorldPos,
  type GeneratedSpriteEntry,
} from '../../src/shared/generated-assets.js';

/** Build a minimal GeneratedSpriteEntry for testing. */
function makeEntry(overrides: Partial<GeneratedSpriteEntry> = {}): GeneratedSpriteEntry {
  return {
    briefId: 'test-enemy-v1',
    textureKey: 'test-enemy-v1-var-00',
    assetPath: 'assets/generated/test-enemy-v1/var-00.png',
    anchor: { x: 32, y: 32 },
    centerOfGravity: { x: 32, y: 32 },
    anchorIsDefault: false,
    approvedAt: '2026-01-01T00:00:00.000Z',
    sourceRun: 'run-01',
    variantIndex: 0,
    sensorScore: 'pass',
    judgeScore: null,
    facingDirection: 'right',
    ...overrides,
  };
}

describe('resolveWeaponAnchorWorldPos', () => {
  const ENTITY_X = 10;
  const ENTITY_Y = 20;
  const SPRITE_W_FT = 2; // sprite is 2 feet wide
  const SPRITE_H_FT = 2; // sprite is 2 feet tall
  const FRAME_W = 64;
  const FRAME_H = 64;

  it('returns entity pivot when entry is null', () => {
    const result = resolveWeaponAnchorWorldPos(
      null,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true,
    );
    expect(result).toEqual({ x: ENTITY_X, y: ENTITY_Y });
  });

  it('returns entity pivot when entry has no weaponAnchor', () => {
    const entry = makeEntry(); // no weaponAnchor field
    const result = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true,
    );
    expect(result).toEqual({ x: ENTITY_X, y: ENTITY_Y });
  });

  it('returns correct world position for explicit weapon anchor facing right', () => {
    // COG at center (32,32), weapon anchor at (40,32) — 8px right of center.
    // For a 2ft-wide, 64px-wide sprite: 8/64 * 2 = 0.25ft offset in X; 0 in Y.
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 32 },
    });
    const result = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true,
    );
    expect(result.x).toBeCloseTo(ENTITY_X + 0.25);
    expect(result.y).toBeCloseTo(ENTITY_Y + 0);
  });

  it('mirrors X when art faces right but entity faces left', () => {
    // COG at center (32,32), weapon anchor at (40,32).
    // When facing left: wpX = 63 - 40 = 23; offset = (23-32)/64*2 = -0.28125ft
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 32 },
      facingDirection: 'right',
    });
    const result = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      false, // entity facing left
    );
    // mirrored wpX = 64 - 1 - 40 = 23; offset = (23-32)/64*2 = -18/64 = -0.28125
    expect(result.x).toBeCloseTo(ENTITY_X - 0.28125);
    expect(result.y).toBeCloseTo(ENTITY_Y + 0);
  });

  it('does not mirror X when art faces left (left-art entity facing left)', () => {
    // Left-facing art: facingDirection='left', anchor stays as-is.
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 32 },
      facingDirection: 'left',
    });
    const resultLeft = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      false, // facing left — but art is already left-facing, no mirror
    );
    const resultRight = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true,
    );
    // Both directions yield the same offset since the art is already left-facing
    // and no mirroring occurs for non-right art.
    expect(resultLeft.x).toBeCloseTo(resultRight.x);
    expect(resultLeft.y).toBeCloseTo(resultRight.y);
    expect(resultLeft.x).toBeCloseTo(ENTITY_X + 0.25);
  });

  it('applies Y offset correctly', () => {
    // COG at (32,32), weapon at (32,20) — 12px above center.
    // Y offset: (20-32)/64 * 2 = -24/64 = -0.375ft (upward)
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 32, y: 20 },
    });
    const result = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true,
    );
    expect(result.x).toBeCloseTo(ENTITY_X + 0);
    expect(result.y).toBeCloseTo(ENTITY_Y - 0.375);
  });

  it('returns entity pivot when entry is undefined', () => {
    const result = resolveWeaponAnchorWorldPos(
      undefined,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true,
    );
    expect(result).toEqual({ x: ENTITY_X, y: ENTITY_Y });
  });

  it('calling with entity position (0,0) yields the canonical right-facing offset', () => {
    // This is how PhaserBridge stores the offset in entityWeaponAnchors.
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 28 },
    });
    // offsetX = (40-32)/64*2 = 0.25; offsetY = (28-32)/64*2 = -0.125
    const offset = resolveWeaponAnchorWorldPos(
      entry,
      0,
      0,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true,
    );
    expect(offset.x).toBeCloseTo(0.25);
    expect(offset.y).toBeCloseTo(-0.125);
  });
});
