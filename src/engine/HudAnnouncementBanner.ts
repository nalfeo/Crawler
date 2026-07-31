/**
 * HudAnnouncementBanner — top-center HUD widget that drains
 * `world.announcements` and shows one message at a time with a fade-in/out.
 *
 * Visual: a centred pixel-UI panel just below the floor timer, showing the
 * archetype name + a state-specific verb ("Battle Begins!" / "Cleared!"). It
 * auto-hides once the message's `durationMs` elapses.
 *
 * Rendering is idempotent — every `sync()` reads `world.elapsedMs`, drains any
 * newly-pushed announcements into an ordered queue, and shows the head. If the
 * head has expired we advance and reveal the next one, or hide the banner.
 *
 * This module has no simulation side-effects (no writes back into `world`),
 * so headless runs that skip HUD rendering behave identically.
 */
import type Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import type { AnnouncementEvent, AnnouncementKind } from '../shared/announcement-events.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { applyCrispText, type ScreenBounds } from './ui-scale.js';
import {
  ANNOUNCEMENT_PANEL_HEIGHT,
  ENCOUNTER_PANEL_WIDTH,
  ENCOUNTER_FIRST_ROW_Y,
  ellipsizeEncounterLabel,
} from './hud-encounter-layout.js';

/**
 * Vertical offset from the top of the screen. Sits below the floor timer
 * (which lives at `TOP_Y = 14` for a 38 px panel, i.e. ~52 px reserved) with
 * a small buffer so the two never touch.
 */
const CENTER_X = GAME.WIDTH / 2;
const PANEL_WIDTH = ENCOUNTER_PANEL_WIDTH;
const PANEL_X = CENTER_X - PANEL_WIDTH / 2;
const MAX_LABEL_CHARACTERS = 44;

const COLORS = {
  start: '#f5f5f5',
  end: '#a7f3d0',
  boss: '#fca5a5',
  unlock: '#fde68a',
  fallback: '#e5e7eb',
} as const;

/** How many still-live announcements we render sequentially. Excess is dropped. */
const MAX_QUEUE = 16;
/** Fade-in / fade-out duration on either edge of an announcement. */
const FADE_MS = 220;

