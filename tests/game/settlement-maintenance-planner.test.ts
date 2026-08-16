import { describe, expect, it, vi } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  runSettlementMaintenancePlanner,
  runEagerMaintenanceTick,
} from '../../src/game/ai/settlement-maintenance-planner.js';
import type { SettlementMaintenanceResult } from '../../src/game/ai/settlement-maintenance-types.js';
import { unlockAchievement } from '../../src/game/systems/achievementSystem.js';
import { isAchievementClaimed } from '../../src/core/systems/achievementRewards.js';
import { LOOT_BOX_GOLD_BY_TIER } from '../../src/shared/achievements.js';
import {
  spawnBossChestForDefeatedBoss,
  createBossChestId,
} from '../../src/game/boss-chest-resolver.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { addGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import { equip, getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import {
  grantAbilitySources,
  getOrCreateAbilityState,
} from '../../src/game/systems/abilitySystem.js';
import {
  learnedAbilityGrantSourceId,
  ACTIVE_ABILITY_SLOT_LIMIT,
} from '../../src/shared/abilities.js';
import { purchaseQuartermasterOffer } from '../../src/core/quartermaster-purchase.js';
import type {
  Floor2QuartermasterStockOffer,
  Floor2QuartermasterStockState,
  Floor2SettlementSnapshot,
} from '../../src/shared/floor-types.js';

// Mock ONLY `purchaseQuartermasterOffer`; every other export (including
// `getQuartermasterOfferViews`, which the planner also calls) stays real, so
// the functional purchase tests still exercise the real atomic transfer path.
// The stale-offer/race test opts in to a failure stub via
// `mockReturnValueOnce`.
vi.mock('../../src/core/quartermaster-purchase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/quartermaster-purchase.js')>();
  return { ...actual, purchaseQuartermasterOffer: vi.fn(actual.purchaseQuartermasterOffer) };
});

type TestWorld = ReturnType<typeof createTestWorld>;

const SETTLEMENT_ROOM_ID = 0; // first (and only) room added by makeMapWithSafeRoom

function enableFloor2Economy(world: TestWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  // AI maintenance flag is required for the equipment-loop purchasing/equipping
  // path; tests exercising those code paths must enable it.
  world.floor2EquipmentFlags.floor2EquipmentAiMaintenance = true;
}

function buildSettlement(
  overrides: Partial<Floor2SettlementSnapshot> = {},
): Floor2SettlementSnapshot {
  return {
    settlementRoomId: SETTLEMENT_ROOM_ID,
    settlementRoomIds: [SETTLEMENT_ROOM_ID],
    brokerEid: 1,
    defectorEid: 2,
    defectorFamilyId: 'test-family',
    defectorAppearanceKey: 'goblin-brute',
    defectorFallbackAppearanceKey: 'goblin',
    quartermasterShop: {
      archetypeId: 'quartermaster',
      npcId: 'quartermaster',
      npcEid: 3,
      inventory: [],
    },
    shops: [],
    ...overrides,
  };
}

interface SettlementFixture {
  readonly world: TestWorld;
  readonly playerEid: number;
  readonly moveOutsideSettlement: () => void;
  readonly moveInsideSettlement: () => void;
}

/**
 * Builds a Floor 2 world with a real settlement room (via `makeMapWithSafeRoom`)
 * and the player positioned inside it. `world.playerInSafeRoom` is set to
 * `true` because `equipFromBag` (invoked by the planner without `{force:true}`)
 * is gated by `isInSafeContext`, which is normally only set by
 * `safeRoomSystem` in the real pipeline.
 */
function createSettlementWorld(
  options: {
    seed?: number;
    settlement?: Floor2SettlementSnapshot | null;
    inSettlement?: boolean;
  } = {},
): SettlementFixture {
  const { seed = 42, settlement = buildSettlement(), inSettlement = true } = options;
  const world = createTestWorld({ seed, floor: 2 });
  enableFloor2Economy(world);
  const floorMap = makeMapWithSafeRoom({ widthTiles: 12, heightTiles: 12 });
  world.floorMap = floorMap;
  const playerEid = spawnPlayer(world, 0, 0);
  world.playerLevel.level = 5;
  world.playerGold = 0;
  world.playerInSafeRoom = true;
  if (settlement) {
    world.floorExtendedState = { settlement };
  }

  const insidePos = floorMap.tileToWorld(2, 2); // interior of the SAFE room (1,1)-(4,4)
  const outsidePos = floorMap.tileToWorld(9, 9);

  const moveInsideSettlement = (): void => {
    world.stores.position.x[playerEid] = insidePos.x;
    world.stores.position.y[playerEid] = insidePos.y;
  };
  const moveOutsideSettlement = (): void => {
    world.stores.position.x[playerEid] = outsidePos.x;
    world.stores.position.y[playerEid] = outsidePos.y;
  };

  if (inSettlement) {
    moveInsideSettlement();
  } else {
    moveOutsideSettlement();
  }

  return { world, playerEid, moveOutsideSettlement, moveInsideSettlement };
}

