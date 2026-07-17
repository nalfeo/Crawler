/**
 * Tests for the candidate scorer. Exercises the full pipeline via the
 * existing builders: build a raw fixture -> postprocess -> score.
 *
 * The fixtures in tests/fixtures/sprites/builders.ts are tuned to exhibit
 * specific sensor failures (empty, solid block, horizontal bar, tiny dot),
 * so the scorecard breakdown should reflect exactly those failures.
 */

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  briefSchema,
  type Brief,
  type PaletteColors,
} from '../../../scripts/sprites/brief-schema.js';
import { postprocess } from '../../../scripts/sprites/postprocess.js';
import { scoreCandidate } from '../../../scripts/sprites/score-candidate.js';
import {
  buildEmptyFixture,
  buildGoodSwordFixture,
  buildHorizontalBarFixture,
  buildSolidBlockFixture,
  buildTinyDotFixture,
} from '../../fixtures/sprites/builders.js';

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [160, 192, 192],
  [192, 192, 200],
  [255, 255, 255],
];

function makeBrief(overrides: Partial<Brief> = {}): Brief {
  return briefSchema.parse({
    type: 'weapon',
    name: 'iron-sword',
    size: { width: 16, height: 16 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 8, y: 8 },
    tags: ['sword'],
    prompt: 'iron sword',
    references: [
      { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
      { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
    ],
    // The "good sword" fixture used by these tests is a diagonal silhouette;
    // pin the brief to diagonal orientation so the default vertical-only
    // sensor doesn't reject it. Tests that exercise other orientations
    // override this field explicitly.
    sensors: { weapon: { orientation: 'diagonal' } },
    ...overrides,
  });
}

function buildProcessedFixture(
  width: number,
  height: number,
  pixels: ReadonlyArray<readonly [number, number]>,
): Buffer {
  const png = new PNG({ width, height });
  for (const [x, y] of pixels) {
    const idx = (y * width + x) * 4;
    png.data[idx] = PALETTE[1]![0];
    png.data[idx + 1] = PALETTE[1]![1];
    png.data[idx + 2] = PALETTE[1]![2];
    png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

function rectPixels(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ReadonlyArray<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) out.push([x, y] as const);
  }
  return out;
}

describe('scoreCandidate', () => {
  it('a good sword fixture passes every sensor', () => {
    const brief = makeBrief();
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    expect(card.passed).toBe(true);
    expect(card.score).toBe(card.outOf);
    expect(card.breakdown.every((r) => r.ok)).toBe(true);
  });

  it('an empty fixture fails the bbox sensor and is reported in the breakdown', () => {
    const brief = makeBrief();
    const processed = postprocess(buildEmptyFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    expect(card.passed).toBe(false);
    const fails = card.breakdown.filter((r) => !r.ok).map((r) => r.sensor);
    expect(fails).toContain('opaque-bbox-fits');
  });

  it('a solid-block fixture fails the opaque-ratio sensor', () => {
    const brief = makeBrief();
    const processed = postprocess(buildSolidBlockFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    expect(card.passed).toBe(false);
    const fails = card.breakdown.filter((r) => !r.ok).map((r) => r.sensor);
    expect(fails).toContain('opaque-ratio');
  });

  it('a horizontal-bar fixture fails the weapon orientation sensor', () => {
    const brief = makeBrief();
    const processed = postprocess(buildHorizontalBarFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const fails = card.breakdown.filter((r) => !r.ok).map((r) => r.sensor);
    expect(fails).toContain('silhouette-orientation-axis');
  });

  it('a tiny-dot fixture is scaled up by the trim phase and rejected by orientation', () => {
    // Before the trim phase a compact tiny dot stayed tiny and tripped the
    // opaque-ratio "below min" guard. The trim phase now crops to the subject
    // and the resize scales it up to fill the frame, so opaque-ratio passes;
    // the featureless square silhouette is instead rejected by the orientation
    // sensor. (A genuinely sparse final sprite is still caught — see the
    // directly-scored case below.)
    const brief = makeBrief();
    const processed = postprocess(buildTinyDotFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    expect(card.passed).toBe(false);
    const opaqueResult = card.breakdown.find((r) => r.sensor === 'opaque-ratio');
    expect(opaqueResult?.ok).toBe(true);
    const fails = card.breakdown.filter((r) => !r.ok).map((r) => r.sensor);
    expect(fails).toContain('silhouette-orientation-axis');
  });

  it('a sparse final sprite still fails the opaque-ratio sensor (below min)', () => {
    // Scored directly (no postprocess), so the trim/scale-up does not run:
    // a single opaque pixel in a 16x16 frame is well under the 0.1 min.
    const brief = makeBrief();
    const sparse = buildProcessedFixture(16, 16, [[8, 8]]);
    const card = scoreCandidate(sparse, brief, PALETTE);
    expect(card.passed).toBe(false);
    const opaqueFail = card.breakdown.find((r) => !r.ok && r.sensor === 'opaque-ratio');
    expect(opaqueFail).toBeDefined();
    expect(opaqueFail && !opaqueFail.ok ? opaqueFail.reason : '').toMatch(/0\.1/);
  });

  it('non-weapon briefs do not run the weapon sensors', () => {
    const brief = makeBrief({ type: 'item' });
    const processed = postprocess(buildHorizontalBarFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const sensors = card.breakdown.map((r) => r.sensor);
    expect(sensors).not.toContain('silhouette-orientation-axis');
  });

  it('enemy briefs derive anchors from center of mass without orientation gating', () => {
    const body = buildProcessedFixture(16, 16, rectPixels(6, 4, 9, 11));
    const brief = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: {
        enemy: { facing: 'front' },
        anchor: { mode: 'center-of-mass' },
      } as Brief['sensors'],
    });
    const card = scoreCandidate(body, brief, PALETTE);
    expect(card.breakdown.map((r) => r.sensor)).toContain('anchor-center-of-mass');
    expect(card.breakdown.map((r) => r.sensor)).not.toContain('silhouette-orientation-axis');
    expect(card.derivedAnchor).toEqual({ x: 7, y: 7 });
  });

  it('enemy briefs ignore orientation-axis even when facing is front', () => {
    const brief = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: {
        enemy: { facing: 'front' },
        anchor: { mode: 'center-of-mass' },
      } as Brief['sensors'],
    });
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    expect(card.breakdown.map((r) => r.sensor)).not.toContain('silhouette-orientation-axis');
  });

  it('rejects source-cell clipping that final trim and re-padding would hide', () => {
    const brief = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: {
        edge: {
          allowMainTouch: false,
          allowDetachedEdgeComponents: false,
          maxDetachedEdgePixels: 0,
        },
        enemy: { facing: 'front' },
        anchor: { mode: 'center-of-mass' },
      } as Brief['sensors'],
    });
    const source = buildProcessedFixture(16, 16, rectPixels(0, 3, 7, 12));
    const normalized = buildProcessedFixture(16, 16, rectPixels(4, 3, 11, 12));
    const card = scoreCandidate(normalized, brief, PALETTE, { sourcePng: source });

    expect(card.breakdown.find((r) => r.sensor === 'opaque-bbox-fits')?.ok).toBe(true);
    const sourceEdge = card.breakdown.find((r) => r.sensor === 'source-opaque-bbox-fits');
    expect(sourceEdge?.ok).toBe(false);
    expect(sourceEdge && !sourceEdge.ok ? sourceEdge.reason : '').toMatch(
      /main silhouette touches frame edge/,
    );
  });

  it('exempts tiles from the source-cell edge gate', () => {
    const brief = makeBrief({
      type: 'tile',
      sensors: {
        edge: {
          allowMainTouch: true,
          allowDetachedEdgeComponents: true,
          maxDetachedEdgePixels: 0,
        },
      } as Brief['sensors'],
    });
    const edgeToEdge = buildProcessedFixture(16, 16, rectPixels(0, 0, 15, 15));
    const card = scoreCandidate(edgeToEdge, brief, PALETTE, { sourcePng: edgeToEdge });
    expect(card.breakdown.find((r) => r.sensor === 'source-opaque-bbox-fits')).toEqual({
      ok: true,
      sensor: 'source-opaque-bbox-fits',
    });
  });

  it('character briefs stay front-facing when an enemy sensor block omits facing', () => {
    const brief = briefSchema.parse({
      type: 'character',
      name: 'iron-sword',
      size: { width: 16, height: 16 },
      palette: { id: 'kenney-roguelike' },
      anchor: { x: 8, y: 8 },
      tags: ['sword'],
      prompt: 'iron sword',
      references: [
        { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
        { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
      ],
      sensors: {
        enemy: {},
        anchor: { mode: 'center-of-mass' },
      },
    });
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    expect(card.breakdown.find((r) => r.sensor === 'silhouette-orientation-axis')?.ok).toBe(false);
  });

  it('honors a brief override that relaxes the opaque-ratio max', () => {
    // The solid-block fixture normally fails opaque-ratio; bumping max to 1.0
    // should let it pass that sensor specifically.
    const brief = makeBrief({
      sensors: { opaqueRatio: { max: 1.0 } } as Brief['sensors'],
    });
    const processed = postprocess(buildSolidBlockFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const opaqueResult = card.breakdown.find((r) => r.sensor === 'opaque-ratio');
    expect(opaqueResult?.ok).toBe(true);
  });

  it('honors a brief override that disables opaque-ratio entirely', () => {
    // The solid-block fixture normally fails opaque-ratio; disabling it should
    // force this sensor to pass for the brief.
    const brief = makeBrief({
      sensors: { opaqueRatio: { disabled: true } } as Brief['sensors'],
    });
    const processed = postprocess(buildSolidBlockFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const opaqueResult = card.breakdown.find((r) => r.sensor === 'opaque-ratio');
    expect(opaqueResult?.ok).toBe(true);
  });

  it('honors a brief override that tightens the weapon diagonal tolerance', () => {
    // Default tolerance is 2°. With a 30° tolerance, even a near-horizontal
    // bar should fail because the cone around horizontal grows.
    const brief = makeBrief({
      sensors: {
        weapon: { orientation: 'diagonal', diagonalToleranceDeg: 30 },
      } as Brief['sensors'],
    });
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    // The good sword's axis is near 45°, which is outside even a 30° cone
    // around horizontal/vertical, so it should still pass.
    expect(card.breakdown.find((r) => r.sensor === 'silhouette-orientation-axis')?.ok).toBe(true);
  });

  it('defaults the weapon orientation to vertical when the brief omits it', () => {
    // A diagonal sword fixture should FAIL the default vertical-only check.
    const brief = makeBrief({
      sensors: { weapon: {} } as Brief['sensors'], // explicit empty weapon block
    });
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const orient = card.breakdown.find((r) => r.sensor === 'silhouette-orientation-axis');
    expect(orient?.ok).toBe(false);
  });

  it('orientation "any" passes regardless of measured axis', () => {
    const brief = makeBrief({
      sensors: { weapon: { orientation: 'any' } } as Brief['sensors'],
    });
    const processed = postprocess(buildHorizontalBarFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const orient = card.breakdown.find((r) => r.sensor === 'silhouette-orientation-axis');
    expect(orient?.ok).toBe(true);
  });

  it('orientation "horizontal" passes a horizontal bar', () => {
    const brief = makeBrief({
      sensors: { weapon: { orientation: 'horizontal' } } as Brief['sensors'],
    });
    const processed = postprocess(buildHorizontalBarFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const orient = card.breakdown.find((r) => r.sensor === 'silhouette-orientation-axis');
    expect(orient?.ok).toBe(true);
  });

  it('produces a stable breakdown order for a given brief type', () => {
    const brief = makeBrief();
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card1 = scoreCandidate(processed, brief, PALETTE);
    const card2 = scoreCandidate(processed, brief, PALETTE);
    expect(card1.breakdown.map((r) => r.sensor)).toEqual(card2.breakdown.map((r) => r.sensor));
  });

  it('rejects variants whose main silhouette is clipped by the frame edge', () => {
    const clipped = buildProcessedFixture(16, 16, rectPixels(6, 0, 10, 10));
    const brief = makeBrief({
      type: 'item',
      anchor: { x: 8, y: 8 },
      sensors: {} as Brief['sensors'],
    });
    const card = scoreCandidate(clipped, brief, PALETTE);
    const edgeResult = card.breakdown.find((r) => r.sensor === 'opaque-bbox-fits');
    expect(edgeResult?.ok).toBe(false);
    expect(edgeResult && !edgeResult.ok ? edgeResult.reason : '').toContain('main silhouette');
  });

  it('rejects detached edge fragments as bleed artifacts', () => {
    const pixels = [...rectPixels(5, 5, 10, 12), [0, 0] as const];
    const withArtifact = buildProcessedFixture(16, 16, pixels);
    const brief = makeBrief({
      type: 'item',
      anchor: { x: 8, y: 8 },
      sensors: {} as Brief['sensors'],
    });

    const card = scoreCandidate(withArtifact, brief, PALETTE);
    const edgeResult = card.breakdown.find((r) => r.sensor === 'opaque-bbox-fits');
    expect(edgeResult?.ok).toBe(false);
    expect(edgeResult && !edgeResult.ok ? edgeResult.reason : '').toContain(
      'detached edge artifact',
    );
  });

  it('rejects enclosed interior transparency holes while allowing transparent background', () => {
    const ringPixels = [
      ...rectPixels(5, 5, 10, 5),
      ...rectPixels(5, 10, 10, 10),
      ...rectPixels(5, 6, 5, 9),
      ...rectPixels(10, 6, 10, 9),
    ];
    const withHole = buildProcessedFixture(16, 16, ringPixels);
    const brief = makeBrief({
      type: 'item',
      anchor: { x: 8, y: 10 },
      sensors: {} as Brief['sensors'],
    });
    const card = scoreCandidate(withHole, brief, PALETTE);
    const result = card.breakdown.find((r) => r.sensor === 'interior-transparency-holes');
    expect(result?.ok).toBe(false);
  });

  it('allows intentional edge touch when brief opts in', () => {
    const clipped = buildProcessedFixture(16, 16, rectPixels(6, 0, 10, 10));
    const brief = makeBrief({
      type: 'tile',
      anchor: { x: 8, y: 8 },
      sensors: { edge: { allowMainTouch: true } } as Brief['sensors'],
    });
    const card = scoreCandidate(clipped, brief, PALETTE);
    const edgeResult = card.breakdown.find((r) => r.sensor === 'opaque-bbox-fits');
    expect(edgeResult?.ok).toBe(true);
  });

  it('uses anchor-opaque by default and reports derivedAnchor=null', () => {
    const brief = makeBrief();
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const sensors = card.breakdown.map((r) => r.sensor);
    expect(sensors).toContain('anchor-opaque');
    expect(sensors).not.toContain('anchor-derivable');
    expect(card.derivedAnchor).toBeNull();
    expect(card.derivedAnchors.hold).toBeNull();
    expect(card.derivedAnchors.centerOfGravity).not.toBeNull();
  });

  it('treats palette-membership as pass-through when paletteMode is not strict', () => {
    const processed = buildProcessedFixture(16, 16, rectPixels(6, 6, 9, 9));
    const png = PNG.sync.read(processed);
    const idx = (7 * png.width + 7) * 4;
    png.data[idx] = 123;
    png.data[idx + 1] = 77;
    png.data[idx + 2] = 201;
    const mutated = PNG.sync.write(png);
    const brief = makeBrief({
      postprocessing: { trimAndFit: false, minDimension: 64, paletteMode: 'none' },
    });
    const card = scoreCandidate(mutated, brief, PALETTE);
    const paletteResult = card.breakdown.find((r) => r.sensor === 'palette-membership');
    expect(paletteResult?.ok).toBe(true);
  });

  it('enforces palette-membership when paletteMode is strict', () => {
    const processed = buildProcessedFixture(16, 16, rectPixels(6, 6, 9, 9));
    const png = PNG.sync.read(processed);
    const idx = (7 * png.width + 7) * 4;
    png.data[idx] = 123;
    png.data[idx + 1] = 77;
    png.data[idx + 2] = 201;
    const mutated = PNG.sync.write(png);
    const brief = makeBrief({
      postprocessing: { trimAndFit: false, minDimension: 64, paletteMode: 'strict' },
    });
    const card = scoreCandidate(mutated, brief, PALETTE);
    const paletteResult = card.breakdown.find((r) => r.sensor === 'palette-membership');
    expect(paletteResult?.ok).toBe(false);
  });

  it('swaps to anchor-derivable when sensors.anchor.derive=true and surfaces the anchor', () => {
    const brief = makeBrief({
      sensors: { anchor: { derive: true, bandRows: 4, centerToleranceX: 3 } } as Brief['sensors'],
    });
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const sensors = card.breakdown.map((r) => r.sensor);
    expect(sensors).toContain('anchor-derivable');
    expect(sensors).not.toContain('anchor-opaque');
    // The good sword fixture has a diagonal blade; the derived grip might not
    // pass tolerance for this synthetic test, but if it does the value must
    // be carried up onto the Scorecard. Assert both shape and consistency.
    const anchorResult = card.breakdown.find((r) => r.sensor === 'anchor-derivable');
    if (anchorResult?.ok) {
      expect(card.derivedAnchor).not.toBeNull();
      expect(card.derivedAnchors.hold).not.toBeNull();
      // Carried value must equal the sensor's own anchor.
      expect(card.derivedAnchor).toEqual(
        (anchorResult as unknown as { anchor: { x: number; y: number } }).anchor,
      );
      expect(card.derivedAnchors.hold).toEqual(card.derivedAnchor);
    } else {
      expect(card.derivedAnchor).toBeNull();
      expect(card.derivedAnchors.hold).toBeNull();
    }
  });
});
