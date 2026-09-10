/**
 * Pistol bullet projectile render guard (issue #4274, rule #9 "observe before
 * done", deterministic).
 *
 * A lab-only/unit assertion on `resolveRenderKind` cannot prove the real
 * render bridge draws the shot with the bullet texture — it only proves the
 * classification function returns 'bullet'. This suite boots the real
 * `MainGameScene` through the shipped floor bootstrap (the probe lab),
 * equips a weapon, fires it through the real `weaponSystem`, and asserts
 * against the live display list that:
 *
 *   1. the pistol (and firearm variants classified via
 *      `weaponTypeSkillId: 'pistol'`) render their shot with the bullet
 *      texture;
 *   2. bow/crossbow keep the arrow texture.
 *
 * Determinism: the probe lab boots with a fixed world seed, the weapon is
 * equipped explicitly by id, and every assertion is on display-list/ECS
 * state, never on pixels or wall clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

/** Wait for the render bridge to run at least one more sync pass. */
async function nextRenderedFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

describe('pistol/firearm projectiles render as bullets in the real booted scene', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page);
    await waitForState(page, (state) => state.hudPresent && state.bridgePresent);
    await mainSceneProbe.resolveLoadout(page);
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it.each(['pistol', 'musketeer-rifle', 'cog-pistol', 'weapon.rivet-gun'] as const)(
    '%s renders its shot with the real bullet texture',
    async (weaponId) => {
      expect(await mainSceneProbe.equipMainHandWeapon(page, weaponId)).toBe(true);
      const spawnedEids = await mainSceneProbe.fireActiveWeaponForProjectileProbe(page);
      expect(spawnedEids.length).toBeGreaterThan(0);
      await nextRenderedFrame(page);

      const infos = await mainSceneProbe.getProjectileRenderInfo(page);
      const spawned = infos.filter((info) => spawnedEids.includes(info.eid));
      expect(spawned.length).toBeGreaterThan(0);
      for (const info of spawned) {
        expect(info.renderKind).toBe('bullet');
        expect(info.textureKey).not.toBeNull();
        expect(info.textureKey).not.toMatch(/arrow/i);
      }
    },
  );

  it.each(['bow', 'crossbow'] as const)(
    '%s renders its shot with the real arrow texture',
    async (weaponId) => {
      expect(await mainSceneProbe.equipMainHandWeapon(page, weaponId)).toBe(true);
      const spawnedEids = await mainSceneProbe.fireActiveWeaponForProjectileProbe(page);
      expect(spawnedEids.length).toBeGreaterThan(0);
      await nextRenderedFrame(page);

      const infos = await mainSceneProbe.getProjectileRenderInfo(page);
      const spawned = infos.filter((info) => spawnedEids.includes(info.eid));
      expect(spawned.length).toBeGreaterThan(0);
      for (const info of spawned) {
        expect(info.renderKind).toBe('arrow');
        expect(info.textureKey).not.toBeNull();
        expect(info.textureKey).not.toMatch(/bullet/i);
      }
    },
  );
});
