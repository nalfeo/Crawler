import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeEffectiveAccuracyFromValues,
  computeExpectedCritDamage,
  computePlayerScaledDamage,
} from '../../src/core/combat-math.js';
import {
  DEFAULT_EQUIPMENT_ERV_CONFIG,
  computeExpectedWeaponTargets,
  evaluateEquipmentLoadoutCandidates,
  type EquipmentEncounterFixture,
  type EquipmentErvConfig,
  type EquipmentLoadoutCandidate,
  type EquipmentLoadoutSnapshot,
} from '../../src/game/ai/equipment-loadout-evaluator.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { type AbilityGrantSource } from '../../src/shared/abilities.js';
import type { GeneratedEquipmentInstanceV1 } from '../../src/shared/generated-equipment-types.js';
import type { PrimaryStatId, StatId } from '../../src/shared/stats.js';
import { applyAttackSpeedAndCooldownReduction } from '../../src/shared/stats.js';
import { createTestWorld } from '../helpers/world-factory.js';

const BASE_STATS = {
  strength: 10,
  dexterity: 10,
  constitution: 10,
  intelligence: 10,
  wisdom: 10,
  charisma: 10,
  luck: 10,
  armor: 0,
  damageBonus: 0,
  damagePercent: 0,
  attackSpeed: 0,
  moveSpeed: 1,
  critChance: 0,
  critMultiplier: 1.5,
  dodgeChance: 0,
  hpRegen: 1,
  xpBonus: 0,
  cooldownReduction: 0,
  maxHp: 100,
  accuracy: 0,
  pickupRange: 0,
  projectileSpeed: 0,
  projectileCount: 0,
} as const satisfies Readonly<Record<StatId, number>>;

const CORE_STATS = {
  strength: 0,
  dexterity: 0,
  constitution: 0,
  intelligence: 0,
  wisdom: 0,
  charisma: 0,
  luck: 0,
} as const satisfies Readonly<Record<PrimaryStatId, number>>;

const SINGLE_TARGET: EquipmentEncounterFixture = {
  id: 'single-target',
  durationSeconds: 30,
  enemyCount: 1,
  clusteredEnemyCount: 1,
  incomingHitDamage: 8,
  incomingHitsPerSecond: 0.5,
  lowHealthUptime: 0.1,
  skillTriggerRatePerSecond: 1,
};

const CROWD: EquipmentEncounterFixture = {
  ...SINGLE_TARGET,
  id: 'crowd',
  enemyCount: 8,
  clusteredEnemyCount: 6,
};

function generated(
  baseId: string,
  runKey: string,
  seed = 42,
  rarity: 'common' | 'rare' = 'common',
): GeneratedEquipmentInstanceV1 {
  return generateEquipmentInstance(createTestWorld({ seed, generatedEquipmentRunKey: runKey }), {
    baseId,
    itemLevel: 2,
    rarity,
    enhancementLevel: 0,
  });
}

function sourcesFor(equipped: readonly GeneratedEquipmentInstanceV1[]): {
  activeAbilityGrantSources: Map<string, AbilityGrantSource[]>;
  passiveAbilityGrantSources: Map<string, AbilityGrantSource[]>;
} {
  const activeAbilityGrantSources = new Map<string, AbilityGrantSource[]>();
  const passiveAbilityGrantSources = new Map<string, AbilityGrantSource[]>();
  for (const instance of equipped) {
    instance.frozen.abilityGrants.forEach((abilityId, effectOrdinal) => {
      const sources = activeAbilityGrantSources.get(abilityId) ?? [];
      sources.push({ kind: 'generated-equipment', instanceId: instance.instanceId, effectOrdinal });
      activeAbilityGrantSources.set(abilityId, sources);
    });
    instance.frozen.passiveGrants.forEach((abilityId, effectOrdinal) => {
      const sources = passiveAbilityGrantSources.get(abilityId) ?? [];
      sources.push({ kind: 'generated-equipment', instanceId: instance.instanceId, effectOrdinal });
      passiveAbilityGrantSources.set(abilityId, sources);
    });
  }
  return { activeAbilityGrantSources, passiveAbilityGrantSources };
}

