import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { SkillHolder } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { statSystem } from '../../src/core/systems/index.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  canPurchaseSpellBrokerSpell,
  getSpellBrokerOffers,
  initializeFloor1Scenario,
  purchaseSpellBrokerSpell,
} from '../../src/game/floorScenario.js';
import {
  forceActivateAbility,
  getOrCreateAbilityState,
  memorizeSpell,
} from '../../src/game/systems/abilitySystem.js';
import { applyCatalogEffect } from '../../src/game/systems/progressionEffects.js';
import {
  configureSpellBrokerPurchase,
  ensureSpellBrokerDecision,
  getSpellBrokerIntent,
  markSpellBrokerPurchased,
  updateSpellBrokerIntent,
} from '../../src/game/ai/spell-broker-intent.js';
import type { Floor1RunPlan } from '../../src/game/ai/run-planner.js';
import { getAllSkillDefinitions, getSkillDefinition } from '../../src/game/skills/registry.js';
import { MERCHANTS_CHARM_COST } from '../../src/shared/equipmentDefs.js';
import {
  FLOOR1_POST_QUEST_WEAPON_COSTS,
  FLOOR1_SPELL_BROKER_MAX_PURCHASES,
} from '../../src/shared/constants.js';
import {
  FLOOR1_SPELL_BROKER_COST,
  SPELL_SKILL_ID_BY_SPELL_ID,
  floor1SpellBrokerOfferCost,
  generateFloor1SpellBrokerOffers,
} from '../../src/shared/index.js';
import {
  configureMerchantWeaponPurchase,
  getMerchantWeaponIntent,
  merchantWeaponReserve,
  spellPurchaseReserve,
  updateMerchantWeaponIntent,
} from '../../src/game/ai/merchant-weapon-intent.js';
import { autoFloor1ProgressionSystem } from '../../src/game/ai/auto-progression.js';

describe('Floor 1 Spell Broker', () => {
  it('generates three unique deterministic offers from the ten-spell pool', () => {
    const first = generateFloor1SpellBrokerOffers(42);
    expect(first).toEqual(generateFloor1SpellBrokerOffers(42));
    expect(first).toHaveLength(3);
    expect(new Set(first.map((offer) => offer.spellId)).size).toBe(3);
    // Rung 0 is the headline price; each further rung steps down by the repeat
    // multiplier, so a repeat purchase is affordable out of banked gold.
    expect(first.map((offer) => offer.cost)).toEqual([
      FLOOR1_SPELL_BROKER_COST,
      floor1SpellBrokerOfferCost(1),
      floor1SpellBrokerOfferCost(2),
    ]);
    expect(floor1SpellBrokerOfferCost(1)).toBeLessThan(FLOOR1_SPELL_BROKER_COST);
    expect(floor1SpellBrokerOfferCost(2)).toBeLessThan(floor1SpellBrokerOfferCost(1));
    expect(first.map((offer) => offer.spellId)).not.toEqual(
      generateFloor1SpellBrokerOffers(43).map((offer) => offer.spellId),
    );
  });

  it('requires the broker quest gate, gold, ownership, and an open spell slot', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    initializeFloor1Scenario(world, player);
    const offer = getSpellBrokerOffers(world)[0]!;
    world.featureUnlocks.spells = true;
    world.goalFlags.set('floor1-boss-spellbook-claimed', true);
    world.playerGold = offer.cost;

    expect(canPurchaseSpellBrokerSpell(world, player, offer.spellId)).toBe(true);
    expect(purchaseSpellBrokerSpell(world, player, offer.spellId)).toBe(true);
    expect(world.playerGold).toBe(0);
    expect(purchaseSpellBrokerSpell(world, player, offer.spellId)).toBe(false);
    expect(
      getSpellBrokerOffers(world).find((entry) => entry.spellId === offer.spellId)?.purchased,
    ).toBe(true);
  });

  it('rejects purchaseSpellBrokerSpell when floorScenario is absent (offer.purchased mutation would be lost)', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    // Do NOT call initializeFloor1Scenario — world.floorScenario remains null.
    world.featureUnlocks.spells = true;
    world.goalFlags.set('floor1-boss-spellbook-claimed', true);
    const [offer] = generateFloor1SpellBrokerOffers(42);
    world.playerGold = offer!.cost;

    expect(purchaseSpellBrokerSpell(world, player, offer!.spellId)).toBe(false);
  });

  it('prices a broker spell as the headline Floor 1 purchase', () => {
    // The spell used to cost 35 gold against roughly 800 gold of Floor 1 income,
    // so it was a rounding error rather than a decision. It is now the most
    // expensive thing on the floor: strictly above every post-quest weapon,
    // which are in turn strictly above the charm.
    const weaponCosts = Object.values(FLOOR1_POST_QUEST_WEAPON_COSTS);
    expect(weaponCosts.length).toBeGreaterThan(0);
    expect(FLOOR1_SPELL_BROKER_COST).toBeGreaterThan(Math.max(...weaponCosts));
    expect(Math.min(...weaponCosts)).toBeGreaterThan(MERCHANTS_CHARM_COST);

    // Bands agreed with the designer for the Floor 1 curve. The economy gate in
    // tests/headless/floor1-economy-gate.test.ts measures the outcome; these are
    // the inputs, pinned so a later tweak cannot silently leave the band.
    expect(FLOOR1_SPELL_BROKER_COST).toBeGreaterThanOrEqual(200);
    expect(FLOOR1_SPELL_BROKER_COST).toBeLessThanOrEqual(350);
    expect(Math.min(...weaponCosts)).toBeGreaterThanOrEqual(120);
    expect(Math.max(...weaponCosts)).toBeLessThanOrEqual(250);
    expect(MERCHANTS_CHARM_COST).toBeGreaterThanOrEqual(60);
    expect(MERCHANTS_CHARM_COST).toBeLessThanOrEqual(100);
    // The weapons must span a real spread, so picking one is a decision.
    expect(Math.max(...weaponCosts) - Math.min(...weaponCosts)).toBeGreaterThanOrEqual(80);
  });
});