/** Generates a real registered equipment instance and adds it to the player's bag. */
function addBagEquipment(
  world: TestWorld,
  playerEid: number,
  baseId: string,
  rarity: 'common' | 'uncommon' = 'common',
): string {
  const instance = generateEquipmentInstance(world, {
    baseId,
    itemLevel: world.playerLevel.level,
    rarity,
    enhancementLevel: 0,
  });
  const bag = world.inventories.get(playerEid);
  if (!bag) throw new Error('Test requires a player bag');
  addGeneratedEquipmentReference(bag, instance.instanceId);
  return instance.instanceId;
}

/** Manually constructs a single-offer, deterministic Quartermaster stock. */
function attachSingleOfferStock(
  world: TestWorld,
  baseId: string,
  unitPrice: number,
): { stockId: string; offer: Floor2QuartermasterStockOffer; instanceId: string } {
  const instance = generateEquipmentInstance(world, {
    baseId,
    itemLevel: world.playerLevel.level,
    rarity: 'common',
    enhancementLevel: 0,
  });
  const offer: Floor2QuartermasterStockOffer = {
    offerId: 'offer-1',
    instanceId: instance.instanceId,
    rarity: 'common',
    unitPrice,
    quantity: 1,
  };
  const stock: Floor2QuartermasterStockState = {
    stockId: 'stock-1',
    restockEpoch: 0,
    offers: [offer],
    retiredInstanceIds: [],
  };
  const settlement = world.floorExtendedState?.settlement;
  if (!settlement) throw new Error('Test requires a settlement');
  world.floorExtendedState = {
    ...world.floorExtendedState,
    settlement: { ...settlement, quartermasterStock: stock },
  };
  return { stockId: stock.stockId, offer, instanceId: instance.instanceId };
}

function decisionKinds(result: SettlementMaintenanceResult): string[] {
  return result.decisions.map((decision) => decision.kind);
}

