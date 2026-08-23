import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { GameWorld } from '../../src/core/index.js';
import {
  buildDirtyRectFromPixelBounds,
  createLightField,
  type LightFieldDirtyRect,
} from '../../src/engine/lighting/light-field.js';
import {
  areLightingRectsEqual,
  formatAbilityTrigger,
  getLightingViewRect,
  LIGHTING_VIEW_BUFFER_PX,
  resolveDialogueLines,
  resolveNpcQuestIndicatorState,
} from '../../src/engine/scenes/main-game-scene-helpers.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import {
  getNpcDef,
  selectTutorialGoonDialogue,
  SHOPKEEPER_DONE_DIALOGUE,
  SHOPKEEPER_EQUIP_HINT_DIALOGUE,
  SHOPKEEPER_LOCKED_DIALOGUE,
  SHOPKEEPER_RETURN_DIALOGUE,
  SHOPKEEPER_SHOP_DIALOGUE,
  selectSpellBrokerDialogue,
} from '../../src/shared/npc-types.js';
import { FLOOR1_LEAVE_FLOOR_QUEST_ID, type ShopkeeperStage } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Unit coverage for the pure helpers lifted out of {@link MainGameScene}. These
 * were previously `private` methods reading `this.*`; the tests pin the exact
 * behavior so the decomposition is provably behavior-preserving.
 */

/** A test world with a fully-initialized Floor 1 scenario (real objective state). */
function freshFloor1World(): GameWorld {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  return world;
}

const rectArb = fc.record({
  minX: fc.integer({ min: -50, max: 50 }),
  minY: fc.integer({ min: -50, max: 50 }),
  maxX: fc.integer({ min: -50, max: 50 }),
  maxY: fc.integer({ min: -50, max: 50 }),
});

describe('areLightingRectsEqual', () => {
  it('is reflexive', () => {
    fc.assert(
      fc.property(rectArb, (r) => {
        expect(areLightingRectsEqual(r, r)).toBe(true);
      }),
    );
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(rectArb, rectArb, (a, b) => {
        expect(areLightingRectsEqual(a, b)).toBe(areLightingRectsEqual(b, a));
      }),
    );
  });

  it('is true exactly when all four components are equal', () => {
    fc.assert(
      fc.property(rectArb, rectArb, (a, b) => {
        const componentwise =
          a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
        expect(areLightingRectsEqual(a, b)).toBe(componentwise);
      }),
    );
  });

  it('flips to false when any single component differs', () => {
    const base: LightFieldDirtyRect = { minX: 1, minY: 2, maxX: 3, maxY: 4 };
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) {
      const mutated = { ...base, [key]: base[key] + 1 };
      expect(areLightingRectsEqual(base, mutated)).toBe(false);
    }
  });
});

describe('getLightingViewRect', () => {
  const field = createLightField(800, 600, 16);

  it('pads the camera view by LIGHTING_VIEW_BUFFER_PX before clamping to cells', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -200, max: 700 }),
        fc.integer({ min: -200, max: 500 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (x, y, w, h) => {
          const worldView = { x, y, right: x + w, bottom: y + h };
          expect(getLightingViewRect(field, worldView)).toEqual(
            buildDirtyRectFromPixelBounds(
              field,
              x - LIGHTING_VIEW_BUFFER_PX,
              y - LIGHTING_VIEW_BUFFER_PX,
              x + w + LIGHTING_VIEW_BUFFER_PX,
              y + h + LIGHTING_VIEW_BUFFER_PX,
            ),
          );
        },
      ),
    );
  });

  it('matches a hand-computed rect for an interior view', () => {
    // view 100..300 x 80..240; +/-64 buffer -> px 36..364 x 16..304; /16 -> cells.
    expect(getLightingViewRect(field, { x: 100, y: 80, right: 300, bottom: 240 })).toEqual({
      minX: 2,
      minY: 1,
      maxX: 22,
      maxY: 19,
    });
  });
});

