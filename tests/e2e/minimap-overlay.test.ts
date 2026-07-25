/**
 * Minimap visual regression tests.
 *
 * Uses Playwright (chromium headless) to render the `ux-snapshot-lab` — the
 * lab that exercises the full HudUI including minimap — and then samples pixel
 * colours from the Phaser WebGL canvas to verify terrain is actually painted.
 *
 * What we're guarding against:
 *   • Docked radar: the round dial must contain non-void terrain pixels.
 *   • Full-screen map overlay: pressing M must reveal the baked terrain
 *     RenderTexture with teal safe-room-floor and dark stone-wall pixels.
 *     "Full screen map doesn't render any rooms/walls" → caught here.
 *
 * Coordinate system
 * -----------------
 * Phaser renders at GAME_W×GAME_H (1280×720) and FIT-scales the canvas to
 * fill the lab stage.  `gameToScreen()` converts a game-space coordinate to
 * the CSS-pixel coordinate visible in Playwright screenshots by reading the
 * canvas element's `getBoundingClientRect()` at runtime.
 *
 * Colour reference (HudMinimap MINI_COLORS)
 * -----------------------------------------
 *   SAFE_ROOM_FLOOR  0x0f766e  rgb(15, 118, 110)  teal
 *   STONE_WALL       0x1f2937  rgb(31,  41,  55)  dark blue-gray
 *   VOID             0x05060f  rgb( 5,   6,  15)  near-black background
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePng, regionContainsColor, readPixel, countNonVoidPoints } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_W, GAME_H } from './e2e-constants.js';

// ── Colour constants (MINI_COLORS from HudMinimap.ts) ────────────────────────
const SAFE_ROOM_FLOOR = { r: 0x0f, g: 0x76, b: 0x6e }; // 0x0f766e  teal
const STONE_WALL = { r: 0x1f, g: 0x29, b: 0x37 }; //      0x1f2937  dark blue-gray
const VOID = { r: 0x05, g: 0x06, b: 0x0f }; //             0x05060f  near-black
const WAYPOINT = { r: 0xfc, g: 0xd3, b: 0x4d }; //         0xfcd34d  gold

// ── Map-overlay layout constants (derived from HudMinimap updateLayout) ───────
// At GAME_W=1280, GAME_H=720 the overlay panel covers most of the canvas.
// ux-snapshot-lab creates a 20×12 tile FloorMap; with fitZoom=44 the terrain
// texture origin lands near game coords (200, 100).
const MAP_ORIGIN_X = 200; // approx screen-space origin of terrain texture
const MAP_ORIGIN_Y = 100;

// Docked radar position (HudMinimap constants):
//   HUD_RADAR_MARGIN=12, HUD_RADAR_RADIUS=76
//   radarCx = GAME_W - 12 - 76 = 1192,  radarCy = 12 + 76 = 88
const RADAR_CX = GAME_W - 12 - 76; // 1192
const RADAR_CY = 12 + 76; //           88

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=ux-snapshot-lab`;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UxSnapshotProbeApi {
  ready(): boolean;
  setTrackedWaypointPx(x: number, y: number): void;
  getMinimapDockedBounds(): ScreenBounds | null;
  getMinimapOverlayViewportBounds(): ScreenBounds | null;
  getMinimapOverlayWaypointArrowBounds(): ScreenBounds | null;
  getMinimapRadarWaypointArrowBounds(): ScreenBounds | null;
}

interface UxSnapshotProbeWindow extends Window {
  __uxSnapshotProbe?: UxSnapshotProbeApi;
}

async function getCanvasRect(page: Page): Promise<CanvasRect> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#lab-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Phaser canvas not found in #lab-canvas');
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/**
 * Convert a game-space coordinate (0..GAME_W, 0..GAME_H) to the CSS-pixel
 * position visible in a full-page Playwright screenshot.
 */
function gameToScreen(rect: CanvasRect, gx: number, gy: number): { x: number; y: number } {
  return {
    x: Math.round(rect.x + gx * (rect.width / GAME_W)),
    y: Math.round(rect.y + gy * (rect.height / GAME_H)),
  };
}

/**
 * Navigate to the lab URL and wait for the Phaser canvas to appear and
 * finish its first rendering pass (≥3 s of scene update ticks).
 */
