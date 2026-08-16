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
 * the hard UX contract. The same intensity signal drives audio: callers wire
 * `onPhaseChange`/`onItemRevealed`/`onSkip`/`onVisibilityChange` to
 * `src/engine/reward-opening-audio.ts`'s controller (see `MainGameScene`'s
 * reward-opening construction) so audio excitement always matches this
 * visual glow rather than guessing a second scale.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { getRenderScale } from './render-scale.js';
import type { ResolvedRewardPresentation } from '../shared/reward-presentation.js';
import {
  computeLootBoxExcitement,
  computeRewardExcitement,
  equipmentRarityWeight,
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
import { createRewardOpeningVfx, type RewardOpeningVfx } from './RewardOpeningVfx.js';
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
   * Fired whenever the phase actually changes (never on a same-phase tick),
   * with the excitement bucket driving this reward's intensity. Drives the
   * `anticipation`/`summary` audio cues. NEVER fired for the `summary`
   * transition reached via `skip()` — see `onSkip` below (adversarial plan
   * review finding: relying on a scheduled-then-immediately-cancelled
   * summary cue being "provably inaudible" via same-tick `AudioContext`
   * timing was correct but fragile; it is architecturally simpler and more
   * robust to simply never schedule that cue for a skip-caused transition).
   */
  readonly onPhaseChange?: (phase: RewardOpeningPhase, bucket: RewardExcitementBucket) => void;
  /** Fired whenever the overlay opens or closes so callers can clear stale input. */
  readonly onVisibilityChange?: (open: boolean) => void;
  /**
   * Fired once per DISTINCT reveal "beat", in reveal order, ONLY from
   * forward `tick()` progression (never from `skip()`, which jumps straight
   * to `summary` — use `onSkip` for that transition instead). `rarityWeight`
   * is the item's own 0..1 rarity weight (e.g. `equipmentRarityWeight(...)`),
   * or `null` for an item with no discrete rarity axis (a lootBox's
   * gold/material beats). Drives the `reveal`/`escalation` audio cues.
   * Under reduced motion, `tick()` can reveal every item in a single call —
   * rather than firing once per item (which would stack N simultaneous
   * cues, the OPPOSITE of reduced audio intensity), this fires exactly ONCE
   * for that whole same-tick batch, reporting the batch's highest-rarity
   * item so escalation still tracks correctly (adversarial plan review
   * finding).
   */
  readonly onItemRevealed?: (index: number, total: number, rarityWeight: number | null) => void;
  /**
   * Fired for a skip/fast-forward input that ACTUALLY advanced the sequence
   * (never for a no-op duplicate skip once already at/past `summary`).
   * Drives the `skip` audio cue.
   */
  readonly onSkip?: () => void;
}

/**
 * Optional "open the next box right away" chain action offered on the
 * `summary` screen. Callers supply it only when another reward is genuinely
 * openable right now (e.g. `AchievementsUI` found another unlocked, unclaimed
 * loot-box achievement); this UI never discovers or resolves that reward
 * itself — it only renders the affordance and invokes `open` after the
 * current reward has been acknowledged.
 */
export interface NextRewardAction {
  /** Short player-facing label for the next reward, e.g. "rare box". */
  readonly label: string;
  /**
   * Claim + present the next reward. Invoked at most once per `open()` call,
   * only after the current sequence acknowledged and closed, and only when no
   * other presentation auto-resumed in the meantime.
   */
  readonly open: () => void;
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
  /**
   * Chain affordance for opening several boxes back to back. When present,
   * the summary screen offers an "Open next" button (and the `[N]` key) that
   * acknowledges this reward and immediately opens the next one, so the
   * player never has to reopen the achievements panel between boxes.
   */
  readonly nextReward?: NextRewardAction;
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
  /**
   * Acknowledge the current summary and immediately open the next reward via
   * the `nextReward` action supplied to `open()`. No-op unless the sequence is
   * at `summary` and a next action exists. If acknowledging already reopened
   * the overlay for some other pending presentation (an already-granted
   * reward that must still be shown), that presentation wins and the chain
   * action is not invoked — the next box stays claimable from the panel.
   */
  openNext(): void;
  /** Label of the chained next reward while at `summary`, else `null`. */
  getNextRewardLabel(): string | null;
  /** Test/automation affordance: current phase, or `null` while closed. */
  getPhase(): RewardOpeningPhase | null;
  /** Test/automation affordance: current excitement bucket, or `null` while closed. */
  getBucket(): RewardExcitementBucket | null;
  /**
   * The full excitement signal (tier + actual granted rarity + bucket) for
   * the current session, or `null` while closed. `src/engine/reward-opening-audio.ts`
   * reads this so audio intensity always derives from the SAME signal driving
   * the visual glow — never a second, independently-tuned scale.
   */
  getExcitement(): RewardExcitement | null;
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

