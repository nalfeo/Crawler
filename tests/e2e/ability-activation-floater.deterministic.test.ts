/**
 * Deterministic observation: a player active-ability activation announces
 * itself as floating text above the player in the REAL booted scene.
 *
 * "Observe before done" (AGENTS.md rule 9): a lab that force-calls the renderer
 * cannot prove the shipped game shows the floater. This suite boots the real
 * `MainGameScene` through the shipped floor bootstrap (`main-scene-probe-lab`),
 * drives the activation through the REAL simulation (a skill-usage event →
 * `skillSystem` → `abilitySystem` → `activateAbility`), and then reads the
 * floater off the real scene's display list.
 *
 * Determinism: fixed world seed, simulation frozen except for explicitly
 * requested fixed steps, and the assertion is on object names/labels — no
 * wall-clock, RNG, screenshot diffing, or model judgement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ftToPx } from '../../src/shared/units.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('ability-activation floating announcement (real scene)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.setSimulationPaused(page, true);
  }, 180_000);

  afterAll(async () => {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(browser);
  });

  it('shows no ability floater before any ability fires', async () => {
    expect(await mainSceneProbe.getAbilityFloaters(page)).toHaveLength(0);
  });

  it('renders the ability name above the player once the ability actually fires', async () => {
    expect(await mainSceneProbe.equipPlayerActiveAbility(page, 'battle-focus')).toBe(true);

    // Real trigger path: battle-focus fires on >= 10 hits_landed skill usage.
    await mainSceneProbe.queueSkillUsage(page, 'swordsmanship', 'hits_landed', 10);
    await mainSceneProbe.advanceSimulationFrames(page, 2);
    await page.waitForFunction(
      () => (window.__mainSceneProbe?.getAbilityFloaters().length ?? 0) > 0,
      undefined,
      { timeout: 10_000, polling: 100 },
    );

    const floaters = await mainSceneProbe.getAbilityFloaters(page);
    expect(floaters.map((f) => f.abilityId)).toContain('battle-focus');
    const battleFocusFloater = floaters.find((f) => f.abilityId === 'battle-focus');
    expect(battleFocusFloater?.label).toBe('BATTLE FOCUS');
    expect(battleFocusFloater?.visible).toBe(true);
    expect(battleFocusFloater?.alpha ?? 0).toBeGreaterThan(0);

    const state = await mainSceneProbe.getState(page);
    expect(state.playerFeet).not.toBeNull();
    const playerFeet = state.playerFeet;
    if (!playerFeet || !battleFocusFloater) {
      throw new Error('Expected player feet and battle-focus floater to exist');
    }
    expect(battleFocusFloater.x).toBeCloseTo(ftToPx(playerFeet.x), 3);
    expect(battleFocusFloater.y).toBeLessThan(ftToPx(playerFeet.y));
  }, 60_000);
});
