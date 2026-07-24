/**
 * RewardOpeningUI — shared full-screen Phaser renderer for the deterministic
 * reward-opening sequence (`shared/reward-opening-sequence.ts`).
 *
 * Drives ONLY presentation: it never grants, resolves, or mutates a reward.
 * Callers (`AchievementsUI`, `BossChestUI`) already performed the exact-once
 * claim/grant through the shared core APIs BEFORE opening this UI, and pass in
 * the resulting `ResolvedRewardPresentation` snapshot purely for redisplay —
 * including on a save/load resume, where the snapshot was read back from
 * persisted state rather than freshly granted.
 *
 * Phases (`anticipation` -> `revealing` -> `summary` -> `claimed`) are driven
 * by the pure reducer in `reward-opening-sequence.ts`; this file only renders
 * the current phase and forwards deterministic `tick(deltaMs)` calls from the
 * caller's own update loop (mirroring `LevelUpUI`/`ModalPickerUI`'s
 * freeze-the-simulation-while-open pattern), which keeps the whole sequence
 * headless-reproducible: the same tick timeline always yields the same phase
 * timeline, in tests as in the real game.
 *
 * Input lock: while open, a full-screen interactive backdrop swallows every
 * pointer event so clicks never reach the game world underneath, and
 * `MainGameScene.isBlockingSurfaceOpen()` must include `isOpen()` so the fixed
 * simulation step freezes too (see the `LevelUpUI`/`modalPicker` branches in
 * `MainGameScene.update()`).
 *
 * Excitement intensity (`RewardExcitement.bucket`) scales the reveal's visual
 * flourish (glow size/colour count) independently of which reward this is —
 * a tier2+common grant renders less intense than a tier2+uncommon grant, per
 * the hard UX contract. Audio is deliberately NOT implemented here; the
 * `onPhaseChange` hook exists purely so a later audio-hook slice has a stable,
 * already-shipped timing/intensity signal to attach sounds to.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { getRenderScale } from './render-scale.js';
import type { ResolvedRewardPresentation } from '../shared/reward-presentation.js';
import {
  computeLootBoxExcitement,
  computeRewardExcitement,
  type RewardExcitement,
  type RewardExcitementBucket,
} from '../shared/reward-presentation.js';
import {
  acknowledge as acknowledgeSequence,
  createRewardOpeningState,
  isRewardOpeningComplete,
  skip as skipSequence,
  tick as tickSequence,
  type RewardOpeningPhase,
  type RewardOpeningState,
} from '../shared/reward-opening-sequence.js';
import {
  createGeneratedEquipmentIcon,
  resolveEquipmentIconSpec,
  type ResolvedEquipmentIconSpec,
} from './generated-equipment-icon.js';
import { getItemById } from '../shared/items.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('engine:reward-opening-ui');

const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';

/** Bucket -> {glow colour count/size, backdrop tint} visual intensity tuning. */
const BUCKET_STYLE: Readonly<
  Record<RewardExcitementBucket, { readonly glowColor: number; readonly glowRadius: number }>
> = {
  modest: { glowColor: 0x8fa0c2, glowRadius: 60 },
  notable: { glowColor: 0x4caf50, glowRadius: 90 },
  exciting: { glowColor: 0x2196f3, glowRadius: 130 },
  legendary: { glowColor: 0xffc107, glowRadius: 180 },
};

export interface RewardOpeningUIHooks {
  /**
   * Optional stable hook for a future audio-hook slice: fired whenever the
   * phase actually changes (never on a same-phase tick), with the excitement
   * bucket driving this reward's intensity. Deliberately unused for audio in
   * this slice.
   */
  readonly onPhaseChange?: (phase: RewardOpeningPhase, bucket: RewardExcitementBucket) => void;
  /** Fired whenever the overlay opens or closes so callers can clear stale input. */
  readonly onVisibilityChange?: (open: boolean) => void;
}

