import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import {
  addGeneratedEquipmentToBag,
  equipFromBag,
  getEquipmentState,
} from '../../src/core/systems/equipmentSystem.js';
import {
  createGeneratedEquipmentInstance,
  listGeneratedEquipmentInstances,
} from '../../src/core/generated-equipment-registry.js';
import type { GameWorld } from '../../src/core/world.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import { setGoalFlag } from '../../src/core/door-lock.js';
import {
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
  FLOOR2_VICTORY_GOAL_ID,
} from '../../src/game/floor2Scenario.js';
import { resolveFloor2SettlementAnchor } from '../../src/core/floor2-settlement-anchor.js';
import { AIState } from '../../src/game/ai/types.js';
import { FLOOR2_QUARTERMASTER_ARCHETYPE_ID } from '../../src/shared/data/shop-archetypes.js';
import { runSettlementMaintenancePlanner } from '../../src/game/ai/settlement-maintenance-planner.js';
import type { Floor2QuartermasterStockState } from '../../src/shared/floor-types.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type GeneratedEquipmentInstanceKey,
} from '../../src/shared/generated-equipment-types.js';

const PLAYABILITY_TEST_UNIT_PRICE = 123;
const PLAYABILITY_TEST_STOCK_ID = 'playability-test-stock';
const PLAYABILITY_TEST_OFFER_ID = 'playability-test-offer';

function createPlayabilityTestInstance(
  world: Parameters<typeof createGeneratedEquipmentInstance>[0],
) {
  return createGeneratedEquipmentInstance(world, {
    baseId: 'armor.playability-test-helm',
    itemLevel: 3,
    rarity: 'common',
    enhancementLevel: 0,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Playability Test Helm',
      artKey: 'equipment.playability-test-helm',
      slots: ['head'],
      tags: ['armor'],
      weightLb: 1,
      statBonuses: { armor: 1 },
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  });
}

function replaceQuartermasterStockWithSoldOffer(
  world: GameWorld,
  instanceId: GeneratedEquipmentInstanceKey,
): void {
  const settlement = world.floorExtendedState?.settlement;
  if (!settlement) {
    throw new Error('Test requires a Floor 2 settlement snapshot');
  }
  const quartermasterStock: Floor2QuartermasterStockState = {
    stockId: PLAYABILITY_TEST_STOCK_ID,
    restockEpoch: 0,
    offers: [
      {
        offerId: PLAYABILITY_TEST_OFFER_ID,
        instanceId,
        rarity: 'common',
        unitPrice: PLAYABILITY_TEST_UNIT_PRICE,
        quantity: 0,
      },
    ],
    retiredInstanceIds: [],
  };
  world.floorExtendedState = {
    ...world.floorExtendedState,
    settlement: {
      ...settlement,
      quartermasterStock,
    },
  };
}

function clearPlayabilityRewardState(world: GameWorld): void {
  world.achievements.unlockedIds.clear();
  world.achievements.pendingPresentations.clear();
  world.bossChests.clear();
}

