import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { loadMainSceneProbeLab } from './helpers/main-scene-probe.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import {
  FAMILY_COMBAT_CASES,
  observeFamilyCombat,
  readFamilyCombat,
  stageFamilyCombat,
} from '../../src/labs/main-scene-probe-lab/family-combat-probe.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('Floor 2 family combat in real MainGameScene', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await closeQuietly(browser);
  });
  it('matches the headless combat matrix, including automatic retaliation', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const observations = [];
    try {
      for (const kind of FAMILY_COMBAT_CASES) {
        await loadMainSceneProbeLab(page, { floor: 'floor2' });
        expect(
          await page.evaluate((kind) => window.__mainSceneProbe!.stageFamilyCombat(kind), kind),
        ).toBe(true);
        const frameBefore = await page.evaluate(
          () => window.__mainSceneProbe!.getState().frameCount!,
        );
        const before = await page.evaluate(() => window.__mainSceneProbe!.readFamilyCombat());
        const frames = kind.startsWith('defend') ? 12 : 2;
        await page.evaluate((frames) => {
          const probe = window.__mainSceneProbe!;
          const target = probe.getState().frameCount! + frames;
          for (
            let attempt = 0;
            probe.getState().frameCount! < target && attempt < frames + 100;
            attempt++
          ) {
            probe.skipRewardOpening();
            probe.acknowledgeRewardOpening();
            probe.dismissBossIntro();
            probe.advanceSimulationFrames(1);
          }
        }, frames);
        expect(await page.evaluate(() => window.__mainSceneProbe!.getState().frameCount!)).toBe(
          frameBefore + frames,
        );
        const visual = await page.evaluate(() => window.__mainSceneProbe!.readFamilyCombat());
        const world = createTestWorld({ floor: 2 });
        stageFamilyCombat(world, spawnPlayer(world, 0, 0), kind);
        const options = createFloorMainSceneOptions('floor2');
        for (let frame = 0; frame < frames; frame++)
          runSimulationStep(world, createInputState(), GAME.DELTA_MS, {
            preSystems: options.preSystems,
            postSystems: [...options.postSystems!, observeFamilyCombat],
          });
        const headless = readFamilyCombat(world);
        observations.push({ kind, before, visual, headless });
        const evidenceDir = process.env.FAMILY_COMBAT_EVIDENCE_DIR;
        if (evidenceDir) {
          await mkdir(evidenceDir, { recursive: true });
          await writeFile(
            join(evidenceDir, 'observations.json'),
            JSON.stringify(observations, null, 2),
          );
          await page.screenshot({ path: join(evidenceDir, `${kind}.png`) });
        }
        expect(visual, kind).toEqual(headless);
        expect(visual!.targetDamaged, kind).toBe(
          !kind.startsWith('friendly') &&
            !kind.startsWith('neutral') &&
            !kind.startsWith('same-family'),
        );
        if (kind.startsWith('defend')) {
          expect(visual!.allyTargetsAttacker, kind).toBe(true);
          expect(visual!.attackerDamaged, kind).toBe(true);
          expect(visual!.allyMoved, kind).toBe(true);
        }
      }
    } finally {
      await page.close();
    }
  }, 180_000);
});