function snapshot(
  equipped: readonly GeneratedEquipmentInstanceV1[] = [],
): EquipmentLoadoutSnapshot {
  return {
    equipped,
    baseStats: BASE_STATS,
    coreStatPoints: CORE_STATS,
    ...sourcesFor(equipped),
    equippedActiveAbilityIds: [],
    bodyWeightLb: 180,
  };
}

function candidate(
  instance: GeneratedEquipmentInstanceV1,
  purchaseCost = 0,
): EquipmentLoadoutCandidate {
  return { instance, source: purchaseCost > 0 ? 'shop' : 'inventory', purchaseCost };
}

function config(weights: Partial<EquipmentErvConfig['weights']>): EquipmentErvConfig {
  return {
    ...DEFAULT_EQUIPMENT_ERV_CONFIG,
    weights: { ...DEFAULT_EQUIPMENT_ERV_CONFIG.weights, ...weights },
  };
}

function inputShape(
  equipped: readonly GeneratedEquipmentInstanceV1[],
  candidates: readonly EquipmentLoadoutCandidate[],
  encounters: readonly EquipmentEncounterFixture[] = [SINGLE_TARGET],
) {
  return {
    current: snapshot(equipped),
    candidates,
    remainingEncounters: encounters,
    affinityTagWeights: {},
  };
}

function mutableInputFingerprint(
  equipped: readonly GeneratedEquipmentInstanceV1[],
  candidates: readonly EquipmentLoadoutCandidate[],
): string {
  return JSON.stringify({
    equipped: equipped.map((instance) => instance.fingerprint),
    candidates: candidates.map(({ instance, source, purchaseCost }) => ({
      fingerprint: instance.fingerprint,
      source,
      purchaseCost,
    })),
  });
}