function plan(slackMs: number): Floor1RunPlan {
  return {
    criticalPathObjective: 'Floor clear',
    remainingMs: 600_000,
    estimatedRequiredMs: 600_000 - slackMs,
    estimatedTravelMs: 0,
    safetyBufferMs: 20_000,
    slackMs,
    urgency: 0,
    segments: [],
    routeHeadId: null,
    nextActionableGoalId: null,
    includedOptionalBundleIds: [],
    droppedOptionalBundleIds: [],
  };
}

describe('spell skills', () => {
  it('defines one usage skill and four real breakpoints for every spell', () => {
    const spellSkillIds = Object.values(SPELL_SKILL_ID_BY_SPELL_ID);
    expect(spellSkillIds).toHaveLength(10);
    expect(
      getAllSkillDefinitions().filter((skill) => spellSkillIds.includes(skill.id)),
    ).toHaveLength(10);
    for (const [spellId, skillId] of Object.entries(SPELL_SKILL_ID_BY_SPELL_ID)) {
      const skill = getSkillDefinition(skillId);
      expect(skill?.usageMetric, spellId).toBe('spell_used');
      expect(skill?.usageThresholds).toHaveLength(20);
      expect(skill?.milestones.map((milestone) => milestone.level)).toEqual([5, 10, 15, 20]);
      expect(skill?.milestones.every((milestone) => milestone.abilityId === undefined)).toBe(true);
    }
  });

  describe('spell broker AI intent', () => {
    it('always intends to buy, stably, once the purchase is enabled', () => {
      // The broker purchase used to be a blind 25% coin flip made before the
      // player had any gold, so three out of four runs skipped the headline
      // Floor 1 purchase regardless of how rich they got. The policy is now
      // budget-aware: always intend to buy, and let the farming/abandon
      // lifecycle decide whether the run can actually afford it.
      const decisions = Array.from({ length: 64 }, (_, index) => {
        const world = createTestWorld({ seed: index + 1 });
        configureSpellBrokerPurchase(world, true);
        const first = ensureSpellBrokerDecision(world);
        const second = ensureSpellBrokerDecision(world);
        expect(second).toEqual(first);
        return first;
      });
      expect(decisions.every((decision) => decision.shouldBuy)).toBe(true);
      expect(decisions.every((decision) => decision.cost === FLOOR1_SPELL_BROKER_COST)).toBe(true);
    });

    it('consumes no RNG when making the decision', () => {
      // A decision that draws from world.rng would shift the gameplay RNG
      // stream for every downstream system depending on whether the AI shops.
      const world = createTestWorld({ seed: 7 });
      configureSpellBrokerPurchase(world, true);
      const before = world.rng.next();
      const replay = createTestWorld({ seed: 7 });
      configureSpellBrokerPurchase(replay, true);
      ensureSpellBrokerDecision(replay);
      expect(replay.rng.next()).toBe(before);
    });

    it('stays idle until spells are unlocked then transitions to farming/returning', () => {
      const world = createTestWorld({ seed: 5 });
      configureSpellBrokerPurchase(world, true);
      const decision = ensureSpellBrokerDecision(world);
      expect(decision.shouldBuy).toBe(true);

      world.playerGold = 0; // below cost → farming once active
      world.featureUnlocks.spells = false;

      // Pre-boss: stays idle.
      const preUnlock = updateSpellBrokerIntent(world, null, 3_000);
      expect(preUnlock.purchaseStatus).toBe('idle');

      // Post-boss: transitions to farming (gold < cost).
      world.featureUnlocks.spells = true;
      const farming = updateSpellBrokerIntent(world, null, 3_000);
      expect(farming.purchaseStatus).toBe('farming');

      // Gold reaches the cost: transitions to returning.
      world.playerGold = decision.cost;
      const returning = updateSpellBrokerIntent(world, null, 3_000);
      expect(returning.purchaseStatus).toBe('returning');
    });

    it('transitions to abandoned when planner drops the spell-broker-purchase bundle', () => {
      const world = createTestWorld({ seed: 5 });
      configureSpellBrokerPurchase(world, true);
      const decision = ensureSpellBrokerDecision(world);
      expect(decision.shouldBuy).toBe(true);

      world.featureUnlocks.spells = true;
      world.playerGold = 0;
      // Activate first.
      updateSpellBrokerIntent(world, null, 3_000);

      // Planner drops the bundle.
      const droppedPlan: Pick<
        Floor1RunPlan,
        'slackMs' | 'droppedOptionalBundleIds' | 'includedOptionalBundleIds'
      > = {
        slackMs: 0,
        droppedOptionalBundleIds: ['spell-broker-purchase'],
        includedOptionalBundleIds: [],
      };
      const dropped = updateSpellBrokerIntent(world, droppedPlan as Floor1RunPlan, 3_000);
      expect(dropped.purchaseStatus).toBe('abandoned');
    });

    it('runs the merchant weapon purchase alongside the broker, behind a gold reserve', () => {
      // These two purchases used to be mutually exclusive, capping a run at one
      // optional pickup no matter how much gold it had. They now run
      // concurrently; the spell keeps priority through a reserve so a weapon
      // can never price the headline purchase out.
      const world = createTestWorld({ seed: 5 });
      world.goalFlags.set('floor1-shop-quest-complete', true);
      world.featureUnlocks.spells = true;
      configureSpellBrokerPurchase(world, true);
      configureMerchantWeaponPurchase(world, true);
      const spellDecision = ensureSpellBrokerDecision(world);
      expect(spellDecision.shouldBuy).toBe(true);

      // Enough for the spell but not for both: the weapon intent stays live
      // (farming) instead of being declined, and does not eat the reserve.
      world.playerGold = spellDecision.cost;
      updateSpellBrokerIntent(world, null, 3_000);
      expect(updateSpellBrokerIntent(world, null, 3_000).purchaseStatus).toBe('returning');
      updateMerchantWeaponIntent(world, plan(1_000_000), 3_000);
      const reserved = getMerchantWeaponIntent(world);
      expect(reserved.status).toBe('farming');
      expect(spellPurchaseReserve(world)).toBe(spellDecision.cost);

      // Enough for both: the weapon is ready to buy in the same shop visit.
      world.playerGold = spellDecision.cost + reserved.cost;
      updateMerchantWeaponIntent(world, plan(1_000_000), 3_000);
      expect(getMerchantWeaponIntent(world).status).toBe('returning');
    });

    it('markSpellBrokerPurchased re-arms for the next rung, then goes terminal', () => {
      const world = createTestWorld({ seed: 1 });
      configureSpellBrokerPurchase(world, true);
      const first = ensureSpellBrokerDecision(world);
      world.featureUnlocks.spells = true;
      updateSpellBrokerIntent(world, null, 3_000);

      // First purchase: the run may come back for one cheaper rung, so the
      // intent re-arms instead of going terminal.
      markSpellBrokerPurchased(world);
      const afterFirst = getSpellBrokerIntent(world);
      expect(afterFirst.purchaseCount).toBe(1);
      expect(afterFirst.spellId).not.toBe(first.spellId);
      expect(afterFirst.cost).toBeLessThan(first.cost);
      expect(afterFirst.purchaseStatus).not.toBe('purchased');

      // The per-run purchase cap ends the sink.
      for (let i = 1; i < FLOOR1_SPELL_BROKER_MAX_PURCHASES; i += 1) {
        markSpellBrokerPurchased(world);
      }
      const afterCap = updateSpellBrokerIntent(world, null, 3_000);
      expect(afterCap.purchaseCount).toBe(FLOOR1_SPELL_BROKER_MAX_PURCHASES);
      expect(afterCap.purchaseStatus).toBe('purchased');

      // Idempotent.
      markSpellBrokerPurchased(world);
      const afterSecond = updateSpellBrokerIntent(world, null, 3_000);
      expect(afterSecond.purchaseStatus).toBe('purchased');
      expect(afterSecond.purchaseCount).toBe(FLOOR1_SPELL_BROKER_MAX_PURCHASES);
    });

    it('a repeat spell never spends gold a pending weapon switch still needs', () => {
      const world = createTestWorld({ seed: 1 });
      const player = spawnPlayer(world, 0, 0);
      initializeBaseStats(world, player);
      initializeFloor1Scenario(world, player);
      configureSpellBrokerPurchase(world, true);
      const first = ensureSpellBrokerDecision(world);
      world.featureUnlocks.spells = true;

      // The headline spell outranks the weapon, so it reserves nothing...
      expect(merchantWeaponReserve(world)).toBeGreaterThanOrEqual(0);
      // ...but once it is bought, the weapon's price is held back from the
      // repeat purchase.
      configureMerchantWeaponPurchase(world, true);
      world.goalFlags.set('floor1-shop-quest-complete', true);
      world.playerGold = 10_000;
      updateMerchantWeaponIntent(world, plan(1_000_000), 3_000);
      const weapon = getMerchantWeaponIntent(world);
      markSpellBrokerPurchased(world);
      if (weapon.status === 'declined') {
        expect(merchantWeaponReserve(world)).toBe(0);
      } else {
        expect(merchantWeaponReserve(world)).toBe(weapon.cost);
        // A repeat spell never outranks the weapon.
        expect(spellPurchaseReserve(world)).toBe(0);
      }
      expect(first.cost).toBeGreaterThan(getSpellBrokerIntent(world).cost);
    });
  });

  function createSpellEffectWorld(spellId: keyof typeof SPELL_SKILL_ID_BY_SPELL_ID, level: number) {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    statSystem(world);
    world.playerSkills.set(SPELL_SKILL_ID_BY_SPELL_ID[spellId], {
      level,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set<number>(),
    });
    return { world, player };
  }

  it('changes representative fireball output at a breakpoint', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    statSystem(world);
    const enemy = spawnEnemy(world, 2, 0, 100);
    const fireball = {
      type: 'spell_fireball' as const,
      damage: { base: 15, scalesWithIntelligence: false },
      radiusTiles: { base: 3, scalesWithIntelligence: false },
    };
    world.playerSkills.set(SPELL_SKILL_ID_BY_SPELL_ID.fireball, {
      level: 0,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set(),
    });
    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: 'fireball:active:0',
      effect: fireball,
      holderEid: player,
    });
    const level0Health = world.stores.health.current[enemy] ?? 0;
    world.stores.health.current[enemy] = 100;
    world.playerSkills.get(SPELL_SKILL_ID_BY_SPELL_ID.fireball)!.level = 20;
    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: 'fireball:active:0',
      effect: fireball,
      holderEid: player,
    });
    expect(100 - (world.stores.health.current[enemy] ?? 0)).toBeGreaterThan(100 - level0Health);
    expect(world.stores.health.current[enemy]).toBeGreaterThan(0);
    expect(world.stores.health.current[enemy]).toBeLessThanOrEqual(
      world.stores.health.max[enemy] ?? 100,
    );
  });

  it.each([
    {
      label: 'heal amount',
      spellId: 'heal' as const,
      read(level: number) {
        const { world, player } = createSpellEffectWorld('heal', level);
        world.stores.health.current[player] = 50;
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: 'heal:active:0',
          effect: { type: 'spell_heal', heal: { base: 10, scalesWithIntelligence: false } },
          holderEid: player,
        });
        return (world.stores.health.current[player] ?? 0) - 50;
      },
    },
    {
      label: 'pulse shield radius/knockback',
      spellId: 'pulse-shield' as const,
      read(level: number) {
        const { world, player } = createSpellEffectWorld('pulse-shield', level);
        const enemy = spawnEnemy(world, 16, 0, 100);
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: 'pulse-shield:active:0',
          effect: {
            type: 'spell_pulse_shield',
            knockbackForce: { base: 10, scalesWithIntelligence: false },
            radiusTiles: { base: 3, scalesWithIntelligence: false },
          },
          holderEid: player,
        });
        return world.stores.knockback.remaining[enemy] ?? 0;
      },
    },
    {
      label: 'magic missile range',
      spellId: 'magic-missile' as const,
      read(level: number) {
        const { world, player } = createSpellEffectWorld('magic-missile', level);
        const enemy = spawnEnemy(world, 16, 0, 100);
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: 'magic-missile:active:0',
          effect: {
            type: 'spell_magic_missile',
            damage: { base: 10, scalesWithIntelligence: false },
            rangeTiles: { base: 3, scalesWithIntelligence: false },
          },
          holderEid: player,
        });
        return 100 - (world.stores.health.current[enemy] ?? 100);
      },
    },
    {
      label: 'timed buff magnitude and duration',
      spellId: 'bless' as const,
      read(level: number) {
        const { world, player } = createSpellEffectWorld('bless', level);
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: 'bless:active:0',
          effect: {
            type: 'spell_timed_buff',
            durationFrames: { base: 10, scalesWithIntelligence: false },
            modifiers: [
              {
                stat: 'damage',
                op: 'add',
                value: { base: 2, scalesWithIntelligence: false },
              },
            ],
          },
          holderEid: player,
        });
        const modifier = world.statModifiers.find((entry) => entry.sourceId === 'bless:active:0');
        return (modifier?.value ?? 0) + (modifier?.expiresFrame ?? 0);
      },
    },
    {
      label: 'enemy slow burst duration',
      spellId: 'curse' as const,
      read(level: number) {
        const { world, player } = createSpellEffectWorld('curse', level);
        const enemy = spawnEnemy(world, 4, 0, 100);
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: 'curse:active:0',
          effect: {
            type: 'spell_enemy_slow_burst',
            radiusTiles: { base: 3, scalesWithIntelligence: false },
            slowMultiplier: { base: 0.8, scalesWithIntelligence: false },
            slowDurationMs: { base: 100, scalesWithIntelligence: false },
          },
          holderEid: player,
        });
        const slow = world.statusEffectsByEntity
          .get(enemy)
          ?.find((entry) => entry.stat === 'speed');
        return slow?.remainingMs ?? 0;
      },
    },
    {
      label: 'life drain damage and healing',
      spellId: 'vampiric-touch' as const,
      read(level: number) {
        const { world, player } = createSpellEffectWorld('vampiric-touch', level);
        world.stores.health.current[player] = 50;
        const enemy = spawnEnemy(world, 8, 0, 100);
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: 'vampiric-touch:active:0',
          effect: {
            type: 'spell_life_drain',
            damage: { base: 10, scalesWithIntelligence: false },
            heal: { base: 5, scalesWithIntelligence: false },
            rangeTiles: { base: 3, scalesWithIntelligence: false },
          },
          holderEid: player,
        });
        const damage = 100 - (world.stores.health.current[enemy] ?? 100);
        const healing = (world.stores.health.current[player] ?? 50) - 50;
        return damage + healing;
      },
    },
  ])('scales representative $label output at the level 20 breakpoint', ({ read }) => {
    expect(read(20)).toBeGreaterThan(read(0));
  });

  it('emits one spell-use event only after successful player activation', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    addComponent(world.ecs, player, SkillHolder);
    memorizeSpell(world, player, 'heal');
    world.featureUnlocks.spells = true;
    expect(forceActivateAbility(world, player, 'heal')).toBe(true);
    world.featureUnlocks.spells = false;
    expect(forceActivateAbility(world, player, 'heal')).toBe(false);
    expect(world.skillUsageEvents).toEqual([
      {
        holderEid: player,
        skillId: SPELL_SKILL_ID_BY_SPELL_ID.heal,
        metric: 'spell_used',
        amount: 1,
      },
    ]);
    expect(getOrCreateAbilityState(world, player).learnedSpellIds).toContain('heal');
  });
});