async function loadLab(page: Page): Promise<void> {
  // `commit` (not `networkidle`): Vite keeps a persistent HMR socket open and may
  // trigger a one-off optimize-deps reload on first lab load, so waiting on
  // network state is flaky (page.goto would intermittently time out at 30s). We
  // commit the navigation and gate on the canvas + a fixed settle below instead,
  // matching the robust pattern in tests/e2e/helpers/ui-probe.ts.
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as unknown as UxSnapshotProbeWindow).__uxSnapshotProbe?.ready()),
    undefined,
    { timeout: 30_000 },
  );
  // Give Phaser time to mount HudUI, call sync(), and bake the terrain
  // RenderTexture.  The 'ux-snapshot-lab' sets visible.fill(1) synchronously,
  // so one game loop tick is enough, but 3 s provides headroom on slow CI.
  await page.waitForTimeout(3_000);
}

function boundsToScreen(rect: CanvasRect, bounds: ScreenBounds): ScreenBounds {
  const scaleX = rect.width / GAME_W;
  const scaleY = rect.height / GAME_H;
  return {
    x: Math.round(rect.x + bounds.x * scaleX),
    y: Math.round(rect.y + bounds.y * scaleY),
    width: Math.round(bounds.width * scaleX),
    height: Math.round(bounds.height * scaleY),
  };
}

function inflateProbe(
  bounds: ScreenBounds,
  pad: number,
): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return {
    x: Math.floor(bounds.x) - pad,
    y: Math.floor(bounds.y) - pad,
    w: Math.ceil(bounds.width) + pad * 2,
    h: Math.ceil(bounds.height) + pad * 2,
  };
}

async function setTrackedWaypointPx(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([nextX, nextY]) => {
      (window as unknown as UxSnapshotProbeWindow).__uxSnapshotProbe!.setTrackedWaypointPx(
        nextX,
        nextY,
      );
    },
    [x, y] as const,
  );
  await page.waitForTimeout(150);
}

