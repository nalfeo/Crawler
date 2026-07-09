import { SPRITE_TYPES, type Brief } from './brief-schema.js';

type SpriteType = Brief['type'];

const BRIEF_DIRECTORY_BY_TYPE: Readonly<Record<SpriteType, string>> = {
  weapon: 'weapons',
  enemy: 'enemies',
  item: 'items',
  tile: 'tiles',
  vfx: 'vfx',
  character: 'characters',
};

export function isSpriteType(value: string): value is SpriteType {
  return (SPRITE_TYPES as readonly string[]).includes(value);
}

export function briefDirectoryForType(type: SpriteType): string {
  return BRIEF_DIRECTORY_BY_TYPE[type];
}
