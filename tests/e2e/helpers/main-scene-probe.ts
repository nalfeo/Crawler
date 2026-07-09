/**
 * Helpers for the `main-scene-probe-lab`-driven e2e characterization suite.
 *
 * MainGameScene (the ~2331-LOC engine god-class) is Phaser-coupled, so its boot
 * wiring and camera-follow behavior can only be observed by booting the real
 * scene in a browser. The lab (`src/labs/main-scene-probe-lab/index.ts`) boots
 * it through the shipped floor bootstrap with a fixed seed and exposes a typed
 * `window.__mainSceneProbe` API; these helpers load the lab, wait for the probe
 * to report `ready()`, and provide typed wrappers the spec drives.
 */
import type { Page } from 'playwright';
import { E2E_LAB_BASE_URL } from '../e2e-constants.js';
// Type-only import (erased at runtime — does NOT execute the lab's registerLab).
import type {
  HarvestableRenderSummary,
  MainSceneProbeApi,
  MainSceneState,
  ProbePoint,
  TerrainRenderSummary,
} from '../../../src/labs/main-scene-probe-lab/index.js';

declare global {
  interface Window {
    __mainSceneProbe?: MainSceneProbeApi;
  }
}

const LAB_ID = 'main-scene-probe-lab';

/** Navigate to the probe lab and wait for `window.__mainSceneProbe.ready()`. */
export async function loadMainSceneProbeLab(
  page: Page,
  params: Record<string, string | number> = {},
): Promise<void> {
  const query = new URLSearchParams({ lab: LAB_ID });
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  const url = `${E2E_LAB_BASE_URL}/lab.html?${query.toString()}`;
  // `commit` (not `networkidle`/`load`): Vite keeps a persistent HMR socket open
  // and may trigger a one-off optimize-deps page reload on the first load of a
  // lab, so waiting on network state is flaky. We commit the navigation and poll
  // for the probe's ready flag instead, re-navigating within a bounded number of
  // windows if an optimize/reload cycle wedges a single polling window.
  await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
  const windows = 3;
  for (let i = 0; i < windows; i += 1) {
    try {
      await page.waitForFunction(() => Boolean(window.__mainSceneProbe?.ready()), undefined, {
        timeout: 30_000,
        polling: 200,
      });
      // A few frames of headroom so the first boot sync()/render pass settles.
      await page.waitForTimeout(600);
      return;
    } catch (err) {
      if (i === windows - 1) throw err;
      await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    }
  }
}

/** Typed wrappers around the in-page `window.__mainSceneProbe` automation API. */
export const mainSceneProbe = {
  getState: (page: Page): Promise<MainSceneState> =>
    page.evaluate(() => window.__mainSceneProbe!.getState()),
  resolveLoadout: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.resolveLoadout()),
  setSimulationPaused: (page: Page, paused: boolean): Promise<void> =>
    page.evaluate((p) => window.__mainSceneProbe!.setSimulationPaused(p), paused),
  setPlayerFeet: (page: Page, x: number, y: number): Promise<void> =>
    page.evaluate(({ x: fx, y: fy }) => window.__mainSceneProbe!.setPlayerFeet(fx, fy), { x, y }),
  getCameraCenter: (page: Page): Promise<ProbePoint | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getCameraCenter()),
  getMapSizeFeet: (page: Page): Promise<ProbePoint | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getMapSizeFeet()),
  getCameraViewSize: (page: Page): Promise<ProbePoint | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getCameraViewSize()),
  getHarvestableRenderSummary: (page: Page): Promise<HarvestableRenderSummary> =>
    page.evaluate(() => window.__mainSceneProbe!.getHarvestableRenderSummary()),
  getTerrainRenderSummary: (page: Page): Promise<TerrainRenderSummary> =>
    page.evaluate(() => window.__mainSceneProbe!.getTerrainRenderSummary()),
};

/**
 * Poll the probe until `predicate(state)` holds (or throw on timeout). Used to
 * wait out the few frames Phaser needs to populate the display list / settle
 * the camera after a teleport, without any wall-clock coupling in assertions.
 */
export async function waitForState(
  page: Page,
  predicate: (state: MainSceneState) => boolean,
  options: { timeoutMs?: number; pollMs?: number; label?: string } = {},
): Promise<MainSceneState> {
  const { timeoutMs = 8_000, pollMs = 100, label = 'state predicate' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await mainSceneProbe.getState(page);
    if (predicate(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(pollMs);
  }
}

/**
 * Poll the live world-camera center until it lands within `tolerancePx` of the
 * expected pixel point (or throw on timeout). Returns the final camera center.
 */
export async function waitForCameraCenter(
  page: Page,
  expected: ProbePoint,
  tolerancePx: number,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ProbePoint> {
  const { timeoutMs = 8_000, pollMs = 80 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const center = await mainSceneProbe.getCameraCenter(page);
    if (
      center &&
      Math.abs(center.x - expected.x) <= tolerancePx &&
      Math.abs(center.y - expected.y) <= tolerancePx
    ) {
      return center;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for camera center ≈ (${expected.x}, ${expected.y}) ±${tolerancePx}px; ` +
          `last: ${JSON.stringify(center)}`,
      );
    }
    await page.waitForTimeout(pollMs);
  }
}
