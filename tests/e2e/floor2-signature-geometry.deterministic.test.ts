import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';

interface ArenaScene {
  world: GameWorld;
  playerEid: number;
  settings: {
    roomPresetId: string;
    floorFilter: string;
    enemyPresetId: string;
    playerMode: string;
    simSpeed: number;
    arenaSeed: number;
  };
  respawn(): void;
  clearEnemies(): void;
  update(time: number, delta: number): void;
  bridge: { sync(world: GameWorld): void };
}

async function arenaStep(page: Page, frames: number) {
  return page.evaluate(
    ({ frames, delta }) => {
      const scene = (window as unknown as { __arenaScene: ArenaScene }).__arenaScene;
      scene.world.state = 'playing';
      for (let frame = 0; frame < frames; frame += 1) scene.update(0, delta);
      scene.world.state = 'paused';
      return {
        cues: scene.world.mobAbilities.cues.map((cue) => cue.geometry),
        zones: scene.world.mobAbilities.ownedZones.map((zone) => zone.geometry),
        bindings: [...scene.world.mobAbilities.byEntity.values()].map((instance) => ({
          phase: instance.phase,
          timer: instance.timerMs,
          casts: instance.resolvedCasts,
          warning: instance.definition.telegraphDurationMs,
        })),
      };
    },
    { frames, delta: GAME.DELTA_MS },
  );
}

function changedWorldPixels(first: Buffer, second: Buffer): number {
  const before = parsePng(first);
  const after = parsePng(second);
  let changed = 0;
  // Exclude banners: the danger geometry itself must produce rendered pixels.
  for (let y = Math.floor(before.height * 0.2); y < before.height * 0.9; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > 24) changed += 1;
    }
  }
  return changed;
}

