import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { buildFloor4HeadlinerCard } from '../../src/shared/floor4-headliners.js';
import { GAME } from '../../src/shared/constants.js';
import authored from '../../src/shared/data/boss-abilities.floor4.json';

const config = getFloorManifest('floor4')!.floor4!;
function selectionSeed(archetypeId: string): number {
  for (let seed = 42; seed < 142; seed++) {
    if (
      buildFloor4HeadlinerCard(config.headliners, seed).some(
        (entry) => entry.archetypeId === archetypeId,
      )
    )
      return seed;
  }
  throw new Error(`No natural card for ${archetypeId}`);
}

async function advance(page: Page, frames: number): Promise<void> {
  const before = (await mainSceneProbe.getFloor4HeadlinerAbilityState(page))!.frame;
  await mainSceneProbe.advanceSimulationFrames(page, frames);
  await page.waitForFunction(
    (target) => (window.__mainSceneProbe!.getFloor4HeadlinerAbilityState()?.frame ?? -1) >= target,
    before + frames,
    { timeout: 45_000 },
  );
}

describe('Floor 4 Headliner signatures in the real MainGameScene', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    mkdirSync('tmp/e2e-screenshots', { recursive: true });
  });
  afterAll(async () => closeQuietly(browser));

  it.each(config.headliners.pool)(
    '$archetypeId executes its authored signature and retires ownership',
    async ({ archetypeId }) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        await loadMainSceneProbeLab(page, { floor: 'floor4', seed: selectionSeed(archetypeId) });
        await mainSceneProbe.resolveLoadout(page);
        expect(await mainSceneProbe.primeFloor4Headliner(page, archetypeId)).toBe(true);
        await advance(page, 1);
        await mainSceneProbe.setFloor4HeadlinerHealth(page, 1_000_000);
        const spawned = (await mainSceneProbe.getFloor4HeadlinerAbilityState(page))!;
        const ability = authored.entries.find((entry) => entry.bossArchetypeId === archetypeId)!;
        expect(spawned.archetypeId).toBe(archetypeId);
        expect(spawned.bindings).toHaveLength(1);
        expect(spawned.bindings[0]!.abilityId).toBe(ability.id);
        expect(spawned.encounterActive).toBe(true);

        await advance(page, Math.ceil(ability.timing.firstEligibleAfterMs / GAME.DELTA_MS));
        const cue = (await mainSceneProbe.getFloor4HeadlinerAbilityState(page))!;
        expect(cue.bindings[0]!.phase).toBe('telegraph');
        expect(cue.bindings[0]!.resolvedCasts).toBe(0);
        expect(cue.cues).toHaveLength(1);
        expect(cue.cues[0]!.geometry).toEqual(cue.bindings[0]!.geometry);
        await page.screenshot({
          path: `tmp/e2e-screenshots/${archetypeId}-signature-telegraph.png`,
        });

        await advance(page, Math.ceil(ability.telegraph.durationMs / GAME.DELTA_MS) + 1);
        const resolved = (await mainSceneProbe.getFloor4HeadlinerAbilityState(page))!;
        expect(resolved.bindings[0]!.resolvedCasts).toBe(1);
        expect(resolved.bindings[0]!.phase).toBe('cooldown');
        expect(resolved.bindings[0]!.timerMs).toBeGreaterThan(0);
        expect(resolved.bindings[0]!.registrationToken).toBe(
          spawned.bindings[0]!.registrationToken,
        );
        if (archetypeId === 'floor4-showrunner') {
          expect(resolved.bindings[0]!.ownedEntities.length).toBeGreaterThan(0);
          expect(resolved.bindings[0]!.ownedEntities.length).toBeLessThanOrEqual(
            config.waves.concurrency.liveCap,
          );
          await page.screenshot({
            path: 'tmp/e2e-screenshots/floor4-showrunner-signature-summons.png',
          });
        }
        await mainSceneProbe.defeatFloor4Headliner(page);
        // One production frame runs ability cleanup and the director's defeat
        // transaction. A second queued frame is intentionally not requested:
        // the resulting boss-chest presentation pauses simulation input.
        await advance(page, 1);
        const retired = (await mainSceneProbe.getFloor4HeadlinerAbilityState(page))!;
        expect(retired.defeated).toBe(true);
        expect(retired.bindings).toHaveLength(0);
        expect(retired.cues).toHaveLength(0);
        expect(retired.registrationTokens).toBe(0);
        expect(retired.ownedEffects).toBe(0);
        expect((await mainSceneProbe.getState(page)).livingEnemyCount).toBe(0);
      } finally {
        await closeQuietly(page);
      }
    },
    120_000,
  );
});
