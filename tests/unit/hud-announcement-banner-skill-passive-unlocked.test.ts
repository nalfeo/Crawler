/**
 * Regression tests for the `skillPassiveUnlocked` announcement kind inside
 * `createHudAnnouncementBanner` (src/engine/HudAnnouncementBanner.ts).
 *
 * Issue #2439 requires a HudAnnouncementBanner unlock announcement at the
 * level-5 skill milestone. These tests exercise the banner's `sync()` /
 * `getCurrentAnnouncement()` surface directly (the same rendered-projection
 * getter the main-scene-probe-lab e2e test reads) using Phaser scene and
 * module stubs — the same technique used by
 * tests/unit/hud-announcement-banner-cancel.test.ts.
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

function createSceneStub() {
  const setColorCalls: string[] = [];

  const makeTween = () => ({ stop: vi.fn(), remove: vi.fn() });
  const makeTextObj = () => ({
    setWordWrapWidth: vi.fn().mockReturnThis(),
    setText: vi.fn().mockReturnThis(),
    setY: vi.fn().mockReturnThis(),
    setColor: vi.fn((color: string) => {
      setColorCalls.push(color);
      return makeTextObj();
    }),
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
      add: vi.fn((cfg: { onComplete?: () => void }) => {
        cfg.onComplete?.();
        return makeTween();
      }),
    },
  };

  return {
    scene: scene as unknown as Parameters<
      typeof import('../../src/engine/HudAnnouncementBanner.js').createHudAnnouncementBanner
    >[0],
    setColorCalls,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HudAnnouncementBanner — skillPassiveUnlocked', () => {
  it('renders the skillPassiveUnlocked event via getCurrentAnnouncement()', async () => {
    const { createHudAnnouncementBanner } =
      await import('../../src/engine/HudAnnouncementBanner.js');
    const { scene } = createSceneStub();
    const banner = createHudAnnouncementBanner(scene);

    const world = createTestWorld();
    world.elapsedMs = GAME.DELTA_MS;
    world.announcements.push({
      kind: 'skillPassiveUnlocked',
      archetypeIndex: -1,
      text: 'Passive Unlocked: Combat Flow',
      durationMs: 2600,
      elapsedMs: world.elapsedMs,
    });

    banner.sync(world);

    const current = banner.getCurrentAnnouncement();
    expect(current).not.toBeNull();
    expect(current?.kind).toBe('skillPassiveUnlocked');
    expect(current?.text).toBe('Passive Unlocked: Combat Flow');
  });

  it('renders skillPassiveUnlocked text verbatim (not ellipsized like spawner labels)', async () => {
    const { createHudAnnouncementBanner } =
      await import('../../src/engine/HudAnnouncementBanner.js');
    const { scene } = createSceneStub();
    const banner = createHudAnnouncementBanner(scene);

    const world = createTestWorld();
    world.elapsedMs = GAME.DELTA_MS;
    const longName = 'Passive Unlocked: A Very Long Ability Presentation Name For Wrapping';
    world.announcements.push({
      kind: 'skillPassiveUnlocked',
      archetypeIndex: -1,
      text: longName,
      durationMs: 2600,
      elapsedMs: world.elapsedMs,
    });

    banner.sync(world);

    expect(banner.getCurrentAnnouncement()?.text).toBe(longName);
  });

  it('uses a distinct accent color from bossAbilityCast (unlock vs danger)', async () => {
    const { createHudAnnouncementBanner } =
      await import('../../src/engine/HudAnnouncementBanner.js');

    const skillStub = createSceneStub();
    const skillBanner = createHudAnnouncementBanner(skillStub.scene);
    const skillWorld = createTestWorld();
    skillWorld.elapsedMs = GAME.DELTA_MS;
    skillWorld.announcements.push({
      kind: 'skillPassiveUnlocked',
      archetypeIndex: -1,
      text: 'Passive Unlocked: Combat Flow',
      durationMs: 2600,
      elapsedMs: skillWorld.elapsedMs,
    });
    skillBanner.sync(skillWorld);

    const bossStub = createSceneStub();
    const bossBanner = createHudAnnouncementBanner(bossStub.scene);
    const bossWorld = createTestWorld();
    bossWorld.elapsedMs = GAME.DELTA_MS;
    bossWorld.announcements.push({
      kind: 'bossAbilityCast',
      archetypeIndex: -1,
      text: 'VERDIGRIS GLAMOUR — test',
      eventId: 'ability:cast-1',
      durationMs: 2200,
      elapsedMs: bossWorld.elapsedMs,
    });
    bossBanner.sync(bossWorld);

    expect(skillStub.setColorCalls.length).toBeGreaterThan(0);
    expect(bossStub.setColorCalls.length).toBeGreaterThan(0);
    expect(skillStub.setColorCalls[0]).not.toBe(bossStub.setColorCalls[0]);
  });

  it('does not throw when both skillPassiveUnlocked and spawner events are queued', async () => {
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
    world.announcements.push({
      kind: 'skillPassiveUnlocked',
      archetypeIndex: -1,
      text: 'Passive Unlocked: Combat Flow',
      durationMs: 2600,
      elapsedMs: world.elapsedMs,
    });

    expect(() => banner.sync(world)).not.toThrow();
  });
});
