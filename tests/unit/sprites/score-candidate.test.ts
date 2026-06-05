/**
 * Tests for the candidate scorer. Exercises the full pipeline via the
 * existing builders: build a raw fixture -> postprocess -> score.
 *
 * The fixtures in tests/fixtures/sprites/builders.ts are tuned to exhibit
 * specific sensor failures (empty, solid block, horizontal bar, tiny dot),
 * so the scorecard breakdown should reflect exactly those failures.
 */

import { describe, expect, it } from 'vitest';
import { briefSchema, type Brief, type PaletteColors } from '../../../scripts/sprites/brief-schema.js';
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

  it('a horizontal-bar fixture fails the weapon diagonal-axis sensor', () => {
    const brief = makeBrief();
    const processed = postprocess(buildHorizontalBarFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    const fails = card.breakdown.filter((r) => !r.ok).map((r) => r.sensor);
    expect(fails).toContain('silhouette-diagonal-axis');
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
    expect(sensors).not.toContain('silhouette-diagonal-axis');
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
        weapon: { diagonalToleranceDeg: 30 },
      } as Brief['sensors'],
    });
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card = scoreCandidate(processed, brief, PALETTE);
    // The good sword's axis is near 45°, which is outside even a 30° cone
    // around horizontal/vertical, so it should still pass.
    expect(card.breakdown.find((r) => r.sensor === 'silhouette-diagonal-axis')?.ok).toBe(true);
  });

  it('produces a stable breakdown order for a given brief type', () => {
    const brief = makeBrief();
    const processed = postprocess(buildGoodSwordFixture(), brief, PALETTE);
    const card1 = scoreCandidate(processed, brief, PALETTE);
    const card2 = scoreCandidate(processed, brief, PALETTE);
    expect(card1.breakdown.map((r) => r.sensor)).toEqual(card2.breakdown.map((r) => r.sensor));
  });
});
