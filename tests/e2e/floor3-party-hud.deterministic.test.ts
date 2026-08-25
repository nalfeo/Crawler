/**
 * Floor-3 party HUD deterministic observation guard (repo rule #9).
 *
 * Loads the Floor-3 party-HUD lab, which mounts the *real* `HudUI` (and
 * therefore `HudFloor3Party`), and proves the before/after behavior of every
 * slice-13 surface through an explicit probe plus pixel evidence that the
 * panel really repaints. No timers, no randomness — each step is an explicit
 * probe call followed by an explicit HUD sync.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parsePng, readPixel, colorDist } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';
import type { Floor3UxProbeApi } from '../../src/labs/floor3-ux-lab/harness.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=floor3-party-hud-lab`;
/** Lab/scene background (0x05070f) — anything else is drawn HUD. */
const BG = { r: 0x05, g: 0x07, b: 0x0f };

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function getCanvasRect(page: Page): Promise<CanvasRect> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#lab-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Phaser canvas not found in #lab-canvas');
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

function panelRegion(
  rect: CanvasRect,
  bounds: { x: number; y: number; width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const sx = rect.width / GAME_W;
  const sy = rect.height / GAME_H;
  return {
    x: rect.x + bounds.x * sx,
    y: rect.y + bounds.y * sy,
    w: bounds.width * sx,
    h: bounds.height * sy,
  };
}

function nonBackgroundRatio(
  png: ReturnType<typeof parsePng>,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 20,
): number {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(png.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(png.height - 1, Math.round(rect.y + rect.h));
  let nonBg = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(png, x, y), BG) > threshold) nonBg += 1;
    }
  }
  return total > 0 ? nonBg / total : 0;
}

function changedPixelRatio(
  before: ReturnType<typeof parsePng>,
  after: ReturnType<typeof parsePng>,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 24,
): number {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(before.width - 1, after.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(before.height - 1, after.height - 1, Math.round(rect.y + rect.h));
  let changed = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > threshold) changed += 1;
    }
  }
  return total > 0 ? changed / total : 0;
}

type ProbeWindow = { __floor3UxProbe?: Floor3UxProbeApi };

/**
 * Run one probe verb in the page. `args` is structured-cloned, so every step is
 * an explicit, serializable command — no closures over test state.
 */
async function probe<K extends keyof Floor3UxProbeApi>(
  page: Page,
  method: K,
  ...args: Parameters<Extract<Floor3UxProbeApi[K], (...rest: never[]) => unknown>>
): Promise<ReturnType<Extract<Floor3UxProbeApi[K], (...rest: never[]) => unknown>>> {
  return page.evaluate(
    ({ method: name, args: callArgs }) => {
      const api = (window as unknown as ProbeWindow).__floor3UxProbe;
      if (!api) throw new Error('Floor 3 UX probe is not ready');
      const fn = api[name as keyof Floor3UxProbeApi] as (...rest: unknown[]) => unknown;
      return fn.apply(api, callArgs as unknown[]);
    },
    { method, args },
  ) as Promise<ReturnType<Extract<Floor3UxProbeApi[K], (...rest: never[]) => unknown>>>;
}

/** Wait for the HUD to re-sync after a probe mutation (one animation frame). */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

