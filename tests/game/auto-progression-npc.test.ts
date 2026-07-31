import { afterEach, describe, expect, it } from 'vitest';
import {
  NPC_INTERACTION_COOLDOWN,
  autoAllocateStatPoints,
  autoFloor1ProgressionSystem,
  autoNpcInteractionSystem,
} from '../../src/game/ai/auto-progression.js';
import { getOfferedBossRewardSpellIds } from '../../src/game/floorScenario.js';
import {
  AINpcInteractionAction,
  AIState,
  type AIDecision,
  type AIInputProvider,
} from '../../src/game/ai/types.js';
import { setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { equip, getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { getEquipmentDefForItem } from '../../src/shared/equipmentDefs.js';
import equipmentDefsTestSeams from '../../src/shared/equipmentDefs.test-seams.js';
import type { EquipmentItemDef } from '../../src/shared/equipment-types.js';
import { addItem, hasItem } from '../../src/shared/inventory.js';
import { _customTag as customTag, ItemRarity, type ItemDef } from '../../src/shared/items.js';
import type { NpcInstance } from '../../src/shared/npc-types.js';
import { NPC_INTERACT_RANGE_FT } from '../../src/shared/npc-types.js';
import { SHOPKEEPER_EQUIPMENT_ITEM_ID } from '../../src/shared/quest-types.js';
import type { GameWorld } from '../../src/core/world.js';
import type { FloorScenarioState } from '../../src/shared/floor-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

function makeFloor1(overrides: Partial<FloorScenarioState['objective']> = {}): FloorScenarioState {
  return {
    protagonistName: 'Test',
    starterWeaponPool: [],
    starterChoices: [],
    selectedWeaponId: null,
    selectedChoiceIndex: null,
    baseStatBonuses: { maxHp: 0, moveSpeed: 0, pickupRange: 0 },
    enemyArchetypes: new Map(),
    guideNpcEid: null,
    spellQuestGiverNpcEid: null,
    shopkeeperNpcEid: null,
    questItemEid: null,
    bossRoomDoorEids: new Map(),
    objective: {
      requiredRats: 6,
      requiredSlimes: 4,
      requiredGold: 50,
      requiredJunk: 2,
      deadlineMs: 600_000,
      staircaseSpawnCountdownMs: 30_000,
      safeRoomPos: { x: 0, y: 0 },
      staircasePos: { x: 100, y: 100 },
      welcomeOfficePos: { x: 10, y: 0 },
      slimeRatRoomPos: { x: 50, y: 0 },
      spellQuestGiverPos: { x: 40, y: 0 },
      shopRoomPos: { x: 20, y: 0 },
      questItemPos: { x: 30, y: 0 },
      markerRadiusFt: 4,
      questAccepted: false,
      questCompleted: false,
      ratsKilled: 0,
      slimesKilled: 0,
      goldCollected: 0,
      junkCollected: 0,
      safeRoomDiscovered: false,
      staircaseSpawnStartedMs: null,
      staircaseSpawnRemainingMs: null,
      staircaseSpawned: false,
      staircaseLocked: false,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
      bossBattles: new Map(),
      ...overrides,
    },
    failReason: null,
    runSummary: null,
  };
}

function fakeProvider(decision: AIDecision): AIInputProvider {
  return {
    poll: () => {},
    getDecision: () => decision,
    reset: () => {},
  };
}

function decision(partial: Partial<AIDecision>): AIDecision {
  return {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'test',
    ...partial,
    npcInteraction: partial.npcInteraction ?? null,
    debug: partial.debug ?? null,
  };
}

function addNpc(world: GameWorld, eid: number, instance: Partial<NpcInstance>): void {
  world.npcs.set(eid, {
    defId: 'tutorial-goon',
    dialogueIndex: 0,
    quests: [],
    nearbyPlayer: true,
    ...instance,
  });
}

function makeCatalogItem(id: string): ItemDef {
  return {
    id,
    name: id,
    description: 'test item',
    tags: [customTag('test')],
    rarity: ItemRarity.Common,
    maxStack: 1,
  };
}

describe('autoNpcInteractionSystem', () => {
  it('returns the last interaction frame while still on cooldown', () => {
    const world = createTestWorld();
    const provider = fakeProvider(decision({ state: AIState.INTERACT, targetEid: 5 }));
    expect(autoNpcInteractionSystem(world, provider, 100, 110, NPC_INTERACTION_COOLDOWN)).toBe(100);
  });

  it('does nothing when the AI is not in the INTERACT state', () => {
    const world = createTestWorld();
    const provider = fakeProvider(decision({ state: AIState.ENGAGE, targetEid: 5 }));
    expect(autoNpcInteractionSystem(world, provider, 0, 100, 30)).toBe(0);
  });

  it('does nothing when the target eid is missing or invalid', () => {
    const world = createTestWorld();
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: null })),
        0,
        100,
        30,
      ),
    ).toBe(0);
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: -1 })),
        0,
        100,
        30,
      ),
    ).toBe(0);
  });

  it('does nothing when the targeted NPC is unknown or not nearby', () => {
    const world = createTestWorld();
    // No NPC registered for eid 7.
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 7 })),
        0,
        100,
        30,
      ),
    ).toBe(0);
    // Registered but not nearby.
    addNpc(world, 8, { nearbyPlayer: false });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 8 })),
        0,
        100,
        30,
      ),
    ).toBe(0);
  });

  it('meets the tutorial goon and advances the interaction frame', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    addNpc(world, 9, { defId: 'tutorial-goon', nearbyPlayer: true });
    const result = autoNpcInteractionSystem(
      world,
      fakeProvider(decision({ state: AIState.INTERACT, targetEid: 9 })),
      0,
      100,
      30,
    );
    expect(result).toBe(100);
    // meetTutorialGoon unlocks drops.
    expect(world.goalFlags.get('floor1-drops-unlocked')).toBe(true);
  });

  it('advances cooldown for unrecognized NPCs so targeting can progress', () => {
    const world = createTestWorld();
    addNpc(world, 10, { defId: 'mystery-npc', nearbyPlayer: true });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 10 })),
        0,
        100,
        30,
      ),
    ).toBe(100);
  });

  it('meets the shopkeeper NPC', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    addNpc(world, 11, { defId: 'shopkeeper', nearbyPlayer: true });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 11 })),
        0,
        100,
        30,
      ),
    ).toBe(100);
  });

  it('meets the spell-quest-giver NPC', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    addNpc(world, 12, { defId: 'spell-quest-giver', nearbyPlayer: true });
    expect(
      autoNpcInteractionSystem(
        world,
        fakeProvider(decision({ state: AIState.INTERACT, targetEid: 12 })),
        0,
        100,
        30,
      ),
    ).toBe(100);
  });

  describe('EXPLORE explicit NPC interaction intent', () => {
    it('does NOT interact when only the anchor is in range but the NPC is still too far', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);
      world.stores.position.x[player] = 0;
      world.stores.position.y[player] = 0;
      addNpc(world, 21, { defId: 'tutorial-goon', nearbyPlayer: false });
      world.stores.position.x[21] = 20;
      world.stores.position.y[21] = 0;
      const result = autoNpcInteractionSystem(
        world,
        fakeProvider(
          decision({
            state: AIState.EXPLORE,
            reason: 'Seeking Tutorial Goon to unlock the floor quest',
            targetEid: 21,
            targetX: NPC_INTERACT_RANGE_FT - 0.25,
            targetY: 0,
            npcInteraction: {
              npcEid: 21,
              action: AINpcInteractionAction.ACCEPT_TUTORIAL_QUEST,
              allowWhileExploring: true,
            },
          }),
        ),
        0,
        100,
        30,
      );
      expect(result).toBe(0);
      expect(world.goalFlags.get('floor1-drops-unlocked')).toBeUndefined();
    });

    it('interacts when EXPLORE carries explicit shopkeeper intent and the player is close enough to the NPC', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);
      world.stores.position.x[player] = 0;
      world.stores.position.y[player] = 0;
      addNpc(world, 22, { defId: 'shopkeeper', nearbyPlayer: false });
      world.stores.position.x[22] = NPC_INTERACT_RANGE_FT - 0.5;
      world.stores.position.y[22] = 0;
      const result = autoNpcInteractionSystem(
        world,
        fakeProvider(
          decision({
            state: AIState.EXPLORE,
            reason: 'Returning to the Shopkeeper to buy the charm',
            targetEid: 22,
            targetX: 1,
            targetY: 0,
            npcInteraction: {
              npcEid: 22,
              action: AINpcInteractionAction.BUY_SHOPKEEPER_EQUIPMENT,
              allowWhileExploring: true,
            },
          }),
        ),
        0,
        100,
        30,
      );
      expect(result).toBe(100);
    });

    it('interacts when EXPLORE carries explicit tutorial-goon intent and the player is close enough to the NPC', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);
      world.stores.position.x[player] = 0;
      world.stores.position.y[player] = 0;
      addNpc(world, 24, { defId: 'tutorial-goon', nearbyPlayer: false });
      world.stores.position.x[24] = NPC_INTERACT_RANGE_FT - 0.25;
      world.stores.position.y[24] = 0;
      const result = autoNpcInteractionSystem(
        world,
        fakeProvider(
          decision({
            state: AIState.EXPLORE,
            reason: 'Seeking Tutorial Goon to unlock the floor quest',
            targetEid: 24,
            targetX: 1,
            targetY: 0,
            npcInteraction: {
              npcEid: 24,
              action: AINpcInteractionAction.ACCEPT_TUTORIAL_QUEST,
              allowWhileExploring: true,
            },
          }),
        ),
        0,
        100,
        30,
      );
      expect(result).toBe(100);
      expect(world.goalFlags.get('floor1-drops-unlocked')).toBe(true);
    });

    it('does NOT trigger for a generic EXPLORE decision without explicit NPC intent', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);
      world.stores.position.x[player] = 0;
      world.stores.position.y[player] = 0;
      addNpc(world, 23, { defId: 'shopkeeper', nearbyPlayer: false });
      world.stores.position.x[23] = NPC_INTERACT_RANGE_FT - 0.5;
      world.stores.position.y[23] = 0;
      const result = autoNpcInteractionSystem(
        world,
        fakeProvider(
          decision({
            state: AIState.EXPLORE,
            reason: 'Exploring frontier',
            targetEid: 23,
            targetX: 1,
            targetY: 0,
          }),
        ),
        0,
        100,
        30,
      );
      expect(result).toBe(0);
    });
  });
});

