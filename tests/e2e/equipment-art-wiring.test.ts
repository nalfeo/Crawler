/**
 * Equipment art wiring guard (rule #9 "observe before done", deterministic).
 *
 * Themed equipment art (`<theme>-<slug>-vN`) used to reach the game only via a
 * hardcoded `resolveBasicLeatherAliasEntry` alias in the ENGINE layer's
 * `preload.ts`, which knew the literal theme id `classic-fantasy-basic-leather`.
 * That alias was deleted once `itemSpriteConcepts` learned to derive themed
 * concepts from the shared theme-set registry
 * (`src/shared/data/equipment-theme-sets.ts`).
 *
 * A lab CANNOT prove that change: the whole question is whether the SHIPPED
 * boot preload (`BootScene` → `preloadGeneratedSprites`) still loads the texture
 * the resolver now picks, and a lab force-loads its own registry. So this suite
 * boots the REAL `MainGameScene` through the shipped floor bootstrap
 * (`createFloorGameConfig` + `createFloorMainSceneOptions`, which includes
 * `BootScene`) and asserts, against the running game:
 *
 *   1. a Classic Fantasy Basic Leather reward-pool piece resolves to REAL
 *      (non-placeholder) art whose texture Phaser actually has loaded — i.e.
 *      the deleted engine-layer alias is genuinely no longer required;
 *   2. `leather-boots` / `leather-gloves` — legacy-catalog ids that already had
 *      Basic Leather art in the manifest but no way to reach it — now resolve to
 *      real art too (the two "freebies" the generalization picks up);
 *   3. an item with no themed art still resolves to its own art rather than
 *      being hijacked by a themed concept (themed concepts are appended LAST, so
 *      they can never outrank the item's own art at the same tier).
 *
 * Determinism: the probe lab boots with a fixed `worldSeed`, and
 * `getItemIconRenderInfo` resolves through the shipped `resolveItemSprite` with
 * the same `hashStringToSeed(itemId) ^ worldSeed` the UI uses. No wall-clock or
 * RNG enters an assertion; every assertion is on a resolved brief id / boolean.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

/**
 * A Classic Fantasy Basic Leather reward-pool stable id. Its art exists in the
 * manifest ONLY under the themed key `classic-fantasy-basic-leather-<slug>-v1`,
 * so before the resolver generalization it was reachable only via the deleted
 * engine-layer alias.
 */
const THEMED_STABLE_ID = 'weapon.iron-dagger';

/** Legacy-catalog ids whose Basic Leather art was previously unreachable. */
const FREEBIE_ITEM_IDS = ['leather-boots', 'leather-gloves'] as const;

describe('equipment art wiring in the real booted scene', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page);
    await waitForState(page, (state) => state.hudPresent && state.bridgePresent);
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('resolves themed Basic Leather art without the deleted engine-layer alias', async () => {
    const info = await mainSceneProbe.getItemIconRenderInfo(page, THEMED_STABLE_ID);

    expect(info.briefId).not.toBeNull();
    expect(info.briefId).toContain('classic-fantasy-basic-leather');
    expect(info.isPlaceholder).toBe(false);
    // The shipped BootScene preload must have queued this exact texture.
    expect(info.textureLoaded).toBe(true);
  });

  it('picks up legacy-catalog leather pieces that already had themed art', async () => {
    for (const itemId of FREEBIE_ITEM_IDS) {
      const info = await mainSceneProbe.getItemIconRenderInfo(page, itemId);

      expect(info.briefId, itemId).not.toBeNull();
      expect(info.isPlaceholder, itemId).toBe(false);
      expect(info.textureLoaded, itemId).toBe(true);
    }
  });

  it('does not let themed art hijack an item that has its own art', async () => {
    const info = await mainSceneProbe.getItemIconRenderInfo(page, 'bone-club');

    expect(info.briefId).not.toBeNull();
    expect(info.briefId).not.toContain('classic-fantasy-basic-leather');
    expect(info.isPlaceholder).toBe(false);
    expect(info.textureLoaded).toBe(true);
  });
});
