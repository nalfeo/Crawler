import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
] as const;

describe('real boss reward ability picker UX', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  for (const viewport of VIEWPORTS) {
    it(`fits measured content without overlap at ${viewport.width}x${viewport.height}`, async () => {
      context = await browser.newContext({ viewport });
      page = await context.newPage();
      await loadMainSceneProbeLab(page);
      await mainSceneProbe.openBossRewardPicker(page);
      const snapshot = await mainSceneProbe.getModalPickerLayout(page);
      if (!snapshot) {
        throw new Error('real boss reward picker layout was unavailable');
      }

      const panelRight = snapshot.panel.x + snapshot.panel.width;
      const panelBottom = snapshot.panel.y + snapshot.panel.height;
      const allContent = [
        snapshot.title,
        snapshot.subtitle,
        snapshot.body,
        ...snapshot.rows.flatMap((row) => [row.row, row.label, row.description]),
        snapshot.footer,
      ].filter((box): box is NonNullable<typeof box> => box !== null);

      for (const box of allContent) {
        expect(box.x).toBeGreaterThanOrEqual(snapshot.panel.x);
        expect(box.y).toBeGreaterThanOrEqual(snapshot.panel.y);
        expect(box.x + box.width).toBeLessThanOrEqual(panelRight);
        expect(box.y + box.height).toBeLessThanOrEqual(panelBottom);
      }
      for (const entry of snapshot.rows) {
        const rowRight = entry.row.x + entry.row.width;
        const rowBottom = entry.row.y + entry.row.height;
        for (const text of [entry.label, entry.description]) {
          expect(text.x).toBeGreaterThanOrEqual(entry.row.x);
          expect(text.y).toBeGreaterThanOrEqual(entry.row.y);
          expect(text.x + text.width).toBeLessThanOrEqual(rowRight);
          expect(text.y + text.height).toBeLessThanOrEqual(rowBottom);
        }
      }

      await context.close();
    });
  }
});