async function getMinimapOverlayViewportBounds(page: Page): Promise<ScreenBounds> {
  const bounds = await page.evaluate(() =>
    (
      window as unknown as UxSnapshotProbeWindow
    ).__uxSnapshotProbe!.getMinimapOverlayViewportBounds(),
  );
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function getMinimapOverlayWaypointArrowBounds(page: Page): Promise<ScreenBounds | null> {
  return page.evaluate(() =>
    (
      window as unknown as UxSnapshotProbeWindow
    ).__uxSnapshotProbe!.getMinimapOverlayWaypointArrowBounds(),
  );
}

async function getMinimapRadarWaypointArrowBounds(page: Page): Promise<ScreenBounds | null> {
  return page.evaluate(() =>
    (
      window as unknown as UxSnapshotProbeWindow
    ).__uxSnapshotProbe!.getMinimapRadarWaypointArrowBounds(),
  );
}

/** Save a screenshot to tmp/e2e-screenshots/ for debugging failures. */
function saveDebugShot(buf: Buffer, filename: string): void {
  try {
    const dir = resolve(process.cwd(), 'tmp', 'e2e-screenshots');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, filename), buf);
  } catch {
    // Non-fatal — debug screenshots are best-effort.
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('minimap visual regression', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // 1600×900 gives the 1280×720 game canvas enough room that Phaser FIT
    // keeps it at ~1:1 scale, making gameToScreen() conversion reliable.
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  // ── Full-screen map overlay ──────────────────────────────────────────────

  describe('full-screen map overlay (press M)', () => {
    it('shows and hides the overlay edge arrow as zoom/pan move a tracked waypoint off-screen', async () => {
      await loadLab(page);
      await setTrackedWaypointPx(page, 0, GAME_H / 2);
      await page.keyboard.press('m');
      await page.waitForTimeout(500);

      const rect = await getCanvasRect(page);
      const viewport = boundsToScreen(rect, await getMinimapOverlayViewportBounds(page));
      const edgeProbe = {
        x: viewport.x + 4,
        y: viewport.y + Math.round(viewport.height / 2) - 16,
        w: 32,
        h: 32,
      };

      let buf = await page.screenshot({ type: 'png' });
      let png = parsePng(buf);
      expect(await getMinimapOverlayWaypointArrowBounds(page)).toBeNull();
      expect(regionContainsColor(png, edgeProbe, WAYPOINT, 30)).toBe(false);

      const viewportCenterX = Math.round(viewport.x + viewport.width / 2);
      const viewportCenterY = Math.round(viewport.y + viewport.height / 2);
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.move(viewportCenterX, viewportCenterY);
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(120);
      }

      await page.waitForFunction(
        () =>
          Boolean(
            (
              window as unknown as UxSnapshotProbeWindow
            ).__uxSnapshotProbe?.getMinimapOverlayWaypointArrowBounds(),
          ),
        undefined,
        { timeout: 2_000 },
      );
      await page.waitForTimeout(100);

      buf = await page.screenshot({ type: 'png' });
      saveDebugShot(buf, 'overlay-waypoint-edge-arrow.png');
      png = parsePng(buf);
      const overlayArrowProbe = inflateProbe(
        boundsToScreen(rect, (await getMinimapOverlayWaypointArrowBounds(page))!),
        4,
      );
      expect(regionContainsColor(png, overlayArrowProbe, WAYPOINT, 30)).toBe(true);

      await page.mouse.move(viewportCenterX, viewportCenterY);
      await page.mouse.down();
      await page.mouse.move(viewportCenterX + 180, viewportCenterY, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      await page.waitForFunction(
        () =>
          !(
            window as unknown as UxSnapshotProbeWindow
          ).__uxSnapshotProbe?.getMinimapOverlayWaypointArrowBounds(),
        undefined,
        { timeout: 2_000 },
      );

      buf = await page.screenshot({ type: 'png' });
      png = parsePng(buf);
      expect(regionContainsColor(png, overlayArrowProbe, WAYPOINT, 30)).toBe(false);
    });

    it('renders safe-room floor tiles (teal) in the map content area', async () => {
      await loadLab(page);
      // window.addEventListener('keydown', …) in HudMinimap picks up 'm'.
      await page.keyboard.press('m');
      await page.waitForTimeout(800);

      const buf = await page.screenshot({ type: 'png' });
      saveDebugShot(buf, 'overlay-floor.png');

      const png = parsePng(buf);
      const rect = await getCanvasRect(page);

      // The center of the game canvas sits on top of the safe-room floor.
      // At fitZoom≈44, each tile is 44×44 px; the center tile (10,6) maps to
      // approximately game coords (640, 364).  Search a generous 80×80 px
      // region to tolerate minor layout rounding.
      const center = gameToScreen(rect, GAME_W / 2, GAME_H / 2);
      const hasTealFloor = regionContainsColor(
        png,
        { x: center.x - 40, y: center.y - 40, w: 80, h: 80 },
        SAFE_ROOM_FLOOR,
        30,
      );

      expect(
        hasTealFloor,
        'Expected teal safe-room floor pixels in the center of the map overlay. ' +
          'If this fails, the terrain RenderTexture is not being baked or rendered.',
      ).toBe(true);
    });

    it('renders stone-wall tiles around the room perimeter', async () => {
      await loadLab(page);
      await page.keyboard.press('m');
      await page.waitForTimeout(800);

      const buf = await page.screenshot({ type: 'png' });
      saveDebugShot(buf, 'overlay-walls.png');

      const png = parsePng(buf);
      const rect = await getCanvasRect(page);

      // Tile (0,0) is STONE_WALL.  With zoom≈44 and terrainRt.origin=(0,0)
      // the wall corner sits near MAP_ORIGIN_X, MAP_ORIGIN_Y in game space.
      const corner = gameToScreen(rect, MAP_ORIGIN_X, MAP_ORIGIN_Y);
      const hasWall = regionContainsColor(
        png,
        { x: corner.x - 20, y: corner.y - 20, w: 80, h: 80 },
        STONE_WALL,
        30,
      );

      expect(
        hasWall,
        'Expected dark stone-wall pixels near the top-left corner of the map overlay. ' +
          'If this fails, wall tiles are not being painted onto the terrain texture.',
      ).toBe(true);
    });

    it('shows a mix of terrain colours (not pure void) across the map area', async () => {
      await loadLab(page);
      await page.keyboard.press('m');
      await page.waitForTimeout(800);

      const buf = await page.screenshot({ type: 'png' });
      const png = parsePng(buf);
      const rect = await getCanvasRect(page);

      // Sample 9 points spread across the interior of the expected map area.
      // If terrain is rendering, most of them should be non-void (dark
      // background) colours.
      const sampleGameCoords = [
        { gx: GAME_W * 0.35, gy: GAME_H * 0.35 },
        { gx: GAME_W * 0.5, gy: GAME_H * 0.35 },
        { gx: GAME_W * 0.65, gy: GAME_H * 0.35 },
        { gx: GAME_W * 0.35, gy: GAME_H * 0.5 },
        { gx: GAME_W * 0.5, gy: GAME_H * 0.5 },
        { gx: GAME_W * 0.65, gy: GAME_H * 0.5 },
        { gx: GAME_W * 0.35, gy: GAME_H * 0.65 },
        { gx: GAME_W * 0.5, gy: GAME_H * 0.65 },
        { gx: GAME_W * 0.65, gy: GAME_H * 0.65 },
      ];

      const screenPoints = sampleGameCoords.map(({ gx, gy }) => gameToScreen(rect, gx, gy));
      const nonVoidCount = countNonVoidPoints(png, screenPoints, VOID, 20);

      expect(
        nonVoidCount,
        `Expected at least 7 of 9 sampled map points to be non-void, got ${nonVoidCount}. ` +
          'If terrain renders, the map interior should show floor and wall colours.',
      ).toBeGreaterThanOrEqual(7);
    });

    it('overlay closes cleanly when M is pressed a second time', async () => {
      await loadLab(page);
      await page.keyboard.press('m');
      await page.waitForTimeout(400);
      // Close
      await page.keyboard.press('m');
      await page.waitForTimeout(400);

      const buf = await page.screenshot({ type: 'png' });
      saveDebugShot(buf, 'overlay-closed.png');
      const png = parsePng(buf);
      const rect = await getCanvasRect(page);

      // After closing, the dimmer is gone.  The center of the screen should
      // show the underlying game scene, not the teal terrain texture.
      // (The ux-snapshot-lab renders a room scene with temp_floor tiles here.)
      // We just verify the overlay teal is NOT dominant (it should be gone).
      const center = gameToScreen(rect, GAME_W / 2, GAME_H / 2);
      const px = readPixel(png, center.x, center.y);

      // After close the scene background is '#0e0b14' (rgb 14, 11, 20) or floor
      // tiles.  The pixel must NOT be the overlay teal (15, 118, 110).
      const isTeal =
        Math.abs(px.r - SAFE_ROOM_FLOOR.r) < 20 &&
        Math.abs(px.g - SAFE_ROOM_FLOOR.g) < 20 &&
        Math.abs(px.b - SAFE_ROOM_FLOOR.b) < 20;

      expect(
        isTeal,
        'Overlay should have closed: expected center pixel to no longer be teal terrain.',
      ).toBe(false);
    });
  });

  // ── Docked radar ─────────────────────────────────────────────────────────

  describe('docked radar (HUD corner dial)', () => {
    it('paints non-void terrain inside the radar dial', async () => {
      await loadLab(page);
      // Overlay is NOT open; docked radar shows terrain in the dial.

      const buf = await page.screenshot({ type: 'png' });
      saveDebugShot(buf, 'radar-docked.png');
      const png = parsePng(buf);
      const rect = await getCanvasRect(page);

      // The radar dial centre is at game coords (RADAR_CX=1192, RADAR_CY=88).
      // The dial is 152×152 px (HUD_RADAR_DIAMETER=152) in game space.
      // RADAR_PX_PER_TILE=6 → tiles 6 px wide.  Floor tiles within clip radius
      // are painted with SAFE_ROOM_FLOOR colour.
      // We search a 60×60 game-pixel region centred on the dial.
      const dialCenter = gameToScreen(rect, RADAR_CX, RADAR_CY);

      // Convert 30 game px to screen px (accounting for Phaser FIT scale).
      const scaleX = rect.width / GAME_W;
      const searchR = Math.round(30 * scaleX);

      const hasTerrainInDial = regionContainsColor(
        png,
        {
          x: dialCenter.x - searchR,
          y: dialCenter.y - searchR,
          w: searchR * 2,
          h: searchR * 2,
        },
        SAFE_ROOM_FLOOR,
        40,
      );

      expect(
        hasTerrainInDial,
        'Expected teal safe-room floor pixels inside the docked radar dial. ' +
          'If this fails, the radar RenderTexture is not compositing terrain.',
      ).toBe(true);
    });

    it('draws a radar edge arrow only while the tracked waypoint is outside the dial', async () => {
      await loadLab(page);
      await setTrackedWaypointPx(page, 2000, GAME_H / 2);

      const rect = await getCanvasRect(page);
      await page.waitForFunction(
        () =>
          Boolean(
            (
              window as unknown as UxSnapshotProbeWindow
            ).__uxSnapshotProbe?.getMinimapRadarWaypointArrowBounds(),
          ),
        undefined,
        { timeout: 2_000 },
      );
      await page.waitForTimeout(100);
      let buf = await page.screenshot({ type: 'png' });
      saveDebugShot(buf, 'radar-waypoint-edge-arrow.png');
      let png = parsePng(buf);
      const edgeProbe = inflateProbe(
        boundsToScreen(rect, (await getMinimapRadarWaypointArrowBounds(page))!),
        4,
      );

      expect(regionContainsColor(png, edgeProbe, WAYPOINT, 30)).toBe(true);

      await setTrackedWaypointPx(page, GAME_W / 2, GAME_H / 2);
      await page.waitForFunction(
        () =>
          !(
            window as unknown as UxSnapshotProbeWindow
          ).__uxSnapshotProbe?.getMinimapRadarWaypointArrowBounds(),
        undefined,
        { timeout: 2_000 },
      );
      buf = await page.screenshot({ type: 'png' });
      png = parsePng(buf);
      expect(regionContainsColor(png, edgeProbe, WAYPOINT, 30)).toBe(false);
    });
  });
});
