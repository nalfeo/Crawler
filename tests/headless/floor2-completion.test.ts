import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import { setGoalFlag } from '../../src/core/door-lock.js';
import {
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
  FLOOR2_VICTORY_GOAL_ID,
} from '../../src/game/floor2Scenario.js';
import { resolveFloor2SettlementAnchor } from '../../src/core/floor2-settlement-anchor.js';
import { AIState } from '../../src/game/ai/types.js';
import { FLOOR2_QUARTERMASTER_ARCHETYPE_ID } from '../../src/shared/data/shop-archetypes.js';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';

describe('Floor 2 headless completion', () => {
  it('starts direct Floor 2 headless runs at level 5 with the charm equipped', async () => {
    let observedLevel = -1;
    let observedUnspent = -1;
    let observedCharmId: string | undefined;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 91 }), {
      seed: 91,
      floorId: 'floor2',
      maxFrames: 1,
      onFinish: (world) => {
        observedLevel = world.playerLevel.level;
        observedUnspent = world.playerLevel.unspentPoints;
        const playerEid = 1;
        const equipment = getEquipmentState(world, playerEid);
        const neckInstanceId = equipment?.equipped.neck ?? null;
        observedCharmId =
          neckInstanceId === null ? undefined : equipment?.instances.get(neckInstanceId)?.def.id;
      },
    });

    expect(observedLevel).toBe(5);
    expect(observedUnspent).toBe(0);
    expect(observedCharmId).toBe(MERCHANTS_CHARM_DEF.id);
    expect(Object.keys(stats.familyTrashKills ?? {}).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(stats.familyTrashKills ?? {}).length).toBeLessThanOrEqual(4);
    expect(Object.values(stats.familyTrashKills ?? {}).every((count) => count === 0)).toBe(true);
  });

  it('uses the settlement as the first real headless Floor 2 progression target', async () => {
    const ai = new BehaviorTreeAI({ seed: 92 });
    let settlementAnchor: { x: number; y: number } | null = null;
    let settlementFound = true;

    await runHeadless(ai, {
      seed: 92,
      floorId: 'floor2',
      maxFrames: 1,
      onFinish: (world) => {
        settlementAnchor = resolveFloor2SettlementAnchor(world);
        settlementFound = world.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID) === true;
      },
    });

    expect(settlementFound).toBe(false);
    expect(settlementAnchor).not.toBeNull();
    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: -1,
      targetX: settlementAnchor!.x,
      targetY: settlementAnchor!.y,
      reason: 'Heading to the Floor 2 settlement',
    });
  });

  it('boots generated Quartermaster stock when the economy is explicitly enabled', async () => {
    const cases = [
      { seed: 6, expectedRooms: 2, expectedShops: 3 },
      { seed: 1, expectedRooms: 3, expectedShops: 3 },
    ] as const;

    for (const { seed, expectedRooms, expectedShops } of cases) {
      let observed:
        | {
            roomCount: number;
            shopIds: readonly string[];
            quartermasterCount: number;
            generatedStockCount: number;
            generatedStockRegistryBacked: boolean;
            generatedStockRarities: readonly string[];
          }
        | undefined;
      await runHeadless(new BehaviorTreeAI({ seed }), {
        seed,
        floorId: 'floor2',
        maxFrames: 1,
        floor2EquipmentFlags: {
          floor2EquipmentRegistry: true,
          floor2EquipmentCatalog: true,
          floor2EquipmentEconomy: true,
        },
        onFinish: (world) => {
          const settlement = world.floorExtendedState?.settlement;
          const allShops = [
            ...(settlement?.quartermasterShop ? [settlement.quartermasterShop] : []),
            ...(settlement?.shops ?? []),
          ];
          const generatedInstanceIds = new Set(
            listGeneratedEquipmentInstances(world).map((instance) => instance.instanceId),
          );
          const generatedOffers = settlement?.quartermasterStock?.offers ?? [];
          observed = {
            roomCount: settlement?.settlementRoomIds.length ?? 0,
            shopIds: allShops.map((shop) => shop.archetypeId),
            quartermasterCount: allShops.filter(
              (shop) => shop.archetypeId === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
            ).length,
            generatedStockCount: generatedOffers.length,
            generatedStockRegistryBacked: generatedOffers.every((offer) =>
              generatedInstanceIds.has(offer.instanceId),
            ),
            generatedStockRarities: generatedOffers.map((offer) => offer.rarity),
          };
        },
      });

      expect(observed).toMatchObject({
        roomCount: expectedRooms,
        quartermasterCount: 1,
      });
      expect(observed?.shopIds).toHaveLength(expectedShops);
      expect(observed?.generatedStockCount).toBeGreaterThanOrEqual(3);
      expect(observed?.generatedStockCount).toBeLessThanOrEqual(4);
      expect(observed?.generatedStockRegistryBacked).toBe(true);
      expect(observed?.generatedStockRarities).toEqual(
        expect.arrayContaining(['common', 'uncommon']),
      );
      expect(
        observed?.generatedStockRarities.every(
          (rarity) => rarity === 'common' || rarity === 'uncommon',
        ),
      ).toBe(true);
      expect(
        observed?.shopIds.filter(
          (archetypeId) => archetypeId !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
        ),
      ).toHaveLength(expectedShops - 1);
    }
  }, 180_000);

  it('exercises floor 2 den-progress and boss-targeting flow without win gating', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 77 }), {
      seed: 77,
      floorId: 'floor2',
      maxFrames: 20000,
    });

    expect(['victory', 'timeout', 'death']).toContain(stats.outcome);
    expect(stats.aiTelemetry?.decisionStateCounts.ENGAGE ?? 0).toBeGreaterThan(0);
    expect(stats.aiTelemetry?.decisionStateCounts.EXPLORE ?? 0).toBeGreaterThan(0);
    expect(
      Object.keys(stats.quests.questLogAccepts).some((questId) =>
        questId.startsWith('floor2-den-'),
      ),
    ).toBe(true);
    expect(stats.familyTrashKills).toBeDefined();
  }, 300_000);

  it('does not treat floor2-victory alone as headless completion before exit', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 123 }), {
      seed: 123,
      floorId: 'floor2',
      maxFrames: 1,
      simulationOptions: {
        postSystems: [
          (world) => {
            setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, true);
          },
        ],
      },
    });

    expect(stats.outcome).toBe('timeout');
  });

  it('confirms Floor 2 stairs headlessly once the exit is reachable', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 124 }), {
      seed: 124,
      floorId: 'floor2',
      maxFrames: 1,
      simulationOptions: {
        postSystems: [
          (world) => {
            const floor2State = world.floorExtendedState?.familyState;
            if (!floor2State) {
              return;
            }
            const playerEid = 1;
            floor2State.staircaseUnlocked = true;
            floor2State.staircaseSpawned = true;
            floor2State.staircasePos = {
              x: world.stores.position.x[playerEid] ?? 0,
              y: world.stores.position.y[playerEid] ?? 0,
            };
            setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, true);
          },
        ],
      },
    });

    expect(stats.outcome).toBe('victory');
  });
});