function verbForKind(kind: AnnouncementKind): string {
  switch (kind) {
    case 'spawnerArenaStart':
      return 'Battle Begins!';
    case 'spawnerArenaEnd':
      return 'Cleared!';
    case 'bossAbilityCast':
      // The full authored announcement is the label; no subtitle verb.
      return '';
    case 'skillPassiveUnlocked':
      // The full authored announcement is the label; no subtitle verb.
      return '';
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled announcement kind: ${String(unreachable)}`);
    }
  }
}

function colorForKind(kind: AnnouncementKind): string {
  switch (kind) {
    case 'spawnerArenaStart':
      return COLORS.start;
    case 'spawnerArenaEnd':
      return COLORS.end;
    case 'bossAbilityCast':
      return COLORS.boss;
    case 'skillPassiveUnlocked':
      return COLORS.unlock;
    default:
      return COLORS.fallback;
  }
}

export function createHudAnnouncementBanner(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  setTop(top: number): void;
  getLayoutBounds(): { panel: ScreenBounds; text: ScreenBounds } | null;
  /**
   * The currently-rendered banner content (kind + exact text), or `null` when
   * the banner is hidden. This is the real, player-visible projection — the
   * same content the player is looking at — so e2e probes can assert on it
   * without reaching into `world.announcements` or internal ability/skill
   * state.
   */
  getCurrentAnnouncement(): { kind: AnnouncementKind; text: string } | null;
  destroy(): void;
} {
  const outerParent = options.parent;
  // Wrap the panel + text in a container so we can fade both together via a
  // single alpha tween. `BeveledPanel` is a factory return type, not a
  // GameObject, so its `.setAlpha` isn't exposed — the container lets us
  // control opacity without leaking into the panel API.
  const wrapper = scene.add
    .container(0, ENCOUNTER_FIRST_ROW_Y)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel);
  outerParent?.add(wrapper);

  const panel = createBeveledPanel(scene, PANEL_X, 0, PANEL_WIDTH, ANNOUNCEMENT_PANEL_HEIGHT, {
    parent: wrapper,
  });

  const accent = scene.add
    .rectangle(PANEL_X + 4, 4, 4, ANNOUNCEMENT_PANEL_HEIGHT - 8, 0xfcd34d)
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  wrapper.add(accent);

  const labelText = scene.add
    .text(CENTER_X, 16, '', {
      fontFamily: 'monospace',
      fontSize: '14px',
      fontStyle: 'bold',
      color: COLORS.fallback,
      stroke: '#02040a',
      strokeThickness: 2,
      align: 'center',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  wrapper.add(labelText);

  const verbText = scene.add
    .text(CENTER_X, 35, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#94a3b8',
      align: 'center',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  wrapper.add(verbText);
  const detachCrispText = applyCrispText(scene, [labelText, verbText]);

  // Hidden by default — banner only appears when an announcement is live.
  wrapper.setAlpha(0);

  /**
   * Queue of announcements we've observed but not yet finished rendering. We
   * copy events out of `world.announcements` into this local queue so replays
   * (e.g. lab scene resets) can drain without disturbing the ECS-owned queue.
   */
  const queue: AnnouncementEvent[] = [];
  // The last elapsedMs we processed a drain at — used to filter out events we
  // already copied, since `world.announcements` is a persistent queue.
  let lastDrainedElapsedMs = -1;
  let activeTween: Phaser.Tweens.Tween | undefined;
  let hidden = true;
  // Track which announcement is currently on-screen so we correctly cross-fade
  // to the next one when the head advances mid-lifetime.
  let currentEvent: AnnouncementEvent | undefined;
  // World time at which the current event started showing. Used to compute
  // expiry from display-start rather than creation-time, so simultaneous
  // announcements each get their full durationMs regardless of when they were
  // originally pushed.
  let displayStartMs = 0;
  // The actual rendered text for the current event — set in show() so that
  // getCurrentAnnouncement() returns what the player literally sees (including
  // any ellipsization applied to spawner labels).
  let currentRenderedText = '';

  function drainWorldAnnouncements(world: GameWorld): void {
    for (const event of world.announcements) {
      if (event.elapsedMs <= lastDrainedElapsedMs) continue;
      queue.push(event);
    }
    lastDrainedElapsedMs = world.elapsedMs;
    if (queue.length > MAX_QUEUE) {
      queue.splice(0, queue.length - MAX_QUEUE);
    }
  }

  function pruneCanceledBossAbilityAnnouncements(world: GameWorld): void {
    const liveBossEventIds = new Set(
      world.announcements
        .filter((event) => event.kind === 'bossAbilityCast')
        .map((event) => event.eventId),
    );
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const event = queue[i]!;
      if (event.kind !== 'bossAbilityCast') continue;
      if (!liveBossEventIds.has(event.eventId)) {
        queue.splice(i, 1);
      }
    }
  }

  function show(event: AnnouncementEvent, nowMs: number): void {
    // Boss-ability casts and skill-passive-unlock milestones both carry a full
    // authored string that must render exactly (never ellipsized or rebuilt
    // from an archetype index). The panel is 420px wide; authored strings can
    // exceed the 44-char single-line budget, so we enable word wrap and
    // vertically re-center the label in the full panel.
    const FULL_TEXT_WRAP_WIDTH = PANEL_WIDTH - 24; // 12px inset on each side
    if (event.kind === 'bossAbilityCast' || event.kind === 'skillPassiveUnlocked') {
      labelText
        .setWordWrapWidth(FULL_TEXT_WRAP_WIDTH, true)
        .setText(event.text)
        .setY(ANNOUNCEMENT_PANEL_HEIGHT / 2)
        .setColor(colorForKind(event.kind));
      verbText.setText('');
      accent.setFillStyle(event.kind === 'bossAbilityCast' ? 0xef4444 : 0x22c55e);
      currentRenderedText = event.text;
    } else {
      const label = event.displayName ?? 'Spawner';
      // Disable word wrap for the standard single-line path.
      const renderedLabel = ellipsizeEncounterLabel(label, MAX_LABEL_CHARACTERS);
      labelText
        .setWordWrapWidth(0)
        .setText(renderedLabel)
        .setY(16)
        .setColor(colorForKind(event.kind));
      verbText.setText(verbForKind(event.kind).toUpperCase());
      accent.setFillStyle(event.kind === 'spawnerArenaStart' ? 0xf2b542 : 0x46d369);
      currentRenderedText = renderedLabel;
    }
    activeTween?.remove();
    activeTween = scene.tweens.add({
      targets: wrapper,
      alpha: { from: hidden ? 0 : 1, to: 1 },
      duration: FADE_MS,
      ease: 'Cubic.easeOut',
    });
    hidden = false;
    currentEvent = event;
    displayStartMs = nowMs;
  }

  function hide(): void {
    if (hidden) return;
    activeTween?.remove();
    activeTween = scene.tweens.add({
      targets: wrapper,
      alpha: { from: 1, to: 0 },
      duration: FADE_MS,
      ease: 'Cubic.easeIn',
    });
    hidden = true;
    currentEvent = undefined;
    currentRenderedText = '';
  }

  function sync(world: GameWorld): void {
    drainWorldAnnouncements(world);
    pruneCanceledBossAbilityAnnouncements(world);
    // Expire the head only when its display duration has fully elapsed from
    // the moment it *started showing* (displayStartMs). Using the creation
    // time (event.elapsedMs) would expire all simultaneously-pushed events at
    // the same wall-clock instant, preventing the second from ever appearing.
    if (queue.length > 0 && currentEvent === queue[0]) {
      // queue[0]! is safe: we just checked queue.length > 0.
      if (world.elapsedMs > displayStartMs + queue[0]!.durationMs) {
        queue.shift();
      }
    }
    if (queue.length === 0) {
      hide();
      return;
    }
    const head = queue[0]!;
    if (currentEvent !== head) {
      show(head, world.elapsedMs);
    }
  }

  function destroy(): void {
    detachCrispText();
    activeTween?.remove();
    labelText.destroy();
    verbText.destroy();
    accent.destroy();
    panel.destroy();
    wrapper.destroy();
  }

  function getLayoutBounds(): { panel: ScreenBounds; text: ScreenBounds } | null {
    if (hidden && wrapper.alpha === 0) return null;
    const panelBounds = panel.getBounds();
    const textLeft = Math.min(labelText.x - labelText.width / 2, verbText.x - verbText.width / 2);
    const textRight = Math.max(labelText.x + labelText.width / 2, verbText.x + verbText.width / 2);
    const textTop =
      wrapper.y + Math.min(labelText.y - labelText.height / 2, verbText.y - verbText.height / 2);
    const textBottom =
      wrapper.y + Math.max(labelText.y + labelText.height / 2, verbText.y + verbText.height / 2);
    return {
      panel: { ...panelBounds, y: wrapper.y + panelBounds.y },
      text: {
        x: textLeft,
        y: textTop,
        width: textRight - textLeft,
        height: textBottom - textTop,
      },
    };
  }

  function getCurrentAnnouncement(): { kind: AnnouncementKind; text: string } | null {
    if (hidden || !currentEvent) return null;
    return { kind: currentEvent.kind, text: currentRenderedText };
  }

  return {
    sync,
    setTop: (top: number) => wrapper.setY(top),
    getLayoutBounds,
    getCurrentAnnouncement,
    destroy,
  };
}
