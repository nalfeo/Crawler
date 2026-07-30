import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { FLOOR2_QUARTERMASTER_ARCHETYPE_ID } from '../../src/shared/data/shop-archetypes.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import {
  PLAYER_ACQUISITION_SOURCES,
  type PlayerAcquisitionSource,
} from './helpers/player-acquisition-sources.js';

describe('MainGameScene Floor 2 Quartermaster placement', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page, { floor: 'floor2' });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('exposes exactly one Quartermaster plus 1-2 other shops through the real scene bootstrap', async () => {
    const state = await mainSceneProbe.getState(page);
    const quartermasters = state.settlementShopArchetypeIds.filter(
      (archetypeId) => archetypeId === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    );
    const otherShops = state.settlementShopArchetypeIds.filter(
      (archetypeId) => archetypeId !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    );

    expect(state.settlementRoomCount).toBeGreaterThanOrEqual(2);
    expect(state.settlementRoomCount).toBeLessThanOrEqual(3);
    expect(quartermasters).toHaveLength(1);
    expect(otherShops.length).toBeGreaterThanOrEqual(1);
    expect(otherShops.length).toBeLessThanOrEqual(2);
  });
});

describe('MainGameScene Floor 2 Quartermaster purchase UI', () => {
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

  async function bootFloor2SafeScene(): Promise<void> {
    await loadMainSceneProbeLab(page, { floor: 'floor2' });
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
    await mainSceneProbe.unlockSafeRoomSurfaces(page);
    await waitForState(page, (s) => s.safeContext, { label: 'safe-room surfaces unlocked' });
  }

  it('shows Shop button in safe context when quartermasterStock exists', async () => {
    await bootFloor2SafeScene();

    const state = await waitForState(page, (s) => s.safeContext, {
      label: 'in safe context',
    });

    // On Floor 2 the settlement is initialised at boot, so quartermasterStock
    // should already be present — the Shop button must be visible.
    expect(
      state.quartermasterButtonVisible,
      'Shop button should be visible in safe context with stock',
    ).toBe(true);
    expect(state.quartermasterOpen, 'Quartermaster panel should start closed').toBe(false);
  });

  it('opens and closes the Quartermaster panel via Q key request', async () => {
    await bootFloor2SafeScene();

    await mainSceneProbe.requestQuartermasterToggle(page);
    const opened = await waitForState(page, (s) => s.quartermasterOpen, {
      label: 'Quartermaster panel opened',
    });

    expect(opened.quartermasterOpen, 'panel should be open').toBe(true);
    expect(opened.primarySurfaceCount, 'Quartermaster panel counts as a primary surface').toBe(1);

    await mainSceneProbe.requestQuartermasterToggle(page);
    const closed = await waitForState(page, (s) => !s.quartermasterOpen, {
      label: 'Quartermaster panel closed',
    });

    expect(closed.quartermasterOpen, 'panel should close on second toggle').toBe(false);
    expect(closed.primarySurfaceCount).toBe(0);
  });

  it('Quartermaster panel closes when inventory opens (exclusivity)', async () => {
    await bootFloor2SafeScene();

    await mainSceneProbe.requestQuartermasterToggle(page);
    await waitForState(page, (s) => s.quartermasterOpen, { label: 'Quartermaster opened' });

    await mainSceneProbe.requestInventoryToggle(page);
    const state = await waitForState(page, (s) => s.inventoryOpen, {
      label: 'Inventory opened, Quartermaster should close',
    });

    expect(state.inventoryOpen, 'inventory must be open').toBe(true);
    expect(state.quartermasterOpen, 'Quartermaster must close when inventory opens').toBe(false);
    expect(state.primarySurfaceCount, 'only one panel open at a time').toBe(1);
  });

  it('generates purchasable stock offers on Floor 2 settlement bootstrap', async () => {
    await bootFloor2SafeScene();

    const offers = await mainSceneProbe.getQuartermasterStockSnapshot(page);
    expect(offers.length, 'should have at least one offer in stock').toBeGreaterThan(0);
    // Verify each offer has required fields
    for (const offer of offers) {
      expect(offer.stockId, 'stockId must be non-empty').toBeTruthy();
      expect(offer.offerId, 'offerId must be non-empty').toBeTruthy();
      expect(offer.unitPrice, 'unitPrice must be positive').toBeGreaterThan(0);
      expect(offer.quantity, 'quantity must be >= 0').toBeGreaterThanOrEqual(0);
    }
  });

  it('purchases the first offer — gold decreases, offer becomes sold out', async () => {
    await bootFloor2SafeScene();

    const offers = await mainSceneProbe.getQuartermasterStockSnapshot(page);
    expect(offers.length, 'need at least one offer to test purchase').toBeGreaterThan(0);

    // Give the player plenty of gold so the first offer is always affordable.
    await mainSceneProbe.setPlayerGold(page, 100_000);
    const goldBefore = await mainSceneProbe.getPlayerGold(page);
    expect(goldBefore, 'gold should be 100_000 after setPlayerGold').toBe(100_000);

    const result = await mainSceneProbe.purchaseFirstQuartermasterOffer(page);
    expect(result.ok, 'purchase should succeed with sufficient gold').toBe(true);
    expect(result.goldSpent, 'goldSpent must be > 0').toBeGreaterThan(0);

    const goldAfter = await mainSceneProbe.getPlayerGold(page);
    expect(goldAfter, 'gold should decrease by goldSpent').toBe(
      (goldBefore ?? 0) - (result.goldSpent ?? 0),
    );

    // The purchased offer should be sold out (quantity = 0) in the next snapshot.
    const offersAfter = await mainSceneProbe.getQuartermasterStockSnapshot(page);
    const purchasedOffer = offersAfter.find((o) => o.offerId === offers[0]!.offerId);
    expect(purchasedOffer?.quantity, 'purchased offer must show quantity = 0').toBe(0);
  });

  it('supports keyboard purchase with Enter on the focused Buy control', async () => {
    await bootFloor2SafeScene();

    const offers = await mainSceneProbe.getQuartermasterStockSnapshot(page);
    expect(offers.length, 'need at least one offer to test keyboard purchase').toBeGreaterThan(0);

    await mainSceneProbe.setPlayerGold(page, 100_000);
    await mainSceneProbe.requestQuartermasterToggle(page);
    await waitForState(page, (s) => s.quartermasterOpen, { label: 'Quartermaster opened' });

    const goldBefore = await mainSceneProbe.getPlayerGold(page);
    await page.keyboard.press('Enter');
    let goldAfter = goldBefore;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      goldAfter = await mainSceneProbe.getPlayerGold(page);
      if ((goldAfter ?? 0) < (goldBefore ?? 0)) break;
      await page.waitForTimeout(100);
    }
    expect(goldAfter, 'gold should decrease after keyboard purchase').toBeLessThan(goldBefore ?? 0);

    const offersAfter = await mainSceneProbe.getQuartermasterStockSnapshot(page);
    const purchasedOffer = offersAfter.find((o) => o.offerId === offers[0]!.offerId);
    expect(purchasedOffer?.quantity, 'keyboard purchase should mark first offer sold out').toBe(0);
  });
});