  // Persistent (created once, shown only on `summary` when a chain action
  // exists) so it is never torn down/recreated by `clearItemObjects()`.
  const nextButton = crispText(GAME.WIDTH / 2, GAME.HEIGHT / 2 + 130, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '13px',
    fontStyle: 'bold',
    color: '#f8fafc',
    backgroundColor: '#2a2a4a',
    padding: { x: 10, y: 6 },
  });
  nextButton.setOrigin(0.5, 0.5);
  nextButton.setVisible(false);
  container.add(nextButton);

  let world: GameWorld | null = null;
  let presentation: ResolvedRewardPresentation | null = null;
  let sourceLabel = '';
  let onAcknowledgeCallback: (() => void) | null = null;
  let nextReward: NextRewardAction | null = null;
  let sequenceState: RewardOpeningState | null = null;
  let excitement: RewardExcitement = { tierWeight: 0, rarityWeight: 0, score: 0, bucket: 'modest' };
  let revealItems: RevealItemDisplay[] = [];
  let lastRenderedPhase: RewardOpeningPhase | null = null;

  const vfx: RewardOpeningVfx = createRewardOpeningVfx(scene);

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

  function render(options?: { readonly suppressPhaseChangeHook?: boolean }): void {
    if (!sequenceState || !presentation) return;
    const style = BUCKET_STYLE[excitement.bucket];
    glow.setFillStyle(style.glowColor, 0.22);

    header.setText(sourceLabel);
    // The chain button only ever exists on the summary screen; every other
    // phase hides AND disables it so it can never swallow a pointer event
    // intended for the skip/advance backdrop.
    const showNextButton = sequenceState.phase === 'summary' && nextReward !== null;
    if (showNextButton && nextReward) {
      nextButton.setText(`▶ Open next: ${nextReward.label}  [N]`);
      nextButton.setVisible(true);
      nextButton.setInteractive({ useHandCursor: true });
    } else {
      nextButton.setVisible(false);
      nextButton.disableInteractive();
    }

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
        footer.setText(
          showNextButton
            ? 'Click / press Enter to claim · [N] open next box'
            : 'Click / press Enter to claim',
        );
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
      const reducedMotion = sequenceState.config.reducedMotion;
      const cx = GAME.WIDTH / 2;
      const cy = GAME.HEIGHT / 2;
      if (sequenceState.phase === 'anticipation') {
        vfx.onAnticipationStart(cx, cy, excitement.bucket, reducedMotion);
      } else if (sequenceState.phase === 'summary') {
        vfx.onSummaryBurst(cx, cy, excitement.bucket, reducedMotion);
      }
      if (!options?.suppressPhaseChangeHook) {
        hooks.onPhaseChange?.(sequenceState.phase, excitement.bucket);
      }
    }
  }

  function close(): void {
    // Only fire the visibility hook when the overlay was ACTUALLY open —
    // `destroy()` unconditionally calls `close()` on every scene teardown,
    // even when no reward was ever opened, or when this reward was already
    // closed (acknowledge → close, then scene shutdown moments later). An
    // unguarded fire here would make `onVisibilityChange(false)` non-
    // idempotent and cause the audio layer to schedule a spurious "close"
    // cue (and a defensive `stopAll()`) on every normal scene teardown, not
    // just a genuine open→close transition (code review round 1, finding 1).
    const wasOpen = sequenceState !== null;
    world = null;
    presentation = null;
    onAcknowledgeCallback = null;
    nextReward = null;
    sequenceState = null;
    lastRenderedPhase = null;
    clearItemObjects();
    nextButton.setVisible(false);
    nextButton.disableInteractive();
    // Kill any in-flight VFX immediately so particles don't linger over the
    // game world after the overlay is dismissed.
    vfx.destroy();
    container.setVisible(false);
    if (wasOpen) {
      hooks.onVisibilityChange?.(false);
    }
  }

  function handleSkip(): void {
    if (!sequenceState) return;
    const previousPhase = sequenceState.phase;
    sequenceState = skipSequence(sequenceState);
    // Suppress the phase-change hook for this render: a skip-caused
    // `summary` transition must NEVER schedule the `reward:summary` audio
    // cue at all (rather than relying on `onSkip`'s `stopAll()` to cancel a
    // just-scheduled cue before its attack ramp rises — adversarial plan
    // review finding). `onSkip` below is the sole audio signal for this
    // transition; it still defensively `stopAll()`s first in case some
    // OTHER cue (e.g. a reveal/escalation cue) is mid-flight from before the
    // skip input arrived.
    render({ suppressPhaseChangeHook: true });
    // Only fire for a skip that actually advanced the sequence — a duplicate
    // skip press once already at/past `summary` is a no-op, and must not
    // replay the skip cue (duplicate input must never overlap/leak audio).
    if (sequenceState.phase !== previousPhase) {
      hooks.onSkip?.();
    }
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

  /**
   * Acknowledge the current reward and immediately chain into the next one.
   * The acknowledge half is identical to `handleAcknowledge` (same exact-once
   * claim callback, same close), so the chain can never double-acknowledge or
   * skip the caller's own bookkeeping.
   */
  function handleOpenNext(): void {
    if (!sequenceState) return;
    if (sequenceState.phase !== 'summary') return;
    const next = nextReward;
    if (!next) return;
    handleAcknowledge();
    // `handleAcknowledge` fires the caller's `onAcknowledge`, which may itself
    // reopen this shared modal for an already-granted pending presentation
    // (save/load resume, a second achievement claimed in the same frame, a
    // boss chest reveal). Those must not be pre-empted, so only chain when the
    // overlay actually settled closed — the next box remains claimable from
    // the achievements panel either way.
    if (sequenceState === null) {
      next.open();
    }
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
  nextButton.on('pointerdown', handleOpenNext);

  const keyListener = (event: KeyboardEvent): void => {
    if (!sequenceState) return;
    switch (event.code) {
      case 'KeyN':
        // Only meaningful on the summary screen with a chain action wired —
        // outside that, leave the key entirely alone (no preventDefault) so a
        // stray [N] is not silently swallowed by this overlay.
        if (sequenceState.phase === 'summary' && nextReward !== null) {
          event.preventDefault();
          handleOpenNext();
        }
        break;
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
      nextReward = params.nextReward ?? null;
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
      const previousRevealedCount = sequenceState.revealedCount;
      sequenceState = next;
      if (needsRender) render();
      // Fire once per newly-revealed item, in order, ONLY from this forward
      // `tick()` progression — `skip()` jumps `revealedCount` straight to
      // `itemCount` without ever calling `tick()`, so it can never reach
      // here (see `onSkip` for that transition instead). Any same-tick batch
      // of more than one item is coalesced into exactly ONE `onItemRevealed`
      // call, reporting whichever item in the batch has the HIGHEST rarity
      // weight (so an escalation cue still correctly fires if the batch
      // contains a new running-max rarity) — every item is still visually
      // rendered by the `render()` call above, only the AUDIO event count is
      // reduced. Batches > 1 can arise in two ways: (1) under reduced motion,
      // `tickSequence` jumps `revealedCount` from 0 straight to `itemCount`
      // in a SINGLE call; (2) in normal mode, a large frame delta spanning
      // multiple 450 ms reveal intervals (e.g. after a slow frame or tab
      // resume) can advance `revealedCount` by 2 or more. In both cases
      // firing one cue per item would stack simultaneous voices — the
      // opposite of "no same-tick stacking" (adversarial plan review finding,
      // extended by follow-up review to cover normal-mode large deltas).
      if (next.phase === 'revealing' && next.revealedCount > previousRevealedCount) {
        // VFX: fire a spark burst for EVERY newly-revealed item in this batch
        // (unlike the audio hook below, stacking per-item VFX is intentional —
        // each item should have its own visual pop at its position).
        const reducedMotion = next.config.reducedMotion;
        for (let i = previousRevealedCount; i < next.revealedCount; i++) {
          const item = revealItems[i] as RevealItemDisplay | undefined;
          if (item) {
            const startX = GAME.WIDTH / 2 - ((next.revealedCount - 1) * 90) / 2;
            const itemX = startX + i * 90;
            const itemY = GAME.HEIGHT / 2 - 20;
            vfx.onItemRevealed(itemX, itemY, item.color, excitement.bucket, reducedMotion);
          }
        }
        const batchSize = next.revealedCount - previousRevealedCount;
        if (batchSize > 1) {
          let bestIndex = previousRevealedCount;
          let bestRarityWeight: number | null = null;
          for (let i = previousRevealedCount; i < next.revealedCount; i++) {
            const item = revealItems[i] as RevealItemDisplay | undefined;
            const rarityWeight = item?.equipmentSpec
              ? equipmentRarityWeight(item.equipmentSpec.rarity)
              : null;
            if ((rarityWeight ?? -1) > (bestRarityWeight ?? -1)) {
              bestRarityWeight = rarityWeight;
              bestIndex = i;
            }
          }
          hooks.onItemRevealed?.(bestIndex, revealItems.length, bestRarityWeight);
        } else {
          const item = revealItems[previousRevealedCount] as RevealItemDisplay | undefined;
          const rarityWeight = item?.equipmentSpec
            ? equipmentRarityWeight(item.equipmentSpec.rarity)
            : null;
          hooks.onItemRevealed?.(previousRevealedCount, revealItems.length, rarityWeight);
        }
      }
    },
    skip: handleSkip,
    acknowledge: handleAcknowledge,
    openNext: handleOpenNext,
    getNextRewardLabel(): string | null {
      return sequenceState?.phase === 'summary' ? (nextReward?.label ?? null) : null;
    },
    getPhase(): RewardOpeningPhase | null {
      return sequenceState?.phase ?? null;
    },
    getBucket(): RewardExcitementBucket | null {
      return sequenceState ? excitement.bucket : null;
    },
    getExcitement(): RewardExcitement | null {
      return sequenceState ? excitement : null;
    },
    getRevealProgress(): { readonly revealed: number; readonly total: number } | null {
      return sequenceState
        ? { revealed: sequenceState.revealedCount, total: sequenceState.itemCount }
        : null;
    },
    destroy(): void {
      backdrop.off('pointerdown', handleAdvanceInput);
      nextButton.off('pointerdown', handleOpenNext);
      scene.input.keyboard?.off('keydown', keyListener);
      close();
      container.destroy(true);
    },
  };
}

/** Re-exported for callers that only need the completion predicate. */
export { isRewardOpeningComplete };
