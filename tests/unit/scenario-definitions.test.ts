import { describe, expect, it, vi } from 'vitest';
import {
  getScenarioDefinition,
  getScenarioPresentationContract,
  isFloorPlayable,
  type ScenarioDefinition,
} from '../../src/game/scenarioDefinitions.js';
import {
  selectScenarioCompletionVariant,
  type ScenarioCompletionVariant,
  type ScenarioRunOutcome,
} from '../../src/shared/scenario-presentation.js';
import * as floorRegistry from '../../src/shared/floor-registry.js';
import { isFloorImplemented } from '../../src/shared/floor-registry.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { asFamilyId, asResourceId } from '../../src/core/faction-relations.js';
import {
  confirmFloor1StairDescend,
  initializeFloor1Scenario,
} from '../../src/game/floorScenario.js';
import { confirmFloor2StairDescend } from '../../src/game/floor2Scenario.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT } from '../../src/shared/constants.js';
import {
  FLOOR3_STAIRS_DISCOVERED_GOAL_ID,
  FLOOR3_TIMEOUT_GOAL_ID,
} from '../../src/game/floor3Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('scenario definitions', () => {
  it('returns floor1 scenario with loadout selector', () => {
    const scenario = getScenarioDefinition('floor1');
    expect(typeof scenario.configureWorld).toBe('function');
    expect(typeof scenario.selectLoadoutOption).toBe('function');
    expect(scenario.director.intro.length).toBeGreaterThan(0);
  });

  it('returns floor2 scenario with director copy', () => {
    const scenario = getScenarioDefinition('floor2');
    expect(typeof scenario.configureWorld).toBe('function');
    expect(scenario.selectLoadoutOption).toBeUndefined();
    expect(scenario.director.victory).toContain('Floor 2');
  });

  it('chains floor2 into floor3 instead of ending the run', () => {
    // "Beating Floor 2 starts Floor 3": the scenario contract is the single
    // place that decides this — `createFloorMainSceneOptions` builds the
    // in-process transition callback from `nextFloorId`, and the completion
    // screen picks its variant from `nextFloorId` + `isTerminalRunVictory`.
    const floor2 = getScenarioDefinition('floor2');
    expect(floor2.nextFloorId).toBe('floor3');
    expect(floor2.isTerminalRunVictory).toBe(false);
    expect(floor2.stairConfirmation?.confirmDescription).toContain('Floor 3');
    // Floor 3 is the last authored floor, so it must not advertise a next one.
    expect(getScenarioDefinition('floor3').nextFloorId).toBeUndefined();
  });

  it('marks every registered floor playable, and only winnable floors implemented', () => {
    for (const floorId of ['floor1', 'floor2', 'floor3'] as const) {
      expect(isFloorPlayable(floorId)).toBe(true);
    }
    expect(isFloorPlayable('floor-does-not-exist')).toBe(false);
    // Floor 3 is playable but has no attainable victory yet, so it must stay
    // OUT of the implemented (sweepable/winnable) set.
    expect(isFloorImplemented('floor3')).toBe(false);
  });

  it('returns floor3 scenario with the biome-overworld director copy', () => {
    const scenario = getScenarioDefinition('floor3');
    expect(typeof scenario.configureWorld).toBe('function');
    // Floor 3 now pauses on a starter-Companion pick (spec R5 §6.1), mirroring
    // Floor 1's weapon loadout, so it must expose a loadout selector too.
    expect(typeof scenario.selectLoadoutOption).toBe('function');
    expect(scenario.director.intro).toContain('wilds');
    expect(scenario.director.victory).toContain('Final Four');
    expect(scenario.isTerminalRunVictory).toBe(true);
  });

  it('throws when a manifest exists but no scenario is registered', () => {
    const realGetFloorManifest = floorRegistry.getFloorManifest;
    const floor2Manifest = realGetFloorManifest('floor2');
    expect(floor2Manifest).toBeDefined();
    const manifestSpy = vi
      .spyOn(floorRegistry, 'getFloorManifest')
      .mockImplementation((floorId) =>
        floorId === 'floor-test-unregistered'
          ? ({ ...floor2Manifest!, id: floorId, name: 'Floor Test Unregistered' } as never)
          : realGetFloorManifest(floorId),
      );

    expect(() => getScenarioDefinition('floor-test-unregistered')).toThrowError(
      /No scenario definition registered for floor manifest/,
    );
    manifestSpy.mockRestore();
  });

  describe('ordered Director milestones', () => {
    it('floor1 declares four stable, ordered milestone ids with non-empty copy', () => {
      const scenario = getScenarioDefinition('floor1');
      expect(scenario.director.milestones.map((m) => m.id)).toEqual([
        'floor1-quest-accepted',
        'floor1-quest-completed',
        'floor1-boss-battle-started',
        'floor1-boss-defeated',
      ]);
      for (const milestone of scenario.director.milestones) {
        expect(milestone.copy.length).toBeGreaterThan(0);
        expect(typeof milestone.isReached).toBe('function');
      }
    });

    it('floor2 declares no mid-run milestones today', () => {
      const scenario = getScenarioDefinition('floor2');
      expect(scenario.director.milestones).toEqual([]);
    });

    it('floor1 milestone predicates flip on as the real objective state advances', () => {
      const scenario = getScenarioDefinition('floor1');
      const world = createTestWorld({ seed: 42 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      const [questAccepted, questCompleted, bossStarted, bossDefeated] =
        scenario.director.milestones;

      expect(questAccepted!.isReached(world)).toBe(false);
      world.floorScenario!.objective.questAccepted = true;
      expect(questAccepted!.isReached(world)).toBe(true);

      expect(questCompleted!.isReached(world)).toBe(false);
      world.floorScenario!.objective.questCompleted = true;
      expect(questCompleted!.isReached(world)).toBe(true);

      expect(bossStarted!.isReached(world)).toBe(false);
      world.floorScenario!.objective.bossBattles.set('staircase', {
        started: true,
        bossEid: null,
        defeated: false,
        displayName: 'Test Boss',
      });
      expect(bossStarted!.isReached(world)).toBe(true);
      expect(bossDefeated!.isReached(world)).toBe(false);

      world.floorScenario!.objective.bossBattles.get('staircase')!.defeated = true;
      expect(bossDefeated!.isReached(world)).toBe(true);
    });
  });

  describe('canonical terminal outcome (sole completion-selection input)', () => {
    it('floor1 getRunOutcome mirrors the real stair-descend run summary', () => {
      const scenario = getScenarioDefinition('floor1');
      const world = createTestWorld({ seed: 42 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      expect(scenario.getRunOutcome(world)).toBeNull();

      const objective = world.floorScenario!.objective;
      objective.staircaseSpawned = true;
      objective.staircaseUnlocked = true;
      objective.staircaseLocked = false;
      world.state = 'playing';
      expect(confirmFloor1StairDescend(world, player)).toBe(true);

      expect(scenario.getRunOutcome(world)).toBe('cleared_floor');
    });

    it('floor2 getRunOutcome is null until staircaseDiscovered flips', () => {
      const scenario = getScenarioDefinition('floor2');
      const world = createTestWorld({ seed: 42 });
      spawnPlayer(world, 0, 0);
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [asFamilyId('rats')],
          contestedResource: asResourceId('cheese'),
          betrayerFlag: false,
        },
      };

      expect(scenario.getRunOutcome(world)).toBeNull();

      world.floorExtendedState.familyState!.staircaseDiscovered = true;
      expect(scenario.getRunOutcome(world)).toBe('cleared_floor');
    });

    it('floor3 reports its timer marker as a timeout outcome', () => {
      const scenario = getScenarioDefinition('floor3');
      const world = createTestWorld({ seed: 42, floor: 3 });

      expect(scenario.getRunOutcome(world)).toBeNull();
      world.goalFlags.set(FLOOR3_TIMEOUT_GOAL_ID, true);
      expect(scenario.getRunOutcome(world)).toBe('failed_timeout');
      expect(scenario.getCompletionCopy('failed_timeout')).toEqual({
        title: 'Game Over',
        subtitle: 'Floor 3 failed',
        body: 'The Companion League timer expired.\nRally your party and reach the objective faster.',
      });
    });

    it('floor3 reports cleared_floor once staircase discovery latches', () => {
      const scenario = getScenarioDefinition('floor3');
      const world = createTestWorld({ seed: 43, floor: 3 });
      expect(scenario.getRunOutcome(world)).toBeNull();
      world.goalFlags.set(FLOOR3_STAIRS_DISCOVERED_GOAL_ID, true);
      expect(scenario.getRunOutcome(world)).toBe('cleared_floor');
    });
  });

  describe('semantic stair marker/proximity', () => {
    it('floor1 stair marker reports null before scenario init and live state once initialized', () => {
      const scenario = getScenarioDefinition('floor1');
      const world = createTestWorld({ seed: 42 });
      expect(scenario.getStairMarkerState?.(world)).toBeNull();

      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      const objective = world.floorScenario!.objective;

      const hidden = scenario.getStairMarkerState!(world);
      expect(hidden).not.toBeNull();
      expect(hidden!.visible).toBe(false);
      // `locked` must track the same flag the descend confirmation enforces,
      // so the prompt is never offered for a descent that would be rejected.
      expect(objective.staircaseUnlocked).toBe(false);
      expect(hidden!.locked).toBe(true);
      expect(confirmFloor1StairDescend(world, player)).toBe(false);
      expect(hidden!.radiusFt).toBe(objective.markerRadiusFt);
      expect(hidden!.positionFt).toEqual(objective.staircasePos);
      // No Phaser/pixel/color/depth values leak into the semantic contract.
      expect(hidden).not.toHaveProperty('depth');
      expect(hidden).not.toHaveProperty('color');
      expect(hidden).not.toHaveProperty('fillColor');

      objective.staircaseSpawned = true;
      objective.staircaseDiscovered = false;
      expect(scenario.getStairMarkerState!(world)!.visible).toBe(true);
      objective.staircaseUnlocked = true;
      expect(scenario.getStairMarkerState!(world)!.locked).toBe(false);
      objective.staircaseDiscovered = true;
      expect(scenario.getStairMarkerState!(world)!.visible).toBe(false);
    });

    it('floor2 stair marker is null until the exit staircase position is set, uses the shared radius constant', () => {
      const scenario = getScenarioDefinition('floor2');
      const world = createTestWorld({ seed: 42 });
      const playerEid = spawnPlayer(world, 0, 0);
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [asFamilyId('rats')],
          contestedResource: asResourceId('cheese'),
          betrayerFlag: false,
        },
      };
      expect(scenario.getStairMarkerState?.(world)).toBeNull();

      world.floorExtendedState.familyState!.staircasePos = { x: 12, y: 34 };
      world.floorExtendedState.familyState!.staircaseSpawned = true;
      const marker = scenario.getStairMarkerState!(world);
      expect(marker).not.toBeNull();
      expect(marker!.positionFt).toEqual({ x: 12, y: 34 });
      expect(marker!.radiusFt).toBe(FLOOR2_STAIR_MARKER_RADIUS_FT);
      expect(marker!.visible).toBe(true);
      // Stairs spawned but not unlocked: `confirmFloor2StairDescend` would
      // reject, so the contract must report the exit as locked.
      expect(confirmFloor2StairDescend(world, playerEid)).toBe(false);
      expect(marker!.locked).toBe(true);

      world.floorExtendedState.familyState!.staircaseUnlocked = true;
      expect(scenario.getStairMarkerState!(world)!.locked).toBe(false);

      world.floorExtendedState.familyState!.staircaseDiscovered = true;
      expect(scenario.getStairMarkerState!(world)!.visible).toBe(false);
    });
  });

  describe('semantic stair-descend confirmation presentation', () => {
    it('floor1 and floor2 declare distinct, non-empty confirmation copy', () => {
      const floor1 = getScenarioDefinition('floor1').stairConfirmation;
      const floor2 = getScenarioDefinition('floor2').stairConfirmation;
      expect(floor1).toBeDefined();
      expect(floor2).toBeDefined();
      expect(floor1).not.toEqual(floor2);
      for (const copy of [floor1, floor2]) {
        expect(copy!.title.length).toBeGreaterThan(0);
        expect(copy!.subtitle.length).toBeGreaterThan(0);
        expect(copy!.body.length).toBeGreaterThan(0);
        expect(copy!.confirmLabel.length).toBeGreaterThan(0);
        expect(copy!.confirmDescription.length).toBeGreaterThan(0);
      }
    });
  });

  describe('completion variants/copy', () => {
    it('floor1 preserves the exact reachable completion copy (failed_timeout, transition_to_next_floor)', () => {
      const scenario = getScenarioDefinition('floor1');
      expect(scenario.getCompletionCopy('failed_timeout')).toEqual({
        title: 'Game Over',
        subtitle: 'Floor 1 failed',
        body: 'You ran out of time before reaching the stairs.\nTry again and move faster through objectives.',
      });
      expect(scenario.getCompletionCopy('transition_to_next_floor')).toEqual({
        title: 'Floor 1 Complete!',
        subtitle: 'Heading to Floor 2...',
        body: 'Prepare yourself for the next challenge!',
      });
    });

    it('floor2 announces the Floor 3 transition on its reachable completion variant', () => {
      // Floor 2 now declares `nextFloorId: 'floor3'`, so the variant the
      // shipped game reaches on a clear is the transition — the old
      // "you escaped the dungeon" terminal copy would lie about what happens
      // next.
      const scenario = getScenarioDefinition('floor2');
      expect(scenario.getCompletionCopy('transition_to_next_floor')).toEqual({
        title: 'Floor 2 Complete!',
        subtitle: 'Heading to Floor 3...',
        body: 'The Companion League wilds are waiting below!',
      });
      // Still total: a host that boots Floor 2 without a transition callback
      // (labs) genuinely ends the run there and must get non-victory-claiming
      // terminal copy.
      expect(scenario.getCompletionCopy('terminal_victory').title).toBe('Floor 2 Complete!');
    });

    it('every registered scenario returns copy for every completion variant (total mapping)', () => {
      const variants: ScenarioCompletionVariant[] = [
        'failed_timeout',
        'transition_to_next_floor',
        'terminal_victory',
        'terminal_complete',
      ];
      for (const floorId of ['floor1', 'floor2']) {
        const scenario = getScenarioDefinition(floorId);
        for (const variant of variants) {
          const copy = scenario.getCompletionCopy(variant);
          expect(copy.title.length).toBeGreaterThan(0);
          expect(copy.subtitle.length).toBeGreaterThan(0);
          expect(copy.body.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('selectScenarioCompletionVariant (pure, terminal-outcome-driven, no floorId branching)', () => {
    it('a null outcome never selects a variant, regardless of scenario shape', () => {
      expect(selectScenarioCompletionVariant(null, { nextFloorId: 'floor2' })).toBeNull();
      expect(selectScenarioCompletionVariant(null, { isTerminalRunVictory: true })).toBeNull();
    });

    it('failed_timeout always wins over nextFloorId/isTerminalRunVictory', () => {
      expect(
        selectScenarioCompletionVariant('failed_timeout', {
          nextFloorId: 'floor2',
          isTerminalRunVictory: true,
        }),
      ).toBe('failed_timeout');
    });

    it('a scenario with nextFloorId transitions regardless of isTerminalRunVictory', () => {
      expect(
        selectScenarioCompletionVariant('cleared_floor', {
          nextFloorId: 'floor2',
          isTerminalRunVictory: true,
        }),
      ).toBe('transition_to_next_floor');
    });

    it('matches the real floor1/floor2 registrations', () => {
      const outcome: ScenarioRunOutcome = 'cleared_floor';
      expect(selectScenarioCompletionVariant(outcome, getScenarioDefinition('floor1'))).toBe(
        'transition_to_next_floor',
      );
      expect(selectScenarioCompletionVariant(outcome, getScenarioDefinition('floor2'))).toBe(
        'transition_to_next_floor',
      );
    });

    /**
     * Synthetic third scenario — never registered in `SCENARIOS` — proving the
     * completion-variant selector generalizes beyond exactly two authored
     * floors and never consults floor identity, only the static
     * `nextFloorId`/`isTerminalRunVictory` shape plus the terminal outcome.
     */
    it('generalizes to a synthetic third scenario with no next floor and no terminal-victory flavor', () => {
      const syntheticFloor3: Pick<ScenarioDefinition, 'nextFloorId' | 'isTerminalRunVictory'> = {
        nextFloorId: undefined,
        isTerminalRunVictory: false,
      };
      expect(selectScenarioCompletionVariant('cleared_floor', syntheticFloor3)).toBe(
        'terminal_complete',
      );
      expect(selectScenarioCompletionVariant('failed_timeout', syntheticFloor3)).toBe(
        'failed_timeout',
      );
    });
  });

  describe('getScenarioPresentationContract (one normalized contract)', () => {
    it('projects exactly the presentation-relevant fields off a full scenario definition', () => {
      const scenario = getScenarioDefinition('floor1');
      const contract = getScenarioPresentationContract(scenario);
      expect(contract.director).toBe(scenario.director);
      expect(contract.getRunOutcome).toBe(scenario.getRunOutcome);
      expect(contract.isTerminalRunVictory).toBe(scenario.isTerminalRunVictory);
      expect(contract.getCompletionCopy).toBe(scenario.getCompletionCopy);
      expect(contract.getStairMarkerState).toBe(scenario.getStairMarkerState);
      expect(contract.stairConfirmation).toBe(scenario.stairConfirmation);
      expect(contract.nextFloorId).toBe(scenario.nextFloorId);
    });
  });
});
