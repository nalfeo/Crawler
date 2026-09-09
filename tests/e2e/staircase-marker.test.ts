/**
 * Floor-exit staircase marker — generated-art wiring guard.
 *
 * The objective marker used to be a plain filled `Arc` (a circle) with no art
 * at all. This guard boots the REAL scene, arranges the unlocked Floor 1
 * staircase (`primeFloor1StairTransition`), and proves the marker actually
 * stamps the approved `the-stairs` generated sprite rather than only the
 * circle fallback — the exact regression this issue closes.
 *
 * Mirrors the existing lab-probe e2e pattern (see `main-game-scene-boot.test.ts`
 * and `tests/e2e/helpers/main-scene-probe.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { STAIR_FOOTPRINT_RADIUS_FT } from '../../src/shared/constants.js';
import { ftToPx } from '../../src/shared/units.js';

/** The stairs cover 2x2 tiles; in render px that is `2 * radius` per side. */
const TWO_TILE_FOOTPRINT_PX = ftToPx(STAIR_FOOTPRINT_RADIUS_FT * 2);

describe('Floor-exit staircase marker', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('stamps the approved generated stairs art, not just the circle fallback', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.primeFloor1StairTransition(page);

    await expect
      .poll(
        async () => {
          const info = await mainSceneProbe.getStaircaseMarkerRenderInfo(page);
          return { usesGeneratedArt: info.usesGeneratedArt, visible: info.visible };
        },
        {
          timeout: 8_000,
          interval: 100,
        },
      )
      .toEqual({ usesGeneratedArt: true, visible: true });
  });

  it('draws the stairs across exactly a 2x2-tile footprint in the real scene', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.primeFloor1StairTransition(page);

    await expect
      .poll(() => mainSceneProbe.getStaircaseMarkerRenderInfo(page), {
        timeout: 8_000,
        interval: 100,
      })
      .toMatchObject({ usesGeneratedArt: true, visible: true });

    const info = await mainSceneProbe.getStaircaseMarkerRenderInfo(page);
    // 2 tiles x 4 ft/tile x PIXELS_PER_FOOT (8) = 64 render px per side.
    expect(info.footprintPx).toBeCloseTo(TWO_TILE_FOOTPRINT_PX, 5);
    expect(info.spriteWidthPx).toBeCloseTo(TWO_TILE_FOOTPRINT_PX, 5);
    expect(info.spriteHeightPx).toBeCloseTo(TWO_TILE_FOOTPRINT_PX, 5);
  });
});
