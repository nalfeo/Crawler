import { SPRITE_TYPES } from './brief-schema.js';
export const BRIEF_DIRECTORY_BY_TYPE = {
  weapon: 'weapons',
  enemy: 'enemies',
  item: 'items',
  tile: 'tiles',
  vfx: 'vfx',
  character: 'characters',
};
export function isSpriteType(value) {
  return SPRITE_TYPES.includes(value);
}
export function briefDirectoryForType(type) {
  return BRIEF_DIRECTORY_BY_TYPE[type];
}
//# sourceMappingURL=brief-paths.js.map