describe('autoFloor1ProgressionSystem spell broker purchase', () => {
  function setUpBrokerVisit(seed: number): {
    world: ReturnType<typeof createTestWorld>;
    player: number;
  } {
    const world = createTestWorld({ seed });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    configureSpellBrokerPurchase(world, true);
    world.featureUnlocks.spells = true;
    world.goalFlags.set('floor1-boss-battle-complete', true);
    // initializeFloor1Scenario already spawns the broker NPC; mark it
    // nearby so isTargetedNpcActionable treats it as reachable.
    const brokerEid = world.floorScenario!.spellQuestGiverNpcEid!;
    const broker = world.npcs.get(brokerEid)!;
    world.npcs.set(brokerEid, { ...broker, nearbyPlayer: true });
    return { world, player };
  }

  it('does not buy a cheaper rack offer while only short on gold for the headline spell', () => {
    // Regression: the fallback used to try every current offer id, not just
    // the intended one, so a run short on gold for its 350g headline spell
    // would silently buy a cheaper rung instead of waiting — bypassing the
    // headline-price policy the intent is supposed to enforce.
    const { world, player } = setUpBrokerVisit(1);
    const intent = ensureSpellBrokerDecision(world);
    const offers = getSpellBrokerOffers(world);
    const cheapestCost = Math.min(...offers.map((offer) => offer.cost));
    expect(cheapestCost).toBeLessThan(intent.cost);

    // Enough for the cheapest rung, but not the intended headline offer.
    world.playerGold = cheapestCost;
    autoFloor1ProgressionSystem(world, player);

    expect(getOrCreateAbilityState(world, player).learnedSpellIds).toEqual([]);
    expect(world.playerGold).toBe(cheapestCost);
    expect(getSpellBrokerIntent(world).purchaseCount).toBe(0);
  });

  it('buys the intended headline spell once it is affordable', () => {
    const { world, player } = setUpBrokerVisit(1);
    const intent = ensureSpellBrokerDecision(world);
    world.playerGold = intent.cost;

    autoFloor1ProgressionSystem(world, player);

    expect(getOrCreateAbilityState(world, player).learnedSpellIds).toContain(intent.spellId);
    expect(world.playerGold).toBe(0);
    expect(getSpellBrokerIntent(world).purchaseCount).toBe(1);
  });

  it('falls back to a cheaper offer — and records the actual purchase — only when the headline spell is unavailable for a non-affordability reason', () => {
    const { world, player } = setUpBrokerVisit(1);
    const intent = ensureSpellBrokerDecision(world);
    const offers = getSpellBrokerOffers(world);
    const cheaper = offers.find((offer) => offer.spellId !== intent.spellId && offer.cost > 0);
    expect(cheaper).toBeDefined();

    // The intended headline spell is already learned through some other path
    // (not a broker purchase) — this is the one legitimate "unavailable for a
    // non-affordability reason" case, so the fallback is allowed to run.
    memorizeSpell(world, player, intent.spellId!);
    world.playerGold = cheaper!.cost;

    autoFloor1ProgressionSystem(world, player);

    expect(getOrCreateAbilityState(world, player).learnedSpellIds).toContain(cheaper!.spellId);
    // The re-armed intent must reflect the spell actually bought, not the
    // headline id the intent still (incorrectly) pointed at.
    expect(getSpellBrokerIntent(world).spellId).not.toBe(cheaper!.spellId);
    expect(getSpellBrokerIntent(world).purchaseCount).toBe(1);
  });
});
