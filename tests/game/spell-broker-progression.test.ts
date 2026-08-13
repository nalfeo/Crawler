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
  SHOPKEEPER_EQUIPMENT_COST,
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
  markSpellBrokerPurchased,
  updateSpellBrokerIntent,
} from '../../src/game/ai/spell-broker-intent.js';
import type { Floor1RunPlan } from '../../src/game/ai/run-planner.js';
import { getAllSkillDefinitions, getSkillDefinition } from '../../src/game/skills/registry.js';
import {
  FLOOR1_SPELL_BROKER_COST,
  SPELL_SKILL_ID_BY_SPELL_ID,
  generateFloor1SpellBrokerOffers,
} from '../../src/shared/index.js';
import { LOOT_BOX_GOLD_BY_TIER } from '../../src/shared/achievements.js';
import {
  configureMerchantWeaponPurchase,
  getMerchantWeaponIntent,
  updateMerchantWeaponIntent,
} from '../../src/game/ai/merchant-weapon-intent.js';

describe('Floor 1 Spell Broker', () => {
  it('generates three unique deterministic offers from the ten-spell pool', () => {
    const first = generateFloor1SpellBrokerOffers(42);
    expect(first).toEqual(generateFloor1SpellBrokerOffers(42));
    expect(first).toHaveLength(3);
    expect(new Set(first.map((offer) => offer.spellId)).size).toBe(3);
    expect(first.every((offer) => offer.cost === FLOOR1_SPELL_BROKER_COST)).toBe(true);
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

  it('prices a broker spell against the existing Floor 1 shopkeeper gold budget', () => {
    const normalFloor1Budget = SHOPKEEPER_EQUIPMENT_COST + LOOT_BOX_GOLD_BY_TIER.common;
    expect(normalFloor1Budget).toBeGreaterThanOrEqual(FLOOR1_SPELL_BROKER_COST);
    expect(normalFloor1Budget).toBeLessThan(FLOOR1_SPELL_BROKER_COST * 2);
  });
});

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
    it('makes one stable seeded decision with the configured 25% chance', () => {
      const outcomes = Array.from({ length: 1000 }, (_, index) => {
        const world = createTestWorld({ seed: index + 1 });
        configureSpellBrokerPurchase(world, true);
        const first = ensureSpellBrokerDecision(world);
        const second = ensureSpellBrokerDecision(world);
        expect(second).toEqual(first);
        return first.shouldBuy;
      });
      const bought = outcomes.filter(Boolean).length;
      expect(bought).toBeGreaterThanOrEqual(200);
      expect(bought).toBeLessThanOrEqual(300);
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

    it('keeps merchant fallback pending while broker is active, then resumes after broker abandonment', () => {
      const world = createTestWorld({ seed: 5 });
      world.goalFlags.set('floor1-shop-quest-complete', true);
      configureSpellBrokerPurchase(world, true);
      configureMerchantWeaponPurchase(world, true);
      const spellDecision = ensureSpellBrokerDecision(world);
      expect(spellDecision.shouldBuy).toBe(true);

      updateMerchantWeaponIntent(world, null, 3_000);
      expect(getMerchantWeaponIntent(world).status).toBe('pending');

      world.featureUnlocks.spells = true;
      updateSpellBrokerIntent(world, null, 3_000);
      updateSpellBrokerIntent(
        world,
        {
          slackMs: 0,
          droppedOptionalBundleIds: ['spell-broker-purchase'],
          includedOptionalBundleIds: [],
        } as unknown as Floor1RunPlan,
        3_000,
      );
      expect(updateSpellBrokerIntent(world, null, 3_000).purchaseStatus).toBe('abandoned');

      updateMerchantWeaponIntent(world, null, 3_000);
      expect(getMerchantWeaponIntent(world).status).not.toBe('pending');
      expect(getMerchantWeaponIntent(world).status).not.toBe('declined');
    });

    it('markSpellBrokerPurchased sets purchaseStatus to purchased and is idempotent', () => {
      const world = createTestWorld({ seed: 1 });
      configureSpellBrokerPurchase(world, true);
      ensureSpellBrokerDecision(world);
      world.featureUnlocks.spells = true;
      updateSpellBrokerIntent(world, null, 3_000);

      markSpellBrokerPurchased(world);
      const afterMark = updateSpellBrokerIntent(world, null, 3_000);
      expect(afterMark.purchaseStatus).toBe('purchased');

      // Idempotent.
      markSpellBrokerPurchased(world);
      const afterSecond = updateSpellBrokerIntent(world, null, 3_000);
      expect(afterSecond.purchaseStatus).toBe('purchased');
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
