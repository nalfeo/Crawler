import type { Affinity } from './affinity.js';
import type { StudioDef } from './studios.js';

const FLOOR3_STUDIO_SET_PIECE_BY_AFFINITY: Readonly<Record<Affinity, string>> = Object.freeze({
  ember: 'floor3-studio-ember',
  bloom: 'floor3-studio-bloom',
  stone: 'floor3-studio-stone',
  gale: 'floor3-studio-gale',
  tide: 'floor3-studio-tide',
  gloom: 'floor3-studio-gloom',
  lumen: 'floor3-studio-lumen',
});

export const FLOOR3_FINAL_FOUR_SET_PIECE_ID = 'floor3-final-four-arena';

export function floor3SetPieceIdForStudio(studio: Pick<StudioDef, 'affinity'>): string {
  return FLOOR3_STUDIO_SET_PIECE_BY_AFFINITY[studio.affinity];
}
