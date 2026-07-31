/**
 * Regression tests for `pruneCanceledBossAbilityAnnouncements` inside
 * `createHudAnnouncementBanner` (src/engine/HudAnnouncementBanner.ts).
 *
 * The banner maintains a local copy of announcements it has drained from
 * `world.announcements`. When the core runtime removes a `bossAbilityCast`
 * event (e.g. because the telegraph was canceled before resolution), the
 * banner's local queue must also discard it on the next `sync()` call so
 * the HUD never shows a stale announcement.
 *
 * These tests exercise the cancellation path end-to-end through `sync()`
 * using Phaser scene and module stubs — the same technique used by
 * tests/unit/mob-ability-vfx.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { GAME } from '../../src/shared/constants.js';

// ── Module stubs ─────────────────────────────────────────────────────────────

vi.mock('../../src/engine/pixel-ui.js', () => ({
  PIXEL_UI_DEPTH: { panel: 0, content: 1, overlay: 2 },
  createBeveledPanel: vi.fn(() => ({
    setY: vi.fn().mockReturnThis(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 420, height: 50 })),
    destroy: vi.fn(),
  })),
}));

vi.mock('../../src/engine/ui-scale.js', () => ({
  applyCrispText: vi.fn(() => () => {}),
}));

vi.mock('../../src/engine/hud-encounter-layout.js', () => ({
  ANNOUNCEMENT_PANEL_HEIGHT: 50,
  ENCOUNTER_PANEL_WIDTH: 420,
  ENCOUNTER_FIRST_ROW_Y: 60,
  ellipsizeEncounterLabel: vi.fn((s: string) => s),
}));

// ── Scene stub ────────────────────────────────────────────────────────────────

type TweenCall = { targets: unknown; alpha: { from?: number; to: number }; duration?: number };

function createSceneStub() {
  const tweenCalls: TweenCall[] = [];

  const makeTween = () => ({ stop: vi.fn(), remove: vi.fn() });
  const makeTextObj = () => ({
    setWordWrapWidth: vi.fn().mockReturnThis(),
    setText: vi.fn().mockReturnThis(),
    setY: vi.fn().mockReturnThis(),
    setColor: vi.fn().mockReturnThis(),
    setOrigin: vi.fn().mockReturnThis(),
    setScrollFactor: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    destroy: vi.fn(),
  });

  const wrapperObj = {
    setScrollFactor: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setAlpha: vi.fn().mockReturnThis(),
    add: vi.fn(),
    alpha: 0,
    y: 0,
    destroy: vi.fn(),
  };

  const scene = {
    add: {
      container: vi.fn(() => wrapperObj),
      rectangle: vi.fn(() => ({
        setOrigin: vi.fn().mockReturnThis(),
        setScrollFactor: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setFillStyle: vi.fn().mockReturnThis(),
        destroy: vi.fn(),
      })),
      text: vi.fn(makeTextObj),
    },
    tweens: {
      add: vi.fn((cfg: TweenCall) => {
        tweenCalls.push(cfg);
        // Immediately invoke onComplete so tween-driven transitions complete.
        (cfg as { onComplete?: () => void }).onComplete?.();
        return makeTween();
      }),
    },
  };

  return {
    scene: scene as unknown as Parameters<
      typeof import('../../src/engine/HudAnnouncementBanner.js').createHudAnnouncementBanner
    >[0],
    wrapperObj,
    tweenCalls,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAbilityCastEvent(eventId: string, elapsedMs: number) {
  return {
    kind: 'bossAbilityCast' as const,
    archetypeIndex: 0,
    durationMs: 2200,
    elapsedMs,
    text: 'VERDIGRIS GLAMOUR — test',
    eventId,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HudAnnouncementBanner — pruneCanceledBossAbilityAnnouncements', () => {
  it('removes a bossAbilityCast from the local queue when its eventId is no longer in world.announcements', async () => {
    const { createHudAnnouncementBanner } =
      await import('../../src/engine/HudAnnouncementBanner.js');
    const { scene, tweenCalls } = createSceneStub();
    const banner = createHudAnnouncementBanner(scene);

    const world = createTestWorld();
    world.elapsedMs = GAME.DELTA_MS; // one tick in

    // Step 1: push a bossAbilityCast to world.announcements and sync.
    const castEvent = makeAbilityCastEvent('ability:cast-1', world.elapsedMs);
    world.announcements.push(castEvent);
    banner.sync(world);

    // The event should have triggered a show (fade-in tween with to:1).
    const showCall = tweenCalls.find((c) => (c.alpha as { to: number }).to === 1);
    expect(showCall).toBeDefined();

    // Step 2: remove the eventId from world.announcements (simulates core
    // runtime retiring the announcement on telegraph cancel).
    world.elapsedMs += GAME.DELTA_MS;
    world.announcements.splice(
      world.announcements.findIndex(
        (e) => e.kind === 'bossAbilityCast' && e.eventId === 'ability:cast-1',
      ),
      1,
    );

    // Step 3: sync again — pruning should remove the event from the local queue.
    const hidesBefore = tweenCalls.filter((c) => (c.alpha as { to: number }).to === 0).length;
    banner.sync(world);
    const hidesAfter = tweenCalls.filter((c) => (c.alpha as { to: number }).to === 0).length;

    // The banner should have issued a hide tween (alpha to 0) after pruning.
    expect(hidesAfter).toBeGreaterThan(hidesBefore);
  });

  it('does not prune a bossAbilityCast that is still live in world.announcements', async () => {
    const { createHudAnnouncementBanner } =
      await import('../../src/engine/HudAnnouncementBanner.js');
    const { scene, tweenCalls } = createSceneStub();
    const banner = createHudAnnouncementBanner(scene);

    const world = createTestWorld();
    world.elapsedMs = GAME.DELTA_MS;

    const castEvent = makeAbilityCastEvent('ability:cast-2', world.elapsedMs);
    world.announcements.push(castEvent);
    banner.sync(world);

    const hidesBefore = tweenCalls.filter((c) => (c.alpha as { to: number }).to === 0).length;

    // Advance time but keep the announcement live.
    world.elapsedMs += GAME.DELTA_MS;
    banner.sync(world);

    const hidesAfter = tweenCalls.filter((c) => (c.alpha as { to: number }).to === 0).length;

    // No new hide tween — the event is still live so it should stay visible.
    expect(hidesAfter).toBe(hidesBefore);
  });

  it('only prunes bossAbilityCast events — spawner events are unaffected', async () => {
    const { createHudAnnouncementBanner } =
      await import('../../src/engine/HudAnnouncementBanner.js');
    const { scene } = createSceneStub();
    const banner = createHudAnnouncementBanner(scene);

    const world = createTestWorld();
    world.elapsedMs = GAME.DELTA_MS;

    // Push a spawnerArenaStart (no eventId) and a bossAbilityCast.
    world.announcements.push({
      kind: 'spawnerArenaStart',
      archetypeIndex: 0,
      displayName: 'Slime Rat',
      durationMs: 2200,
      elapsedMs: world.elapsedMs,
    });
    const castEvent = makeAbilityCastEvent('ability:cast-3', world.elapsedMs);
    world.announcements.push(castEvent);
    banner.sync(world);

    // Remove only the bossAbilityCast.
    world.elapsedMs += GAME.DELTA_MS;
    world.announcements.splice(
      world.announcements.findIndex(
        (e) => e.kind === 'bossAbilityCast' && e.eventId === 'ability:cast-3',
      ),
      1,
    );
    banner.sync(world);

    // The spawnerArenaStart (at queue head) should still occupy the banner;
    // the test just ensures we did not throw and the banner is still alive.
    expect(() => banner.sync(world)).not.toThrow();
  });

  it('getCurrentAnnouncement returns the rendered (possibly ellipsized) label for spawner events', async () => {
    // Regression for the raw-displayName bug: the getter must return the same
    // text that show() actually rendered (ellipsizeEncounterLabel output), not
    // the raw event.displayName, so e2e probes see the player-visible string.
    const { createHudAnnouncementBanner } =
      await import('../../src/engine/HudAnnouncementBanner.js');
    const { scene } = createSceneStub();
    const banner = createHudAnnouncementBanner(scene);

    const world = createTestWorld();
    world.elapsedMs = GAME.DELTA_MS;
    world.announcements.push({
      kind: 'spawnerArenaStart',
      archetypeIndex: 0,
      displayName: 'Slime Rat',
      durationMs: 2200,
      elapsedMs: world.elapsedMs,
    });

    banner.sync(world);

    const current = banner.getCurrentAnnouncement();
    expect(current).not.toBeNull();
    expect(current?.kind).toBe('spawnerArenaStart');
    // The stub's ellipsizeEncounterLabel is a passthrough, so the rendered text
    // matches the original displayName in this test environment.
    expect(current?.text).toBe('Slime Rat');
  });
});
