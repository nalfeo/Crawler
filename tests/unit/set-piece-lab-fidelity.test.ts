/**
 * Pins the Set Piece Lab's fidelity contract against the REAL game.
 *
 * WHY THIS EXISTS. The lab synthesizes its own room instead of running map
 * generation, so two decisions the game makes elsewhere have to be mirrored by
 * hand. Both were wrong at the same time — the lab painted the interior as cool
 * blue-grey STONE_FLOOR when the game carves warm orange SAFE_ROOM_FLOOR, and it
 * drew the `kind:'wall'`/`kind:'door'` props as blue-grey Kenney placeholder
 * sprites that the game deliberately skips — while the lab's own header claimed
 * the preview was "byte-faithful to the game".
 *
 * The result was a full session of visual review conducted against a room the
 * player never sees, plus prop briefs that named the wrong background colour. A
 * lab that renders something the game does not is worse than no lab: it launders
 * a wrong image as evidence, and "observe before done" (project rule #9) is the
 * backstop that is supposed to catch a gate going green wrongly.
 *
 * These are deterministic assertions, not an eyeball. Both rules are single
 * shared definitions imported by BOTH renderers, so the tests below check the
 * definitions rather than two copies that could drift apart.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAB_INTERIOR_TERRAIN,
  LAB_BORDER_TERRAIN,
  LAB_INTERIOR_TERRAIN,
  labInteriorTerrainFor,
} from '../../src/labs/set-piece-lab/fidelity.js';
import { TerrainType } from '../../src/shared/map-types.js';
import {
  STRUCTURAL_PROP_KINDS,
  getSetPieceDef,
  isStructuralSetPieceProp,
  type SetPiecePropKind,
} from '../../src/shared/set-piece-types.js';

const ALL_PROP_KINDS: readonly SetPiecePropKind[] = [
  'floor',
  'wall',
  'door',
  'fixture',
  'furniture',
  'decoration',
  'actor',
];

describe('structural prop predicate', () => {
  it('treats exactly wall and door as terrain-owned', () => {
    const structural = ALL_PROP_KINDS.filter((kind) => isStructuralSetPieceProp({ kind }));
    expect(structural).toEqual(['wall', 'door']);
  });

  it('leaves every dressing kind renderable', () => {
    for (const kind of ['floor', 'fixture', 'furniture', 'decoration', 'actor'] as const) {
      expect(isStructuralSetPieceProp({ kind })).toBe(false);
    }
  });

  it('exposes the same set as the exported constant', () => {
    expect([...STRUCTURAL_PROP_KINDS].sort()).toEqual(['door', 'wall']);
  });
});

describe('lab interior terrain matches what the game carves', () => {
  it('paints the welcome room as SAFE_ROOM_FLOOR, not STONE_FLOOR', () => {
    // floorScenario.tagRoomAsSafe repaints the welcome room's STONE_FLOOR tiles
    // to SAFE_ROOM_FLOOR. Confirmed in the running game (seed 42, room bounds
    // (20,64) 7x7): every interior tile reads terrain 16.
    expect(labInteriorTerrainFor('welcome-room')).toBe(TerrainType.SAFE_ROOM_FLOOR);
    expect(labInteriorTerrainFor('welcome-room')).not.toBe(TerrainType.STONE_FLOOR);
  });

  it('falls back to an ordinary carved dungeon floor for unmapped pieces', () => {
    expect(labInteriorTerrainFor('a-piece-that-does-not-exist')).toBe(DEFAULT_LAB_INTERIOR_TERRAIN);
    expect(DEFAULT_LAB_INTERIOR_TERRAIN).toBe(TerrainType.STONE_FLOOR);
  });

  it('only maps set pieces that actually exist', () => {
    // A typo'd key fails open (silently falls back to STONE_FLOOR) and would
    // reintroduce the exact wrong-background bug for that piece.
    for (const id of Object.keys(LAB_INTERIOR_TERRAIN)) {
      expect(getSetPieceDef(id), `no set piece named "${id}"`).toBeDefined();
    }
  });

  it('borders the room with wall terrain so the shell reads as carved', () => {
    expect(LAB_BORDER_TERRAIN).toBe(TerrainType.STONE_WALL);
  });
});

describe('welcome-room shell is terrain-owned, not sprite-owned', () => {
  it('has structural props that both renderers must skip', () => {
    const def = getSetPieceDef('welcome-room');
    expect(def).toBeDefined();
    const structural = (def?.props ?? []).filter(isStructuralSetPieceProp);
    // The def declares a full wall ring plus at least one door; these exist to
    // drive the composition gate and map-gen door slots, and are never drawn.
    expect(structural.length).toBeGreaterThan(0);
    expect(structural.some((prop) => prop.kind === 'door')).toBe(true);
    expect(structural.some((prop) => prop.kind === 'wall')).toBe(true);
  });

  it('leaves the dressing props renderable', () => {
    const def = getSetPieceDef('welcome-room');
    const renderable = (def?.props ?? []).filter((prop) => !isStructuralSetPieceProp(prop));
    expect(renderable.length).toBeGreaterThan(0);
  });
});
