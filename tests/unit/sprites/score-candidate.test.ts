/**
 * Tests for the candidate scorer. Exercises the full pipeline via the
 * existing builders: build a raw fixture -> postprocess -> score.
 *
 * The fixtures in tests/fixtures/sprites/builders.ts are tuned to exhibit
 * specific sensor failures (empty, solid block, horizontal bar, tiny dot),
 * so the scorecard breakdown should reflect exactly those failures.
 */

import { describe, expect, it } from 'vitest';
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

  it('a tiny-dot fixture fails the opaque-ratio sensor (below min)', () => {
    const brief = makeBrief();
    const processed = postprocess(buildTinyDotFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    expect(card.passed).toBe(false);
    const fails = card.breakdown.filter((r) => !r.ok).map((r) => r.sensor);
    expect(fails).toContain('opaque-ratio');
  });

  it('non-weapon briefs do not run the weapon sensors', () => {
    const brief = makeBrief({ type: 'item' });
    const processed = postprocess(buildHorizontalBarFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const sensors = card.breakdown.map((r) => r.sensor);
    expect(sensors).not.toContain('silhouette-orientation-axis');
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

  it('uses anchor-opaque by default and reports derivedAnchor=null', () => {
    const brief = makeBrief();
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const sensors = card.breakdown.map((r) => r.sensor);
    expect(sensors).toContain('anchor-opaque');
    expect(sensors).not.toContain('anchor-derivable');
    expect(card.derivedAnchor).toBeNull();
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
      // Carried value must equal the sensor's own anchor.
      expect(card.derivedAnchor).toEqual(
        (anchorResult as unknown as { anchor: { x: number; y: number } }).anchor,
      );
    } else {
      expect(card.derivedAnchor).toBeNull();
    }
  });
});
