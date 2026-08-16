/**
 * Pure helper functions lifted out of {@link MainGameScene} so they can be
 * unit-tested in isolation. Each was previously a `private` method that read
 * `this.*`; here the dependencies are explicit parameters, making the functions
 * referentially transparent (no Phaser, no scene state, no I/O).
 *
 * Behavior is identical to the original methods — this module only relocates
 * logic to module scope and threads in what `this.*` used to supply.
 */
import type { GameWorld } from '../../core/index.js';
import {
  buildDirtyRectFromPixelBounds,
  type LightField,
  type LightFieldDirtyRect,
} from '../lighting/light-field.js';
import {
  getNpcDef,
  selectSpellBrokerDialogue,
  selectTutorialGoonDialogue,
  SHOPKEEPER_DONE_DIALOGUE,
  SHOPKEEPER_EQUIP_HINT_DIALOGUE,
  SHOPKEEPER_LOCKED_DIALOGUE,
  SHOPKEEPER_RETURN_DIALOGUE,
  SHOPKEEPER_SHOP_DIALOGUE,
} from '../../shared/npc-types.js';
import {
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
  type NpcQuestIndicatorState,
  type ShopkeeperStage,
} from '../../shared/quest-types.js';

/** Render-pixel padding added around the camera view when rebuilding light. */
export const LIGHTING_VIEW_BUFFER_PX = 64;

/**
 * The floor-run terminal outcome, if the run has reached one. Handles both
 * Floor 1 (runSummary) and Floor 2 (staircaseDiscovered) terminal states.
 * Only `cleared_floor` and `failed_timeout` are treated as terminal; anything
 * else is `null`.
 */
export function getFloorRunOutcome(world: GameWorld): 'cleared_floor' | 'failed_timeout' | null {
  // Floor 2: player confirmed exit descent → victory
  if (world.floorExtendedState?.familyState?.staircaseDiscovered === true) {
    return 'cleared_floor';
  }
  // Floor 1
  const outcome = world.floorScenario?.runSummary?.outcome;
  if (outcome === 'cleared_floor' || outcome === 'failed_timeout') {
    return outcome;
  }
  return null;
}

export type FloorCompletionPresentation =
  | 'failed_timeout'
  | 'transition_to_next_floor'
  | 'terminal_victory'
  | 'terminal_complete';

/**
 * Chooses which completion-screen branch the scene should present once
 * {@link getFloorRunOutcome} reports a terminal state.
 *
 * Transition callbacks take precedence over the Floor 2 terminal-victory branch
 * so scenarios that clear via `familyState.staircaseDiscovered` can still route
 * onward to another authored floor.
 */
export function getFloorCompletionPresentation(
  world: GameWorld,
  hasFloorTransition: boolean,
): FloorCompletionPresentation | null {
  const outcome = getFloorRunOutcome(world);
  if (!outcome) {
    return null;
  }
  if (outcome === 'failed_timeout') {
    return 'failed_timeout';
  }
  if (hasFloorTransition) {
    return 'transition_to_next_floor';
  }
  if (world.floorExtendedState?.familyState?.staircaseDiscovered === true) {
    return 'terminal_victory';
  }
  return 'terminal_complete';
}