describe('resolveNpcQuestIndicatorState', () => {
  it('delegates to the matching controller and threads the world through', () => {
    const world = createTestWorld();
    const tutorialGoon = { getIndicatorState: vi.fn().mockReturnValue('actionable' as const) };
    const shopkeeper = { getIndicatorState: vi.fn().mockReturnValue('accepted' as const) };
    const spellQuestGiver = { getIndicatorState: vi.fn().mockReturnValue('actionable' as const) };
    const controllers = { tutorialGoon, shopkeeper, spellQuestGiver };

    expect(resolveNpcQuestIndicatorState('tutorial-goon', world, controllers)).toBe('actionable');
    expect(resolveNpcQuestIndicatorState('shopkeeper', world, controllers)).toBe('accepted');
    expect(resolveNpcQuestIndicatorState('spell-quest-giver', world, controllers)).toBe(
      'actionable',
    );
    expect(tutorialGoon.getIndicatorState).toHaveBeenCalledWith(world);
    expect(shopkeeper.getIndicatorState).toHaveBeenCalledWith(world);
    expect(spellQuestGiver.getIndicatorState).toHaveBeenCalledWith(world);
  });

  it('returns "none" for unknown defs, absent controllers, and missing handlers', () => {
    const world = createTestWorld();
    expect(resolveNpcQuestIndicatorState('nobody', world, {})).toBe('none');
    expect(resolveNpcQuestIndicatorState('tutorial-goon', world, {})).toBe('none');
    expect(resolveNpcQuestIndicatorState('shopkeeper', world, { shopkeeper: {} })).toBe('none');
  });
});

describe('formatAbilityTrigger', () => {
  it('maps the known ability ids to their auto-trigger descriptions', () => {
    expect(formatAbilityTrigger('fireball')).toBe(
      'Auto: hits the nearest enemy, favoring clusters',
    );
    expect(formatAbilityTrigger('heal')).toBe('Auto: casts when HP deficit warrants it');
    expect(formatAbilityTrigger('pulse-shield')).toBe('Auto: casts at low HP when surrounded');
  });

  it('falls back to "Auto trigger" for any other id', () => {
    const known = new Set(['fireball', 'heal', 'pulse-shield']);
    fc.assert(
      fc.property(fc.string(), (id) => {
        fc.pre(!known.has(id));
        expect(formatAbilityTrigger(id)).toBe('Auto trigger');
      }),
    );
  });
});

