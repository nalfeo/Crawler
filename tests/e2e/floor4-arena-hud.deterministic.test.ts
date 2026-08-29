import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';
import type { HudProbeApi } from '../../src/labs/hud-lab/index.js';
import type { MainSceneProbeApi } from '../../src/labs/main-scene-probe-lab/index.js';
import type { HudFloor4ArenaProbeState } from '../../src/engine/HudFloor4Arena.js';

const HUD_LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=hud-lab`;
const MAIN_SCENE_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=main-scene-probe-lab&floor=floor4`;
const BG = { r: 0x05, g: 0x07, b: 0x0f };

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Floor4Surface = 'waves' | 'headline' | 'overtime' | 'break' | 'winner';

async function getCanvasRect(page: Page): Promise<CanvasRect> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#lab-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Phaser canvas not found in #lab-canvas');
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

function boundsToScreen(rect: CanvasRect, bounds: Bounds): Bounds {
  return {
    x: rect.x + bounds.x * (rect.width / GAME_W),
    y: rect.y + bounds.y * (rect.height / GAME_H),
    width: bounds.width * (rect.width / GAME_W),
    height: bounds.height * (rect.height / GAME_H),
  };
}

function contains(outer: Bounds, inner: Bounds, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

function overlaps(a: Bounds, b: Bounds, tolerance = 0.5): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > tolerance &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > tolerance
  );
}

function nonBackgroundRatio(
  png: ReturnType<typeof parsePng>,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 20,
): number {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(png.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(png.height - 1, Math.round(rect.y + rect.h));
  let nonBg = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(png, x, y), BG) > threshold) nonBg += 1;
    }
  }
  return total > 0 ? nonBg / total : 0;
}

async function hideLabShell(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('app-header')?.style.setProperty('display', 'none');
    document.getElementById('lab-controls')?.style.setProperty('display', 'none');
    document.getElementById('controls-toggle')?.style.setProperty('display', 'none');
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);
}

async function loadHudLab(page: Page): Promise<void> {
  await page.goto(HUD_LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as { __hudProbe?: HudProbeApi }).__hudProbe?.ready()),
    undefined,
    { timeout: 30_000 },
  );
  await hideLabShell(page);
}

async function setFloor4Surface(
  page: Page,
  surface: Floor4Surface,
): Promise<HudFloor4ArenaProbeState> {
  return page.evaluate((next) => {
    const probe = (window as { __hudProbe?: HudProbeApi }).__hudProbe;
    if (!probe) throw new Error('__hudProbe not available');
    probe.setFloor4Surface(next);
    return probe.getFloor4HudState();
  }, surface);
}

function assertLayout(rect: CanvasRect, state: HudFloor4ArenaProbeState): void {
  expect(state.visible).toBe(true);
  expect(state.bounds).not.toBeNull();
  const bounds = state.bounds!;
  expect(state.renderedSummary).toEqual(state.summary);
  const viewport: Bounds = { x: 0, y: 0, width: rect.width, height: rect.height };
  const panel = boundsToScreen(rect, bounds.panel);
  expect(contains(viewport, panel), `${state.title} panel must fit in viewport`).toBe(true);
  for (const [index, pip] of bounds.pips.entries()) {
    const screenPip = boundsToScreen(rect, pip);
    expect(contains(panel, screenPip), `${state.title} pip ${index} must fit in panel`).toBe(true);
  }
  for (const region of [bounds.clock, bounds.headliner, bounds.notice, ...bounds.summary].filter(
    (item): item is Bounds => item !== null,
  )) {
    expect(contains(panel, boundsToScreen(rect, region)), `${state.title} region must fit`).toBe(
      true,
    );
  }
  for (let i = 0; i < bounds.pips.length; i += 1) {
    for (let j = i + 1; j < bounds.pips.length; j += 1) {
      expect(
        overlaps(boundsToScreen(rect, bounds.pips[i]!), boundsToScreen(rect, bounds.pips[j]!)),
        `${state.title} pips ${i}/${j} must not overlap`,
      ).toBe(false);
    }
  }
}

