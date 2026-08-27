import { describe, expect, it } from 'vitest';
import {
  ENTITY_DEPTH,
  PLAYER_DEPTH,
  TERRAIN_DEPTH,
  WORLD_VFX_DEPTH,
  setPieceZToDepth,
} from '../../src/shared/render-depths.js';
import { PROP_KIND_Z } from '../../src/shared/set-piece-types.js';

describe('setPieceZToDepth', () => {
  it('keeps low-z background props above terrain but below entities', () => {
    for (const z of [PROP_KIND_Z.floor, 6, 8, 9, PROP_KIND_Z.wall]) {
      const depth = setPieceZToDepth(z);
      expect(depth).toBeGreaterThan(TERRAIN_DEPTH);
      expect(depth).toBeLessThan(ENTITY_DEPTH);
    }
  });

  it('places high-z foreground props in front of entities but below gore VFX', () => {
    for (const z of [
      PROP_KIND_Z.fixture,
      PROP_KIND_Z.furniture,
      PROP_KIND_Z.decoration,
      PROP_KIND_Z.actor,
    ]) {
      const depth = setPieceZToDepth(z);
      expect(depth).toBeGreaterThan(ENTITY_DEPTH);
      expect(depth).toBeLessThan(WORLD_VFX_DEPTH.gore);
    }
  });

  it('renders a floor rug beneath a wall banner (both background)', () => {
    // rug z=0, banner z=6 in the authored welcome room.
    expect(setPieceZToDepth(0)).toBeLessThan(setPieceZToDepth(6));
  });

  it('renders a bookcase (z=9) behind an NPC standing on the entity plane', () => {
    expect(setPieceZToDepth(9)).toBeLessThan(ENTITY_DEPTH);
  });

  it('renders a door-kind prop (z=12) behind entities like other structural props', () => {
    // door sits in the structural/backdrop band with floor + wall, so an NPC in
    // the doorway draws in front of it rather than being buried behind.
    expect(setPieceZToDepth(PROP_KIND_Z.door)).toBeLessThan(ENTITY_DEPTH);
    expect(setPieceZToDepth(PROP_KIND_Z.door)).toBeGreaterThan(TERRAIN_DEPTH);
  });

  it('renders a welcome desk (z=30) in front of the NPC it fronts', () => {
    expect(setPieceZToDepth(30)).toBeGreaterThan(ENTITY_DEPTH);
  });

  it('keeps the player above all set-piece foreground props but below world VFX', () => {
    expect(PLAYER_DEPTH).toBeGreaterThan(setPieceZToDepth(PROP_KIND_Z.actor));
    expect(PLAYER_DEPTH).toBeLessThan(WORLD_VFX_DEPTH.gore);
  });

  it('clamps out-of-ladder authored z so no prop can reach the player plane', () => {
    // `propSourceSchema` accepts any integer z, so the mapper — not the schema —
    // is what guarantees the player stays on top. z=60 would otherwise map
    // exactly onto PLAYER_DEPTH and anything above it strictly higher.
    for (const z of [PROP_KIND_Z.actor, 51, 60, 100, 10_000]) {
      const depth = setPieceZToDepth(z);
      expect(depth).toBe(setPieceZToDepth(PROP_KIND_Z.actor));
      expect(depth).toBe(5);
      // Even with the whole per-layer stamping epsilon budget (<0.1) added.
      expect(depth + 0.1).toBeLessThan(PLAYER_DEPTH);
    }
  });

  it('is monotonic non-decreasing across the prop-kind z ladder', () => {
    const ladder = [0, 6, 8, 9, 10, 20, 30, 40, 50];
    for (let i = 1; i < ladder.length; i += 1) {
      expect(setPieceZToDepth(ladder[i]!)).toBeGreaterThanOrEqual(setPieceZToDepth(ladder[i - 1]!));
    }
  });

  it('is deterministic (pure)', () => {
    expect(setPieceZToDepth(30)).toBe(setPieceZToDepth(30));
  });
});
