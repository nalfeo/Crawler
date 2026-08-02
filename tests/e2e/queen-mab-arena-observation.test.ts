import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const QUEEN_ANNOUNCEMENT = 'VERDIGRIS GLAMOUR — All that glitters will corrode!';
const DELTA_MS = 1000 / 60;
/** Frame at which the first telegraph starts (9000ms / DELTA_MS). */
const TELEGRAPH_FRAME = 540;
/** Frame at which the first cast resolves (telegraph 1500ms / DELTA_MS = 90 frames). */
const RESOLUTION_FRAME = 630;
/** Frame at which Tarnished expires (4000ms / DELTA_MS = 240 frames after resolution). */
const TARNISHED_EXPIRY_FRAME = 870;
/** Frame at which the second telegraph starts (cooldown 9000ms / DELTA_MS after resolution). */
const SECOND_TELEGRAPH_FRAME = 1170;
/** Frame at which the second cast resolves. */
const SECOND_RESOLUTION_FRAME = 1260;

/**
 * Richer local type for the Queen Mab arena scene hook.
 *
 * Intentionally NOT augmenting the global `Window` interface here — the
 * narrower `__arenaScene` declaration in `combat-arena-terrain.test.ts` covers
 * that file's needs, and a conflicting augmentation would cause TS2717.
 * All `page.evaluate` / `page.waitForFunction` callbacks cast `window` inline
 * as `{ __arenaScene?: QmArenaScene }` — the interface is erased at compile
 * time so the emitted JavaScript simply reads `window.__arenaScene`.
 */
interface QmArenaScene {
  /** Player entity ID — private in TypeScript source but accessible at runtime. */
  readonly playerEid: number;
  settings: {
    roomPresetId: string;
    floorFilter: string;
    enemyPresetId: string;
    playerMode: string;
    simSpeed: number;
  };
  respawn(): void;
  update(time: number, delta: number): void;
  world: {
    state: string;
    frameCount: number;
    elapsedMs: number;
    announcements: Array<{ kind: string; text?: string }>;
    mobAbilities?: { cues?: unknown[] };
    statusEffectsByEntity: Map<number, Array<{ sourceType: string; sourceId: string }>>;
  };
  children?: {
    list?: Array<{ type?: string; visible?: boolean }>;
  };
}

async function loadArenaLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
        timeout: 30_000,
        polling: 200,
      });
      await page.waitForTimeout(150);
      return;
    } catch {
      if (attempt < 2) {
        await page.reload({ waitUntil: 'commit', timeout: 45_000 });
        await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
      }
    }
  }
  throw new Error('ArenaScene.create() never set window.__arenaReady');
}

async function configureQueenArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: QmArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-queen-mab';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const scene = (window as unknown as { __arenaScene?: QmArenaScene }).__arenaScene;
      return Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-queen-mab';
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: QmArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

interface ArenaProbe {
  readonly frame: number;
  readonly elapsedMs: number;
  readonly graphicsCount: number;
  readonly cueCount: number;
  readonly announcementText: string | null;
  /** Whether the player entity currently has an active Verdigris Glamour (Tarnished) debuff. */
  readonly tarnishedActive: boolean;
}

async function stepToFrame(page: Page, targetFrame: number): Promise<ArenaProbe> {
  return page.evaluate(
    ({ targetFrame, deltaMs, announcement }) => {
      const scene = (window as unknown as { __arenaScene?: QmArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      const stepFrames = (count: number) => {
        scene.world.state = 'playing';
        for (let i = 0; i < count; i += 1) {
          scene.update(0, deltaMs);
        }
        scene.world.state = 'paused';
      };
      const currentFrame = scene.world.frameCount;
      if (currentFrame > targetFrame) {
        throw new Error(
          `scene already advanced past target frame ${targetFrame} (at ${currentFrame})`,
        );
      }
      stepFrames(targetFrame - currentFrame);
      const graphicsCount =
        scene.children?.list?.filter((obj) => obj?.type === 'Graphics' && obj.visible !== false)
          .length ?? 0;
      const announcementText =
        scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null;
      const cueCount = scene.world.mobAbilities?.cues?.length ?? 0;
      // Check whether the player has an active Verdigris Glamour debuff.
      // statusEffectsByEntity is a JavaScript Map — process inside evaluate to
      // avoid serialisation issues (Maps are not JSON-serialisable).
      const playerEid = scene.playerEid;
      const effects = scene.world.statusEffectsByEntity.get(playerEid) ?? [];
      const tarnishedActive = effects.some(
        (e) =>
          e.sourceType === 'ability' &&
          e.sourceId.startsWith('mob-ability:queen-mab-verdigris-glamour:'),
      );
      const probe = {
        frame: scene.world.frameCount,
        elapsedMs: scene.world.elapsedMs,
        graphicsCount,
        cueCount,
        announcementText,
        tarnishedActive,
      } satisfies ArenaProbe;
      if (probe.announcementText !== null && probe.announcementText !== announcement) {
        throw new Error(`unexpected announcement text: ${probe.announcementText}`);
      }
      return probe;
    },
    { targetFrame, deltaMs: DELTA_MS, announcement: QUEEN_ANNOUNCEMENT },
  );
}

function countChangedPixels(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 24,
): number {
  const before = parsePng(beforeBuffer);
  const after = parsePng(afterBuffer);
  let changed = 0;
  let total = 0;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(before.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(before.height - 1, Math.round(rect.y + rect.h));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > threshold) {
        changed += 1;
      }
    }
  }
  return total === 0 ? 0 : changed / total;
}