export interface OpenRewardOpeningParams {
  readonly world: GameWorld;
  readonly presentation: ResolvedRewardPresentation;
  readonly reducedMotion: boolean;
  /** Short label shown in the header, e.g. "Achievement Reward" / "Boss Chest". */
  readonly sourceLabel: string;
  /**
   * Fired exactly once per `open()` call, when the player confirms the
   * summary (or a duplicate confirm arrives, which is safely ignored by the
   * caller's idempotent acknowledge/claim APIs). The caller uses this to
   * invoke the matching shared `acknowledge*` function against the real
   * world and refresh its own panel — this UI never touches `GameWorld`
   * mutation state itself. Scoped per-open (rather than a constructor hook)
   * so one shared `RewardOpeningUI` instance can serve multiple callers
   * (achievements, boss chests) without cross-talk.
   */
  readonly onAcknowledge: () => void;
}

export interface RewardOpeningUI {
  open(params: OpenRewardOpeningParams): void;
  isOpen(): boolean;
  /** Advance the sequence by `deltaMs`. No-op while closed. */
  tick(deltaMs: number): void;
  /** Jump straight to `summary`. No-op while closed or already at/past `summary`. */
  skip(): void;
  /**
   * Confirm the summary, firing `onAcknowledge` and closing. No-op unless the
   * sequence is currently at `summary` — duplicate calls once closed are safe.
   */
  acknowledge(): void;
  /** Test/automation affordance: current phase, or `null` while closed. */
  getPhase(): RewardOpeningPhase | null;
  /** Test/automation affordance: current excitement bucket, or `null` while closed. */
  getBucket(): RewardExcitementBucket | null;
  /** Test/automation affordance: items revealed so far / total, or null while closed. */
  getRevealProgress(): { readonly revealed: number; readonly total: number } | null;
  destroy(): void;
}

interface RevealItemDisplay {
  readonly label: string;
  readonly color: number;
  readonly equipmentSpec?: ResolvedEquipmentIconSpec;
}

function lootBoxRevealItems(
  presentation: Extract<ResolvedRewardPresentation, { kind: 'lootBox' }>,
): RevealItemDisplay[] {
  const materialCounts = new Map<string, number>();
  for (const itemId of presentation.materials) {
    materialCounts.set(itemId, (materialCounts.get(itemId) ?? 0) + 1);
  }
  const items: RevealItemDisplay[] = [{ label: `${presentation.gold} gold`, color: 0xffc107 }];
  for (const [itemId, count] of materialCounts) {
    const def = getItemById(itemId);
    const name = def?.name ?? itemId;
    items.push({ label: count > 1 ? `${name} x${count}` : name, color: 0x9e9e9e });
  }
  return items;
}

function equipmentRevealItems(
  world: GameWorld,
  presentation: Extract<ResolvedRewardPresentation, { kind: 'equipment' }>,
): RevealItemDisplay[] {
  return presentation.instanceKeys.map((instanceKey) => {
    const spec = resolveEquipmentIconSpec(world, instanceKey);
    if (!spec) {
      logger.warn('Missing generated-equipment instance for reward presentation', {
        instanceKey,
      });
      return { label: '???', color: 0x9e9e9e };
    }
    return { label: spec.itemName, color: spec.rarityColor, equipmentSpec: spec };
  });
}