describe('Floor 2 signatures in the live renderer and MainGameScene', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    mkdirSync('tmp/e2e-screenshots', { recursive: true });
  });
  afterAll(async () => closeQuietly(browser));

  it.each([
    ['cactusfolk', 'annulus', null],
    ['batfolk', 'composite', 'annulus'],
    ['beetlefolk', 'sweeping-arc', 'sweeping-arc'],
    ['molefolk', 'composite', 'composite'],
    ['snailfolk', 'contracting-annulus', 'annulus'],
  ] as const)(
    '%s renders its committed warning and owned active geometry',
    async (family, kind, activeKind) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        await page.goto(`${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`, {
          waitUntil: 'commit',
        });
        await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
          timeout: 30_000,
        });
        await page.evaluate((familyId) => {
          const scene = (window as unknown as { __arenaScene: ArenaScene }).__arenaScene;
          window.__arenaReady = false;
          Object.assign(scene.settings, {
            arenaSeed: 42,
            roomPresetId: 'boss-arena',
            floorFilter: 'floor2',
            enemyPresetId: `f2-signature-${familyId}`,
            playerMode: 'observer',
            simSpeed: 1,
          });
          scene.respawn();
        }, family);
        await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
          timeout: 30_000,
        });
        await page.evaluate(() => {
          const scene = (window as unknown as { __arenaScene: ArenaScene }).__arenaScene;
          scene.world.state = 'paused';
          const boss = [...scene.world.mobAbilities.byEntity.keys()][0];
          if (boss === undefined) throw new Error('Arena signature caster missing');
          const x = scene.world.floorMap!.widthFt / 2;
          const y = scene.world.floorMap!.heightFt / 2;
          scene.world.stores.position.x[boss] = x - 10;
          scene.world.stores.position.y[boss] = y;
          scene.world.stores.enemyBehavior.speed[boss] = 0;
          scene.world.stores.velocity.x[boss] = 0;
          scene.world.stores.velocity.y[boss] = 0;
          scene.world.stores.position.x[scene.playerEid] = x + 10;
          scene.world.stores.position.y[scene.playerEid] = y;
        });
        const before = await arenaStep(page, 0);
        expect(before.bindings).toHaveLength(1);
        const cue = await arenaStep(
          page,
          Math.ceil((before.bindings[0]!.timer - 1e-6) / GAME.DELTA_MS) + 12,
        );
        expect(cue.cues[0]?.kind).toBe(kind);
        const canvas = page.locator('#lab-canvas canvas');
        const warning = await canvas.screenshot({
          path: `tmp/e2e-screenshots/floor2-${family}-warning.png`,
        });
        // Isolate the danger rendering at the SAME simulation state. Only public
        // cues are hidden for one bridge sync, never the production draw routine.
        await page.evaluate(() => {
          const scene = (window as unknown as { __arenaScene: ArenaScene }).__arenaScene;
          const cues = scene.world.mobAbilities.cues.splice(0);
          scene.bridge.sync(scene.world);
          scene.world.mobAbilities.cues.push(...cues);
        });
        const withoutWarning = await canvas.screenshot();
        expect(changedWorldPixels(warning, withoutWarning)).toBeGreaterThan(100);
        const resolved = await arenaStep(
          page,
          Math.ceil((cue.bindings[0]!.timer - 1e-6) / GAME.DELTA_MS) + 1,
        );
        expect(resolved.bindings[0]?.casts).toBe(1);
        if (family === 'molefolk') {
          const warningShape = cue.cues[0]!;
          const activeShape = resolved.zones[0]!;
          expect(warningShape.kind).toBe('composite');
          expect(activeShape.kind).toBe('composite');
          if (warningShape.kind === 'composite' && activeShape.kind === 'composite') {
            expect(activeShape.shapes.find((shape) => shape.kind === 'circle')).toEqual(
              warningShape.shapes.find((shape) => shape.kind === 'circle'),
            );
          }
        }
        if (activeKind !== null) {
          expect(resolved.zones[0]?.kind).toBe(activeKind);
          const active = await canvas.screenshot({
            path: `tmp/e2e-screenshots/floor2-${family}-active.png`,
          });
          await page.evaluate(() => {
            const scene = (window as unknown as { __arenaScene: ArenaScene }).__arenaScene;
            const zones = scene.world.mobAbilities.ownedZones.splice(0);
            scene.bridge.sync(scene.world);
            scene.world.mobAbilities.ownedZones.push(...zones);
          });
          expect(changedWorldPixels(active, await canvas.screenshot())).toBeGreaterThan(100);
        }
        await page.evaluate(() =>
          (window as unknown as { __arenaScene: ArenaScene }).__arenaScene.clearEnemies(),
        );
        const cleared = await arenaStep(page, 1);
        expect(cleared.bindings).toHaveLength(0);
        expect(cleared.cues).toHaveLength(0);
        expect(cleared.zones).toHaveLength(0);
      } finally {
        await closeQuietly(page);
      }
    },
    120_000,
  );

  it('registers, casts and cleans a natural Floor 2 boss through the real MainGameScene objective', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor2', seed: 42 });
      await mainSceneProbe.resolveLoadout(page);
      expect(
        await page.evaluate(() => window.__mainSceneProbe!.primeFloor2Signature()),
      ).not.toBeNull();
      await mainSceneProbe.advanceSimulationFrames(page, 1);
      await page.evaluate(() => window.__mainSceneProbe!.dismissBossIntro());
      const started = await page.evaluate(
        () => window.__mainSceneProbe!.getFloor2SignatureState()!,
      );
      expect(started.started).toBe(true);
      expect(started.enabled).toBe(true);
      expect(started.bindings).toHaveLength(1);
      await mainSceneProbe.advanceSimulationFrames(
        page,
        Math.ceil((started.bindings[0]!.timerMs - 1e-6) / GAME.DELTA_MS) + 12,
      );
      const warned = await page.evaluate(() => window.__mainSceneProbe!.getFloor2SignatureState()!);
      expect(warned.bindings[0]?.phase, JSON.stringify(warned)).toBe('telegraph');
      expect(warned.cues).toHaveLength(1);
      expect(warned.cues[0]!.geometry).toEqual(warned.bindings[0]!.geometry);
      await page.screenshot({
        path: 'tmp/e2e-screenshots/floor2-production-signature-warning.png',
      });
      await mainSceneProbe.advanceSimulationFrames(
        page,
        Math.ceil((warned.bindings[0]!.timerMs - 1e-6) / GAME.DELTA_MS) + 1,
      );
      const resolved = await page.evaluate(
        () => window.__mainSceneProbe!.getFloor2SignatureState()!,
      );
      expect(resolved.bindings[0]?.resolvedCasts).toBe(1);
      await page.screenshot({ path: 'tmp/e2e-screenshots/floor2-production-signature-active.png' });
      await page.evaluate(() => window.__mainSceneProbe!.defeatFloor2Signature());
      await mainSceneProbe.advanceSimulationFrames(page, 1);
      const retired = await page.evaluate(
        () => window.__mainSceneProbe!.getFloor2SignatureState()!,
      );
      expect(retired.defeated).toBe(true);
      expect(retired.bindings).toHaveLength(0);
      expect(retired.cues).toHaveLength(0);
      expect(retired.ownedZones).toHaveLength(0);
    } finally {
      await closeQuietly(page);
    }
  }, 120_000);
});
