/**
 * Sprite pipeline integration test.
 *
 * Builds 1024² fixture PNGs deterministically (see ./builders), runs the real
 * post-processor over each, and asserts that the real sensors produce the
 * expected verdict.
 *
 * No network calls. No filesystem reads outside the source tree.
 */

import { describe, it, expect } from 'vitest';
import { postprocess } from '../../scripts/sprites/postprocess.js';
import type { Brief, PaletteColors } from '../../scripts/sprites/brief-schema.js';
import { decodeSprite, universalSensors } from '../../scripts/sprites/sensors/common.js';
import { weaponSensors } from '../../scripts/sprites/sensors/weapons.js';
import {
  buildGoodSwordFixture,
  buildEmptyFixture,
  buildHorizontalBarFixture,
  buildSolidBlockFixture,
  buildTinyDotFixture,
} from '../fixtures/sprites/builders.js';

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [192, 192, 200], // blade silver — matches the fixture body color exactly
  [120, 90, 60], // crossguard brown
  [200, 170, 50], // pommel gold
  [255, 255, 255],
];

const SWORD_BRIEF: Brief = {
  type: 'weapon',
  name: 'integration-sword',
  size: { width: 32, height: 32 },
  palette: {
    id: 'integration-test',
    colors: PALETTE.map((c) => [...c] as [number, number, number]),
  },
  anchor: { x: 16, y: 16 },
  tags: ['blade'],
  prompt: 'integration test diagonal sword',
  floor: 1,
  // Two synthetic references to keep the fixture brief schema-valid (F2.3).
  // The integration test never reads these — it constructs raw PNGs directly.
  references: [
    { path: 'tests/fixtures/sprites/_ref-a.png' },
    { path: 'tests/fixtures/sprites/_ref-b.png' },
  ],
  seedFrames: [],
  generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
  sensors: {},
  variations: [],
  minVariations: 4,
  judge: { enabled: false, maxVariants: 16 },
  postprocessing: { trimAndFit: false, minDimension: 64, paletteMode: 'strict' },
  frameSequence: { enabled: false, frameCount: 3, frameRate: 8, loop: true },
};

function runAllSensors(
  rawPng: Buffer,
  brief: Brief,
): { passed: string[]; failed: { sensor: string; reason: string }[] } {
  const processed = postprocess(rawPng, brief, PALETTE);
  const decoded = decodeSprite(processed);
  const results = [
    ...universalSensors(decoded, brief, PALETTE),
    ...(brief.type === 'weapon' ? weaponSensors(decoded, { orientation: 'diagonal' }) : []),
  ];
  const passed: string[] = [];
  const failed: { sensor: string; reason: string }[] = [];
  for (const r of results) {
    if (r.ok) passed.push(r.sensor);
    else failed.push({ sensor: r.sensor, reason: r.reason });
  }
  return { passed, failed };
}

describe('weapons pipeline integration', () => {
  it('good sword fixture passes every sensor', () => {
    const png = buildGoodSwordFixture();
    const { passed, failed } = runAllSensors(png, SWORD_BRIEF);
    expect(failed, `unexpected failures: ${JSON.stringify(failed, null, 2)}`).toEqual([]);
    // Sanity-check that we actually ran every expected sensor.
    expect(passed).toContain('dimensions-exact');
    expect(passed).toContain('alpha-binary');
    expect(passed).toContain('palette-membership');
    expect(passed).toContain('opaque-bbox-fits');
    expect(passed).toContain('opaque-ratio');
    expect(passed).toContain('anchor-opaque');
    expect(passed).toContain('silhouette-orientation-axis');
  });

  it('empty fixture fails opaque-bbox-fits with the expected reason', () => {
    const png = buildEmptyFixture();
    const { failed } = runAllSensors(png, SWORD_BRIEF);
    const bbox = failed.find((f) => f.sensor === 'opaque-bbox-fits');
    expect(bbox).toBeDefined();
    expect(bbox?.reason).toContain('no opaque pixels');
  });

  it('horizontal bar fixture fails the silhouette orientation sensor', () => {
    const png = buildHorizontalBarFixture();
    const { failed } = runAllSensors(png, SWORD_BRIEF);
    const silhouette = failed.find((f) => f.sensor === 'silhouette-orientation-axis');
    expect(silhouette).toBeDefined();
    expect(silhouette?.reason).toContain('horizontal');
  });

  it('solid-block fixture fails opaque-ratio (too high)', () => {
    const png = buildSolidBlockFixture();
    const { failed } = runAllSensors(png, SWORD_BRIEF);
    const ratio = failed.find((f) => f.sensor === 'opaque-ratio');
    expect(ratio).toBeDefined();
    expect(ratio?.reason).toMatch(/outside \[0\.1, 0\.65\]/);
  });

  it('tiny-dot fixture fails opaque-ratio (too low)', () => {
    const png = buildTinyDotFixture();
    const { failed } = runAllSensors(png, SWORD_BRIEF);
    const ratio = failed.find((f) => f.sensor === 'opaque-ratio');
    expect(ratio).toBeDefined();
    expect(ratio?.reason).toMatch(/outside \[0\.1, 0\.65\]/);
  });
});
