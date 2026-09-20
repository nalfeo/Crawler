import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { Floor6PlayerLoopProbe } from '../../src/labs/main-scene-probe-lab/index.js';
import { loadMainSceneProbeLab } from './helpers/main-scene-probe.js';

/** Every write in this acceptance flow is an ordinary browser pointer event. */
const read = (page: Page): Promise<Floor6PlayerLoopProbe> =>
  page.evaluate(() => window.__mainSceneProbe!.getFloor6PlayerLoop()!);

async function clickGame(page: Page, x: number, y: number, touch: boolean): Promise<void> {
  const canvas = (await page.locator('#lab-canvas canvas').boundingBox())!;
  const clientX = canvas.x + (x / 1280) * canvas.width;
  const clientY = canvas.y + (y / 720) * canvas.height;
  if (touch) await page.touchscreen.tap(clientX, clientY);
  else await page.mouse.click(clientX, clientY);
  await page.waitForTimeout(100);
}

async function clickOption(page: Page, id: string, touch: boolean): Promise<void> {
  const state = await read(page);
  const index = state.modal!.options.findIndex((option) => option.id === id);
  expect(index, `Expected visible modal option ${id}`).toBeGreaterThanOrEqual(0);
  expect(state.modal!.options[index]!.disabled).toBe(false);
  const row = state.modalLayout!.rows[index]!.row;
  await clickGame(page, row.x + row.width / 2, row.y + row.height / 2, touch);
}

async function walk(page: Page, x: number, y: number): Promise<void> {
  const canvas = (await page.locator('#lab-canvas canvas').boundingBox())!;
  const origin = { x: canvas.x + canvas.width * 0.15, y: canvas.y + canvas.height * 0.7 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  try {
    for (let step = 0; step < 160; step += 1) {
      const state = await read(page);
      expect(state.modal, 'Movement must not open a construction modal').toBeNull();
      const dx = x - state.playerFt.x;
      const dy = y - state.playerFt.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 2) return;
      await page.mouse.move(origin.x + (dx / distance) * 65, origin.y + (dy / distance) * 65);
      await page.waitForTimeout(40);
    }
    throw new Error(
      `Normal movement could not reach ${x},${y}: ${JSON.stringify((await read(page)).playerFt)}`,
    );
  } finally {
    await page.mouse.up();
  }
}

async function evidence(page: Page, name: string): Promise<void> {
  const dir = process.env.FLOOR6_PLAYER_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `floor6-player-${name}.png`) });
}

