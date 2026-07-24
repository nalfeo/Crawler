/**
 * BossChestUI — safe-room-independent panel listing Floor 2 boss chests.
 *
 * Boss chests have no physical world entity yet (ADR 0070) — they exist only
 * as `world.bossChests` records created by `spawnBossChestForDefeatedBoss`
 * once a family boss is defeated. This panel is the only surface the player
 * can use to open/view them: it lists every chest by family, and opening one
 * drives the shared `RewardOpeningUI` sequence exactly like `AchievementsUI`.
 *
 * Opening a chest is reveal-only from this panel's perspective: it calls the
 * exact-once `openBossChest` grant (core layer, idempotent) and then presents
 * the resulting `revealedGrant` snapshot — this panel never generates or
 * mutates reward contents itself.
 *
 * Layer note: imports only from core + shared (never game/labs), mirroring
 * `AchievementsUI`. `src/game/boss-chest-resolver.ts` re-exports the same
 * `openBossChest`/`acknowledgeBossChestReveal` primitives from core for
 * game-layer callers, so importing them here directly from
 * `core/systems/bossChestRewards.js` reaches the identical functions.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { fitUiScale } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';
import { GAME } from '../shared/constants.js';
import {
  openBossChest,
  acknowledgeBossChestReveal,
  type BossChestRecord,
  type BossChestState,
} from '../core/systems/bossChestRewards.js';
import { loadFamilies, type FamilyDef } from '../shared/data/families.js';
import type { RewardOpeningUI } from './RewardOpeningUI.js';
import { prefersReducedMotion } from './reduced-motion.js';

const PANEL_PADDING = 16;
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
const ROW_HEIGHT = 64;
const ROW_GAP = 8;

const COLORS = {
  panelBg: 0x0d0d1a,
  panelBorder: 0x2a2a4a,
  rowBg: 0x15152a,
  rowBorder: 0x333355,
  textPrimary: 0xf8fafc,
  textSecondary: 0x9ca3af,
  btnBg: 0x2a2a4a,
  btnHover: 0x3a3a6a,
  claimed: 0x22c55e,
} as const;

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function familyNameMap(): Map<string, FamilyDef> {
  const map = new Map<string, FamilyDef>();
  for (const family of loadFamilies()) map.set(family.id, family);
  return map;
}

function stateLabel(state: BossChestState): string {
  switch (state) {
    case 'available':
      return 'Ready to open';
    case 'opening':
      return 'Opening…';
    case 'revealed':
      return 'Reward revealed — claim it';
    case 'claimed':
      return 'Claimed';
  }
}

export interface BossChestUIConfig {
  width?: number;
  height?: number;
  /** Resolves the entity that receives an opened chest's granted equipment. */
  getPlayerEid: () => number | undefined;
  /**
   * Invoked when opening a chest's grant fails (e.g. the player's inventory
   * is full), so the caller can surface feedback — the chest row gives no
   * other indication that the click did nothing (the chest stays `available`
   * and retryable).
   */
  onGrantFailed?: (reason: string) => void;
  /**
   * Fired only when this UI has drained its own pending-presentation queue and
   * the shared RewardOpeningUI is now closed, so the caller can resume another
   * reward source through the same modal.
   */
  onPresentationQueueDrained?: (world: GameWorld) => void;
}

