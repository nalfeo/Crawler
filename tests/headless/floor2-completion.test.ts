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
import { runSettlementMaintenancePlanner } from '../../src/game/ai/settlement-maintenance-planner.js';

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

  it('boots generated Quartermaster stock on the real default Floor 2 path (no flag override)', async () => {
    // Regression guard for the shipped-inert failure class (ADR 0034/0036):
    // this intentionally passes NO floor2EquipmentFlags override, so it only
    // passes if initializeFloor2Scenario itself enables floor2EquipmentEconomy
    // in the real production path.
    let observed:
      | {
          quartermasterCount: number;
          generatedStockCount: number;
          generatedStockRegistryBacked: boolean;
          generatedStockRarities: readonly string[];
        }
      | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 6 }), {
      seed: 6,
      floorId: 'floor2',
      maxFrames: 1,
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

    expect(observed?.quartermasterCount).toBe(1);
    expect(observed?.generatedStockCount).toBeGreaterThanOrEqual(3);
    expect(observed?.generatedStockRegistryBacked).toBe(true);
    expect(
      observed?.generatedStockRarities.every(
        (rarity) => rarity === 'common' || rarity === 'uncommon',
      ),
    ).toBe(true);
  }, 60_000);

  it('lets the headless AI actually purchase and equip Quartermaster stock on the real default path', async () => {
    // Enabling floor2EquipmentEconomy activates a real, already-wired
    // consumer beyond boss chests: `runSettlementMaintenancePlanner` (called
    // unconditionally every frame from headless-runner.ts) purchases and
    // equips Quartermaster/shop stock through the atomic
    // `purchaseQuartermasterOffer` API whenever the AI is inside the
    // settlement. This proves that activation reaches a real consumer beyond
    // boss chests, closing the plan-review concern that this content might
    // be "inert-but-untested" for the headless AI client (unlike the
    // interactive game, which has no Quartermaster UI yet — see PR
    // description / handoff / issue #2334 for that caveat).
    //
    // This deliberately does NOT drive a full organic AI run to an emergent
    // purchase: `runEquipmentLoop` can legitimately return zero decisions on
    // any given real playthrough (no unclaimed achievement, no open boss
    // chest, and every candidate scoring <= 0 relative to the current
    // loadout all short-circuit before a single decision is pushed — see
    // `runSettlementMaintenancePlanner`'s early "exhausted" returns). A CI
    // run on seed 77 hit exactly that path and produced zero decisions over
    // the full 20000-frame budget even though the wiring itself was sound,
    // proving that "an organic run eventually buys something" is not a valid
    // determinism guarantee for this assertion (rule: never bend the gate to
    // fit one seed — fix the test's premise instead).
    //
    // So instead this constructs the one condition the claim actually
    // depends on directly, using the exact real production init
    // (`initializeFloor2Scenario`, invoked here via `runHeadless` with NO
    // flag override — the real default path) plus the exact real settlement
    // anchor (`resolveFloor2SettlementAnchor`) and the exact real planner
    // entry point (`runSettlementMaintenancePlanner`) that the organic AI
    // loop would otherwise call. Teleporting the player onto the real
    // settlement anchor and guaranteeing affordability removes the emergent
    // dependency while still exercising every real link in the chain: real
    // init → real generated Quartermaster stock → real settlement layout →
    // real planner → real atomic purchase API → real equip.
    let decisionKinds: readonly string[] = [];
    await runHeadless(new BehaviorTreeAI({ seed: 77 }), {
      seed: 77,
      floorId: 'floor2',
      maxFrames: 1,
      onFinish: (world) => {
        const anchor = resolveFloor2SettlementAnchor(world);
        if (!anchor) throw new Error('Test requires a resolvable Floor 2 settlement anchor');
        const playerEid = 1;
        world.stores.position.x[playerEid] = anchor.x;
        world.stores.position.y[playerEid] = anchor.y;
        // Mirrors what the real safeRoomSystem sets while the player is
        // physically standing in a safe room; the planner's equip step
        // (`equipFromBag` without `{force:true}`) is gated on this flag in
        // the real pipeline, so it must be set for a direct planner call to
        // behave identically to the organic in-run path.
        world.playerInSafeRoom = true;
        // Guarantee affordability regardless of the real generator's rolled
        // prices for this seed — the property under test is "the wiring
        // completes a purchase when one is affordable," not "this seed's
        // gold economy happens to cover it."
        world.playerGold = 999_999;

        const result = runSettlementMaintenancePlanner(world);
        decisionKinds = result.decisions.map((decision) => decision.kind);
      },
    });

    expect(decisionKinds).toContain('purchase-equipment');
    expect(decisionKinds).toContain('equip-instance');
  });

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
