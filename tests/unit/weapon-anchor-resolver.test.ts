import { describe, expect, it } from 'vitest';
import {
  computeNormalizedWeaponAnchor,
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
    // relX = 8; offsetX = 8/64 * 2 = 0.25ft; Y offset = 0.
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

  it('mirrors X by negating the relative offset when right-art entity faces left', () => {
    // COG at center (32,32), weapon anchor at (40,32).
    // Right-art, entity facing left → needsMirror=true → offsetX = -8/64*2 = -0.25ft.
    // (No asymmetric -1 pixel; we negate the relative offset, not mirror the pixel coordinate.)
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
    expect(result.x).toBeCloseTo(ENTITY_X - 0.25);
    expect(result.y).toBeCloseTo(ENTITY_Y + 0);
  });

  it('does not mirror X when art faces left and entity faces left', () => {
    // Left-facing art, entity facing left: facingDirection='left', facingRight=false.
    // needsMirror = ('left' !== 'left') = false → offsetX = relX/frameW * spriteW = +0.25ft.
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 32 },
      facingDirection: 'left',
    });
    const result = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      false, // facing left — same as art direction, no mirror
    );
    expect(result.x).toBeCloseTo(ENTITY_X + 0.25);
    expect(result.y).toBeCloseTo(ENTITY_Y + 0);
  });

  it('mirrors X when art faces left and entity faces right', () => {
    // Left-facing art, entity facing right: needsMirror = ('left' !== 'right') = true.
    // offsetX = -relX/frameW * spriteW = -0.25ft.
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 32 },
      facingDirection: 'left',
    });
    const result = resolveWeaponAnchorWorldPos(
      entry,
      ENTITY_X,
      ENTITY_Y,
      SPRITE_W_FT,
      SPRITE_H_FT,
      FRAME_W,
      FRAME_H,
      true, // entity facing right — art is left, needs mirror
    );
    expect(result.x).toBeCloseTo(ENTITY_X - 0.25);
    expect(result.y).toBeCloseTo(ENTITY_Y + 0);
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
    // Game-layer consumers call resolveWeaponAnchorWorldPos with entity=(0,0) to get
    // the pure offset, then apply facingRight/mirror at usage time.
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 28 },
    });
    // relX = 8, relY = -4; offsetX = 8/64*2 = 0.25; offsetY = -4/64*2 = -0.125
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

describe('computeNormalizedWeaponAnchor', () => {
  it('returns null when entry has no weaponAnchor', () => {
    const entry = makeEntry();
    expect(computeNormalizedWeaponAnchor(entry)).toBeNull();
  });

  it('computes correct normalized offsets', () => {
    // COG at (32,32), weapon at (40,28), frame 64×64.
    // relX = (40-32)/64 = 0.125, relY = (28-32)/64 = -0.0625
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 28 },
      facingDirection: 'right',
    });
    const result = computeNormalizedWeaponAnchor(entry, 64, 64);
    expect(result).not.toBeNull();
    expect(result!.relX).toBeCloseTo(0.125);
    expect(result!.relY).toBeCloseTo(-0.0625);
    expect(result!.artFacing).toBe('right');
  });

  it('preserves left artFacing for left-art sprites', () => {
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 24, y: 32 },
      facingDirection: 'left',
    });
    const result = computeNormalizedWeaponAnchor(entry, 64, 64);
    expect(result!.artFacing).toBe('left');
    expect(result!.relX).toBeCloseTo(-0.125); // weapon left of COG
  });

  it('uses the default frame size (64) when no frame size is provided', () => {
    // COG at (32,32), weapon at (40,28). Default frame = 64px.
    // Same calc as explicit 64x64.
    const entry = makeEntry({
      centerOfGravity: { x: 32, y: 32 },
      weaponAnchor: { x: 40, y: 28 },
    });
    const withDefault = computeNormalizedWeaponAnchor(entry);
    const withExplicit = computeNormalizedWeaponAnchor(entry, 64, 64);
    expect(withDefault).toEqual(withExplicit);
  });
});