describe('Floor 6 ordinary player economy loop', () => {
  it('keeps small-viewport touch drags distinct from taps and exposes unaffordable choices', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 960, height: 540 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(
        page,
        { floor: 'floor6', seed: 606 },
        process.env.FLOOR6_PLAYER_LAB_BASE_URL,
      );
      await walk(page, 150, 130);
      await walk(page, 194, 130);
      await walk(page, 194, 98);
      let state = await read(page);
      const canvas = (await page.locator('#lab-canvas canvas').boundingBox())!;
      const site = state.sites.find((candidate) => candidate.siteId === 'plinth-relay')!;
      const touch = {
        x: canvas.x + (site.x / 1280) * canvas.width,
        y: canvas.y + (site.y / 720) * canvas.height,
      };
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...touch, id: 1 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: touch.x + 65, y: touch.y, id: 1 }],
      });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(100);
      state = await read(page);
      expect(state.modal, 'A movement drag starting on a pad must not select it').toBeNull();
      expect(state.snapshot.sites.every((candidate) => !candidate.occupied)).toBe(true);
      const tapSite = state.sites.find((candidate) => candidate.siteId === 'plinth-relay')!;
      await clickGame(page, tapSite.x, tapSite.y, true);
      state = await read(page);
      expect(state.modal!.kind).toBe('floor6-tower-build');
      expect(state.modal!.options.find((option) => option.id === '__upgrades__')!.disabled).toBe(
        false,
      );
      expect(state.modal!.options.find((option) => option.id === 'signal-slinger')!.disabled).toBe(
        true,
      );
      for (const bounds of [
        state.modalLayout!.panel,
        ...state.modalLayout!.rows.map((row) => row.row),
      ]) {
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
      }
      await evidence(page, 'small-touch-build');
      await clickOption(page, '__upgrades__', true);
      expect((await read(page)).modal!.kind).toBe('construction-upgrades');
      await evidence(page, 'small-touch-upgrades');
      await clickOption(page, '__close__', true);
      expect((await read(page)).modal).toBeNull();
    } finally {
      await context.close();
      await browser.close();
    }
  }, 60_000);

  it('earns and collects requisitions, builds, inspects, sells, and buys an upgrade through pointer controls', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(
        page,
        { floor: 'floor6', seed: 606 },
        process.env.FLOOR6_PLAYER_LAB_BASE_URL,
      );
      const initial = await read(page);
      expect(initial.economy).toEqual({ balance: 0, totalEarned: 0, pickupsCollected: 0 });
      expect(initial.snapshot.sites.every((site) => !site.occupied)).toBe(true);
      await evidence(page, 'fresh-zero-currency');

      // Walk out of the ingress and along the authored south lane to its junction.
      // No fixture priming, currency injection, sim stepping, or transaction calls.
      await walk(page, 150, 130);
      await walk(page, 194, 130);
      await walk(page, 194, 98);
      let earned = await read(page);
      for (let attempt = 0; attempt < 90; attempt += 1) {
        earned = await read(page);
        if (earned.economy.balance >= 5 && earned.economy.pickupsCollected > 0) break;
        expect(earned.worldState).toBe('playing');
        expect(earned.phase).not.toBe('DEFEAT');
        const pickup = earned.pickups[0];
        if (pickup) {
          await walk(page, pickup.positionFt.x, pickup.positionFt.y);
          await walk(page, 194, 98);
        }
        await page.waitForTimeout(500);
      }
      expect(
        earned.economy.pickupsCollected,
        'Must collect a defeated raider requisition drop',
      ).toBeGreaterThan(0);
      expect(earned.economy.balance).toBeGreaterThanOrEqual(5);
      expect(earned.economy.totalEarned).toBeGreaterThanOrEqual(5);
      await evidence(page, 'earned-requisitions');

      const siteId = 'plinth-relay';
      let state = await read(page);
      const site = state.sites.find((candidate) => candidate.siteId === siteId)!;
      const balanceBeforeBuild = state.economy.balance;
      await clickGame(page, site.x, site.y, false);
      expect((await read(page)).modal!.kind).toBe('floor6-tower-build');
      await clickOption(page, 'signal-slinger', false);
      state = await read(page);
      expect(state.economy.balance).toBe(balanceBeforeBuild - 2);
      expect(
        state.snapshot.sites.find((candidate) => candidate.siteId === siteId)!.tower?.towerId,
      ).toBe('signal-slinger');
      expect(
        state.renderedLabels.find((label) => label.id === `construction-label:${siteId}`)!.text,
      ).toContain('Signal Slinger');
      await evidence(page, 'built-world');

      // Touch uses the same occupied-site path and actual picker hit areas.
      const occupiedSite = state.sites.find((candidate) => candidate.siteId === siteId)!;
      await clickGame(page, occupiedSite.x, occupiedSite.y, true);
      state = await read(page);
      expect(state.modal!.kind).toBe('construction-inspect');
      expect(`${state.modal!.title} ${state.modal!.body}`).toContain('36');
      await evidence(page, 'inspect');
      const balanceBeforeSell = state.economy.balance;
      await clickOption(page, '__sell__', true);
      state = await read(page);
      expect(state.economy.balance).toBe(balanceBeforeSell + 1);
      expect(state.snapshot.sites.find((candidate) => candidate.siteId === siteId)!.occupied).toBe(
        false,
      );

      const vacantSite = state.sites.find((candidate) => candidate.siteId === siteId)!;
      await clickGame(page, vacantSite.x, vacantSite.y, true);
      await clickOption(page, '__upgrades__', true);
      state = await read(page);
      expect(state.modal!.kind).toBe('construction-upgrades');
      const offer = state.snapshot.upgrades.find(
        (candidate) => candidate.affordable && !candidate.selected,
      )!;
      expect(offer).toBeDefined();
      const balanceBeforePurchase = state.economy.balance;
      await evidence(page, 'upgrade-offers');
      await clickOption(page, offer.offerId, true);
      state = await read(page);
      expect(state.economy.balance).toBe(balanceBeforePurchase - offer.cost);
      expect(
        state.snapshot.upgrades.find((candidate) => candidate.offerId === offer.offerId)!.selected,
      ).toBe(true);
      await evidence(page, 'upgrade-purchased');
      await clickOption(page, '__close__', true);
      expect((await read(page)).modal).toBeNull();
      await walk(page, 210, 98);
      // Use the shipped quest-log collapse control so the world evidence shows
      // the Relay glyph as well as its label, health, and incoming route arrows.
      const questLog = await page.evaluate(
        () =>
          window
            .__mainSceneProbe!.getSafeAreaLayout()
            .surfaces.find((surface) => surface.name === 'questTracker')!.bounds,
      );
      await clickGame(page, questLog.x + questLog.width / 2, questLog.y + 10, false);
      await evidence(page, 'quest-collapse');
      expect(
        (await read(page)).modal,
        'Quest-log header must not activate the Relay behind it',
      ).toBeNull();
      const collapsedQuestLog = await page.evaluate(
        () =>
          window
            .__mainSceneProbe!.getSafeAreaLayout()
            .surfaces.find((surface) => surface.name === 'questTracker')!.bounds,
      );
      expect(collapsedQuestLog.height).toBeLessThan(questLog.height);
      await evidence(page, 'relay-world');
      state = await read(page);
      const relayLabel = state.renderedLabels.find(
        (label) => label.id === 'construction-label:relay',
      )!;
      expect(relayLabel.visible).toBe(true);
      expect(relayLabel.text).toContain('HP');
      await clickGame(page, state.relay.x, state.relay.y, true);
      expect((await read(page)).modal!.kind).toBe('construction-upgrades');
      await clickOption(page, '__close__', true);
      expect((await read(page)).modal).toBeNull();
    } finally {
      await context.close();
      await browser.close();
    }
  }, 120_000);
});
