import { SpriteTextureId } from './constants.js';

export const FIXED_STARTER_CHOICE_COUNT = 3;

const MELEE_ATTACK_TEXTURE_BY_WEAPON_ID = new Map<string, number>([
  ['sword', SpriteTextureId.STARTER_SWORD],
  ['baseball-bat', SpriteTextureId.BASEBALL_BAT],
]);

const PROJECTILE_TEXTURE_BY_WEAPON_ID = new Map<string, number>([
  ['bow', SpriteTextureId.BOW_ARROW],
]);

const PROJECTILE_SPRITE_SIZE_BY_TEXTURE_ID = new Map<number, number>([
  [SpriteTextureId.BOW_ARROW, 12],
]);

export function getMeleeAttackTextureId(weaponId: string): number {
  return MELEE_ATTACK_TEXTURE_BY_WEAPON_ID.get(weaponId) ?? SpriteTextureId.DEFAULT;
}

export function getProjectileTextureId(weaponId: string): number {
  return PROJECTILE_TEXTURE_BY_WEAPON_ID.get(weaponId) ?? SpriteTextureId.DEFAULT;
}

export function getProjectileSpriteSize(textureId: number): number {
  return PROJECTILE_SPRITE_SIZE_BY_TEXTURE_ID.get(textureId) ?? 6;
}