/** Exact-equality of two light-field dirty rects (component-wise). */
export function areLightingRectsEqual(a: LightFieldDirtyRect, b: LightFieldDirtyRect): boolean {
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

/** The minimal camera-view shape the lighting view-rect needs (Phaser's `worldView`). */
export interface LightingViewBounds {
  readonly x: number;
  readonly y: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Builds the light-field dirty rect covering the camera view (plus
 * {@link LIGHTING_VIEW_BUFFER_PX} of padding on every edge), clamped to the
 * field grid. Mirrors the former `MainGameScene.getLightingViewRect()`.
 */
export function getLightingViewRect(
  field: LightField,
  worldView: LightingViewBounds,
): LightFieldDirtyRect {
  return buildDirtyRectFromPixelBounds(
    field,
    worldView.x - LIGHTING_VIEW_BUFFER_PX,
    worldView.y - LIGHTING_VIEW_BUFFER_PX,
    worldView.right + LIGHTING_VIEW_BUFFER_PX,
    worldView.bottom + LIGHTING_VIEW_BUFFER_PX,
  );
}

/** A controller that can report an NPC's quest indicator state. */
interface NpcIndicatorController {
  getIndicatorState?: (world: GameWorld) => NpcQuestIndicatorState;
}

/** The NPC controllers consulted for quest indicators (subset of scene options). */
export interface NpcQuestIndicatorControllers {
  tutorialGoon?: NpcIndicatorController;
  shopkeeper?: NpcIndicatorController;
  spellQuestGiver?: NpcIndicatorController;
}

/**
 * Resolves the quest indicator state for an NPC def, delegating to the matching
 * controller (or `'none'` when there is no controller / handler). Mirrors the
 * former `MainGameScene.resolveNpcQuestIndicatorState()`.
 */
export function resolveNpcQuestIndicatorState(
  defId: string,
  world: GameWorld,
  controllers: NpcQuestIndicatorControllers,
): NpcQuestIndicatorState {
  if (defId === 'tutorial-goon') {
    return controllers.tutorialGoon?.getIndicatorState?.(world) ?? 'none';
  }
  if (defId === 'shopkeeper') {
    return controllers.shopkeeper?.getIndicatorState?.(world) ?? 'none';
  }
  if (defId === 'spell-quest-giver') {
    return controllers.spellQuestGiver?.getIndicatorState?.(world) ?? 'none';
  }
  return 'none';
}

/**
 * Human-readable auto-trigger description for an ability id (used in the
 * abilities-config modal). Mirrors the former
 * `MainGameScene.formatAbilityTrigger()`.
 */
export function formatAbilityTrigger(abilityId: string): string {
  const triggerText = new Map<string, string>([
    ['fireball', 'Auto: hits the nearest enemy, favoring clusters'],
    ['heal', 'Auto: casts when HP deficit warrants it'],
    ['pulse-shield', 'Auto: casts at low HP when surrounded'],
  ]);
  return triggerText.get(abilityId) ?? 'Auto trigger';
}

/** Minimal NPC-instance shape the interaction picker reads. */
export interface NearbyNpcLike {
  readonly nearbyPlayer: boolean;
}

/**
 * Pick the nearest NPC whose `nearbyPlayer` flag is set, or -1 when none qualify.
 *
 * Iterates the npc map directly and reads positions from the entity-store
 * arrays, so the per-frame call in the interaction update allocates nothing
 * beyond the map's key iterator — no intermediate candidate array and no
 * per-NPC objects. This runs every tick in a hot path, so the previous
 * `Array.from(npcs.entries(), mapFn)` materialization was pure garbage churn.
 */
export function findNearestNearbyNpc(
  playerX: number,
  playerY: number,
  npcs: ReadonlyMap<number, NearbyNpcLike>,
  positionX: ArrayLike<number>,
  positionY: ArrayLike<number>,
): number {
  let nearNpcEid = -1;
  let nearNpcDistanceSq = Number.POSITIVE_INFINITY;
  for (const eid of npcs.keys()) {
    const instance = npcs.get(eid);
    if (!instance?.nearbyPlayer) {
      continue;
    }
    const dx = playerX - (positionX[eid] ?? 0);
    const dy = playerY - (positionY[eid] ?? 0);
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < nearNpcDistanceSq) {
      nearNpcDistanceSq = distanceSq;
      nearNpcEid = eid;
    }
  }
  return nearNpcEid;
}

/** Shopkeeper controller fields the dialogue resolver reads (subset of scene options). */
interface DialogueShopkeeperController {
  isLocked?: (world: GameWorld) => boolean;
  getStage: (world: GameWorld) => ShopkeeperStage;
}

/** Spell-quest-giver controller fields the dialogue resolver reads. */
interface DialogueSpellQuestGiverController {
  isLocked?: (world: GameWorld) => boolean;
}

/** Scene-supplied dependencies for {@link resolveDialogueLines}. */
export interface DialogueResolutionDeps {
  shopkeeper?: DialogueShopkeeperController;
  spellQuestGiver?: DialogueSpellQuestGiverController;
  /** True when the merchant errand was just returned (changes the shop greeting). */
  shopkeeperJustReturned: boolean;
}

/**
 * Resolves the dialogue lines an NPC should speak given the current world and
 * quest controllers. Mirrors the former `MainGameScene.resolveDialogueLines()`
 * — quest-aware tutorial-goon lines, the shopkeeper stage machine, the gated
 * spell-quest-giver, then the NPC def's default dialogue.
 */
export function resolveDialogueLines(
  defId: string,
  world: GameWorld,
  deps: DialogueResolutionDeps,
  npcEid?: number,
): string[] {
  const override = npcEid !== undefined ? world.npcs.get(npcEid)?.dialogueOverride : undefined;
  if (override !== undefined && override.length > 0) {
    return [...override];
  }
  const objective = world.floorScenario?.objective;
  if (defId === 'tutorial-goon') {
    const goonLines = selectTutorialGoonDialogue({
      bossDefeated: objective?.bossBattles.get('staircase')?.defeated === true,
      leaveFloorAccepted: world.questLog.has(FLOOR1_LEAVE_FLOOR_QUEST_ID),
      goonGrindComplete: world.goalFlags.get('floor1-goon-quest-complete') === true,
      merchantErrandComplete: world.goalFlags.get('floor1-shop-quest-complete') === true,
      spellBrokerComplete: world.goalFlags.get('floor1-boss-battle-complete') === true,
    });
    if (goonLines) {
      return [...goonLines];
    }
  }
  if (defId === 'shopkeeper' && deps.shopkeeper) {
    if (deps.shopkeeper.isLocked?.(world)) {
      return [...SHOPKEEPER_LOCKED_DIALOGUE];
    }
    const stage = deps.shopkeeper.getStage(world);
    if (stage === 'complete') {
      return [...SHOPKEEPER_DONE_DIALOGUE];
    }
    if (stage === 'awaiting-equip') {
      return [...SHOPKEEPER_EQUIP_HINT_DIALOGUE];
    }
    if (stage === 'ready-to-buy') {
      return deps.shopkeeperJustReturned
        ? [...SHOPKEEPER_RETURN_DIALOGUE]
        : [...SHOPKEEPER_SHOP_DIALOGUE];
    }
    // not-met / awaiting-prize: the merchant's initial fetch request.
  }
  if (defId === 'spell-quest-giver') {
    const brokerLines = selectSpellBrokerDialogue({
      locked: deps.spellQuestGiver?.isLocked?.(world) === true,
      spellbookClaimed:
        world.goalFlags.get('floor1-boss-spellbook-claimed') === true &&
        world.featureUnlocks.spells === true,
    });
    if (brokerLines) {
      return [...brokerLines];
    }
  }
  const def = getNpcDef(defId);
  return def?.dialogue.map((line) => line.text) ?? [];
}

/**
 * Fraction of the next fixed simulation step that has already elapsed in
 * wall-clock time, clamped to `[0, 1]`.
 *
 * The scene simulates on a fixed `GAME.DELTA_MS` accumulator while the browser
 * renders on rAF, so rendered frames rarely land on a step boundary: without
 * this factor some frames advance the world by zero steps and the next by two,
 * which reads as judder. Rendering at `alpha` between steps smooths that out.
 *
 * Defensive clamping matters because the paused single-step drain can leave the
 * accumulator negative (it is zeroed mid-step and then decremented), and a long
 * stall can leave it above one step before the spiral-of-death clamp runs.
 */
export function renderInterpolationAlpha(accumulatorMs: number, stepMs: number): number {
  if (!Number.isFinite(accumulatorMs) || !Number.isFinite(stepMs) || stepMs <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, accumulatorMs / stepMs));
}

/**
 * Advances a fixed-step position by `alpha` of its per-step velocity, matching
 * the render-side extrapolation `PhaserBridge.sync` applies to every entity
 * sprite (`position + velocity * interpAlpha`). The camera must use the exact
 * same expression for the player, otherwise the interpolated player sprite
 * would slide against a step-quantized camera.
 */
export function extrapolateRenderPosition(
  position: number,
  velocityPerStep: number,
  alpha: number,
): number {
  return position + velocityPerStep * alpha;
}
