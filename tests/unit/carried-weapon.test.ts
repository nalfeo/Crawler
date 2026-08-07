import { describe, expect, it } from 'vitest';
import {
  CARRIED_WEAPON_TILT_RAD,
  DEFAULT_CARRIED_WEAPON_LENGTH_FT,
  MIN_CARRIED_WEAPON_SPRITE_SCALE,
  carriedWeaponLengthFt,
  computeCarriedWeaponPlacement,
  kenneyCarriedWeaponSpriteId,
} from '../../src/engine/phaser-bridge/carried-weapon.js';
import { WeaponType } from '../../src/shared/constants.js';

describe('kenneyCarriedWeaponSpriteId', () => {
  it('uses the mallet placeholder for the baseball bat', () => {
    expect(kenneyCarriedWeaponSpriteId('baseball-bat', WeaponType.MELEE)).toBe('weapon.bat');
  });

  it('uses the sword placeholder for other melee weapons', () => {
    expect(kenneyCarriedWeaponSpriteId('knife', WeaponType.MELEE)).toBe('weapon.sword');
  });

  it('has no placeholder for non-melee weapons (never draw a sword for a bow)', () => {
    expect(kenneyCarriedWeaponSpriteId('bow', WeaponType.RANGED)).toBeNull();
    expect(kenneyCarriedWeaponSpriteId('fireball', WeaponType.MAGIC)).toBeNull();
  });
});

describe('carriedWeaponLengthFt', () => {
  it('draws a melee weapon at its swing reach', () => {
    expect(carriedWeaponLengthFt({ weaponType: WeaponType.MELEE, aoeRadius: 4 })).toBe(4);
  });

  it('falls back to the neutral hand-prop length for non-melee or reachless weapons', () => {
    expect(carriedWeaponLengthFt({ weaponType: WeaponType.RANGED, aoeRadius: 0 })).toBe(
      DEFAULT_CARRIED_WEAPON_LENGTH_FT,
    );
    expect(carriedWeaponLengthFt({ weaponType: WeaponType.MELEE, aoeRadius: 0 })).toBe(
      DEFAULT_CARRIED_WEAPON_LENGTH_FT,
    );
  });
});

describe('computeCarriedWeaponPlacement', () => {
  const base = {
    playerX: 100,
    playerY: 200,
    facingRight: true,
    handOffsetPx: 8,
    handDropPx: 2,
    lengthPx: 40,
    holdX: 8,
    holdY: 14,
    frameWidth: 16,
    frameHeight: 16,
    clampMinScale: false,
  };

  it('pins the grip anchor to the hand on the facing side', () => {
    const placement = computeCarriedWeaponPlacement(base);
    expect(placement.x).toBe(108);
    expect(placement.y).toBe(202);
    expect(placement.originX).toBeCloseTo(0.5, 5);
    expect(placement.originY).toBeCloseTo(14 / 16, 5);
  });

  it('mirrors offset and tilt when facing left', () => {
    const placement = computeCarriedWeaponPlacement({ ...base, facingRight: false });
    expect(placement.x).toBe(92);
    expect(placement.rotation).toBeCloseTo(-CARRIED_WEAPON_TILT_RAD, 5);
  });

  it('scales the anchor-to-tip distance onto the requested length', () => {
    expect(computeCarriedWeaponPlacement(base).scale).toBeCloseTo(40 / 14, 5);
  });

  it('clamps the placeholder scale so a short weapon stays readable', () => {
    const placement = computeCarriedWeaponPlacement({
      ...base,
      lengthPx: 4,
      clampMinScale: true,
    });
    expect(placement.scale).toBe(MIN_CARRIED_WEAPON_SPRITE_SCALE);
  });

  it('never clamps generated art (its tip would decouple from the intended length)', () => {
    const placement = computeCarriedWeaponPlacement({
      ...base,
      lengthPx: 44,
      holdY: 60,
      frameWidth: 64,
      frameHeight: 64,
      clampMinScale: false,
    });
    expect(placement.scale).toBeCloseTo(44 / 60, 5);
  });

  it('degrades to a centred origin when the frame size is unknown', () => {
    const placement = computeCarriedWeaponPlacement({
      ...base,
      frameWidth: 0,
      frameHeight: 0,
    });
    expect(placement.originX).toBe(0.5);
    expect(placement.originY).toBe(1);
    expect(placement.scale).toBeCloseTo(40 / 14, 5);
  });
});