describe('autoAllocateStatPoints', () => {
  it('is a no-op when there are no unspent points', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.playerLevel.unspentPoints = 0;
    expect(() => autoAllocateStatPoints(world, player)).not.toThrow();
  });

  it('spends available points into Constitution first for survival', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.playerLevel.unspentPoints = 5;
    const constitutionBefore = world.stores.coreStatPoints.constitution[player] ?? 0;

    autoAllocateStatPoints(world, player);

    expect(world.stores.coreStatPoints.constitution[player]).toBeGreaterThan(constitutionBefore);
  });
});

describe('autoFloor1ProgressionSystem', () => {
  afterEach(() => {
    equipmentDefsTestSeams._clearEquipmentDefsForTest();
  });

  it('is a no-op when floor1 is null', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = null;
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
  });

  it('selects one of the offered boss-reward spells when boss battle is complete and spells not unlocked', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1();
    world.goalFlags.set('floor1-boss-battle-complete', true);
    world.featureUnlocks.spells = false;
    // selectSpellFromBossBattle should not throw
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
    // Spell unlocks should be set after the call
    expect(world.featureUnlocks.spells).toBe(true);
    const learnedSpellId = world.abilityStatesByEntity.get(player)?.learnedSpellIds[0];
    expect(learnedSpellId).toBeDefined();
    expect(getOfferedBossRewardSpellIds(world)).toContain(learnedSpellId);
  });

  it('prefers heal from the offered trio when auto-claiming the boss reward', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1();
    world.floorScenario.offeredRewardSpellIds = ['curse', 'heal', 'haste'];
    world.goalFlags.set('floor1-boss-battle-complete', true);
    world.featureUnlocks.spells = false;

    autoFloor1ProgressionSystem(world, player);

    expect(world.abilityStatesByEntity.get(player)?.learnedSpellIds).toEqual(['heal']);
  });

  it('does not attempt staircase descend when staircase is not unlocked', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: false });
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
    // No staircase action should have been taken (floor1 state unchanged)
    expect(world.floorScenario.objective.staircaseDiscovered).toBe(false);
  });

  it('does not descend when staircase is already discovered', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: true, staircaseDiscovered: true });
    expect(() => autoFloor1ProgressionSystem(world, player)).not.toThrow();
  });

  it('triggers staircase descend when player is inside the marker radius', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Position player exactly at the staircase (100, 100) in feet
    world.stores.position.x[player] = 100;
    world.stores.position.y[player] = 100;
    world.state = 'playing';
    world.floorScenario = makeFloor1({
      staircaseUnlocked: true,
      staircaseDiscovered: false,
      staircaseSpawned: true,
      staircasePos: { x: 100, y: 100 },
    });
    autoFloor1ProgressionSystem(world, player);
    // confirmFloor1StairDescend sets staircaseDiscovered
    expect(world.floorScenario.objective.staircaseDiscovered).toBe(true);
  });

  it('equips only persona-scored gear, so different weapons keep different loadouts', () => {
    const swordWorld = createTestWorld();
    const swordPlayer = spawnPlayer(swordWorld, 0, 0);
    swordWorld.floorScenario = makeFloor1({ staircaseUnlocked: false });
    setActiveWeaponDef(swordWorld, getWeaponDef('sword')!);
    const swordBag = swordWorld.inventories.get(swordPlayer)!;
    addItem(swordBag, 'signet-of-focus', 1);

    const fireballWorld = createTestWorld();
    const fireballPlayer = spawnPlayer(fireballWorld, 0, 0);
    fireballWorld.floorScenario = makeFloor1({ staircaseUnlocked: false });
    setActiveWeaponDef(fireballWorld, getWeaponDef('fireball')!);
    const fireballBag = fireballWorld.inventories.get(fireballPlayer)!;
    addItem(fireballBag, 'signet-of-focus', 1);

    autoFloor1ProgressionSystem(swordWorld, swordPlayer, undefined, true);
    autoFloor1ProgressionSystem(fireballWorld, fireballPlayer, undefined, true);

    expect(hasItem(swordBag, 'signet-of-focus')).toBe(true);
    expect(hasItem(fireballBag, 'signet-of-focus')).toBe(false);
    const fireballEquipment = getEquipmentState(fireballWorld, fireballPlayer)!;
    expect(fireballEquipment.instances.get(fireballEquipment.equipped.ringRight!)?.def.id).toBe(
      'signet-of-focus',
    );
  });

  it('uses persona gear selection by default when weaponPersonas is omitted', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: false });
    setActiveWeaponDef(world, getWeaponDef('sword')!);
    const bag = world.inventories.get(player)!;
    addItem(bag, 'signet-of-focus', 1);

    autoFloor1ProgressionSystem(world, player);

    const legacyWorld = createTestWorld();
    const legacyPlayer = spawnPlayer(legacyWorld, 0, 0);
    legacyWorld.floorScenario = makeFloor1({ staircaseUnlocked: false });
    setActiveWeaponDef(legacyWorld, getWeaponDef('sword')!);
    const legacyBag = legacyWorld.inventories.get(legacyPlayer)!;
    addItem(legacyBag, 'signet-of-focus', 1);
    autoFloor1ProgressionSystem(legacyWorld, legacyPlayer, undefined, false);

    expect(hasItem(bag, 'signet-of-focus')).toBe(true);
    expect(hasItem(legacyBag, 'signet-of-focus')).toBe(false);
    expect(getEquipmentState(world, player)).toBeUndefined();
  });

  it('preserves legacy purchased-gear flow when weaponPersonas is false', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: false });
    setActiveWeaponDef(world, getWeaponDef('sword')!);
    const bag = world.inventories.get(player)!;
    addItem(bag, 'signet-of-focus', 1);

    autoFloor1ProgressionSystem(world, player, undefined, false);

    expect(hasItem(bag, 'signet-of-focus')).toBe(false);
    const equipment = getEquipmentState(world, player)!;
    expect(equipment.instances.get(equipment.equipped.ringRight!)?.def.id).toBe('signet-of-focus');
  });

  it("still equips the Merchant's Charm even when persona scoring is zero", () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: false });
    setActiveWeaponDef(world, getWeaponDef('sword')!);
    const bag = world.inventories.get(player)!;
    addItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID, 1);

    autoFloor1ProgressionSystem(world, player, undefined, true);

    expect(hasItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID)).toBe(false);
    const equipment = getEquipmentState(world, player)!;
    expect(equipment.instances.get(equipment.equipped.neck!)?.def.id).toBe(
      SHOPKEEPER_EQUIPMENT_ITEM_ID,
    );
  });

  it('can swap out weaker equipped gear for a better persona-scored replacement', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.floorScenario = makeFloor1({ staircaseUnlocked: false });
    setActiveWeaponDef(world, getWeaponDef('fireball')!);

    const circlet: EquipmentItemDef = {
      id: 'arcanist-circlet',
      name: 'Arcanist Circlet',
      slots: ['head'],
      statBonuses: { intelligence: 2, cooldownReduction: 0.05 },
      weightLb: 0,
      rarity: 'rare',
    };
    equipmentDefsTestSeams._registerEquipmentDefForTest(circlet);

    expect(equip(world, player, getEquipmentDefForItem('iron-helm')!, { force: true }).ok).toBe(
      true,
    );
    const bag = world.inventories.get(player)!;
    addItem(bag, 'arcanist-circlet', 1, [makeCatalogItem('arcanist-circlet')]);

    autoFloor1ProgressionSystem(world, player, undefined, true);

    expect(hasItem(bag, 'arcanist-circlet')).toBe(false);
    expect(hasItem(bag, 'iron-helm')).toBe(true);
    const equipment = getEquipmentState(world, player)!;
    expect(equipment.instances.get(equipment.equipped.head!)?.def.id).toBe('arcanist-circlet');
  });
});
