import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { TeamId } from '../../src/shared/constants.js';
import { boundsOverlap } from '../../src/engine/navigation-hud-layout.js';
import { GAME_W, GAME_H } from './e2e-constants.js';

async function attack(page: Page, kind: 'minion' | 'hero') {
  await page.evaluate(() => window.__mainSceneProbe!.resetFloor5WeaponAttacks());
  const before = await page.evaluate(() => window.__mainSceneProbe!.getFloor5Actors());
  // Reset only fixture positions and siege-owned outgoing attack cooldowns;
  // all targeting, firing, collision, damage and rendering use MainGameScene.
  for (let i = 0; i < 90; i++) {
    const frame = await page.evaluate((target) => {
      const probe = window.__mainSceneProbe!;
      probe.stageFloor5CombatTarget(target);
      const frame = probe.getState().frameCount!;
      probe.advanceSimulationFrames(1);
      return frame;
    }, kind);
    await page.waitForFunction(
      (previous) => window.__mainSceneProbe!.getState().frameCount! > previous,
      frame,
    );
  }
  const after = await page.evaluate(() => window.__mainSceneProbe!.getFloor5Actors());
  expect(after.find((actor) => actor.kind === kind)!.hp).toBeLessThan(
    before.find((actor) => actor.kind === kind)!.hp,
  );
  for (const protectedKind of ['ally', 'command-post', 'ram']) {
    const initial = before.find((actor) => actor.kind === protectedKind)!;
    const final = after.find((actor) => actor.kind === protectedKind)!;
    expect(final.hp, `${protectedKind} remains unharmed`).toBe(initial.hp);
    expect(final.enemy).toBe(false);
    expect(final.team).toBe(TeamId.SIEGE_ALLIED);
  }
  return { before, after };
}

describe('Floor 5 real scene siege combat and presentation', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await closeQuietly(browser);
  });
  it.each(['sword', 'knife', 'bow', 'pistol', 'throwing-knife'])(
    '%s damages hostile minions and field Heroes without friendly fire',
    async (weapon) => {
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      const page = await context.newPage();
      try {
        await loadMainSceneProbeLab(page, { floor: 'floor5' });
        expect(await page.evaluate(() => window.__mainSceneProbe!.prepareFloor5Combat())).toBe(
          true,
        );
        expect(await mainSceneProbe.equipMainHandWeapon(page, weapon)).toBe(true);
        const minion = await attack(page, 'minion');
        const hero = await attack(page, 'hero');
        for (const kind of ['minion', 'hero']) {
          const actor = hero.after.find((value) => value.kind === kind)!;
          expect(actor.enemy).toBe(true);
          expect(actor.team).toBe(TeamId.SIEGE_ENEMY);
        }
        const evidenceDir = process.env.FLOOR5_EVIDENCE_DIR;
        if (evidenceDir) {
          await mkdir(evidenceDir, { recursive: true });
          await writeFile(
            join(evidenceDir, `${weapon}.json`),
            JSON.stringify({ minion, hero }, null, 2),
          );
          await page.screenshot({ path: join(evidenceDir, `${weapon}.png`) });
        }
        if (weapon === 'sword') {
          await page.evaluate(() => window.__mainSceneProbe!.stageFloor5Presentation(false));
          await page.waitForFunction(() => {
            const actors = window.__mainSceneProbe!.getFloor5Actors();
            return (
              actors.length === 5 && actors.every((actor) => actor.textureKey?.includes('siege'))
            );
          });
          const actors = await page.evaluate(() => window.__mainSceneProbe!.getFloor5Actors());
          expect(actors.every((actor) => actor.visible)).toBe(true);
          const textures = Object.fromEntries(
            actors.map((actor) => [actor.kind, actor.textureKey]),
          );
          expect(textures).toEqual({
            ally: '__cw_siege_allied_minion',
            minion: '__cw_enemy_siege_minion',
            hero: '__cw_enemy_siege_hero',
            ram: '__cw_siege_ram',
            'command-post': '__cw_siege_command_post',
          });
          expect(new Set(Object.values(textures)).size).toBe(5);
          await page.waitForFunction(() => window.__mainSceneProbe!.getScenarioHudState().visible);
          const initialHud = await mainSceneProbe.getScenarioHudState(page);
          expect(initialHud.text).toContain('Command Post 1000/1000 HP');
          expect(initialHud.text).toContain('Ram: Ready');
          expect(initialHud.text).toContain('Objective:');
          if (evidenceDir) {
            // Combat has stopped; give the existing transient hit text time to clear.
            await page.waitForTimeout(1000);
            await page.screenshot({ path: join(evidenceDir, 'after-roles-and-hud.png') });
          }
          await page.evaluate(() => window.__mainSceneProbe!.stageFloor5Presentation(true));
          await page.waitForFunction(() =>
            window
              .__mainSceneProbe!.getScenarioHudState()
              .text?.includes('Command Post 700/1000 HP'),
          );
          const liveHud = await mainSceneProbe.getScenarioHudState(page);
          expect(liveHud.text).toContain('Siege · Escort');
          expect(liveHud.text).toContain('Hostile pressure:');
          expect(liveHud.text).toContain('under attack — defend the line');
          expect(liveHud.text).toContain('/16');
          expect(liveHud.text).toContain('Heroes');
          expect(liveHud.text).toContain('Objective: Escort the Ram to the wall');
          expect(liveHud.text).toContain('Ram: Advancing · 75/120 HP');
          expect(
            liveHud.cueLabels.some((label) => label === 'audio: Command Post under attack'),
          ).toBe(true);
          expect(
            liveHud.cueLabels.some((label) => label === 'vfx: Command Post under attack'),
          ).toBe(true);
          for (const viewport of [
            { width: 1280, height: 720 },
            { width: 960, height: 540 },
          ]) {
            await page.setViewportSize(viewport);
            await page.evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                ),
            );
            const hud = await mainSceneProbe.getScenarioHudState(page);
            expect(hud.visible).toBe(true);
            expect(hud.bounds).not.toBeNull();
            expect(hud.bounds!.x).toBeGreaterThanOrEqual(0);
            expect(hud.bounds!.y).toBeGreaterThanOrEqual(0);
            expect(hud.bounds!.x + hud.bounds!.width).toBeLessThanOrEqual(GAME_W);
            expect(hud.bounds!.y + hud.bounds!.height).toBeLessThanOrEqual(GAME_H);
            const surfaces = (await mainSceneProbe.getSafeAreaLayout(page)).surfaces;
            const bottomCenter = surfaces.find(
              (surface) => surface.name === 'bottomCenter',
            )?.bounds;
            expect(bottomCenter).toBeDefined();
            expect(boundsOverlap(hud.bounds!, bottomCenter!)).toBe(false);
            if (evidenceDir)
              await page.screenshot({
                path: join(evidenceDir, `after-escort-${viewport.width}.png`),
              });
          }
          if (evidenceDir)
            await writeFile(
              join(evidenceDir, 'presentation.json'),
              JSON.stringify({ textures, initialHud, liveHud }, null, 2),
            );
        }
      } finally {
        await context.close();
      }
    },
    60_000,
  );
});