describe('Floor 4 arena HUD deterministic surfaces', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it.each([
    { width: 1280, height: 720 },
    { width: 960, height: 540 },
  ])(
    'renders every Floor 4 feedback surface at $width×$height',
    async ({ width, height }) => {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      try {
        await loadHudLab(page);
        const rect = await getCanvasRect(page);
        expect(rect).toEqual({ x: 0, y: 0, width, height });

        const waves = await setFloor4Surface(page, 'waves');
        expect(waves.title).toBe('ACT 2 / 5');
        expect(waves.pips.map((pip) => pip.state)).toEqual([
          'released',
          'released',
          'released',
          'armed',
          'pending',
          'pending',
          'pending',
          'pending',
        ]);
        assertLayout(rect, waves);

        const headline = await setFloor4Surface(page, 'headline');
        expect(headline.notice).toBe('CLEAR THE FLOOR');
        expect(headline.headliner?.title).toBe('Camera Kraken');
        expect(headline.headliner?.hpLabel).toBe('496 / 800');
        assertLayout(rect, headline);

        const overtime = await setFloor4Surface(page, 'overtime');
        expect(overtime.title).toBe('OVERTIME');
        expect(overtime.overtime).toBe(true);
        expect(overtime.clock).toBe('+0:48');
        expect(overtime.headliner?.subtitle).toContain('OVERTIME');
        assertLayout(rect, overtime);

        const breakSummary = await setFloor4Surface(page, 'break');
        expect(breakSummary.summary).toContain('Act 2 survived');
        expect(breakSummary.summary).toContain('Sponsors open: 2');
        assertLayout(rect, breakSummary);

        const winner = await setFloor4Surface(page, 'winner');
        expect(winner.title).toBe("WINNER'S CIRCLE");
        expect(winner.winner).toBe(true);
        expect(winner.summary).toContain('Take the stairs to claim the belt');
        assertLayout(rect, winner);

        // Encounter-stack regression guard: with the arena panel visible, an
        // announcement banner must be pushed BELOW the panel (HudUI.ts
        // floor4Offset), never overlapping it.
        const beforeAnnouncement = await page.evaluate(() => {
          const probe = (window as { __hudProbe?: HudProbeApi }).__hudProbe;
          if (!probe) throw new Error('__hudProbe not available');
          return probe.getEncounterProbeBounds();
        });
        expect(beforeAnnouncement.announcementPanel).toBeNull();

        const encounter = await page.evaluate(() => {
          const probe = (window as { __hudProbe?: HudProbeApi }).__hudProbe;
          if (!probe) throw new Error('__hudProbe not available');
          probe.pushTestAnnouncement('CAMERA KRAKEN — all angles are bad angles!');
          return probe.getEncounterProbeBounds();
        });
        expect(encounter.announcementPanel).not.toBeNull();
        const panelScreen = boundsToScreen(rect, winner.bounds!.panel);
        const announcementScreen = boundsToScreen(rect, encounter.announcementPanel!);
        expect(
          announcementScreen.y,
          'announcement banner must start below the Floor 4 arena panel',
        ).toBeGreaterThanOrEqual(panelScreen.y + panelScreen.height - 0.5);
        expect(overlaps(panelScreen, announcementScreen)).toBe(false);

        const png = parsePng(await page.screenshot());
        const panel = boundsToScreen(rect, winner.bounds!.panel);
        expect(
          nonBackgroundRatio(png, { x: panel.x, y: panel.y, w: panel.width, h: panel.height }),
        ).toBeGreaterThan(0.45);
      } finally {
        await closeQuietly(context);
      }
    },
    120_000,
  );
});

describe('Floor 4 arena HUD real-scene wiring', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await page.goto(MAIN_SCENE_URL, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
    await page.waitForFunction(
      () => Boolean((window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe?.ready()),
      undefined,
      { timeout: 30_000 },
    );
    await hideLabShell(page);
  }, 120_000);

  afterAll(async () => {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(browser);
  });

  it('boots Floor 4 through the shipped scene path with the arena HUD mounted', async () => {
    const state = await page.evaluate(() => {
      const probe = (window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe;
      if (!probe) throw new Error('__mainSceneProbe not available');
      probe.resolveLoadout();
      return {
        scene: probe.getState(),
        hud: probe.getFloor4ArenaHudState(),
      };
    });
    expect(state.scene.floorId).toBe('floor4');
    expect(state.hud?.visible).toBe(true);
    expect(state.hud?.title).toBe('THE MAIN EVENT');
    expect(state.hud?.bounds?.panel).not.toBeNull();
  });
});
