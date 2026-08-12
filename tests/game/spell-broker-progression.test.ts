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
import { getSpellSkillEfficacyMultiplier } from '../../src/game/systems/progressionEffects.js';
import { applyCatalogEffect } from '../../src/game/systems/progressionEffects.js';
import {
  configureSpellBrokerPurchase,
  ensureSpellBrokerDecision,
  SPELL_BROKER_AI_PURCHASE_CHANCE,
} from '../../src/game/ai/spell-broker-intent.js';
import { getAllSkillDefinitions, getSkillDefinition } from '../../src/game/skills/registry.js';
import {
  FLOOR1_SPELL_BROKER_COST,
  SPELL_SKILL_ID_BY_SPELL_ID,
  SPELL_SKILL_IDS,
  generateFloor1SpellBrokerOffers,
} from '../../src/shared/index.js';

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

  it('keeps the normal budget at one purchase rather than two', () => {
    const representativeBudgets = [35, 38, 42, 46, 50];
    const oneButNotTwo = representativeBudgets.filter(
      (budget) => budget >= FLOOR1_SPELL_BROKER_COST && budget < FLOOR1_SPELL_BROKER_COST * 2,
    );
    expect(oneButNotTwo.length / representativeBudgets.length).toBeGreaterThanOrEqual(0.8);
  });
});

describe('spell skills', () => {
  it('defines one usage skill and four real breakpoints for every spell', () => {
    expect(SPELL_SKILL_IDS).toHaveLength(10);
    expect(
      getAllSkillDefinitions().filter((skill) => SPELL_SKILL_IDS.includes(skill.id)),
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
      expect(SPELL_BROKER_AI_PURCHASE_CHANCE).toBe(0.25);
      expect(bought).toBeGreaterThanOrEqual(200);
      expect(bought).toBeLessThanOrEqual(300);
    });
  });

  it('applies small per-level efficacy and larger breakpoint efficacy', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const skillId = SPELL_SKILL_ID_BY_SPELL_ID.fireball;
    const state = {
      level: 4,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set<number>(),
    };
    world.playerSkills.set(skillId, state);
    const level4 = getSpellSkillEfficacyMultiplier(world, player, 'fireball');
    state.level = 5;
    const level5 = getSpellSkillEfficacyMultiplier(world, player, 'fireball');
    state.level = 20;
    const level20 = getSpellSkillEfficacyMultiplier(world, player, 'fireball');
    expect(level5).toBeGreaterThan(level4);
    expect(level20).toBeGreaterThan(level5);
  });

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
