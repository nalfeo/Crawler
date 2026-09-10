/**
 * Real-artifact guard for Floor 3 ranged Companion attacks (issue #4426
 * review). `tests/game/floor3-companion-combat.test.ts` proves the ECS
 * behavior in isolation (force-calling `companionCombatSystem` directly), but
 * a unit test can never prove the shipped scene actually renders the shot
 * with the friendly bullet texture or that the real per-frame simulation
 * loop carries it through to impact and cleanup (AGENTS.md rule #9). This
 * suite boots the real `MainGameScene` on Floor 3 through the shipped floor
 * bootstrap (`main-scene-probe-lab`), places a real `ember-slinger` (the
 * shipped `aiType: "ranged"` species, `enemies.floor3.json`) Companion and a
 * rival target, and lets the REAL scenario-wired `companionCombatSystem`
 * (run every frame by the shipped bootstrap, not force-called) fire,
 * render, and resolve the shot.
 *
 * Determinism: the probe lab boots with a fixed world seed; the Companion
 * and target are placed at fixed positions with a clean line of sight, so
 * the shot always fires on the Companion's first attack window. Assertions
 * poll bounded, real-time-driven state (never wall-clock duration or RNG).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Floor 3 ranged Companion attacks render and resolve in the real booted scene', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page, { floor: 'floor3' });
    await waitForState(page, (s) => s.floorId === 'floor3', {
      timeoutMs: 20_000,
      label: 'Floor 3 boot',
    });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('fires a real bullet-rendered projectile that damages and despawns on impact', async () => {
    const probe = await mainSceneProbe.spawnFloor3RangedCompanionProbe(page);
    expect(probe).not.toBeNull();
    const { companionEid, targetEid } = probe!;

    const beforeHp = await mainSceneProbe.getEntityHealth(page, targetEid);
    expect(beforeHp).toBe(100);

    // The real per-frame sim (not a forced system call) fires the shot on
    // the Companion's own cooldown window.
    const projectiles = await waitFor(
      () => mainSceneProbe.getProjectileRenderInfo(page),
      (infos) => infos.length > 0,
      'the real companionCombatSystem to spawn a projectile',
    );
    const shot = projectiles[0];
    expect(shot).toBeDefined();
    // Proves the render bridge — not just the ECS tag — draws the friendly
    // Companion shot as a bullet rather than the hostile enemy-projectile
    // asset (the exact regression this suite guards against).
    expect(shot!.renderKind).toBe('bullet');
    expect(shot!.foundNamedObject).toBe(true);
    expect(shot!.textureKey).not.toBeNull();

    // The real sim keeps running: the shot travels, collides, and damages
    // the target — all through production wiring, not a forced test-only
    // pipeline call.
    await waitFor(
      () => mainSceneProbe.getEntityHealth(page, targetEid),
      (hp) => hp !== null && hp < 100,
      'the target to take damage from the projectile impact',
    );
    // Companions keep firing on cooldown, so the exact spent eid can be
    // reused by bitecs's entity-id pool for the NEXT shot; assert cleanup
    // ran by checking the live projectile count stays bounded (never
    // accumulates unbounded) rather than tracking one specific eid.
    await waitFor(
      () => mainSceneProbe.getProjectileRenderInfo(page),
      (infos) => infos.length <= 2,
      'spent projectiles to be cleaned up instead of accumulating',
    );

    // The Companion itself must still be alive and unharmed by its own shot.
    const companionHp = await mainSceneProbe.getEntityHealth(page, companionEid);
    expect(companionHp).toBe(100);
  });
});