describe('Floor 3 party HUD deterministic observation', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let rect: CanvasRect;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
    await page.waitForFunction(
      () => Boolean((window as unknown as ProbeWindow).__floor3UxProbe?.ready()),
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(400);
    rect = await getCanvasRect(page);
  }, 120_000);

  afterAll(async () => {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(browser);
  });

  it('renders one row per party companion in slot order', async () => {
    const state = await probe(page, 'getPartyState');
    expect(state.visible).toBe(true);
    expect(state.rows.length).toBeGreaterThanOrEqual(3);
    expect(state.rows.map((row) => row.slot)).toEqual(
      [...state.rows.map((row) => row.slot)].sort((a, b) => a - b),
    );
    expect(state.bounds).not.toBeNull();

    const png = parsePng(await page.screenshot());
    const region = panelRegion(rect, state.bounds!);
    // The panel is really painted, not just logically "visible".
    expect(nonBackgroundRatio(png, region)).toBeGreaterThan(0.5);
  });

  it('repaints the HP bar when a companion takes damage (before/after)', async () => {
    const before = parsePng(await page.screenshot());
    const beforeRows = (await probe(page, 'getPartyState')).rows;
    expect(beforeRows[0]!.hpFraction).toBeGreaterThan(0.5);

    await probe(page, 'setHp', 0, 8);
    await settle(page);

    const afterRows = (await probe(page, 'getPartyState')).rows;
    expect(afterRows[0]!.hpFraction).toBeLessThan(0.2);

    const after = parsePng(await page.screenshot());
    const state = await probe(page, 'getPartyState');
    expect(changedPixelRatio(before, after, panelRegion(rect, state.bounds!))).toBeGreaterThan(0);
  });

  it('shows a KO row and refuses to command it', async () => {
    await probe(page, 'setKnockedOut', 0, true);
    await settle(page);
    const rows = (await probe(page, 'getPartyState')).rows;
    expect(rows[0]!.knockedOut).toBe(true);
    expect(rows[0]!.commandReady).toBe(false);

    const result = await probe(page, 'command', 0);
    expect(result).toEqual({ accepted: false, detail: 'knocked-out' });
    await probe(page, 'setKnockedOut', 0, false);
  });

  it('spends and recharges a command charge', async () => {
    await probe(page, 'setPlayerLevel', 1);
    await settle(page);
    const capacity = (await probe(page, 'getPartyState')).commandCapacity;
    expect(capacity).toBe(1);

    const accepted = await probe(page, 'command', 0);
    expect(accepted.accepted).toBe(true);

    const spent = await probe(page, 'getPartyState');
    expect(spent.commandsInUse).toBe(1);
    expect(spent.rows[0]!.commandReady).toBe(false);
    // The single charge is spent, so the other slots are blocked too.
    expect(spent.rows[1]!.commandReady).toBe(false);

    const blocked = await probe(page, 'command', 1);
    expect(blocked).toEqual({ accepted: false, detail: 'no-capacity' });

    await probe(page, 'advanceFrames', 600);
    await settle(page);
    const recharged = await probe(page, 'getPartyState');
    expect(recharged.commandsInUse).toBe(0);
    expect(recharged.rows[0]!.commandReady).toBe(true);
  });

  it('flips the matchup chevron when the rival affinity changes', async () => {
    await probe(page, 'setRivalDistanceFt', 6);
    await probe(page, 'setRivalSpecies', 'bloom-warden');
    await settle(page);
    const strong = (await probe(page, 'getPartyState')).rows[0]!.matchup;

    await probe(page, 'setRivalSpecies', 'lumen-warden');
    await settle(page);
    const weak = (await probe(page, 'getPartyState')).rows[0]!.matchup;

    expect(strong).toBe('strong');
    expect(weak).toBe('weak');

    // Out of engagement range there is no matchup to report.
    await probe(page, 'setRivalDistanceFt', 400);
    await settle(page);
    expect((await probe(page, 'getPartyState')).rows[0]!.matchup).toBeNull();
  });

  it('announces a level-up, evolution, and learned ability, then expires them', async () => {
    await probe(page, 'setLevel', 1, 16);
    await settle(page);
    const notices = (await probe(page, 'getPartyState')).notices;
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.join(' | ')).not.toContain('f3.');

    await probe(page, 'advanceFrames', 600);
    await settle(page);
    expect((await probe(page, 'getPartyState')).notices).toEqual([]);
  });

  it('opens the roster overlay and moves the cursor between companions', async () => {
    await probe(page, 'openRoster');
    await settle(page);
    const opened = await probe(page, 'getRosterState');
    expect(opened.open).toBe(true);
    expect(opened.cursor).toBe(0);
    expect(opened.entries.length).toBeGreaterThanOrEqual(3);
    expect(opened.detailLines.join(' | ')).toContain('ABILITIES');

    await probe(page, 'moveRosterCursor', 1);
    await settle(page);
    const moved = await probe(page, 'getRosterState');
    expect(moved.cursor).toBe(1);
    expect(moved.detailLines).not.toEqual(opened.detailLines);

    // Cursor wraps backwards off the top of the list.
    await probe(page, 'moveRosterCursor', -2);
    await settle(page);
    const wrapped = await probe(page, 'getRosterState');
    expect(wrapped.cursor).toBe(moved.entries.length - 1);

    await probe(page, 'closeRoster');
    await settle(page);
    expect((await probe(page, 'getRosterState')).open).toBe(false);
  });
});