function formatEquipFailureReason(reason: { readonly type: string }): string {
  if ('message' in reason && typeof reason.message === 'string') {
    return reason.message;
  }
  if ('instanceKey' in reason && typeof reason.instanceKey === 'string') {
    return `${reason.type}: ${reason.instanceKey}`;
  }
  if ('slotId' in reason && typeof reason.slotId === 'string') {
    return `${reason.type}: ${reason.slotId}`;
  }
  return reason.type;
}

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
    // Enabling floor2EquipmentEconomy activates a real, already-wired data
    // consumer beyond boss chests: real Quartermaster/shop stock is
    // generated during settlement init. Whether the AI *acts* on that stock
    // is gated by a separate flag, `floor2EquipmentAiMaintenance`. This is
    // now enabled by `initializeFloor2Scenario` (the real shipped path)
    // alongside the other four equipment flags, specifically so that this
    // consumer is genuinely live rather than "shipped inert" (the ADR
    // 0034/0036 failure class this whole PR exists to eliminate) — an
    // earlier revision of this fix left `floor2EquipmentAiMaintenance` off
    // by default and only overrode it inside this test, which reproduced
    // that exact failure class one layer down; see the PR discussion / this
    // handoff's "Post-open-PR CI fix" section for the full story. There is
    // still no interactive-game equivalent consumer (no Quartermaster
    // purchase UI — see issue #2334); this flag only affects AI-controlled
    // runs (headless completion tests, win-rate sweeps).
    //
    // This test proves the purchase MECHANISM itself is real and reachable
    // through the real production wiring on the real default path: real
    // init (`initializeFloor2Scenario`, no flag override) → real generated
    // Quartermaster stock → real settlement layout → real planner
    // (`runSettlementMaintenancePlanner`) → real atomic purchase API → real
    // equip. It deliberately does NOT drive a full organic AI run to an
    // emergent purchase: `runEquipmentLoop` can legitimately return zero
    // decisions on any given real playthrough even with AI maintenance
    // enabled (no unclaimed achievement, no open boss chest, and every
    // equipment candidate scoring <= 0 relative to the current loadout all
    // short-circuit before a single decision is pushed). An earlier version
    // of this test asserted `decisionKinds.length > 0` after a full organic
    // 20000-frame run; CI's `ubuntu-latest` runner hit exactly that
    // legitimate empty branch on seed 77 and produced zero decisions even
    // though the wiring was sound, proving "an organic run eventually buys
    // something" is not a valid determinism guarantee (rule: never bend the
    // gate to fit one seed/run — fix the test's premise instead). So instead
    // this constructs the one condition the claim actually depends on
    // directly, using the exact real settlement anchor
    // (`resolveFloor2SettlementAnchor`) and the exact real planner entry
    // point that the organic AI loop would otherwise call.
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
        // completes a purchase when one is affordable and evaluation-positive,"
        // not "this seed's gold economy or price tier happens to cover it."
        // Setting playerGold ensures the preparePurchase affordability gate
        // passes; setting unitPrice to 1g ensures the evaluator's purchaseCost
        // component is negligible so stat-gain always dominates (score > 0).
        // Both are needed: playerGold alone doesn't prevent the evaluator from
        // rejecting items when tier pricing (e.g. floor2TierMultiplier) raises
        // costs above the stat-gain magnitude.
        world.playerGold = 999_999;
        const settlement = world.floorExtendedState?.settlement;
        const stock = settlement?.quartermasterStock;
        if (settlement && stock) {
          world.floorExtendedState = {
            ...world.floorExtendedState!,
            settlement: {
              ...settlement,
              quartermasterStock: Object.freeze({
                ...stock,
                offers: Object.freeze(
                  stock.offers.map((offer) => Object.freeze({ ...offer, unitPrice: 1 })),
                ),
              }),
            },
          };
        }

        const result = runSettlementMaintenancePlanner(world);
        decisionKinds = result.decisions.map((decision) => decision.kind);
      },
    });

    expect(decisionKinds).toContain('purchase-equipment');
    expect(decisionKinds).toContain('equip-instance');
  });

  it('converts sold Quartermaster stock with no generated gear into a real headless invariant error', async () => {
    let postFrameCount = 0;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 211 }), {
      seed: 211,
      floorId: 'floor2',
      maxFrames: 2,
      settlementReturnRouting: true,
      simulationOptions: {
        postSystems: [
          (world) => {
            postFrameCount += 1;
            if (postFrameCount !== 2) return;
            clearPlayabilityRewardState(world);
            const generated = createPlayabilityTestInstance(world);
            replaceQuartermasterStockWithSoldOffer(world, generated.instanceId);
          },
        ],
      },
    });

    expect(stats.outcome).toBe('error');
    expect(stats.error).toContain('Headless playability invariant failed:');
    expect(stats.error).toContain(
      `Spent ${PLAYABILITY_TEST_UNIT_PRICE} gold on equipment but ended with no generated equipment bagged or equipped`,
    );
    expect(stats.equipmentPlayability).toMatchObject({
      goldSpentOnEquipment: PLAYABILITY_TEST_UNIT_PRICE,
      baggedGeneratedCount: 0,
      equippedGeneratedCount: 0,
    });
  });

  it('converts unopened Floor 2 rewards into a real headless invariant error', async () => {
    let armed = false;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 212 }), {
      seed: 212,
      floorId: 'floor2',
      maxFrames: 1,
      settlementReturnRouting: true,
      simulationOptions: {
        postSystems: [
          (world) => {
            if (armed) return;
            armed = true;
            clearPlayabilityRewardState(world);
            world.achievements.unlockedIds.add('playability-test-achievement');
          },
        ],
      },
    });

    expect(stats.outcome).toBe('error');
    expect(stats.error).toContain('Headless playability invariant failed:');
    expect(stats.error).toContain('Run ended with 1 unopened reward boxes');
    expect(stats.equipmentPlayability).toMatchObject({
      unopenedRewardBoxes: 1,
    });
  });

  it('converts bagged generated gear with an empty matching slot into a real headless invariant error', async () => {
    let armed = false;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 213 }), {
      seed: 213,
      floorId: 'floor2',
      maxFrames: 1,
      settlementReturnRouting: true,
      simulationOptions: {
        postSystems: [
          (world) => {
            if (armed) return;
            armed = true;
            clearPlayabilityRewardState(world);
            // Mainline eager maintenance now auto-equips better bagged gear each
            // tick. Disable just that loop here so the fixture can still assert
            // the deliberate "bagged gear left while slot is empty" invariant.
            world.floor2EquipmentFlags.floor2EquipmentAiMaintenance = false;
            const generated = createPlayabilityTestInstance(world);
            const result = addGeneratedEquipmentToBag(world, 1, generated.instanceId);
            if (!result.ok) {
              throw new Error(
                `Failed to seed generated gear: ${formatEquipFailureReason(result.reason)}`,
              );
            }
          },
        ],
      },
    });

    expect(stats.outcome).toBe('error');
    expect(stats.error).toContain('Headless playability invariant failed:');
    expect(stats.error).toContain(
      '1 generated items remained bagged while a matching slot stayed empty',
    );
    expect(stats.equipmentPlayability).toMatchObject({
      baggedGeneratedCount: 1,
      unequippedWithEmptySlotCount: 1,
    });
  });

  it('scopes the playability invariant off when settlement return routing stays disabled', async () => {
    let postFrameCount = 0;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 214 }), {
      seed: 214,
      floorId: 'floor2',
      maxFrames: 2,
      simulationOptions: {
        postSystems: [
          (world) => {
            postFrameCount += 1;
            if (postFrameCount !== 2) return;
            clearPlayabilityRewardState(world);
            const generated = createPlayabilityTestInstance(world);
            replaceQuartermasterStockWithSoldOffer(world, generated.instanceId);
          },
        ],
      },
    });

    expect(stats.outcome).toBe('timeout');
    expect(stats.error).toBeUndefined();
    expect(stats.equipmentPlayability).toMatchObject({
      goldSpentOnEquipment: PLAYABILITY_TEST_UNIT_PRICE,
    });
  });

  it('returns normal Floor 2 RunStats when the synthetic Quartermaster purchase ends equipped', async () => {
    let postFrameCount = 0;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 215 }), {
      seed: 215,
      floorId: 'floor2',
      maxFrames: 2,
      settlementReturnRouting: true,
      simulationOptions: {
        postSystems: [
          (world) => {
            postFrameCount += 1;
            if (postFrameCount !== 2) return;
            clearPlayabilityRewardState(world);
            const generated = createPlayabilityTestInstance(world);
            replaceQuartermasterStockWithSoldOffer(world, generated.instanceId);
            const addResult = addGeneratedEquipmentToBag(world, 1, generated.instanceId);
            if (!addResult.ok) {
              throw new Error(
                `Failed to seed generated gear: ${formatEquipFailureReason(addResult.reason)}`,
              );
            }
            const equipResult = equipFromBag(
              world,
              1,
              { kind: 'generated-instance', instanceKey: generated.instanceId },
              { force: true },
            );
            if (!equipResult.ok) {
              throw new Error(
                `Failed to equip generated gear: ${equipResult.reasons.map(formatEquipFailureReason).join(', ')}`,
              );
            }
          },
        ],
      },
    });

    expect(stats.outcome).toBe('timeout');
    expect(stats.error).toBeUndefined();
    expect(stats.equipmentPlayability).toMatchObject({
      goldSpentOnEquipment: PLAYABILITY_TEST_UNIT_PRICE,
      baggedGeneratedCount: 0,
      equippedGeneratedCount: 1,
      unopenedRewardBoxes: 0,
      unequippedWithEmptySlotCount: 0,
    });
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
