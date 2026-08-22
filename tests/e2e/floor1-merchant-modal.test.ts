import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

/**
 * Deterministic real-artifact coverage for the shared shop system on the
 * dialogue-merchant surface: the Floor 1 shopkeeper is opened through the REAL
 * MainGameScene interaction path and must render the shared shop wording
 * (`Name (Ng)` rows, `Gold: Ng` wallet line, shared blocked-row status text)
 * that `src/engine/shop/` defines for every merchant.
 */
describe('Floor 1 merchant modal — shared shop presentation', () => {
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

  async function openMerchantModal(gold: number): Promise<void> {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
    const merchant = await mainSceneProbe.primeShopkeeperPurchase(page, gold);
    expect(merchant, 'Floor 1 shopkeeper should be spawned').not.toBeNull();
    await mainSceneProbe.queueInteraction(page);
    await waitForState(page, (s) => s.modalOpen, { label: 'merchant modal opened' });
  }

  it('renders an affordable ware as a shared, enabled offer row', async () => {
    await openMerchantModal(500);

    const content = await mainSceneProbe.getModalPickerContent(page);
    expect(content).not.toBeNull();
    expect(content!.title).toBe("The Merchant's Wares");
    expect(content!.subtitle).toBe('Gold: 500g');
    expect(content!.options).toHaveLength(1);
    const [option] = content!.options;
    expect(option!.disabled).toBe(false);
    expect(option!.label).toMatch(/^.+ \(\d+g\)$/);
  });

  it('still shows the ware when it is unaffordable, disabled with the shared status', async () => {
    await openMerchantModal(0);

    const content = await mainSceneProbe.getModalPickerContent(page);
    expect(content).not.toBeNull();
    expect(content!.subtitle).toBe('Gold: 0g');
    expect(content!.options).toHaveLength(1);
    const [option] = content!.options;
    expect(option!.disabled).toBe(true);
    expect(option!.description).toBe('Not enough gold.');
    expect(option!.label).toMatch(/^.+ \(\d+g\)$/);
  });
});
