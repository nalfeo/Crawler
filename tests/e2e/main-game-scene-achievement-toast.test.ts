import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('MainGameScene achievement toast layout', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('places a real achievement toast below visible director commentary', async () => {
    await loadMainSceneProbeLab(page);
    const layout = await mainSceneProbe.primeAchievementToastWithCommentary(page);

    expect(layout?.commentaryText).toContain('long director callout');
    expect(layout?.toastText).toContain('Fully Outfitted');
    expect(layout?.commentary).not.toBeNull();
    expect(layout?.toast).not.toBeNull();
    expect(layout!.toast!.y).toBeGreaterThanOrEqual(
      layout!.commentary!.y + layout!.commentary!.height,
    );
  });

  it.each([
    { name: 'standard', width: 1280, height: 720 },
    { name: 'compact', width: 640, height: 360 },
  ])('keeps Fully Outfitted text regions separate at $name size', async ({ width, height }) => {
    const visualContext = await browser.newContext({ viewport: { width, height } });
    const visualPage = await visualContext.newPage();
    try {
      await loadMainSceneProbeLab(visualPage, { floor: 'floor2' });
      await mainSceneProbe.resolveLoadout(visualPage);
      await mainSceneProbe.unlockSafeRoomSurfaces(visualPage);
      await mainSceneProbe.seedAchievementForPresentation(visualPage, 'floor2-run-fully-outfitted');
      await mainSceneProbe.requestAchievementsToggle(visualPage);
      await waitForState(visualPage, (state) => state.achievementsOpen, {
        label: 'Awards panel open for layout measurement',
      });
      await mainSceneProbe.setAchievementsFilter(visualPage, 'global');
      const layout = await mainSceneProbe.getAchievementsLayoutRegions(visualPage);
      const textRegions = layout.filter(
        (region) =>
          region.id.startsWith('row:floor2-run-fully-outfitted.') && region.kind === 'text',
      );
      expect(textRegions, JSON.stringify(layout)).toHaveLength(3);
      const title = textRegions.find((region) => region.id.endsWith('.title'))!;
      const criteria = textRegions.find((region) => region.id.endsWith('.criteria'))!;
      const flavor = textRegions.find((region) => region.id.endsWith('.flavor'))!;
      expect(criteria.box.y).toBeGreaterThanOrEqual(title.box.y + title.box.height + 4);
      expect(flavor.box.y).toBeGreaterThanOrEqual(criteria.box.y + criteria.box.height + 6);
    } finally {
      await visualContext.close();
    }
  });
});