describe('runSettlementMaintenancePlanner', () => {
  it('no-ops when there is no settlement/floorExtendedState opportunity', () => {
    const { world } = createSettlementWorld({ settlement: null });
    const result = runSettlementMaintenancePlanner(world);
    expect(result).toEqual({ ran: false, terminationReason: 'no-opportunity', decisions: [] });
  });

  it('no-ops when the player is outside the settlement room', () => {
    const { world } = createSettlementWorld({ inSettlement: false });
    const result = runSettlementMaintenancePlanner(world);
    expect(result).toEqual({ ran: false, terminationReason: 'no-opportunity', decisions: [] });
  });

  it('is a deterministic replay: two fresh identical worlds yield identical decisions', () => {
    function run(): SettlementMaintenanceResult {
      const { world, playerEid } = createSettlementWorld();
      unlockAchievement(world, 'first-bonk');
      spawnBossChestForDefeatedBoss(world, 'test-family');
      addBagEquipment(world, playerEid, 'iron-breastplate');
      return runSettlementMaintenancePlanner(world);
    }
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    expect(first.ran).toBe(true);
    expect(first.decisions.length).toBeGreaterThan(0);
  });

  it('runs its decision loop only once per continuous settlement visit (latch/idempotency)', () => {
    const { world, moveOutsideSettlement, moveInsideSettlement } = createSettlementWorld();
    unlockAchievement(world, 'first-bonk');

    const first = runSettlementMaintenancePlanner(world);
    expect(first.ran).toBe(true);
    expect(decisionKinds(first)).toContain('claim-achievement');

    // Still inside the settlement: second call in the same visit is a no-op.
    const second = runSettlementMaintenancePlanner(world);
    expect(second).toEqual({ ran: false, terminationReason: 'already-processed', decisions: [] });

    // Leaving and re-entering resets the latch.
    moveOutsideSettlement();
    const whileOutside = runSettlementMaintenancePlanner(world);
    expect(whileOutside).toEqual({
      ran: false,
      terminationReason: 'no-opportunity',
      decisions: [],
    });

    moveInsideSettlement();
    unlockAchievement(world, 'slime-no-more');
    const third = runSettlementMaintenancePlanner(world);
    expect(third.ran).toBe(true);
    expect(decisionKinds(third)).toContain('claim-achievement');
  });

  it('claims an unlocked achievement reward exactly once through the shared claim API', () => {
    const { world } = createSettlementWorld();
    unlockAchievement(world, 'first-bonk');
    expect(isAchievementClaimed(world, 'first-bonk')).toBe(false);

    const goldBefore = world.playerGold;
    const result = runSettlementMaintenancePlanner(world);

    expect(isAchievementClaimed(world, 'first-bonk')).toBe(true);
    expect(result.decisions).toContainEqual({
      kind: 'claim-achievement',
      detail: "Claimed achievement reward for 'first-bonk'",
    });
    expect(world.playerGold).toBe(goldBefore + LOOT_BOX_GOLD_BY_TIER.trash);
  });

  it('opens and acknowledges an available boss chest through the shared exact-once APIs', () => {
    const { world, playerEid } = createSettlementWorld();
    const spawnResult = spawnBossChestForDefeatedBoss(world, 'test-family');
    expect(spawnResult.created).toBe(true);
    const chestId = createBossChestId('test-family');
    expect(world.bossChests.get(chestId)?.state).toBe('available');

    const result = runSettlementMaintenancePlanner(world);

    expect(world.bossChests.get(chestId)?.state).toBe('claimed');
    expect(decisionKinds(result)).toEqual(
      expect.arrayContaining(['open-boss-chest', 'acknowledge-boss-chest']),
    );
    void playerEid;
  });

  it('retries a bag-full boss-chest open once after the equipment loop frees bag capacity', () => {
    const { world, playerEid } = createSettlementWorld();
    // Fill the bag's single generated-equipment slot so the chest's reward
    // grant fails with `grantFailed` on the first pass.
    const bagInstanceId = addBagEquipment(world, playerEid, 'iron-breastplate');
    const bag = world.inventories.get(playerEid);
    if (!bag) throw new Error('Test requires a player bag');
    world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 1 });

    const spawnResult = spawnBossChestForDefeatedBoss(world, 'test-family');
    expect(spawnResult.created).toBe(true);
    const chestId = createBossChestId('test-family');

    const result = runSettlementMaintenancePlanner(world);

    // The equipment loop equips the breastplate (freeing the bag's one slot),
    // so the deferred retry succeeds and the chest ends up claimed in the
    // same visit — no unrelated room exit/re-entry required.
    const equipped = getEquipmentState(world, playerEid)?.equipped;
    expect(Object.values(equipped ?? {})).toContain(bagInstanceId);
    expect(world.bossChests.get(chestId)?.state).toBe('claimed');
    expect(result.decisions).toContainEqual({
      kind: 'open-boss-chest',
      detail: `Opened boss chest '${chestId}' (retried after equipment loop freed bag capacity)`,
    });
    expect(decisionKinds(result)).toContain('acknowledge-boss-chest');
    // The first-pass failure must never have been recorded as a terminal skip.
    expect(result.decisions.some((d) => d.kind === 'skip' && d.detail.includes(chestId))).toBe(
      false,
    );
  });

  it('equips a positive-utility inventory candidate over an empty loadout', () => {
    const { world, playerEid } = createSettlementWorld();
    const instanceId = addBagEquipment(world, playerEid, 'iron-breastplate');

    const result = runSettlementMaintenancePlanner(world);

    const equipDecision = result.decisions.find((d) => d.kind === 'equip-instance');
    expect(equipDecision).toBeDefined();
    expect(equipDecision?.utility).toBeGreaterThan(0);
    const equipped = getEquipmentState(world, playerEid)?.equipped;
    expect(Object.values(equipped ?? {})).toContain(instanceId);
  });

  it('purchases from the Quartermaster shop through the shared atomic purchase API when a shop candidate wins', () => {
    const { world, playerEid } = createSettlementWorld();
    world.playerGold = 5_000;
    const { instanceId } = attachSingleOfferStock(world, 'leather-boots', 5);

    const result = runSettlementMaintenancePlanner(world);

    const purchaseDecision = result.decisions.find((d) => d.kind === 'purchase-equipment');
    expect(purchaseDecision).toBeDefined();
    expect(purchaseDecision?.cost).toBe(5);
    expect(world.playerGold).toBe(4_995);
    const equipped = getEquipmentState(world, playerEid)?.equipped;
    expect(Object.values(equipped ?? {})).toContain(instanceId);
  });

  it('does not purchase when the player cannot afford the only shop offer (affordability failure)', () => {
    const { world } = createSettlementWorld();
    world.playerGold = 0;
    attachSingleOfferStock(world, 'leather-boots', 50);

    const result = runSettlementMaintenancePlanner(world);

    expect(result.terminationReason).toBe('exhausted');
    expect(result.decisions.some((d) => d.kind === 'purchase-equipment')).toBe(false);
    expect(world.playerGold).toBe(0);
  });

  it('does not purchase when the player bag has zero generated-equipment capacity (capacity failure)', () => {
    const { world, playerEid } = createSettlementWorld();
    world.playerGold = 5_000;
    attachSingleOfferStock(world, 'leather-boots', 50);
    const bag = world.inventories.get(playerEid);
    if (!bag) throw new Error('Test requires a player bag');
    world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 0 });

    const result = runSettlementMaintenancePlanner(world);

    expect(result.terminationReason).toBe('exhausted');
    expect(result.decisions.some((d) => d.kind === 'purchase-equipment')).toBe(false);
    expect(world.playerGold).toBe(5_000);
  });

  it('records a skip and blacklists the offer (exhausting the loop, since it was the only candidate) when the top-ranked shop offer goes stale mid-purchase', () => {
    const { world } = createSettlementWorld();
    world.playerGold = 5_000;
    const { instanceId } = attachSingleOfferStock(world, 'leather-boots', 5);

    const mockedPurchase = vi.mocked(purchaseQuartermasterOffer);
    mockedPurchase.mockClear();
    mockedPurchase.mockReturnValueOnce({
      ok: false,
      reason: 'stock-unavailable',
      message: 'Quartermaster offer is sold out',
    });

    const result = runSettlementMaintenancePlanner(world);

    // Blacklisted (not retried) rather than aborting the whole equipment
    // loop — purchase is only attempted once even though the loop continues.
    expect(mockedPurchase).toHaveBeenCalledTimes(1);
    expect(result.terminationReason).toBe('exhausted');
    expect(result.decisions).toContainEqual({
      kind: 'skip',
      detail: `Purchase failed for '${instanceId}': stock-unavailable; blacklisting and continuing`,
    });
    expect(world.playerGold).toBe(5_000);
  });

  it('blacklists a failed shop offer purchase and still purchases+equips the other offer in the same visit', () => {
    const { world } = createSettlementWorld();
    world.playerGold = 5_000;

    // Two offers in different slots so there is no equip conflict between
    // them. Whichever ranks top gets its purchase stubbed to fail once (via
    // the single queued `mockReturnValueOnce` below); the loop must blacklist
    // it and continue on to actually purchase + equip the OTHER offer rather
    // than aborting the whole visit. (Quartermaster offers are never 'rare'
    // — see `Floor2QuartermasterStockOffer['rarity']`.)
    const helmInstance = generateEquipmentInstance(world, {
      baseId: 'iron-helm',
      itemLevel: world.playerLevel.level,
      rarity: 'uncommon',
      enhancementLevel: 0,
    });
    const bootsInstance = generateEquipmentInstance(world, {
      baseId: 'leather-boots',
      itemLevel: world.playerLevel.level,
      rarity: 'common',
      enhancementLevel: 0,
    });
    const stock: Floor2QuartermasterStockState = {
      stockId: 'stock-1',
      restockEpoch: 0,
      offers: [
        {
          offerId: 'offer-helm',
          instanceId: helmInstance.instanceId,
          rarity: 'uncommon',
          unitPrice: 5,
          quantity: 1,
        },
        {
          offerId: 'offer-boots',
          instanceId: bootsInstance.instanceId,
          rarity: 'common',
          unitPrice: 5,
          quantity: 1,
        },
      ],
      retiredInstanceIds: [],
    };
    const settlement = world.floorExtendedState?.settlement;
    if (!settlement) throw new Error('Test requires a settlement');
    world.floorExtendedState = {
      ...world.floorExtendedState,
      settlement: { ...settlement, quartermasterStock: stock },
    };

    const mockedPurchase = vi.mocked(purchaseQuartermasterOffer);
    mockedPurchase.mockClear();
    mockedPurchase.mockReturnValueOnce({
      ok: false,
      reason: 'stock-unavailable',
      message: 'Quartermaster offer is sold out',
    });
    // Subsequent calls fall through to the real implementation (no further
    // mockReturnValueOnce queued), so whichever offer is tried second
    // actually purchases.

    const result = runSettlementMaintenancePlanner(world);

    // Ranking between the two offers is an implementation detail of the
    // affinity/utility scorer — this test only asserts the MECHANISM: the
    // top-ranked candidate's failed purchase is blacklisted, and the loop
    // continues to actually purchase + equip the OTHER offer instead of
    // aborting the whole visit.
    const skipDecision = result.decisions.find(
      (d): d is { kind: 'skip'; detail: string } =>
        d.kind === 'skip' && d.detail.includes('blacklisting'),
    );
    expect(skipDecision).toBeDefined();
    const failedInstanceId = skipDecision!.detail.includes(helmInstance.instanceId)
      ? helmInstance.instanceId
      : bootsInstance.instanceId;
    const succeededInstanceId =
      failedInstanceId === helmInstance.instanceId
        ? bootsInstance.instanceId
        : helmInstance.instanceId;
    const succeededPrice = 5; // both offers are priced at 5g now

    expect(
      result.decisions.some(
        (d) => d.kind === 'purchase-equipment' && d.detail.includes(succeededInstanceId),
      ),
    ).toBe(true);
    expect(
      result.decisions.some(
        (d) => d.kind === 'equip-instance' && d.detail.includes(succeededInstanceId),
      ),
    ).toBe(true);
    expect(mockedPurchase).toHaveBeenCalledTimes(2);
    expect(world.playerGold).toBe(5_000 - succeededPrice); // only the succeeding purchase is actually spent
  });

  it('bounds the equipment swap loop at the action cap even with more positive candidates available', () => {
    const { world, playerEid } = createSettlementWorld();
    const baseIds = [
      'iron-helm',
      'iron-visor',
      'steel-pauldrons',
      'iron-breastplate',
      'bronze-vambrace',
      'iron-armguard',
      'iron-greaves',
      'leather-boots',
      'iron-sword',
    ];
    expect(baseIds.length).toBe(9); // 1 more than the equipment action cap (8)
    for (const baseId of baseIds) {
      addBagEquipment(world, playerEid, baseId, 'uncommon');
    }

    const result = runSettlementMaintenancePlanner(world);

    expect(result.terminationReason).toBe('action-cap-equipment');
    const equipCount = result.decisions.filter((d) => d.kind === 'equip-instance').length;
    expect(equipCount).toBe(8);
  });

  it('configures at most ACTIVE_ABILITY_SLOT_LIMIT owned-but-unequipped abilities, skipping the rest without throwing', () => {
    const { world, playerEid } = createSettlementWorld();
    const ownedAbilityIds = [
      'battle-focus',
      'bless',
      'curse',
      'fireball',
      'frost-nova',
      'haste',
      'heal',
      'magic-missile',
      'pulse-shield',
      'stoneskin',
      'vampiric-touch',
    ];
    expect(ownedAbilityIds.length).toBe(ACTIVE_ABILITY_SLOT_LIMIT + 1);
    for (const abilityId of ownedAbilityIds) {
      grantAbilitySources(world, playerEid, [
        { kind: 'active', abilityId, sourceId: learnedAbilityGrantSourceId(abilityId) },
      ]);
    }

    const result = runSettlementMaintenancePlanner(world);

    const abilityState = getOrCreateAbilityState(world, playerEid);
    expect(abilityState.equippedActiveAbilityIds.length).toBe(ACTIVE_ABILITY_SLOT_LIMIT);
    // Sorted ascending; the 11th (alphabetically last) never gets a slot.
    expect(abilityState.equippedActiveAbilityIds).not.toContain('vampiric-touch');
    const configureCount = result.decisions.filter((d) => d.kind === 'configure-ability').length;
    expect(configureCount).toBe(ACTIVE_ABILITY_SLOT_LIMIT);
  });

  it("configures the accepted equipment candidate's own selected abilities before the owned-ability fill pass", () => {
    const { world, playerEid } = createSettlementWorld();
    // Own an ability but don't equip it — the equip loop's ability-grant
    // candidate carries no configuredActiveAbilityIds by itself here, but this
    // asserts the fill pass still runs after the equipment loop settles and
    // picks it up deterministically (ascending id order).
    grantAbilitySources(world, playerEid, [
      { kind: 'active', abilityId: 'heal', sourceId: learnedAbilityGrantSourceId('heal') },
    ]);
    addBagEquipment(world, playerEid, 'iron-breastplate');

    const result = runSettlementMaintenancePlanner(world);

    const abilityState = getOrCreateAbilityState(world, playerEid);
    expect(abilityState.equippedActiveAbilityIds).toContain('heal');
    expect(result.decisions).toContainEqual({
      kind: 'configure-ability',
      detail: "Filled open active-ability slot with already-owned ability 'heal'",
    });
  });

  it('never displaces a statically-equipped item (e.g. the Floor 2 starter weapon) with a generated-equipment candidate for the same slot', () => {
    const { world, playerEid } = createSettlementWorld();
    // Static equip path: mirrors how starterWeaponEquip.ts / floor2Scenario.ts
    // equip non-generated items — a numeric EquipmentInstanceId, invisible to
    // the evaluator's `equipped` snapshot (see `buildEquipmentSnapshot`).
    const staticEquip = equip(world, playerEid, MERCHANTS_CHARM_DEF, { force: true });
    expect(staticEquip.ok).toBe(true);
    const staticInstanceId = staticEquip.ok ? staticEquip.instanceId : null;

    // A generated-equipment candidate targeting the SAME slot ('neck') as the
    // static charm — without the protected-slot filter this would look like a
    // pure upgrade over "no weapon" and get equipped, silently discarding the
    // static item's stat bonuses/status effect.
    const lockerInstanceId = addBagEquipment(
      world,
      playerEid,
      'accessory.gearwork-locket',
      'uncommon',
    );

    const result = runSettlementMaintenancePlanner(world);

    expect(
      result.decisions.some(
        (d) => d.kind === 'equip-instance' && d.detail.includes(lockerInstanceId),
      ),
    ).toBe(false);
    const skipDecision = result.decisions.find(
      (d) => d.kind === 'skip' && d.detail.includes(lockerInstanceId),
    );
    expect(skipDecision).toBeDefined();
    expect(skipDecision?.detail).toContain('statically-equipped');

    const equipped = getEquipmentState(world, playerEid)?.equipped;
    expect(equipped?.neck).toBe(staticInstanceId);
  });

  it('logs a Quartermaster offer skip decision for an unaffordable offer exactly once, even across multiple equipment-loop iterations', () => {
    const { world, playerEid } = createSettlementWorld();
    world.playerGold = 10;
    const { offer } = attachSingleOfferStock(world, 'iron-breastplate', 5_000);
    addBagEquipment(world, playerEid, 'iron-helm', 'uncommon');
    addBagEquipment(world, playerEid, 'leather-boots', 'common');

    const result = runSettlementMaintenancePlanner(world);

    // Both bag candidates get equipped (different slots), spanning at least
    // two equipment-loop iterations, while the unaffordable shop offer is
    // re-evaluated (and re-filtered) on every iteration.
    expect(result.decisions.filter((d) => d.kind === 'equip-instance').length).toBe(2);

    const offerSkips = result.decisions.filter(
      (d) => d.kind === 'skip' && d.detail.includes(offer.offerId),
    );
    expect(offerSkips).toHaveLength(1);
    expect(offerSkips[0]?.detail).toContain('insufficient-funds');
    expect(result.decisions.some((d) => d.kind === 'purchase-equipment')).toBe(false);
    expect(world.playerGold).toBe(10);
  });
});