export interface BossChestUIApi {
  toggle(world: GameWorld): void;
  refresh(world: GameWorld): void;
  /** Auto-resumes any chest whose reveal hasn't been presented/acknowledged yet. */
  resumePendingPresentation(world: GameWorld): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createBossChestUI(
  scene: Phaser.Scene,
  rewardOpeningUI: RewardOpeningUI,
  config: BossChestUIConfig,
): BossChestUIApi {
  const snap = (value: number): number => Math.round(value);
  const baseResolution = getRenderScale(scene);
  let textResolution = baseResolution;
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(textResolution);

  const panelWidth = config.width ?? 520;
  const panelHeight = config.height ?? 420;

  let uiScale = fitUiScale(scene, panelWidth, panelHeight);
  textResolution = Math.max(1, Math.round(baseResolution * uiScale));
  const viewWidth = (): number => GAME.WIDTH / uiScale;
  const viewHeight = (): number => GAME.HEIGHT / uiScale;

  let visible = false;
  let lastWorld: GameWorld | null = null;
  let lastSignature: string | null = null;
  const families = familyNameMap();

  const container = scene.add.container(0, 0).setDepth(1000).setVisible(false);

  let panelX = snap((viewWidth() - panelWidth) / 2);
  let panelY = snap((viewHeight() - panelHeight) / 2);

  const bg = scene.add.rectangle(0, 0, panelWidth, panelHeight, COLORS.panelBg, 0.96);
  bg.setStrokeStyle(2, COLORS.panelBorder);
  container.add(bg);

  const title = crispText(0, 0, '📦 BOSS CHESTS', {
    fontFamily: FONT_FAMILY,
    fontSize: '20px',
    color: hex(COLORS.textPrimary),
  });
  container.add(title);

  const hint = crispText(0, 0, '[C] to close', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: hex(COLORS.textSecondary),
  });
  hint.setOrigin(1, 0);
  container.add(hint);

  const rowObjects: Phaser.GameObjects.GameObject[] = [];
  function clearRows(): void {
    for (const obj of rowObjects) obj.destroy();
    rowObjects.length = 0;
  }

  function sortedChests(world: GameWorld): BossChestRecord[] {
    return [...world.bossChests.values()].sort((a, b) => a.chestId.localeCompare(b.chestId));
  }

  function computeSignature(world: GameWorld): string {
    return sortedChests(world)
      .map((c) => `${c.chestId}:${c.state}`)
      .join('|');
  }

  function presentBossChestReward(world: GameWorld, chest: BossChestRecord): void {
    if (!chest.revealedGrant) return;
    const family = families.get(chest.familyId);
    rewardOpeningUI.open({
      world,
      presentation: chest.revealedGrant,
      reducedMotion: prefersReducedMotion(),
      sourceLabel: family ? `Boss Chest: ${family.boss.name}` : 'Boss Chest',
      onAcknowledge: () => {
        acknowledgeBossChestReveal(world, chest.chestId);
        lastSignature = null;
        refresh(world);
        resumePendingPresentation(world);
        if (!rewardOpeningUI.isOpen()) {
          config.onPresentationQueueDrained?.(world);
        }
      },
    });
  }

  /**
   * Auto-resumes at most one chest stuck in `revealed` with an unpresented
   * reveal (e.g. reloaded between opening and acknowledging, or several
   * chests opened before dismissing). Deterministic ordering (sorted chest
   * id) so a save/frame with several pending chests always resumes in the
   * same order; `presentBossChestReward`'s `onAcknowledge` callback calls
   * back into this function so every pending chest gets surfaced in turn.
   */
  function resumePendingPresentation(world: GameWorld): void {
    if (rewardOpeningUI.isOpen()) return;
    for (const chest of sortedChests(world)) {
      if (chest.state === 'revealed' && chest.revealedGrant) {
        presentBossChestReward(world, chest);
        return;
      }
    }
  }

  function openChest(world: GameWorld, chest: BossChestRecord): void {
    const playerEid = config.getPlayerEid();
    if (playerEid === undefined || playerEid < 0) return;
    const result = openBossChest(world, chest.chestId, playerEid);
    lastSignature = null;
    refresh(world);
    if (!result.ok) {
      config.onGrantFailed?.(result.reason);
      return;
    }
    const updated = world.bossChests.get(chest.chestId);
    if (updated) presentBossChestReward(world, updated);
  }