export function createRewardOpeningUI(
  scene: Phaser.Scene,
  hooks: RewardOpeningUIHooks,
): RewardOpeningUI {
  const baseResolution = getRenderScale(scene);
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(Math.round(x), Math.round(y), text, style).setResolution(baseResolution);

  const container = scene.add.container(0, 0).setDepth(6000).setVisible(false).setScrollFactor(0);

  const backdrop = scene.add.rectangle(
    GAME.WIDTH / 2,
    GAME.HEIGHT / 2,
    GAME.WIDTH,
    GAME.HEIGHT,
    0x000000,
    0.72,
  );
  backdrop.setInteractive();
  container.add(backdrop);

  const glow = scene.add.circle(GAME.WIDTH / 2, GAME.HEIGHT / 2, 60, 0x8fa0c2, 0.25);
  container.add(glow);

  const header = crispText(GAME.WIDTH / 2, GAME.HEIGHT / 2 - 160, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '16px',
    color: '#9ca3af',
  });
  header.setOrigin(0.5, 0.5);
  container.add(header);

  const title = crispText(GAME.WIDTH / 2, GAME.HEIGHT / 2 - 120, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '26px',
    fontStyle: 'bold',
    color: '#f8fafc',
  });
  title.setOrigin(0.5, 0.5);
  container.add(title);

  const itemObjects: Phaser.GameObjects.GameObject[] = [];
  function clearItemObjects(): void {
    for (const obj of itemObjects) obj.destroy();
    itemObjects.length = 0;
  }

  const footer = crispText(GAME.WIDTH / 2, GAME.HEIGHT / 2 + 180, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '13px',
    color: '#9ca3af',
  });
  footer.setOrigin(0.5, 0.5);
  container.add(footer);

  let world: GameWorld | null = null;
  let presentation: ResolvedRewardPresentation | null = null;
  let sourceLabel = '';
  let onAcknowledgeCallback: (() => void) | null = null;
  let sequenceState: RewardOpeningState | null = null;
  let excitement: RewardExcitement = { tierWeight: 0, rarityWeight: 0, score: 0, bucket: 'modest' };
  let revealItems: RevealItemDisplay[] = [];
  let lastRenderedPhase: RewardOpeningPhase | null = null;

  function computeExcitement(): RewardExcitement {
    if (!presentation || !world) {
      return { tierWeight: 0, rarityWeight: 0, score: 0, bucket: 'modest' };
    }
    if (presentation.kind === 'lootBox') {
      return computeLootBoxExcitement(presentation.tier);
    }
    const rarities = presentation.instanceKeys
      .map((key) => resolveEquipmentIconSpec(world!, key)?.rarity)
      .filter((rarity): rarity is NonNullable<typeof rarity> => rarity !== undefined);
    const computed = computeRewardExcitement(presentation, rarities);
    if (!computed) {
      logger.warn('Reward presentation had no resolvable rarities; defaulting to modest', {
        kind: presentation.kind,
      });
      return { tierWeight: 0, rarityWeight: 0, score: 0, bucket: 'modest' };
    }
    return computed;
  }

  function render(): void {
    if (!sequenceState || !presentation) return;
    const style = BUCKET_STYLE[excitement.bucket];
    glow.setFillStyle(style.glowColor, 0.22);

    header.setText(sourceLabel);

    switch (sequenceState.phase) {
      case 'anticipation': {
        glow.setRadius(style.glowRadius * 0.5);
        title.setText('...');
        clearItemObjects();
        footer.setText('Click / press Enter to skip');
        break;
      }
      case 'revealing': {
        glow.setRadius(style.glowRadius * 0.85);
        title.setText('Revealing...');
        clearItemObjects();
        const revealed = revealItems.slice(0, sequenceState.revealedCount);
        const startX = GAME.WIDTH / 2 - ((revealed.length - 1) * 90) / 2;
        revealed.forEach((item, index) => {
          const x = startX + index * 90;
          const y = GAME.HEIGHT / 2 - 20;
          if (item.equipmentSpec && world) {
            const icon = createGeneratedEquipmentIcon(scene, world, item.equipmentSpec, x, y, 48);
            container.add(icon);
            itemObjects.push(icon);
          } else {
            const box = scene.add.rectangle(x, y, 48, 48, item.color, 0.85);
            container.add(box);
            itemObjects.push(box);
          }
          const label = crispText(x, y + 34, item.label, {
            fontFamily: FONT_FAMILY,
            fontSize: '11px',
            color: '#d6d9f1',
          });
          label.setOrigin(0.5, 0);
          container.add(label);
          itemObjects.push(label);
        });
        footer.setText('Click / press Enter to skip');
        break;
      }
      case 'summary': {
        glow.setRadius(style.glowRadius);
        title.setText('Reward Summary');
        clearItemObjects();
        const startX = GAME.WIDTH / 2 - ((revealItems.length - 1) * 90) / 2;
        revealItems.forEach((item, index) => {
          const x = startX + index * 90;
          const y = GAME.HEIGHT / 2 - 20;
          if (item.equipmentSpec && world) {
            const icon = createGeneratedEquipmentIcon(scene, world, item.equipmentSpec, x, y, 48);
            container.add(icon);
            itemObjects.push(icon);
          } else {
            const box = scene.add.rectangle(x, y, 48, 48, item.color, 0.85);
            container.add(box);
            itemObjects.push(box);
          }
          const label = crispText(x, y + 34, item.label, {
            fontFamily: FONT_FAMILY,
            fontSize: '11px',
            color: '#d6d9f1',
          });
          label.setOrigin(0.5, 0);
          container.add(label);
          itemObjects.push(label);
        });
        footer.setText('Click / press Enter to claim');
        break;
      }
      case 'claimed': {
        title.setText('Claimed!');
        footer.setText('');
        break;
      }
    }

    if (lastRenderedPhase !== sequenceState.phase) {
      lastRenderedPhase = sequenceState.phase;
      hooks.onPhaseChange?.(sequenceState.phase, excitement.bucket);
    }
  }

  function close(): void {
    world = null;
    presentation = null;
    onAcknowledgeCallback = null;
    sequenceState = null;
    lastRenderedPhase = null;
    clearItemObjects();
    container.setVisible(false);
    hooks.onVisibilityChange?.(false);
  }

  function handleSkip(): void {
    if (!sequenceState) return;
    sequenceState = skipSequence(sequenceState);
    render();
  }

  function handleAcknowledge(): void {
    if (!sequenceState) return;
    if (sequenceState.phase !== 'summary') return;
    sequenceState = acknowledgeSequence(sequenceState);
    render();
    const callback = onAcknowledgeCallback;
    close();
    callback?.();
  }

  function handleAdvanceInput(): void {
    if (!sequenceState) return;
    if (sequenceState.phase === 'summary') {
      handleAcknowledge();
    } else if (sequenceState.phase !== 'claimed') {
      handleSkip();
    }
  }

  backdrop.on('pointerdown', handleAdvanceInput);

  const keyListener = (event: KeyboardEvent): void => {
    if (!sequenceState) return;
    switch (event.code) {
      case 'Enter':
      case 'Space':
      case 'Escape':
        event.preventDefault();
        handleAdvanceInput();
        break;
      default:
        break;
    }
  };
  scene.input.keyboard?.on('keydown', keyListener);

  return {
    open(params: OpenRewardOpeningParams): void {
      world = params.world;
      presentation = params.presentation;
      sourceLabel = params.sourceLabel;
      onAcknowledgeCallback = params.onAcknowledge;
      excitement = computeExcitement();
      revealItems =
        presentation.kind === 'lootBox'
          ? lootBoxRevealItems(presentation)
          : equipmentRevealItems(world, presentation);
      // Drive the sequence's itemCount from the ACTUAL number of reveal
      // items (gold + each distinct material stack for lootBox, or each
      // equipment instance) rather than a hardcoded/instanceKeys-only count,
      // so the per-item incremental reveal genuinely matches what's
      // rendered — a lootBox with materials previously always reported
      // itemCount=1 regardless of how many items it actually revealed
      // (round-2 code review).
      sequenceState = createRewardOpeningState(Math.max(1, revealItems.length), {
        reducedMotion: params.reducedMotion,
      });
      lastRenderedPhase = null;
      container.setVisible(true);
      hooks.onVisibilityChange?.(true);
      render();
    },
    isOpen(): boolean {
      return sequenceState !== null;
    },
    tick(deltaMs: number): void {
      if (!sequenceState) return;
      const next = tickSequence(sequenceState, deltaMs);
      if (next === sequenceState) return;
      // `tickSequence` allocates a fresh state object every frame while a
      // phase's elapsed timer is running (even when nothing visible changes),
      // so only re-render when phase/revealedCount actually change — a
      // per-frame render() tears down and recreates every item GameObject via
      // clearItemObjects(), which is far too expensive to run at 60 FPS.
      const needsRender =
        next.phase !== sequenceState.phase || next.revealedCount !== sequenceState.revealedCount;
      sequenceState = next;
      if (needsRender) render();
    },
    skip: handleSkip,
    acknowledge: handleAcknowledge,
    getPhase(): RewardOpeningPhase | null {
      return sequenceState?.phase ?? null;
    },
    getBucket(): RewardExcitementBucket | null {
      return sequenceState ? excitement.bucket : null;
    },
    getRevealProgress(): { readonly revealed: number; readonly total: number } | null {
      return sequenceState
        ? { revealed: sequenceState.revealedCount, total: sequenceState.itemCount }
        : null;
    },
    destroy(): void {
      backdrop.off('pointerdown', handleAdvanceInput);
      scene.input.keyboard?.off('keydown', keyListener);
      close();
      container.destroy(true);
    },
  };
}

/** Re-exported for callers that only need the completion predicate. */
export { isRewardOpeningComplete };
