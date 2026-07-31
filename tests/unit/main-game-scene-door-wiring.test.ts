import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * DELIBERATE INVERSION of the retired `main-game-scene-door-pack-wiring` test.
 *
 * That test asserted the scene resolved a per-pack `doorSet` variant and passed
 * `packDoorTextureKey` into `resolveDoorRenderMode`. Terrain packs no longer
 * carry door art, so those assertions cannot pass — and rather than deleting
 * them (which would leave the removal unguarded), they are inverted: the scene
 * must NOT reintroduce a second door geometry path.
 *
 * Source-text assertions are a blunt instrument, justified here for the same
 * reason the original was: the failure mode is a WIRING regression (a second
 * art source silently winning), which type-checks and unit-tests fine because
 * every individual branch is correct in isolation. The e2e gate in
 * `tests/e2e/unified-door-overlay.test.ts` is the behavioural guard; this is the
 * cheap structural one that fails in ~10 ms instead of after a browser boot.
 */
/**
 * Strip block and line comments so the "must NOT appear" assertions test CODE,
 * not prose. The retired symbols are deliberately named in explanatory comments
 * (that is how a future reader learns why the branch is gone); only a live
 * reference is a regression.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('MainGameScene door wiring — exactly one geometry rule', () => {
  const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
  const code = stripComments(source);

  it('has no terrain-pack door branch left', () => {
    // Each of these was load-bearing in the retired pack path. Any one of them
    // reappearing means a second art source can override the shared fit again.
    expect(code).not.toContain('resolveDoorPoolVariant');
    expect(code).not.toContain('packDoorTextureKey');
    expect(code).not.toContain('activeDoorSet');
    expect(code).not.toContain("case 'pack'");
  });

  it('routes door scale through the ONE shared contain-fit, not a bespoke divisor', () => {
    // The pack branch computed `tileSize / TERRAIN_PACK_CELL_PX` and the Kenney
    // branch `tileSize / 16`; both now go through resolveDoorContainFit. If a
    // branch reintroduces its own divisor, door size again depends on which
    // asset happened to exist.
    expect(source).toContain('resolveDoorContainFit');
    expect(code).not.toContain('TERRAIN_PACK_CELL_PX');
  });

  it('the KENNEY fallback goes through the shared fit, not its own divisor', () => {
    // The generated branch alone calling `resolveDoorContainFit` is NOT enough:
    // reintroducing `tileSize / KENNEY_DOOR_FRAME_PX` in the Kenney branch would
    // still leave the symbol present somewhere in the file and pass the check
    // above. Kenney is the branch most likely to regress because its 16x16 frame
    // contain-fits to EXACTLY the old constant — the numbers agree, so a bespoke
    // divisor produces no visible symptom until the doorway box changes.
    expect(code).toContain('KENNEY_DOOR_FRAME_PX');
    // The frame size may only ever be handed to the shared fit as a canvas
    // dimension. Any arithmetic on it is a second geometry rule by definition.
    expect(code).toContain('canvasWidth: KENNEY_DOOR_FRAME_PX');
    expect(code).toContain('canvasHeight: KENNEY_DOOR_FRAME_PX');
    expect(code).not.toMatch(/[/*+-]\s*KENNEY_DOOR_FRAME_PX/);
    expect(code).not.toMatch(/KENNEY_DOOR_FRAME_PX\s*[/*+-]/);
  });

  it('the comment-stripper is not vacuous', () => {
    // Guards the guard: if stripComments ever nuked the whole file, every
    // `not.toContain` above would pass trivially.
    expect(code).toContain('resolveDoorContainFit');
    expect(code.length).toBeGreaterThan(source.length * 0.5);
  });

  it('still resolves door orientation through the shared terrain-pack helper', () => {
    expect(source).toContain('resolveDoorOrientationFromFlanks(horizontalDoorway)');
    expect(source).toContain('resolveDoorRenderMode(isOpen, {');
  });

  it('counts cross-orientation borrows so the art gap cannot hide', () => {
    expect(source).toContain('crossOrientationCount');
  });

  it('threads floor manifest pack selection into the terrain bake path', () => {
    // Packs still own walls/floors/corridors — only their door art was retired.
    expect(source).toContain('buildTerrainLayer(this, floorMap, {');
    expect(source).toContain('terrainPacks: this.options.terrainPacks');
  });
});
