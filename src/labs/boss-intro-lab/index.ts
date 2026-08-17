/**
 * Boss Intro Lab — Phaser sandbox for the boss-battle introduction lore sheet
 * (`createBossIntroUI`) and its trigger rules (`resolvePendingBossIntro`).
 *
 * Two modes, both driving the REAL production code paths:
 *
 *  1. **Preview** — pick any boss (Floor 1's two scripted bosses or any Floor 2
 *     family den boss) and open the real sheet with the real content resolver,
 *     so portrait/copy/layout regressions are visible immediately.
 *  2. **Trigger** — flip a real Floor 2 family boss encounter to `started` on a
 *     real `GameWorld` and let `resolvePendingBossIntro` decide whether the
 *     sheet should open. Proves the once-per-boss latch: pressing "Detect"
 *     twice only opens the sheet once.
 *
 * NOTE: a green lab does NOT prove the game wires this up — `MainGameScene`
 * owns that wiring (see `showBossIntroIfNeeded`), and the in-game observation
 * is recorded in the PR/handoff per repo rule #9.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { addEntity } from 'bitecs';
import { GAME } from '../../shared/constants.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { asFamilyId, asResourceId } from '../../core/faction-relations.js';
import { loadFamilies } from '../../shared/data/families.js';
import { loadResources } from '../../shared/data/resources.js';
import {
  familyBossIntroFor,
  fallbackBossIntro,
  floor1BossIntro,
  type BossIntroContent,
} from '../../shared/boss-intro.js';
import { createBossIntroUI } from '../../engine/BossIntroUI.js';
import { resolvePendingBossIntro } from '../../engine/boss-intro-state.js';
import { createLogger } from '../../shared/logger.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'boss-intro-lab';
const SCENE_KEY = 'BossIntroLabScene';
const LAB_SEED = 42;
const logger = createLogger('labs:boss-intro');

interface BossIntroLabSettings {
  /** Preview target: a Floor 1 boss key or `family:<id>`. */
  boss: string;
  /** Family whose den encounter the trigger mode starts. */
  triggerFamily: string;
  /** Simulate the reduced-motion preference (skips the entrance tween). */
  reducedMotion: boolean;
}

function previewOptions(): string[] {
  return [
    'slime-rat',
    'staircase',
    ...loadFamilies().map((family) => `family:${family.id}`),
    'unknown-boss',
  ];
}

function contentFor(option: string): BossIntroContent {
  if (option.startsWith('family:')) {
    const familyId = option.slice('family:'.length);
    return familyBossIntroFor(familyId) ?? fallbackBossIntro(`floor2:${familyId}`, familyId);
  }
  return floor1BossIntro(option) ?? fallbackBossIntro(`boss:${option}`, 'Unbilled Guest');
}

function createBossIntroLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const families = loadFamilies();
  const settings: BossIntroLabSettings = {
    boss: 'staircase',
    triggerFamily: families[0]?.id ?? 'goblins',
    reducedMotion: false,
  };

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);

  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';
  root.append(gameHost);

  const status = document.createElement('pre');
  status.style.cssText =
    'margin-top:16px;padding:8px;background:#0b0e18;color:#c9d4ff;line-height:1.5;white-space:pre-wrap;';
  controls.append(status);

  const hint = document.createElement('p');
  hint.textContent =
    'Boss Intro Lab: "Preview" opens the real lore sheet for any boss. "Start den battle" flips a ' +
    'real Floor 2 encounter to started; "Detect + open" runs resolvePendingBossIntro against it — ' +
    'it fires exactly once per boss. Dismiss with click, Space, Enter or Escape.';
  hint.style.cssText = 'margin-top:12px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  let game: Phaser.Game | undefined;
  let world: GameWorld | undefined;
  let bossIntroUI: ReturnType<typeof createBossIntroUI> | undefined;
  const shownIntroIds = new Set<string>();

  function describeWorld(): string[] {
    const encounters = world?.floorExtendedState?.familyState?.bossEncounters;
    if (!encounters || encounters.size === 0) {
      return ['No den encounters yet — press "Start den battle".'];
    }
    return [...encounters.entries()].map(
      ([familyId, encounter]) =>
        `${familyId}: started=${encounter.started} defeated=${encounter.defeated} eid=${String(
          encounter.bossEid,
        )}`,
    );
  }

  function refreshStatus(extra?: string): void {
    status.textContent = [
      ...(extra === undefined ? [] : [extra]),
      `Intros shown: ${shownIntroIds.size === 0 ? '(none)' : [...shownIntroIds].join(', ')}`,
      ...describeWorld(),
    ].join('\n');
  }

  function resetWorld(): void {
    const created = createGameWorld({ seed: LAB_SEED, floor: 2, entityCapacityMode: 'lab' });
    created.state = 'playing';
    created.floorExtendedState = {
      familyState: {
        presentFamilies: families.slice(0, 3).map((family) => asFamilyId(family.id)),
        contestedResource: asResourceId(loadResources()[0]!.id),
        betrayerFlag: false,
        bossEncounters: new Map(),
      },
    };
    world = created;
    shownIntroIds.clear();
    refreshStatus('World reset.');
  }

  function startDenBattle(): void {
    const familyState = world?.floorExtendedState?.familyState;
    if (!world || !familyState?.bossEncounters) return;
    const familyId = asFamilyId(settings.triggerFamily);
    const bossEid = addEntity(world.ecs);
    familyState.bossEncounters.set(familyId, {
      started: true,
      defeated: false,
      bossEid,
      displayName: familyBossIntroFor(familyId)?.name ?? familyId,
      familyId,
      roomId: 0,
      doorEids: [],
      activeGoalId: `floor2-den-${familyId}-boss-active`,
    });
    refreshStatus(`Started ${familyId} den battle (boss eid ${bossEid}).`);
  }

  function detectAndOpen(): void {
    if (!world || !bossIntroUI) return;
    const pending = resolvePendingBossIntro(world, shownIntroIds);
    if (!pending) {
      refreshStatus('No pending intro (already shown, not started, or boss gone).');
      return;
    }
    shownIntroIds.add(pending.content.introId);
    bossIntroUI.open({
      content: pending.content,
      reducedMotion: settings.reducedMotion,
      onDismiss: () => {
        logger.info('Boss intro dismissed', { introId: pending.content.introId });
        refreshStatus(`Dismissed ${pending.content.introId}.`);
      },
    });
    refreshStatus(`Opened ${pending.content.introId}.`);
  }

  function preview(): void {
    if (!bossIntroUI) return;
    const content = contentFor(settings.boss);
    bossIntroUI.open({
      content,
      reducedMotion: settings.reducedMotion,
      onDismiss: () => refreshStatus(`Dismissed ${content.introId}.`),
    });
    refreshStatus(`Previewing ${content.introId}.`);
  }

  class BossIntroLabScene extends Phaser.Scene {
    constructor() {
      super({ key: SCENE_KEY });
    }

    create(): void {
      this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x0a1120).setOrigin(0, 0);
      this.add
        .text(GAME.WIDTH / 2, 40, 'Boss Intro Lab', {
          fontFamily: 'monospace',
          fontSize: '18px',
          color: '#4b5563',
        })
        .setOrigin(0.5, 0.5);

      bossIntroUI = createBossIntroUI(this);
      resetWorld();
      preview();

      this.events.once('shutdown', () => {
        bossIntroUI?.destroy();
        bossIntroUI = undefined;
      });
    }
  }

  const createGame = (): void => {
    game?.destroy(true);
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: gameHost,
      width: GAME.WIDTH,
      height: GAME.HEIGHT,
      backgroundColor: '#0a1120',
      scene: [BossIntroLabScene],
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });
  };

  gui.add(settings, 'boss', previewOptions()).name('Preview boss');
  gui.add(settings, 'reducedMotion').name('Reduced motion');
  gui.add({ preview: () => preview() }, 'preview').name('Preview lore sheet');
  gui
    .add(
      settings,
      'triggerFamily',
      families.map((family) => family.id),
    )
    .name('Den family');
  gui.add({ start: () => startDenBattle() }, 'start').name('Start den battle');
  gui.add({ detect: () => detectAndOpen() }, 'detect').name('Detect + open');
  gui.add({ reset: () => resetWorld() }, 'reset').name('Reset world');
  gui.add({ restart: () => createGame() }, 'restart').name('Restart scene');

  createGame();

  return () => {
    bossIntroUI?.destroy();
    game?.destroy(true);
    hint.remove();
    status.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Entities' as LabCategory,
  name: 'Boss Intro Lab',
  description: 'Lore-sheet preview plus live trigger check for the boss-battle introduction.',
  create: createBossIntroLab,
});