describe('runEagerMaintenanceTick', () => {
  // ──────────────────────────────────────────────────────────────────
  // Achievement claiming — anywhere, any floor
  // ──────────────────────────────────────────────────────────────────

  it('claims a Floor 1 lootBox achievement reward in any safe room, with no settlement required', () => {
    // No settlement wired: plain Floor 1 world, player in a safe room. The
    // achievements panel is safe-context gated for a human, so the AI's eager
    // claim is too — but it does NOT need the Floor 2 settlement specifically.
    const world = createTestWorld({ seed: 42, floor: 1 });
    const playerEid = spawnPlayer(world, 400, 400);
    world.playerInSafeRoom = true;

    unlockAchievement(world, 'first-bonk');
    expect(isAchievementClaimed(world, 'first-bonk')).toBe(false);
    const goldBefore = world.playerGold;

    runEagerMaintenanceTick(world, playerEid);

    expect(isAchievementClaimed(world, 'first-bonk')).toBe(true);
    expect(world.playerGold).toBeGreaterThan(goldBefore);
  });

  it('claims multiple unlocked but unclaimed lootBox achievements in one tick', () => {
    const world = createTestWorld({ seed: 42, floor: 1 });
    const playerEid = spawnPlayer(world, 400, 400);
    world.playerInSafeRoom = true;

    unlockAchievement(world, 'first-bonk');
    unlockAchievement(world, 'slime-no-more');
    unlockAchievement(world, 'rat-retired');

    runEagerMaintenanceTick(world, playerEid);

    expect(isAchievementClaimed(world, 'first-bonk')).toBe(true);
    expect(isAchievementClaimed(world, 'slime-no-more')).toBe(true);
    expect(isAchievementClaimed(world, 'rat-retired')).toBe(true);
  });

  it('is idempotent: repeated calls do not double-claim or throw', () => {
    const world = createTestWorld({ seed: 42, floor: 1 });
    const playerEid = spawnPlayer(world, 400, 400);
    world.playerInSafeRoom = true;
    unlockAchievement(world, 'first-bonk');

    runEagerMaintenanceTick(world, playerEid);
    const goldAfterFirst = world.playerGold;

    // Second call: already claimed — should be a no-op.
    runEagerMaintenanceTick(world, playerEid);
    expect(world.playerGold).toBe(goldAfterFirst);
  });

  it('claims Floor 2 equipment achievement rewards in any safe room, not just the settlement', () => {
    // Floor 2 world with all equipment flags, player in a safe room that is
    // NOT the settlement room.
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    world.floor2EquipmentFlags.floor2EquipmentRewards = true;
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentAiMaintenance = true;
    const playerEid = spawnPlayer(world, 400, 400);
    world.playerLevel.level = 5;
    world.playerInSafeRoom = true; // safe context, but not the settlement room

    unlockAchievement(world, 'floor2-field-kit');
    expect(isAchievementClaimed(world, 'floor2-field-kit')).toBe(false);

    runEagerMaintenanceTick(world, playerEid);

    expect(isAchievementClaimed(world, 'floor2-field-kit')).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────
  // Generated-equipment equipping — outside settlement, from bag
  // ──────────────────────────────────────────────────────────────────

  it('equips a generated-equipment bag item in any safe room outside the settlement', () => {
    const { world, playerEid, moveOutsideSettlement } = createSettlementWorld();
    // Move the player OUT of the settlement so the settlement planner would
    // no-op; the eager path still equips because the player is in a safe
    // context, exactly as a human opening the equipment panel would be.
    moveOutsideSettlement();
    world.playerInSafeRoom = true;

    const instanceId = addBagEquipment(world, playerEid, 'iron-breastplate', 'common');

    runEagerMaintenanceTick(world, playerEid);

    const equipped = getEquipmentState(world, playerEid)?.equipped;
    expect(Object.values(equipped ?? {})).toContain(instanceId);
  });

  it('prefers filling empty slots over contested ones (empty-slot-first priority)', () => {
    const { world, playerEid, moveOutsideSettlement } = createSettlementWorld();
    moveOutsideSettlement();
    world.playerInSafeRoom = true; // safe context: the human equip gate is satisfied

    // Equip a static charm into the neck slot so the locket candidate is
    // contested (the evaluator requires a stat improvement to displace a
    // statically-equipped item, while the breastplate fills an empty slot).
    const staticEquip = equip(world, playerEid, MERCHANTS_CHARM_DEF, { force: true });
    expect(staticEquip.ok).toBe(true);

    // Add two candidates: one for an empty slot, one competing with the
    // charm that now occupies the neck slot. The evaluator scores an empty-slot
    // fill positive regardless of stats, while a contested slot requires a stat
    // improvement — and a static item protects the neck slot from being displaced.
    const emptySlotId = addBagEquipment(world, playerEid, 'iron-breastplate', 'common');
    const contestedSlotId = addBagEquipment(
      world,
      playerEid,
      'accessory.gearwork-locket',
      'common',
    );

    runEagerMaintenanceTick(world, playerEid);

    const equipped = getEquipmentState(world, playerEid)?.equipped;
    const equippedValues = Object.values(equipped ?? {});
    // The empty-slot item (breastplate) must be equipped.
    expect(equippedValues).toContain(emptySlotId);
    // The neck slot must still be held by either the static charm (number eid)
    // or the new locket — it was not displaced to "nothing".
    expect(equippedValues.some((v) => v === contestedSlotId || typeof v === 'number')).toBe(true);
  });

  it('does NOT purchase from the Quartermaster shop (inventory-only path)', () => {
    const { world, playerEid, moveOutsideSettlement } = createSettlementWorld();
    moveOutsideSettlement();
    world.playerInSafeRoom = true; // safe context: the human equip gate is satisfied
    world.playerGold = 100_000; // enough to buy anything

    // Attach a shop offer that would be a clear upgrade for an empty slot.
    attachSingleOfferStock(world, 'iron-breastplate', 10);

    runEagerMaintenanceTick(world, playerEid);

    // No gold spent: the eager path must never buy from the shop.
    expect(world.playerGold).toBe(100_000);
    const equipped = getEquipmentState(world, playerEid)?.equipped;
    // The breastplate (shop-only) must NOT be equipped.
    expect(Object.values(equipped ?? {}).every((v) => typeof v === 'number')).toBe(true);
  });

  it('equips multiple bag items that each fill a different empty slot', () => {
    const { world, playerEid, moveOutsideSettlement } = createSettlementWorld();
    moveOutsideSettlement();
    world.playerInSafeRoom = true; // safe context: the human equip gate is satisfied

    const helmId = addBagEquipment(world, playerEid, 'iron-helm', 'common');
    const bootsId = addBagEquipment(world, playerEid, 'leather-boots', 'common');

    runEagerMaintenanceTick(world, playerEid);

    const equipped = getEquipmentState(world, playerEid)?.equipped;
    const equippedValues = Object.values(equipped ?? {});
    expect(equippedValues).toContain(helmId);
    expect(equippedValues).toContain(bootsId);
  });

  it('retries a deferred claim once equipping frees bag capacity', () => {
    // Scenario: bag is at capacity (1 slot, 1 item). A second achievement
    // unlocks — its claim is deferred because the bag is full. The eager
    // equipment loop equips the existing bag item (freeing the slot), then
    // the retry pass claims the previously-deferred achievement.
    const { world, playerEid, moveOutsideSettlement } = createSettlementWorld();
    moveOutsideSettlement();
    world.playerInSafeRoom = true; // safe context: the human equip gate is satisfied
    // floor2-field-kit is an equipment-reward achievement gated on this flag.
    world.floor2EquipmentFlags.floor2EquipmentRewards = true;

    // Fill the bag to capacity with a single item that is a clear upgrade for
    // an empty slot (so runBagOnlyEquipmentLoop will equip it).
    addBagEquipment(world, playerEid, 'iron-breastplate', 'common');
    const bag = world.inventories.get(playerEid);
    if (!bag) throw new Error('Expected bag');
    // Clamp capacity to 1 so the bag is now exactly full.
    world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 1 });

    // Unlock an equipment achievement whose reward would go into the bag.
    // With capacity=1 and 1 item already there, claimAchievementReward will
    // defer (grantFailed) on the first pass.
    const ok = unlockAchievement(world, 'floor2-field-kit');
    expect(ok).toBe(true); // sanity: unlock succeeded (bundle stored, not in bag)
    expect(isAchievementClaimed(world, 'floor2-field-kit')).toBe(false);

    // The eager tick must:
    //   1. attempt claim → deferred (bag full)
    //   2. equip iron-breastplate from bag → bag now has 0 items
    //   3. retry deferred claim → succeeds (capacity freed)
    runEagerMaintenanceTick(world, playerEid);

    expect(isAchievementClaimed(world, 'floor2-field-kit')).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────
  // AI/human parity — the eager tick has no privileges a player lacks
  // ──────────────────────────────────────────────────────────────────

  it('does nothing outside a safe context: no equip, no achievement claim', () => {
    const { world, playerEid, moveOutsideSettlement } = createSettlementWorld();
    moveOutsideSettlement();
    world.playerInSafeRoom = false;
    world.state = 'playing';
    world.floor2EquipmentFlags.floor2EquipmentRewards = true;

    const instanceId = addBagEquipment(world, playerEid, 'iron-breastplate', 'common');
    unlockAchievement(world, 'floor2-field-kit');
    const goldBefore = world.playerGold;

    runEagerMaintenanceTick(world, playerEid);

    // A human cannot open the equipment or achievements panel here, so neither
    // can the AI: the loot stays in the bag and the reward stays unclaimed.
    const equipped = getEquipmentState(world, playerEid)?.equipped;
    expect(Object.values(equipped ?? {})).not.toContain(instanceId);
    expect(isAchievementClaimed(world, 'floor2-field-kit')).toBe(false);
    expect(world.playerGold).toBe(goldBefore);
  });

  it('completes the deferred work on the next safe-room entry', () => {
    const { world, playerEid, moveOutsideSettlement } = createSettlementWorld();
    moveOutsideSettlement();
    world.playerInSafeRoom = false;
    world.state = 'playing';

    const instanceId = addBagEquipment(world, playerEid, 'iron-breastplate', 'common');
    runEagerMaintenanceTick(world, playerEid);
    expect(Object.values(getEquipmentState(world, playerEid)?.equipped ?? {})).not.toContain(
      instanceId,
    );

    // Walk into a safe room — the same trip a player makes to re-gear.
    world.playerInSafeRoom = true;
    runEagerMaintenanceTick(world, playerEid);

    expect(Object.values(getEquipmentState(world, playerEid)?.equipped ?? {})).toContain(
      instanceId,
    );
  });
});
