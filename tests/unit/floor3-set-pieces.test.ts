import { describe, expect, it } from 'vitest';
import type { RoomBounds } from '../../src/shared/map-types.js';
import {
  FLOOR3_FINAL_FOUR_SET_PIECE_ID,
  floor3SetPieceIdForStudio,
} from '../../src/shared/data/floor3/set-pieces.js';
import { STUDIO_CANDIDATES } from '../../src/shared/data/floor3/studios.js';
import { AFFINITY_RING } from '../../src/shared/data/floor3/affinity.js';
import {
  getSetPieceDef,
  getSetPieceFootprint,
  isStructuralSetPieceProp,
  resolveSetPieceDoorSlots,
} from '../../src/shared/set-piece-types.js';
import { stampSetPiece } from '../../src/core/map/stampSetPiece.js';

const TILE_SIZE_FT = 4;
const ROOM_BOUNDS: RoomBounds = { x: 10, y: 20, width: 14, height: 12 };

describe('Floor 3 set-piece slice', () => {
  it('defines one authored Studio motif per affinity plus the Final Four arena', () => {
    const studioSetPieceIds = AFFINITY_RING.map((affinity) =>
      floor3SetPieceIdForStudio({ affinity }),
    );
    expect(new Set(studioSetPieceIds).size).toBe(AFFINITY_RING.length);
    expect(studioSetPieceIds).toHaveLength(7);

    for (const id of [...studioSetPieceIds, FLOOR3_FINAL_FOUR_SET_PIECE_ID]) {
      const def = getSetPieceDef(id);
      expect(def, `${id} should be registered`).toBeDefined();
      expect(def?.theme).toBe('floor3-companion-league');
      expect(def?.tags).toContain('floor3');
      expect(def?.tags).toContain('companion-league');
      expect(new Set(def?.tags).size).toBe(def?.tags.length);
      expect(resolveSetPieceDoorSlots(def!)).toHaveLength(1);
    }
  });

  it('maps every Studio candidate to a registered affinity motif', () => {
    for (const studio of STUDIO_CANDIDATES) {
      const id = floor3SetPieceIdForStudio(studio);
      expect(getSetPieceDef(id), `${studio.studioId} maps to missing ${id}`).toBeDefined();
    }
  });

  it('stamps each authored Floor 3 set piece with non-structural dressing props', () => {
    for (const id of [
      ...AFFINITY_RING.map((affinity) => floor3SetPieceIdForStudio({ affinity })),
      FLOOR3_FINAL_FOUR_SET_PIECE_ID,
    ]) {
      const def = getSetPieceDef(id)!;
      const footprint = getSetPieceFootprint(def);
      expect(footprint.width).toBeLessThanOrEqual(ROOM_BOUNDS.width);
      expect(footprint.height).toBeLessThanOrEqual(ROOM_BOUNDS.height);
      const stamp = stampSetPiece(def, {
        roomBounds: ROOM_BOUNDS,
        tileSizeFt: TILE_SIZE_FT,
        anchor: 'bounds-topleft',
      });
      expect(stamp.props.length).toBeGreaterThan(0);
      expect(stamp.npcs).toHaveLength(0);
      const structuralPropIds = new Set(
        def.props.filter(isStructuralSetPieceProp).map((prop) => prop.id),
      );
      const renderedLabels = new Set(
        stamp.props
          .filter(
            (prop) => prop.render.label === undefined || !structuralPropIds.has(prop.render.label),
          )
          .map((prop) => prop.render.label),
      );
      expect(renderedLabels.has('entry-door')).toBe(false);
      expect(renderedLabels.has('champion-entry-door')).toBe(false);
      expect(renderedLabels.size).toBeGreaterThan(0);
    }
  });

  it('keeps Studio set pieces suitable for territory rooms', () => {
    for (const id of AFFINITY_RING.map((affinity) => floor3SetPieceIdForStudio({ affinity }))) {
      expect(getSetPieceDef(id)?.tags).toContain('studio-den');
    }
  });
});
