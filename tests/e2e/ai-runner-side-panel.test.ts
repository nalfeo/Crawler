import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=ai-runner`;
const PRIMARY_CONTROL_IDS = [
  'ai-manual-toggle',
  'ai-toggle-run',
  'ai-restart-current',
  'ai-speed-1',
  'ai-speed-4',
  'ai-speed-16',
] as const;

interface ControlSnapshot {
  id: string;
  missing: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
  hit: boolean;
}

async function loadSidePanel(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#ai-playback-dock', { timeout: 45_000 });
  await page.evaluate(() => {
    document.getElementById('app-header')?.remove();
    document.getElementById('lab-stage')?.remove();
    document.getElementById('controls-toggle')?.remove();
    const controls = document.getElementById('lab-controls');
    if (!controls) throw new Error('Missing AI Runner controls host');
    controls.style.cssText =
      'position:fixed;inset:0;width:100vw;max-width:none;height:100vh;max-height:none;padding:0;overflow:auto;';
    for (const child of controls.children) {
      if (child instanceof HTMLElement) {
        child.style.display = child.querySelector?.('#ai-playback-dock') ? '' : 'none';
      }
    }
  });
}

describe('AI Runner expert side panel', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('keeps every primary command visible, separate, and clickable at 360x900', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    await loadSidePanel(page);

    const controls = (await page.evaluate((ids) => {
      return ids.map((id) => {
        const element = document.getElementById(id);
        if (!(element instanceof HTMLButtonElement)) {
          return { id, missing: true, box: null, hit: false };
        }
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          id,
          missing: false,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          hit: hit === element || element.contains(hit),
        };
      });
    }, PRIMARY_CONTROL_IDS)) as ControlSnapshot[];

    for (const control of controls) {
      expect(control.missing, `${control.id} must exist`).toBe(false);
      if (!control.box) continue;
      expect(control.box.x, `${control.id} left edge`).toBeGreaterThanOrEqual(0);
      expect(control.box.y, `${control.id} top edge`).toBeGreaterThanOrEqual(0);
      expect(control.box.x + control.box.width, `${control.id} right edge`).toBeLessThanOrEqual(
        360,
      );
      expect(control.box.y + control.box.height, `${control.id} bottom edge`).toBeLessThanOrEqual(
        900,
      );
      expect(control.hit, `${control.id} center must be clickable`).toBe(true);
    }

    for (const [index, control] of controls.entries()) {
      if (!control.box) continue;
      for (const later of controls.slice(index + 1)) {
        if (!later.box) continue;
        const overlaps =
          control.box.x < later.box.x + later.box.width &&
          control.box.x + control.box.width > later.box.x &&
          control.box.y < later.box.y + later.box.height &&
          control.box.y + control.box.height > later.box.y;
        expect(overlaps, `${control.id} must not overlap ${later.id}`).toBe(false);
      }
    }

    await page.locator('#ai-tree-details').evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.locator('#ai-tree-details-summary').focus();
    await page.evaluate(() => {
      document.getElementById('ai-speed-4')?.click();
    });
    await expect.poll(() => page.locator('#ai-tree-details').getAttribute('open')).not.toBeNull();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe('ai-tree-details-summary');

    await page.locator('#ai-toggle-run').click();
    await expect.poll(() => page.locator('#ai-toggle-run').textContent()).toBe('Pause');
    await page.locator('#ai-speed-4').click();
    await expect.poll(() => page.locator('#ai-speed-4').getAttribute('aria-pressed')).toBe('true');
    await page.locator('#ai-manual-toggle').click();
    await expect.poll(() => page.locator('#ai-manual-toggle').textContent()).toBe('◆ Return AI');

    // Open Run Setup disclosure to expose the staged seed/target inputs before restarting
    await page.locator('#ai-run-setup').evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });

    // Record the initially applied seed and stage a clearly different value
    const initialAppliedSeed = await page.locator('#ai-seed-input').inputValue();
    const stagedSeed = String(parseInt(initialAppliedSeed, 10) + 9999);
    await page.locator('#ai-seed-input').fill(stagedSeed);

    // Stage a different run target (scenario vs. the applied floor:floor1)
    await page.locator('#ai-run-target-select').selectOption('scenario:spawner-sealable-room');

    // Restart replays the currently applied run — staged values must not be consumed
    await page.locator('#ai-restart-current').click();
    await expect
      .poll(() => page.locator('#ai-run-settings-note').textContent())
      .toContain('Restarted the currently applied run.');

    // Staged seed must remain in the input (not reverted to the originally applied seed)
    await expect.poll(() => page.locator('#ai-seed-input').inputValue()).toBe(stagedSeed);

    // Staged run target must remain selected (not cleared back to the applied floor:floor1)
    await expect
      .poll(() => page.locator('#ai-run-target-select').inputValue())
      .toBe('scenario:spawner-sealable-room');

    // Debug snapshot must reflect the originally applied scenario (floor1-default),
    // confirming the restart did not silently apply the staged scenario target
    await expect
      .poll(() => page.evaluate(() => window.__aiRunnerDebug?.()?.scenarioPreset ?? null))
      .toBe('floor1-default');

    await page.locator('.runner-content details').evaluateAll((details) => {
      for (const detail of details) {
        (detail as HTMLDetailsElement).open = true;
      }
    });
    await page.locator('#lab-controls').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const deckTop = await page.locator('#ai-playback-dock').evaluate((element) => {
      return element.getBoundingClientRect().top;
    });
    expect(deckTop).toBe(0);
    await page.close();
  }, 90_000);
});