  function makeRow(
    world: GameWorld,
    chest: BossChestRecord,
    x: number,
    y: number,
    w: number,
  ): void {
    const family = families.get(chest.familyId);
    const displayName = family?.boss.name ?? family?.name ?? chest.familyId;

    const box = scene.add.rectangle(
      x + w / 2,
      y + ROW_HEIGHT / 2,
      w,
      ROW_HEIGHT,
      COLORS.rowBg,
      0.9,
    );
    box.setStrokeStyle(1, COLORS.rowBorder);
    container.add(box);
    rowObjects.push(box);

    const t = crispText(x + 12, y + 10, displayName, {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      fontStyle: 'bold',
      color: hex(COLORS.textPrimary),
    });
    container.add(t);
    rowObjects.push(t);

    const status = crispText(x + 12, y + 34, stateLabel(chest.state), {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: hex(chest.state === 'claimed' ? COLORS.claimed : COLORS.textSecondary),
    });
    container.add(status);
    rowObjects.push(status);

    if (chest.state === 'available' || chest.state === 'revealed') {
      const label = chest.state === 'available' ? 'Open' : 'View';
      const btn = crispText(x + w - 12, y + ROW_HEIGHT / 2, label, {
        fontFamily: FONT_FAMILY,
        fontSize: '13px',
        fontStyle: 'bold',
        color: hex(COLORS.textPrimary),
        backgroundColor: hex(COLORS.btnBg),
        padding: { x: 10, y: 6 },
      });
      btn.setOrigin(1, 0.5);
      btn
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => btn.setBackgroundColor(hex(COLORS.btnHover)))
        .on('pointerout', () => btn.setBackgroundColor(hex(COLORS.btnBg)))
        .on('pointerdown', () => {
          if (chest.state === 'available') openChest(world, chest);
          else presentBossChestReward(world, chest);
        });
      container.add(btn);
      rowObjects.push(btn);
    }
  }

  function render(): void {
    clearRows();
    if (!lastWorld) return;
    const chests = sortedChests(lastWorld);
    const x = panelX + PANEL_PADDING;
    const w = panelWidth - PANEL_PADDING * 2;

    if (chests.length === 0) {
      const empty = crispText(
        x,
        panelY + PANEL_PADDING + 40,
        'No boss chests yet — defeat a Floor 2 family boss to earn one.',
        { fontFamily: FONT_FAMILY, fontSize: '14px', color: hex(COLORS.textSecondary) },
      );
      container.add(empty);
      rowObjects.push(empty);
      return;
    }

    let currentY = panelY + PANEL_PADDING + 40;
    for (const chest of chests) {
      makeRow(lastWorld, chest, x, currentY, w);
      currentY += ROW_HEIGHT + ROW_GAP;
    }
  }

  function applyLayout(): void {
    uiScale = fitUiScale(scene, panelWidth, panelHeight);
    textResolution = Math.max(1, Math.round(baseResolution * uiScale));
    container.setScale(uiScale);
    panelX = snap((viewWidth() - panelWidth) / 2);
    panelY = snap((viewHeight() - panelHeight) / 2);
    bg.setPosition(panelX + panelWidth / 2, panelY + panelHeight / 2);
    title.setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING).setResolution(textResolution);
    hint
      .setPosition(panelX + panelWidth - PANEL_PADDING, panelY + PANEL_PADDING + 2)
      .setResolution(textResolution);
    if (visible) lastSignature = null;
  }

  function refresh(world: GameWorld): void {
    lastWorld = world;
    if (!visible) return;
    const signature = computeSignature(world);
    if (signature !== lastSignature) {
      render();
      lastSignature = signature;
    }
  }

  function toggle(world: GameWorld): void {
    visible = !visible;
    container.setVisible(visible);
    if (visible) {
      applyLayout();
      lastSignature = null;
      refresh(world);
    }
  }

  scene.scale.on('resize', applyLayout);

  return {
    toggle,
    refresh,
    resumePendingPresentation,
    isOpen: () => visible,
    destroy() {
      scene.scale.off('resize', applyLayout);
      clearRows();
      container.destroy();
    },
  };
}
