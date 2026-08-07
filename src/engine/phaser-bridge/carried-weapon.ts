/**
 * Carried (idle) main-hand weapon rendering helpers.
 *
 * The melee-swing branch in `PhaserBridge` only draws a weapon sprite while a
 * `MeleeSwing` entity is alive, so between swings — and for every non-melee
 * weapon — the player appeared empty-handed. These pure helpers describe the
 * art and the placement of a persistent "carried" weapon sprite that hangs off
 * the player's hand whenever a main-hand weapon is equipped.
 *
 * Pure + Phaser-free so the geometry can be unit-tested without a scene.
 * Pixels are legal here: this is the engine layer (see ADR 0023).
 */
import { WeaponType, type WeaponTypeValue } from '../../shared/constants.js';

/**
 * Kenney placeholder sprite id for a weapon that has no approved generated art.
 *
 * Only melee weapons get a placeholder: the Kenney tiny-dungeon sheet has a
 * sword and a mallet, and drawing a sword in the hand of a bow user would be a
 * lie. Non-melee weapons render only when real generated art resolves.
 */
export function kenneyCarriedWeaponSpriteId(
  weaponId: string,
  weaponType: WeaponTypeValue,
): string | null {
  if (weaponId === 'baseball-bat') {
    return 'weapon.bat';
  }
  if (weaponType === WeaponType.MELEE) {
    return 'weapon.sword';
  }
  return null;
}

/**
 * Visual length (in feet) of the carried weapon. Melee weapons are drawn at
 * their swing reach so the carried sprite matches the swing sprite; every other
 * weapon type uses a neutral hand-prop length.
 */
export const DEFAULT_CARRIED_WEAPON_LENGTH_FT = 2.5;

export function carriedWeaponLengthFt(weapon: {
  readonly weaponType: WeaponTypeValue;
  readonly aoeRadius: number;
}): number {
  if (weapon.weaponType === WeaponType.MELEE && weapon.aoeRadius > 0) {
    return weapon.aoeRadius;
  }
  return DEFAULT_CARRIED_WEAPON_LENGTH_FT;
}

/**
 * Minimum scale for the 16x16 Kenney placeholder so a short weapon stays
 * readable. Mirrors `MIN_WEAPON_SPRITE_SCALE` in the swing branch; generated
 * art already ships at 32/64 px so it is never clamped.
 */
export const MIN_CARRIED_WEAPON_SPRITE_SCALE = 1.8;

/** Horizontal hand offset from the player's centre, in feet. */
export const CARRIED_WEAPON_HAND_OFFSET_FT = 0.55;
/** Vertical hand offset from the player's centre, in feet (positive = down). */
export const CARRIED_WEAPON_HAND_DROP_FT = 0.15;
/**
 * Resting tilt of the carried weapon, in radians. The sprite's local "up"
 * (0,-1) is the blade tip, so a positive rotation tips the tip toward the
 * facing side; the sign is mirrored when the player faces left.
 */
export const CARRIED_WEAPON_TILT_RAD = 0.45;

export interface CarriedWeaponPlacement {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
}

/**
 * Placement for the carried weapon sprite.
 *
 * The sprite's origin is pinned to its hold anchor (the grip pixel) so the
 * weapon rotates around the hand exactly like the swing sprite does, and the
 * scale maps the anchor→tip distance (`holdY`) onto the desired on-screen
 * length so the drawn weapon is the right size for its reach.
 */
export function computeCarriedWeaponPlacement(input: {
  readonly playerX: number;
  readonly playerY: number;
  readonly facingRight: boolean;
  readonly handOffsetPx: number;
  readonly handDropPx: number;
  readonly lengthPx: number;
  readonly holdX: number;
  readonly holdY: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly clampMinScale: boolean;
}): CarriedWeaponPlacement {
  const rawScale = input.holdY > 0 ? input.lengthPx / input.holdY : 1;
  const scale =
    input.clampMinScale && rawScale < MIN_CARRIED_WEAPON_SPRITE_SCALE
      ? MIN_CARRIED_WEAPON_SPRITE_SCALE
      : rawScale;
  const dirSign = input.facingRight ? 1 : -1;
  return {
    x: input.playerX + dirSign * input.handOffsetPx,
    y: input.playerY + input.handDropPx,
    rotation: dirSign * CARRIED_WEAPON_TILT_RAD,
    scale,
    originX: input.frameWidth > 0 ? input.holdX / input.frameWidth : 0.5,
    originY: input.frameHeight > 0 ? input.holdY / input.frameHeight : 1,
  };
}
