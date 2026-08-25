/**
 * MainGameScene characterization guards (WAVE 2 / workstream E precursor).
 *
 * MainGameScene (`src/engine/scenes/MainGameScene.ts`, ~2331 LOC) is a
 * Phaser-coupled engine god-class that is ~0% unit-tested. Before a future
 * session decomposes it, these e2e guards pin two high-value, currently-
 * UNGUARDED observable behaviors so the refactor can prove equivalence:
 *
 *   1. Boot wiring — booting the real scene through the shipped floor bootstrap
 *      (`createFloor1GameConfig` + `createFloor1MainSceneOptions`) spawns a
 *      world + player, wires the entity→sprite bridge and the HUD, opens the
 *      loadout modal, and populates the Phaser display list.
 *   2. Camera-follow invariant — the main camera centers on the player at
 *      `ftToPx(playerFeet)`, and the camera center DELTA equals `ftToPx(Δfeet)`
 *      as the player moves. This is the contract `updateCamera()` upholds via
 *      `cameras.main.centerOn(ftToPx(px), ftToPx(py))`.
 *
 * Determinism: the lab boots with a fixed `worldSeed`, the suite freezes the
 * simulation (so the player only moves when the test teleports it), and the
 * camera read (`worldView.centerX/centerY`) is zoom/DPR-invariant. No
 * wall-clock or RNG enters any assertion — positions are exact integers and the
 * expected pixels are computed with the shipped `ftToPx`. Player teleports
 * target the map CENTER so the camera is provably unclamped by the map bounds
 * the scene installs (`setBounds(0, 0, ftToPx(widthFt), ftToPx(heightFt))`).
 *
 * Mirrors the existing lab-probe e2e pattern (see `tests/e2e/inventory-flow.test.ts`
 * and `tests/e2e/helpers/ui-probe.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ftToPx } from '../../src/shared/units.js';
import { closeQuietly } from './helpers/ui-probe.js';
import {
  loadMainSceneProbeLab,
  mainSceneProbe,
  waitForCameraCenter,
  waitForState,
} from './helpers/main-scene-probe.js';

// Camera center reads are exact modulo Phaser's render-time pixel rounding.
const CAMERA_TOLERANCE_PX = 2;

describe('MainGameScene characterization guards', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // 1600×900 gives the 1280×720 game canvas room so Phaser FIT keeps it near
    // 1:1, matching the other lab-probe suites.
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('boots the real scene with world, player, bridge, HUD, modal, and display list wired', async () => {
    await loadMainSceneProbeLab(page);

    // Poll until the boot wiring has fully settled (HUD + display list are
    // populated across the first few frames), then assert each fact for a clear
    // failure message.
    const state = await waitForState(
      page,
      (s) =>
        s.worldState === 'loadout' &&
        s.playerEid >= 0 &&
        s.hudPresent &&
        s.bridgePresent &&
        s.modalOpen &&
        s.displayObjectCount > 0,
      { label: 'boot wiring (loadout + hud + bridge + modal + display list)' },
    );

    expect(state.worldState, 'scene should boot into the loadout world state').toBe('loadout');
    expect(state.playerEid, 'player entity should be spawned at boot').toBeGreaterThanOrEqual(0);
    expect(state.bridgePresent, 'entity→sprite PhaserBridge should be wired at boot').toBe(true);
    expect(state.hudPresent, 'HUD UI should be wired at boot').toBe(true);
    expect(state.modalOpen, 'loadout modal picker should be open at boot').toBe(true);
    expect(
      state.displayObjectCount,
      'scene display list should be populated at boot',
    ).toBeGreaterThan(0);
    expect(state.playerFeet, 'player should have a world position at boot').not.toBeNull();
  });

  it('keeps the main camera centered on the player at ftToPx(feet) as the player moves', async () => {
    await loadMainSceneProbeLab(page);

    // Resolve the loadout (state → playing) and freeze the simulation. With the
    // sim paused and no pending advance-steps, the scene still runs
    // updateCamera() every frame but skips the sim loop — so the player only
    // moves when this test teleports it.
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });

    const mapFeet = await mainSceneProbe.getMapSizeFeet(page);
    const viewPx = await mainSceneProbe.getCameraViewSize(page);
    expect(mapFeet, 'probe should report the floor map size').not.toBeNull();
    expect(viewPx, 'probe should report the camera viewport size').not.toBeNull();
    const map = mapFeet!;
    const view = viewPx!;

    const mapWpx = ftToPx(map.x);
    const mapHpx = ftToPx(map.y);

    // Two player positions straddling the map center by a small symmetric delta.
    // Centering there keeps the camera provably inside its bounds (no edge
    // clamping) as long as the map exceeds the viewport by the delta margin.
    const deltaFeetX = 8;
    const deltaFeetY = 6;
    expect(
      mapWpx - view.x,
      'map must exceed the camera viewport width for an unclamped camera-follow guard',
    ).toBeGreaterThan(ftToPx(deltaFeetX) + 16);
    expect(
      mapHpx - view.y,
      'map must exceed the camera viewport height for an unclamped camera-follow guard',
    ).toBeGreaterThan(ftToPx(deltaFeetY) + 16);

    const centerXFt = Math.round(map.x / 2);
    const centerYFt = Math.round(map.y / 2);
    const aFeet = { x: centerXFt - deltaFeetX / 2, y: centerYFt - deltaFeetY / 2 };
    const bFeet = { x: centerXFt + deltaFeetX / 2, y: centerYFt + deltaFeetY / 2 };

    await mainSceneProbe.setPlayerFeet(page, aFeet.x, aFeet.y);
    const camA = await waitForCameraCenter(
      page,
      { x: ftToPx(aFeet.x), y: ftToPx(aFeet.y) },
      CAMERA_TOLERANCE_PX,
    );

    await mainSceneProbe.setPlayerFeet(page, bFeet.x, bFeet.y);
    const camB = await waitForCameraCenter(
      page,
      { x: ftToPx(bFeet.x), y: ftToPx(bFeet.y) },
      CAMERA_TOLERANCE_PX,
    );

    // The strongest characterization: the camera center moves by exactly the
    // feet delta converted to pixels (linear 1:1 follow, no smoothing/deadzone).
    expect(
      Math.abs(camB.x - camA.x - ftToPx(deltaFeetX)),
      'camera X delta should equal ftToPx(Δfeet.x)',
    ).toBeLessThanOrEqual(CAMERA_TOLERANCE_PX);
    expect(
      Math.abs(camB.y - camA.y - ftToPx(deltaFeetY)),
      'camera Y delta should equal ftToPx(Δfeet.y)',
    ).toBeLessThanOrEqual(CAMERA_TOLERANCE_PX);
  });

  it('restarts the real scene during a Floor 1 to Floor 2 transition', async () => {
    const pageErrors: string[] = [];
    const onPageError = (error: Error): void => {
      pageErrors.push(error.message);
    };
    page.on('pageerror', onPageError);

    try {
      await loadMainSceneProbeLab(page);
      await mainSceneProbe.resolveLoadout(page);
      await mainSceneProbe.primeFloor1StairTransition(page);

      await mainSceneProbe.queueInteraction(page);
      await waitForState(page, (s) => s.modalOpen, {
        label: 'descend confirmation modal',
      });
      await page.keyboard.press('Enter');

      const floor2State = await waitForState(
        page,
        (s) => s.settlementRoomCount > 0 && s.displayObjectCount > 0,
        { timeoutMs: 15_000, label: 'Floor 2 scene after restart' },
      );

      expect(new URL(page.url()).searchParams.get('floor')).toBe('floor2');
      expect(floor2State.settlementRoomCount).toBeGreaterThan(0);
      expect(pageErrors).toEqual([]);
    } finally {
      page.off('pageerror', onPageError);
    }
  });

  it('restarts the real scene during a Floor 2 to Floor 3 transition', async () => {
    // "Beating Floor 2 starts Floor 3" in the SHIPPED game: the real scene must
    // take the exit, show the transition completion screen, and restart
    // in-process on Floor 3 — reading the scenario contract only, with no
    // floor-identity branch in the engine.
    const pageErrors: string[] = [];
    const onPageError = (error: Error): void => {
      pageErrors.push(error.message);
    };
    page.on('pageerror', onPageError);

    try {
      await loadMainSceneProbeLab(page, { floor: 'floor2' });
      const floor2State = await waitForState(page, (s) => s.settlementRoomCount > 0, {
        timeoutMs: 15_000,
        label: 'Floor 2 scene boot',
      });
      expect(floor2State.floorId).toBe('floor2');

      await mainSceneProbe.primeFloor2StairTransition(page);
      await mainSceneProbe.queueInteraction(page);
      await waitForState(page, (s) => s.modalOpen, {
        label: 'Floor 2 exit confirmation modal',
      });
      await page.keyboard.press('Enter');

      const floor3State = await waitForState(
        page,
        (s) => s.floorId === 'floor3' && s.displayObjectCount > 0,
        { timeoutMs: 20_000, label: 'Floor 3 scene after restart' },
      );
      const floor3LoadoutState = await waitForState(
        page,
        (s) => s.floorId === 'floor3' && s.worldState === 'loadout' && s.modalOpen,
        { timeoutMs: 10_000, label: 'Floor 3 starter-companion loadout modal open' },
      );
      const floor3LoadoutContent = await mainSceneProbe.getModalPickerContent(page);

      expect(new URL(page.url()).searchParams.get('floor')).toBe('floor3');
      expect(floor3State.floorId).toBe('floor3');
      expect(floor3LoadoutState.worldState).toBe('loadout');
      expect(floor3LoadoutContent?.title).toBe('Choose your starter Companion');
      expect(floor3LoadoutContent?.options).toHaveLength(4);
      expect(
        floor3LoadoutContent?.options.every(
          (option) =>
            option.label.trim().length > 0 &&
            (option.description ?? '').trim().length > 0 &&
            option.disabled === false,
        ),
      ).toBe(true);

      await page.keyboard.press('Enter');
      await waitForState(
        page,
        (s) => s.floorId === 'floor3' && s.worldState === 'playing' && !s.modalOpen,
        { timeoutMs: 10_000, label: 'Floor 3 starter-companion loadout confirmed' },
      );
      expect(pageErrors).toEqual([]);
    } finally {
      page.off('pageerror', onPageError);
    }
  });
});