describe('resolveDialogueLines', () => {
  const baseDeps = { shopkeeperJustReturned: false };

  it('returns an NPC def default dialogue when no controller intervenes', () => {
    const world = createTestWorld();
    const expected = getNpcDef('shopkeeper')!.dialogue.map((line) => line.text);
    expect(resolveDialogueLines('shopkeeper', world, baseDeps)).toEqual(expected);
  });

  it('prefers a per-instance dialogue override when one exists', () => {
    const world = createTestWorld();
    world.npcs.set(7, {
      defId: 'shopkeeper',
      dialogueIndex: 0,
      quests: [],
      dialogueOverride: ['Custom line 1', 'Custom line 2'],
      nearbyPlayer: true,
    });
    expect(resolveDialogueLines('shopkeeper', world, baseDeps, 7)).toEqual([
      'Custom line 1',
      'Custom line 2',
    ]);
  });

  it('returns an empty list for an unknown NPC', () => {
    const world = createTestWorld();
    expect(resolveDialogueLines('nobody', world, baseDeps)).toEqual([]);
  });

  it('mirrors selectTutorialGoonDialogue for the tutorial goon', () => {
    const world = freshFloor1World();
    const objective = world.floorScenario!.objective;
    const expected = selectTutorialGoonDialogue({
      bossDefeated: objective.bossBattles.get('staircase')?.defeated === true,
      leaveFloorAccepted: world.questLog.has(FLOOR1_LEAVE_FLOOR_QUEST_ID),
      goonGrindComplete: world.goalFlags.get('floor1-goon-quest-complete') === true,
      merchantErrandComplete: world.goalFlags.get('floor1-shop-quest-complete') === true,
      spellBrokerComplete: world.goalFlags.get('floor1-boss-battle-complete') === true,
    });
    const result = resolveDialogueLines('tutorial-goon', world, baseDeps);
    if (expected) {
      expect(result).toEqual([...expected]);
    } else {
      expect(result).toEqual(getNpcDef('tutorial-goon')!.dialogue.map((line) => line.text));
    }
  });

  it('walks the shopkeeper stage machine', () => {
    const world = createTestWorld();
    const make = (stage: ShopkeeperStage, isLocked = false) => ({
      shopkeeper: {
        isLocked: () => isLocked,
        getStage: () => stage,
      },
      shopkeeperJustReturned: false,
    });

    expect(resolveDialogueLines('shopkeeper', world, make('ready-to-buy', true))).toEqual([
      ...SHOPKEEPER_LOCKED_DIALOGUE,
    ]);
    expect(resolveDialogueLines('shopkeeper', world, make('complete'))).toEqual([
      ...SHOPKEEPER_DONE_DIALOGUE,
    ]);
    expect(resolveDialogueLines('shopkeeper', world, make('awaiting-equip'))).toEqual([
      ...SHOPKEEPER_EQUIP_HINT_DIALOGUE,
    ]);
    expect(resolveDialogueLines('shopkeeper', world, make('ready-to-buy'))).toEqual([
      ...SHOPKEEPER_SHOP_DIALOGUE,
    ]);
  });

  it('uses the returning-customer greeting once the errand was just returned', () => {
    const world = createTestWorld();
    const deps = {
      shopkeeper: { isLocked: () => false, getStage: () => 'ready-to-buy' as never },
      shopkeeperJustReturned: true,
    };
    expect(resolveDialogueLines('shopkeeper', world, deps)).toEqual([
      ...SHOPKEEPER_RETURN_DIALOGUE,
    ]);
  });

  it('returns the locked line for a gated spell quest giver', () => {
    const world = createTestWorld();
    const deps = { spellQuestGiver: { isLocked: () => true }, shopkeeperJustReturned: false };
    expect(resolveDialogueLines('spell-quest-giver', world, deps)).toEqual([
      ...selectSpellBrokerDialogue({ locked: true, spellbookClaimed: false })!,
    ]);
  });

  it('returns the spell broker post-claim line once the spellbook is claimed', () => {
    const world = createTestWorld();
    world.goalFlags.set('floor1-boss-spellbook-claimed', true);
    world.featureUnlocks.spells = true;
    const deps = { spellQuestGiver: { isLocked: () => false }, shopkeeperJustReturned: false };
    expect(resolveDialogueLines('spell-quest-giver', world, deps)).toEqual([
      ...selectSpellBrokerDialogue({ locked: false, spellbookClaimed: true })!,
    ]);
  });

  it('keeps the authored spell broker intro until the spell unlock is actually live', () => {
    const world = createTestWorld();
    world.goalFlags.set('floor1-boss-spellbook-claimed', true);
    const deps = { spellQuestGiver: { isLocked: () => false }, shopkeeperJustReturned: false };
    expect(resolveDialogueLines('spell-quest-giver', world, deps)).toEqual(
      getNpcDef('spell-quest-giver')!.dialogue.map((line) => line.text),
    );
  });

  it('prefers the locked line over the post-claim line for the spell broker', () => {
    const world = createTestWorld();
    world.goalFlags.set('floor1-boss-spellbook-claimed', true);
    world.featureUnlocks.spells = true;
    const deps = { spellQuestGiver: { isLocked: () => true }, shopkeeperJustReturned: false };
    expect(resolveDialogueLines('spell-quest-giver', world, deps)).toEqual([
      ...selectSpellBrokerDialogue({ locked: true, spellbookClaimed: true })!,
    ]);
  });

  it('falls back to authored spell broker dialogue before the spellbook is claimed', () => {
    const world = createTestWorld();
    const deps = { spellQuestGiver: { isLocked: () => false }, shopkeeperJustReturned: false };
    expect(resolveDialogueLines('spell-quest-giver', world, deps)).toEqual(
      getNpcDef('spell-quest-giver')!.dialogue.map((line) => line.text),
    );
  });
});
