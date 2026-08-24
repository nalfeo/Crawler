/**
 * Deterministic observation: combat/loot audio cues actually fire through the
 * REAL booted scene's real-per-frame render pipeline (AGENTS.md rule #9 —
 * "observe before done").
 *
 * `combat-audio.ts` is unit/integration tested against a `createTestWorld()`
 * fixture, which proves the pure decision logic and cooldown/priority
 * arbitration in isolation — but it cannot prove that `PhaserBridge` actually
 * calls `combatAudio.update()` every real frame, or that `MainGameScene`
 * actually wires a real `AudioCueEngine` through to it. This suite boots the
 * real `MainGameScene` through the shipped floor bootstrap (`main-scene-probe-lab`,
 * same production class as the shipped game) and asserts against
 * `combatAudioCueLog` — a thin logging wrapper around the REAL `AudioCueEngine`
 * instance injected into the REAL `PhaserBridge`'s `combatAudio` controller —
 * that:
 *
 *   1. a real ability activation (`forceActivateAbility`, driven through the
 *      shipped ability-activation pipeline) dispatches a `combat:spell-cast`
 *      cue;
 *   2. a combat event pushed onto the real `world.combatEvents` queue (the
 *      same queue the real damage/weapon systems push onto) dispatches a
 *      `combat:damage-taken` cue on the next real render frame;
 *   3. a pickup VFX event pushed onto the real `world.vfxEvents` queue
 *      dispatches a `combat:pickup` cue on the next real render frame.
 *
 * Determinism: fixed world seed, simulation frozen except for explicitly
 * requested fixed steps; assertions are on cue labels/frequencies actually
 * dispatched to the real synth engine, never on wall-clock or audible output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('combat/loot audio cues fire through the real scene + bridge wiring', () => {
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

  it('starts with an empty combat audio cue log', async () => {
    expect(await mainSceneProbe.getCombatAudioCueLog(page)).toHaveLength(0);
  });

  it('dispatches a spell-cast cue for a real ability activation', async () => {
    expect(await mainSceneProbe.primeMagicMissileLightProbe(page)).toBe(true);
    await mainSceneProbe.advanceSimulationFrames(page, 2);

    const log = await mainSceneProbe.getCombatAudioCueLog(page);
    expect(log.some((entry) => entry.label === 'combat:spell-cast')).toBe(true);
  }, 30_000);

  it('dispatches a damage-taken cue for a real combatEvents entry', async () => {
    await mainSceneProbe.clearCombatAudioCueLog(page);
    await mainSceneProbe.pushTestCombatEvent(page, {
      type: 'hit',
      targetType: 'player',
      amount: 12,
    });
    await mainSceneProbe.advanceSimulationFrames(page, 2);

    const log = await mainSceneProbe.getCombatAudioCueLog(page);
    expect(log.some((entry) => entry.label === 'combat:damage-taken')).toBe(true);
  }, 30_000);

  it('dispatches a pickup cue for a real vfxEvents pickupSparkle entry', async () => {
    await mainSceneProbe.clearCombatAudioCueLog(page);
    await mainSceneProbe.pushTestVfxEvent(page, { kind: 'pickupSparkle' });
    await mainSceneProbe.advanceSimulationFrames(page, 2);

    const log = await mainSceneProbe.getCombatAudioCueLog(page);
    expect(log.some((entry) => entry.label === 'combat:pickup')).toBe(true);
  }, 30_000);
});