describe('equipment loadout expected-run-value evaluator', () => {
  it('ranks equivalent candidate sets independently of input order with stable ties', () => {
    const pistol = candidate(generated('plasma-pistol', 'erv-order-pistol'));
    const fireball = candidate(generated('fireball', 'erv-order-fireball'));
    const sword = candidate(generated('iron-sword', 'erv-order-sword'));
    const forward = evaluateEquipmentLoadoutCandidates(
      inputShape([], [pistol, fireball, sword], [SINGLE_TARGET, CROWD]),
    );
    const reverse = evaluateEquipmentLoadoutCandidates(
      inputShape([], [sword, fireball, pistol], [SINGLE_TARGET, CROWD]),
    );

    expect(forward.ranked.map((entry) => entry.candidate.instance.instanceId)).toEqual(
      reverse.ranked.map((entry) => entry.candidate.instance.instanceId),
    );
    expect(forward.ranked.map((entry) => entry.score)).toEqual(
      reverse.ranked.map((entry) => entry.score),
    );
  });

  it('separates AOE encounter fit from single-target offense', () => {
    const pistol = candidate(generated('plasma-pistol', 'erv-aoe-pistol'));
    const fireball = candidate(generated('fireball', 'erv-aoe-fireball'));
    const result = evaluateEquipmentLoadoutCandidates(inputShape([], [pistol, fireball], [CROWD]));
    const byBaseId = new Map(
      result.ranked.map((entry) => [entry.candidate.instance.baseId, entry]),
    );

    expect(byBaseId.get('fireball')?.components.encounterFit).toBeGreaterThan(0);
    expect(
      (byBaseId.get('fireball')?.components.encounterFit ?? 0) /
        (byBaseId.get('fireball')?.components.offense ?? 1),
    ).toBeGreaterThan(
      (byBaseId.get('plasma-pistol')?.components.encounterFit ?? 0) /
        (byBaseId.get('plasma-pistol')?.components.offense ?? 1),
    );
    expect(byBaseId.get('plasma-pistol')?.components.offense).toBeGreaterThan(0);
  });

  it('models every realized beam tick in weapon offense', () => {
    const laser = generated('laser', 'erv-beam-ticks');
    const result = evaluateEquipmentLoadoutCandidates(inputShape([], [candidate(laser)]))
      .ranked[0]!;
    const weapon = laser.frozen.activeWeaponSnapshot!;
    const stats = result.nextScore.effectiveStats;
    const damage = computeExpectedCritDamage(
      computePlayerScaledDamage(weapon.baseDamage, stats, {
        affinity: 'physical',
        scaleWithPrimary: true,
      }),
      stats.critChance,
      stats.critMultiplier,
    );
    const accuracy = computeEffectiveAccuracyFromValues(
      weapon.weaponType,
      weapon.baseAccuracy,
      stats.accuracy,
    );
    const cooldownMs = applyAttackSpeedAndCooldownReduction(
      weapon.cooldownMs,
      stats.attackSpeed,
      stats.cooldownReduction,
    );
    const beamTicks = 1 + Math.floor(weapon.durationMs / weapon.beamTickMs);
    const expectedDps = (damage * accuracy * beamTicks * 1_000) / cooldownMs;

    expect(result.nextScore.components.offense).toBeCloseTo(
      expectedDps * SINGLE_TARGET.durationSeconds,
      10,
    );
  });

  it('does not count arena-wall bounces as additional enemy targets', () => {
    const pistol = generated('plasma-pistol', 'erv-wall-bounces');
    const spreadTargets: EquipmentEncounterFixture = {
      ...SINGLE_TARGET,
      enemyCount: 30,
      clusteredEnemyCount: 1,
    };
    const weapon = {
      ...pistol.frozen.activeWeaponSnapshot!,
      pierce: 2,
      bounceCount: 6,
    };

    expect(computeExpectedWeaponTargets(weapon, spreadTargets)).toBe(3);
  });

  it('caps skill-triggered activations by both event rate and cooldown capacity', () => {
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([]),
      activeAbilityGrantSources: new Map([['battle-focus', [{ kind: 'learned' }]]]),
      equippedActiveAbilityIds: ['battle-focus'],
    };
    const helm = candidate(generated('iron-helm', 'erv-skill-trigger-rate'));
    const lowRate = evaluateEquipmentLoadoutCandidates({
      ...inputShape([], [helm], [{ ...SINGLE_TARGET, skillTriggerRatePerSecond: 0.001 }]),
      current,
    }).ranked[0]!.nextScore.components.activeAbility;
    const highRate = evaluateEquipmentLoadoutCandidates({
      ...inputShape([], [helm], [{ ...SINGLE_TARGET, skillTriggerRatePerSecond: 100 }]),
      current,
    }).ranked[0]!.nextScore.components.activeAbility;

    expect(lowRate).toBeGreaterThan(0);
    expect(highRate).toBeGreaterThan(lowRate * 1_000);
  });

  it('does not value extra projectiles until runtime consumes projectileCount', () => {
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([]),
      passiveAbilityGrantSources: new Map([['juggling-arsenal', [{ kind: 'learned' }]]]),
    };
    const result = evaluateEquipmentLoadoutCandidates({
      ...inputShape([], [candidate(generated('throwing-knife', 'erv-extra-projectile-runtime'))]),
      current,
    });

    expect(result.ranked[0]?.nextScore.components.passiveAbility).toBe(0);
  });

  it('models source-owned active and passive grants without mutating configuration', () => {
    const activeGrant = generated('band-of-fortune', 'erv-active-grant', 2, 'rare');
    const passiveGrant = generated('band-of-fortune', 'erv-passive-grant', 1, 'rare');
    const active = evaluateEquipmentLoadoutCandidates(inputShape([], [candidate(activeGrant)]))
      .ranked[0]!;
    const passive = evaluateEquipmentLoadoutCandidates(inputShape([], [candidate(passiveGrant)]))
      .ranked[0]!;

    expect(active.configuredActiveAbilityIds).toEqual(['fireball']);
    expect(active.blockedActiveAbilityIds).toEqual([]);
    expect(active.nextScore.components.activeAbility).toBeGreaterThan(0);
    expect(passive.nextScore.availablePassiveAbilityIds).toEqual(['veteran-instinct']);
    expect(snapshot([]).equippedActiveAbilityIds).toEqual([]);
  });

  it('preserves learned and skill grant sources while evaluating generated equipment', () => {
    const activeSources: AbilityGrantSource[] = [{ kind: 'learned' }];
    const passiveSources: AbilityGrantSource[] = [{ kind: 'skill', skillId: 'unarmed' }];
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([]),
      activeAbilityGrantSources: new Map([['fireball', activeSources]]),
      passiveAbilityGrantSources: new Map([['veteran-instinct', passiveSources]]),
      equippedActiveAbilityIds: ['fireball'],
    };
    const result = evaluateEquipmentLoadoutCandidates({
      ...inputShape([], [candidate(generated('iron-helm', 'erv-non-equipment-sources'))]),
      current,
    });

    expect(result.ranked[0]?.currentScore.equippedActiveAbilityIds).toEqual(['fireball']);
    expect(result.ranked[0]?.nextScore.equippedActiveAbilityIds).toEqual(['fireball']);
    expect(result.ranked[0]?.nextScore.availablePassiveAbilityIds).toEqual(['veteran-instinct']);
    expect(activeSources).toEqual([{ kind: 'learned' }]);
    expect(passiveSources).toEqual([{ kind: 'skill', skillId: 'unarmed' }]);
  });

  it('removes equipment-kind sources when their generated instance is displaced', () => {
    const equipped = generated('iron-helm', 'erv-legacy-source-current');
    const replacement = generated('iron-helm', 'erv-legacy-source-replacement');
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([equipped]),
      activeAbilityGrantSources: new Map([
        ['fireball', [{ kind: 'equipment', instanceId: equipped.instanceId }]],
      ]),
      equippedActiveAbilityIds: ['fireball'],
    };
    const result = evaluateEquipmentLoadoutCandidates({
      ...inputShape([equipped], [candidate(replacement)]),
      current,
    }).ranked[0]!;

    expect(result.displacedInstanceIds).toEqual([equipped.instanceId]);
    expect(result.nextScore.equippedActiveAbilityIds).toEqual([]);
  });

  it('exposes defensive, encumbrance, displacement, and purchase opportunity costs', () => {
    const currentWeapon = generated('bone-club', 'erv-current-club');
    const current = [
      currentWeapon,
      generated('iron-helm', 'erv-current-helm'),
      generated('steel-pauldrons', 'erv-current-shoulders'),
      generated('travelers-cloak', 'erv-current-cloak'),
      generated('iron-greaves', 'erv-current-greaves'),
      generated('sturdy-belt', 'erv-current-belt'),
      generated('iron-visor', 'erv-current-visor'),
      generated('leather-gloves', 'erv-current-gloves'),
    ];
    const armor = generated('iron-breastplate', 'erv-armor');
    const defensive = evaluateEquipmentLoadoutCandidates({
      ...inputShape(current, [candidate(armor)], [SINGLE_TARGET]),
      current: {
        ...snapshot(current),
        baseStats: { ...BASE_STATS, strength: 0 },
      },
      config: config({
        defense: 3,
        encumbrance: 4,
      }),
    }).ranked[0]!;
    const pistol = generated('plasma-pistol', 'erv-opportunity-pistol');
    const transition = evaluateEquipmentLoadoutCandidates({
      ...inputShape(current, [candidate(pistol, 25)], [SINGLE_TARGET]),
      config: config({ purchaseCost: 2 }),
    }).ranked[0]!;

    expect(defensive.components.defense).toBeGreaterThan(0);
    expect(defensive.components.encumbrance).toBeLessThan(0);
    expect(transition.displacedInstanceIds).toEqual([currentWeapon.instanceId]);
    expect(transition.components.purchaseCost).toBe(-50);
    expect(transition.score).toBeCloseTo(
      transition.nextScore.total - transition.currentScore.total - 50,
      10,
    );
    expect(transition.score).toBeCloseTo(
      transition.candidateContribution - transition.displacementCost - 50,
      10,
    );
  });

  it('filters duplicate candidate transitions while retaining the first legal transition', () => {
    const pistol = candidate(generated('plasma-pistol', 'erv-duplicate'));
    const result = evaluateEquipmentLoadoutCandidates(inputShape([], [pistol, pistol]));

    expect(result.ranked).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reasons).toContain(
      `duplicate candidate ${pistol.instance.instanceId}`,
    );
  });

  it('does not let an invalid occurrence consume the first legal candidate transition', () => {
    const pistol = candidate(generated('plasma-pistol', 'erv-invalid-before-valid'));
    const result = evaluateEquipmentLoadoutCandidates(
      inputShape([], [{ ...pistol, purchaseCost: -1 }, pistol]),
    );

    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]?.candidate.instance.instanceId).toBe(pistol.instance.instanceId);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reasons).toEqual([
      'purchaseCost must be a finite non-negative number',
    ]);
  });

  it('replays finite results without mutating inputs', () => {
    const equipped = [generated('iron-sword', 'erv-replay-current')];
    const candidates = [
      candidate(generated('plasma-pistol', 'erv-replay-pistol'), 5),
      candidate(generated('fireball', 'erv-replay-fireball'), 7),
    ];
    const input = inputShape(equipped, candidates, [SINGLE_TARGET, CROWD]);
    const before = mutableInputFingerprint(equipped, candidates);
    const first = evaluateEquipmentLoadoutCandidates(input);
    const second = evaluateEquipmentLoadoutCandidates(input);

    expect(second).toEqual(first);
    expect(first.ranked.every((entry) => Number.isFinite(entry.score))).toBe(true);
    expect(mutableInputFingerprint(equipped, candidates)).toBe(before);
  });

  it('preserves finiteness, replay, non-mutation, and order independence over costs', () => {
    const candidates = [
      candidate(generated('plasma-pistol', 'erv-property-pistol')),
      candidate(generated('fireball', 'erv-property-fireball')),
    ];

    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({ min: 0, max: 10_000, noNaN: true }),
          fc.double({ min: 0, max: 10_000, noNaN: true }),
        ),
        ([firstCost, secondCost]) => {
          const priced = [
            { ...candidates[0]!, purchaseCost: firstCost },
            { ...candidates[1]!, purchaseCost: secondCost },
          ];
          const before = mutableInputFingerprint([], priced);
          const forward = evaluateEquipmentLoadoutCandidates(
            inputShape([], priced, [SINGLE_TARGET, CROWD]),
          );
          const reverse = evaluateEquipmentLoadoutCandidates(
            inputShape([], [...priced].reverse(), [SINGLE_TARGET, CROWD]),
          );

          expect(forward).toEqual(
            evaluateEquipmentLoadoutCandidates(inputShape([], priced, [SINGLE_TARGET, CROWD])),
          );
          expect(forward.ranked.map((entry) => entry.candidate.instance.instanceId)).toEqual(
            reverse.ranked.map((entry) => entry.candidate.instance.instanceId),
          );
          expect(forward.ranked.every((entry) => Number.isFinite(entry.score))).toBe(true);
          expect(mutableInputFingerprint([], priced)).toBe(before);
        },
      ),
      { numRuns: 50 },
    );
  });
});