describe('MainGameScene acquisition → observation contract', () => {
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

  async function bootFloor2SafeScene(): Promise<void> {
    await loadMainSceneProbeLab(page, { floor: 'floor2' });
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
    await mainSceneProbe.unlockSafeRoomSurfaces(page);
    await waitForState(page, (s) => s.safeContext, { label: 'safe-room surfaces unlocked' });
  }

  async function ensureInventoryOpen(): Promise<void> {
    const state = await mainSceneProbe.getState(page);
    if (!state.inventoryOpen) {
      await mainSceneProbe.requestInventoryToggle(page);
    }
    await waitForState(page, (s) => s.inventoryOpen, { label: 'inventory open' });
  }

  async function waitForInventoryItems(
    predicate: (ids: readonly string[]) => boolean,
    label: string,
  ): Promise<readonly string[]> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const ids = await mainSceneProbe.getInventoryVisibleItemIds(page);
      if (predicate(ids)) {
        return ids;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${label}`);
      }
      await page.waitForTimeout(100);
    }
  }

  async function acquireAndObserve(source: PlayerAcquisitionSource): Promise<void> {
    await bootFloor2SafeScene();
    await ensureInventoryOpen();
    const before = await mainSceneProbe.getInventoryVisibleItemIds(page);
    if (source === 'achievement-reward-claim') {
      await mainSceneProbe.claimAchievementReward(page, 'floor2-field-kit');
      const reward = await mainSceneProbe.getRewardOpeningState(page);
      if (reward.open) {
        await mainSceneProbe.skipRewardOpening(page);
        await mainSceneProbe.acknowledgeRewardOpening(page);
      }
      await ensureInventoryOpen();
      const after = await waitForInventoryItems(
        (ids) => ids.length > before.length,
        'achievement claim inventory render',
      );
      expect(
        after.length,
        'achievement claim should add a rendered inventory entry',
      ).toBeGreaterThan(before.length);
      return;
    }
    if (source === 'quartermaster-purchase') {
      await mainSceneProbe.setPlayerGold(page, 100_000);
      const result = await mainSceneProbe.purchaseFirstQuartermasterOffer(page);
      expect(result.ok, 'quartermaster purchase should succeed').toBe(true);
      expect(result.itemId, 'quartermaster purchase should resolve an item id').toBeTruthy();
      await ensureInventoryOpen();
      const after = await waitForInventoryItems(
        (ids) => ids.length > before.length && ids.includes(result.itemId!),
        'quartermaster purchase inventory render',
      );
      expect(
        after.length,
        'quartermaster purchase should add a rendered inventory entry',
      ).toBeGreaterThan(before.length);
      expect(after).toContain(result.itemId!);
      return;
    }
    if (source === 'boss-chest') {
      await mainSceneProbe.seedAvailableBossChest(page);
      const opened = await mainSceneProbe.openFirstAvailableBossChest(page);
      expect(opened, 'boss chest should open and acknowledge').toEqual({ ok: true });
      await ensureInventoryOpen();
      const after = await waitForInventoryItems(
        (ids) => ids.length > before.length,
        'boss chest inventory render',
      );
      expect(after.length, 'boss chest should add a rendered inventory entry').toBeGreaterThan(
        before.length,
      );
      return;
    }
    const seededDropItemId = before.includes('iron-breastplate')
      ? 'merchant-charm'
      : 'iron-breastplate';
    const pickedUp = await mainSceneProbe.spawnAndPickupFloorDrop(page, seededDropItemId);
    expect(pickedUp.ok, `floor drop '${seededDropItemId}' should be picked up`).toBe(true);
    await mainSceneProbe.unlockSafeRoomSurfaces(page);
    await ensureInventoryOpen();
    const after = await waitForInventoryItems(
      (ids) => ids.length > before.length && ids.includes(seededDropItemId),
      'floor drop inventory render',
    );
    expect(after, `floor drop should be rendered in inventory (${seededDropItemId})`).toContain(
      seededDropItemId,
    );
  }

  const runners: Record<PlayerAcquisitionSource, () => Promise<void>> = {
    'achievement-reward-claim': () => acquireAndObserve('achievement-reward-claim'),
    'quartermaster-purchase': () => acquireAndObserve('quartermaster-purchase'),
    'boss-chest': () => acquireAndObserve('boss-chest'),
    'floor-drop': () => acquireAndObserve('floor-drop'),
  };

  it('enforces that every registered acquisition source has seam coverage', () => {
    expect(Object.keys(runners).sort()).toEqual([...PLAYER_ACQUISITION_SOURCES].sort());
  });

  for (const source of PLAYER_ACQUISITION_SOURCES) {
    it(`acquireAndObserve(${source}) reaches rendered inventory contents`, async () => {
      await runners[source]();
    });
  }
});