describe('Queen Mab arena observation', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: GAME_W, height: GAME_H } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('observes the full two-cast Verdigris Glamour lifecycle in the live combat arena (frames 540, 630, 870, 1170, 1260)', async () => {
    await loadArenaLab(page);
    await configureQueenArena(page);

    // ── Phase 1: first telegraph starts at frame 540 ──────────────────────
    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();

    const telegraph1 = await stepToFrame(page, TELEGRAPH_FRAME);
    const telegraph1Shot = await page.locator('#lab-canvas canvas').screenshot();

    expect(before.frame).toBe(TELEGRAPH_FRAME - 1);
    expect(before.elapsedMs).toBeCloseTo(9000 - DELTA_MS, 6);
    expect(before.cueCount).toBe(0);
    expect(before.announcementText).toBeNull();
    expect(before.tarnishedActive).toBe(false);

    expect(telegraph1.frame).toBe(TELEGRAPH_FRAME);
    expect(telegraph1.elapsedMs).toBeCloseTo(9000, 6);
    expect(telegraph1.cueCount).toBe(1);
    expect(telegraph1.announcementText).toBe(QUEEN_ANNOUNCEMENT);
    expect(telegraph1.graphicsCount).toBeGreaterThan(before.graphicsCount);
    expect(telegraph1.tarnishedActive).toBe(false); // Telegraph visible; no hit yet

    const telegraphDiff = countChangedPixels(beforeShot, telegraph1Shot, {
      x: GAME_W * 0.3,
      y: GAME_H * 0.3,
      w: GAME_W * 0.4,
      h: GAME_H * 0.4,
    });
    const bannerDiff = countChangedPixels(beforeShot, telegraph1Shot, {
      x: GAME_W * 0.25,
      y: 0,
      w: GAME_W * 0.5,
      h: GAME_H * 0.16,
    });
    expect(telegraphDiff).toBeGreaterThan(0.002);
    expect(bannerDiff).toBeGreaterThan(0.01);

    // ── Phase 2: first resolution at frame 630 — Tarnished applied ────────
    const resolution1 = await stepToFrame(page, RESOLUTION_FRAME);
    const resolution1Shot = await page.locator('#lab-canvas canvas').screenshot();

    expect(resolution1.frame).toBe(RESOLUTION_FRAME);
    expect(resolution1.elapsedMs).toBeCloseTo(10_500, 6);
    expect(resolution1.cueCount).toBe(0); // Cue resolved; no active telegraph
    expect(resolution1.tarnishedActive).toBe(true); // Player in 12ft AOE; Tarnished applied

    // Resolution burst should produce a visible render change in the centre.
    const resolutionDiff = countChangedPixels(telegraph1Shot, resolution1Shot, {
      x: GAME_W * 0.3,
      y: GAME_H * 0.3,
      w: GAME_W * 0.4,
      h: GAME_H * 0.4,
    });
    expect(resolutionDiff).toBeGreaterThan(0.002);

    // ── Phase 3: Tarnished expires at frame 870 — indicator cleaned up ────
    const tarnishedExpiry = await stepToFrame(page, TARNISHED_EXPIRY_FRAME);

    expect(tarnishedExpiry.frame).toBe(TARNISHED_EXPIRY_FRAME);
    expect(tarnishedExpiry.elapsedMs).toBeCloseTo(14_500, 6);
    expect(tarnishedExpiry.tarnishedActive).toBe(false); // 4000ms elapsed; debuff expired
    // Tarnish indicator Graphics should have been cleaned up from the scene.
    expect(tarnishedExpiry.graphicsCount).toBeLessThan(resolution1.graphicsCount);

    // ── Phase 4: second telegraph at frame 1170 ───────────────────────────
    const telegraph2 = await stepToFrame(page, SECOND_TELEGRAPH_FRAME);
    const telegraph2Shot = await page.locator('#lab-canvas canvas').screenshot();

    expect(telegraph2.frame).toBe(SECOND_TELEGRAPH_FRAME);
    expect(telegraph2.elapsedMs).toBeCloseTo(19_500, 6);
    expect(telegraph2.cueCount).toBe(1);
    expect(telegraph2.announcementText).toBe(QUEEN_ANNOUNCEMENT);
    expect(telegraph2.tarnishedActive).toBe(false); // Tarnished expired well before this

    // ── Phase 5: second resolution at frame 1260 — Tarnished re-applied ──
    const resolution2 = await stepToFrame(page, SECOND_RESOLUTION_FRAME);
    const resolution2Shot = await page.locator('#lab-canvas canvas').screenshot();

    expect(resolution2.frame).toBe(SECOND_RESOLUTION_FRAME);
    expect(resolution2.elapsedMs).toBeCloseTo(21_000, 6);
    expect(resolution2.cueCount).toBe(0); // Second cue resolved
    expect(resolution2.tarnishedActive).toBe(true); // Player re-Tarnished by second cast

    // Second resolution burst should also produce a visible render change.
    const resolution2Diff = countChangedPixels(telegraph2Shot, resolution2Shot, {
      x: GAME_W * 0.3,
      y: GAME_H * 0.3,
      w: GAME_W * 0.4,
      h: GAME_H * 0.4,
    });
    expect(resolution2Diff).toBeGreaterThan(0.0015);
  }, 120_000);
});
