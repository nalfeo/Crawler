import type { SpriteType } from '../../src/shared/sprite-types.js';

export const SPRITE_CATEGORY_DESIGN_LANGUAGE: Readonly<Record<SpriteType, string>> = {
  weapon:
    'Classic RPG inventory weapon presentation. Show one complete weapon with a readable silhouette, upright by default, consistent grip-to-tip construction, and materials that remain legible at game scale.',
  equipment:
    'Classic RPG equipment presentation. Show one wearable item without a mannequin or character, with an immediately readable slot identity, practical construction, and a silhouette distinct from neighboring equipment categories.',
  enemy:
    'Classic RPG 3/4 orthographic enemy presentation. Default to a screen-right turn so the front and appropriate top planes of the head are simultaneously legible. This is not a symmetric direct-front view and not a 90-degree profile. Use parallel vertical/front edges and perpendicular horizontal construction: no vanishing point, foreshortening, apparent-size change, or receding perspective. An explicit brief-facing instruction overrides only the facing direction while preserving the orthographic construction.',
  item: 'Classic RPG pickup-item presentation. Show one grounded, self-contained object with a compact readable silhouette, no character hands, no scene dressing, and no implied camera perspective.',
  prop: 'Classic RPG 3/4 orthographic world-prop presentation. Show the useful front and top planes together with parallel construction, stable grounding, and no vanishing point or receding perspective.',
  tile: 'Classic RPG orthographic tile presentation. Preserve exact edge continuity, tileable construction, consistent scale, and a camera-independent surface with no vanishing point or perspective convergence.',
  vfx: 'Classic RPG gameplay-effect presentation. Use a centered, readable effect silhouette with clear timing shapes, restrained particle noise, and no environmental background or camera-dependent perspective.',
  character:
    'Classic RPG 3/4 orthographic character presentation. Keep the full body visible, the face readable, a stable floor line, parallel construction, and no vanishing point, foreshortening, or receding perspective unless an explicit directional-animation brief overrides the facing.',
  icon: 'Classic RPG icon presentation. Use one bold symbolic subject, centered and readable at very small size, with no scene, character hand, text, or camera-dependent perspective.',
};

export function spriteCategoryDesignLanguageBlock(type: SpriteType, override?: string): string {
  const categoryLanguage = override?.trim() || SPRITE_CATEGORY_DESIGN_LANGUAGE[type];
  return ['## Sprite category design language', `Category: ${type}`, categoryLanguage].join('\n');
}
