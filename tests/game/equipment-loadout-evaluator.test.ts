import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeEffectiveAccuracyFromValues,
  computeExpectedCritDamage,
  computePlayerScaledDamage,
} from '../../src/core/combat-math.js';
import {
  computeActiveWeaponSnapshotFingerprint,
  computeEquipmentFingerprint,
} from '../../src/core/generated-equipment-registry.js';
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
import {
  equipmentAbilityGrantSourceId,
  learnedAbilityGrantSourceId,
  skillAbilityGrantSourceId,
  type AbilityGrantSourceId,
} from '../../src/shared/abilities.js';
import { WeaponType } from '../../src/shared/constants.js';
import type { GeneratedEquipmentInstanceV1 } from '../../src/shared/generated-equipment-types.js';
import type { PrimaryStatId, StatId } from '../../src/shared/stats.js';
import {
  applyAttackSpeedAndCooldownReduction,
  applyCooldownReduction,
} from '../../src/shared/stats.js';
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
  activeAbilityGrantSources: Map<string, AbilityGrantSourceId[]>;
  passiveAbilityGrantSources: Map<string, AbilityGrantSourceId[]>;
} {
  const activeAbilityGrantSources = new Map<string, AbilityGrantSourceId[]>();
  const passiveAbilityGrantSources = new Map<string, AbilityGrantSourceId[]>();
  for (const instance of equipped) {
    instance.frozen.abilityGrants.forEach((abilityId, effectOrdinal) => {
      const sources = activeAbilityGrantSources.get(abilityId) ?? [];
      sources.push(equipmentAbilityGrantSourceId(instance.instanceId, effectOrdinal));
      activeAbilityGrantSources.set(abilityId, sources);
    });
    instance.frozen.passiveGrants.forEach((abilityId, effectOrdinal) => {
      const sources = passiveAbilityGrantSources.get(abilityId) ?? [];
      sources.push(equipmentAbilityGrantSourceId(instance.instanceId, effectOrdinal));
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

function expectedSingleHitDps(
  instance: GeneratedEquipmentInstanceV1,
  stats: Readonly<Record<StatId, number>>,
): number {
  const weapon = instance.frozen.activeWeaponSnapshot!;
  const damage = computeExpectedCritDamage(
    computePlayerScaledDamage(weapon.baseDamage, stats, {
      affinity: weapon.weaponType === WeaponType.MAGIC ? 'magic' : 'physical',
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
  return (damage * accuracy * 1_000) / cooldownMs;
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

  it('scores and reports static baselines separately from generated equipment', () => {
    const replacement = candidate(generated('plasma-pistol', 'erv-static-replacement', 42, 'rare'));
    const withStatic = evaluateEquipmentLoadoutCandidates({
      ...inputShape([], [replacement]),
      current: {
        ...snapshot(),
        staticEquipped: [
          {
            equipmentInstanceId: 101,
            slots: ['mainHand'],
            tags: ['weapon', 'physical'],
            weightLb: 2,
            statBonuses: { dexterity: 3 },
            weaponId: 'pistol',
          },
        ],
      },
    }).ranked[0]!;
    const generatedOnly = evaluateEquipmentLoadoutCandidates(inputShape([], [replacement]))
      .ranked[0]!;

    expect(withStatic.currentScore.total).not.toBe(generatedOnly.currentScore.total);
    expect(withStatic.displacedInstanceIds).toEqual([]);
    expect(withStatic.displacedStaticEquipmentInstanceIds).toEqual([101]);
    expect(withStatic.displacementCost).toBeGreaterThan(0);
    expect(withStatic.score).toBeLessThan(generatedOnly.score);
  });

  it('rejects malformed static baselines and preserves generated-only snapshots when omitted', () => {
    const helm = candidate(generated('iron-helm', 'erv-static-validation'));
    const input = inputShape([], [helm]);
    expect(evaluateEquipmentLoadoutCandidates(input)).toEqual(
      evaluateEquipmentLoadoutCandidates({
        ...input,
        current: { ...input.current, staticEquipped: [] },
      }),
    );
    expect(() =>
      evaluateEquipmentLoadoutCandidates({
        ...input,
        current: {
          ...input.current,
          staticEquipped: [
            {
              equipmentInstanceId: 1,
              slots: ['mainHand'],
              weightLb: Number.NaN,
              statBonuses: {},
              weaponId: null,
            },
          ],
        },
      }),
    ).toThrow('weightLb must be a finite number');
  });

  it('separates AOE encounter fit from single-target offense', () => {
    const pistol = candidate(generated('plasma-pistol', 'erv-aoe-pistol'));
    const fireball = candidate(generated('fireball', 'erv-aoe-fireball'));
    const result = evaluateEquipmentLoadoutCandidates(inputShape([], [pistol, fireball], [CROWD]));
    const byBaseId = new Map(
      result.ranked.map((entry) => [entry.candidate.instance.baseId, entry]),
    );
    const fireballResult = byBaseId.get('fireball')!;

    expect(fireballResult.components.offense).toBeGreaterThan(0);
    expect(fireballResult.components.encounterFit / fireballResult.components.offense).toBeCloseTo(
      (CROWD.clusteredEnemyCount - 1) / 2,
      10,
    );
    expect(byBaseId.get('plasma-pistol')?.components.offense).toBeGreaterThan(0);
  });

  it('uses the runtime area predicate for affinity tags', () => {
    const laser = candidate(generated('laser', 'erv-area-affinity'));
    const input = inputShape([], [laser]);
    const result = evaluateEquipmentLoadoutCandidates({
      ...input,
      affinityTagWeights: { aoe: 7, 'single-target': -7 },
    });

    expect(result.ranked[0]?.nextScore.components.affinity).toBe(7);
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

  it.each([
    ['fireball impact and splash', 'fireball', false],
    ['returning projectile outbound and return', 'plasma-pistol', true],
  ])('models both realized primary hits for %s', (_label, baseId, returning) => {
    const generatedInstance = generated(baseId, `erv-multi-stage-${baseId}`);
    let instance = generatedInstance;
    if (returning) {
      const { fingerprint: _snapshotFingerprint, ...snapshotWithoutFingerprint } =
        generatedInstance.frozen.activeWeaponSnapshot!;
      const returningSnapshotWithoutFingerprint = {
        ...snapshotWithoutFingerprint,
        returnSpeed: 500,
        maxRange: 300,
      };
      const returningSnapshot = {
        ...returningSnapshotWithoutFingerprint,
        fingerprint: computeActiveWeaponSnapshotFingerprint(returningSnapshotWithoutFingerprint),
      };
      const { fingerprint: _instanceFingerprint, ...instanceWithoutFingerprint } =
        generatedInstance;
      const returningInstanceWithoutFingerprint = {
        ...instanceWithoutFingerprint,
        frozen: {
          ...generatedInstance.frozen,
          activeWeaponSnapshot: returningSnapshot,
        },
      };
      instance = {
        ...returningInstanceWithoutFingerprint,
        fingerprint: computeEquipmentFingerprint(returningInstanceWithoutFingerprint),
      };
    }
    const result = evaluateEquipmentLoadoutCandidates(inputShape([], [candidate(instance)]))
      .ranked[0]!;
    const expectedDps = expectedSingleHitDps(instance, result.nextScore.effectiveStats) * 2;

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

  it('fractionally values a persistent activation then caps it at one applied modifier', () => {
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([]),
      activeAbilityGrantSources: new Map([
        ['battle-focus', [learnedAbilityGrantSourceId('battle-focus')]],
      ]),
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

    expect(lowRate).toBeCloseTo(0.15 * 0.001 * SINGLE_TARGET.durationSeconds, 10);
    expect(highRate).toBeCloseTo(0.15, 10);
  });

  it('excludes runtime-inert stats from timed-buff value', () => {
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([]),
      activeAbilityGrantSources: new Map([['haste', [learnedAbilityGrantSourceId('haste')]]]),
      equippedActiveAbilityIds: ['haste'],
    };
    const result = evaluateEquipmentLoadoutCandidates({
      ...inputShape([], [candidate(generated('iron-helm', 'erv-live-timed-buff'))]),
      current,
    }).ranked[0]!;
    const expectedActivations =
      (SINGLE_TARGET.durationSeconds * 60) /
      applyCooldownReduction(1_080, result.nextScore.effectiveStats.cooldownReduction);

    expect(result.nextScore.components.activeAbility).toBeCloseTo(0.125 * expectedActivations, 10);
  });

  it('awards no weapon offense when an encounter has no targets', () => {
    const noTargets: EquipmentEncounterFixture = {
      ...SINGLE_TARGET,
      enemyCount: 0,
      clusteredEnemyCount: 0,
    };
    const result = evaluateEquipmentLoadoutCandidates(
      inputShape([], [candidate(generated('iron-sword', 'erv-empty-encounter'))], [noTargets]),
    ).ranked[0]!;

    expect(result.nextScore.components.offense).toBe(0);
    expect(result.nextScore.components.encounterFit).toBe(0);
  });

  it('does not value extra projectiles until runtime consumes projectileCount', () => {
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([]),
      passiveAbilityGrantSources: new Map([
        ['juggling-arsenal', [learnedAbilityGrantSourceId('juggling-arsenal')]],
      ]),
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
    const activeSources: AbilityGrantSourceId[] = [learnedAbilityGrantSourceId('fireball')];
    const passiveSources: AbilityGrantSourceId[] = [skillAbilityGrantSourceId('unarmed', 0)];
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
    expect(activeSources).toEqual([learnedAbilityGrantSourceId('fireball')]);
    expect(passiveSources).toEqual([skillAbilityGrantSourceId('unarmed', 0)]);
  });

  it('removes equipment-kind sources when their generated instance is displaced', () => {
    const equipped = generated('iron-helm', 'erv-legacy-source-current');
    const replacement = generated('iron-helm', 'erv-legacy-source-replacement');
    const current: EquipmentLoadoutSnapshot = {
      ...snapshot([equipped]),
      activeAbilityGrantSources: new Map([
        ['fireball', [equipmentAbilityGrantSourceId(equipped.instanceId, 0)]],
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
    // Use incomingHitDamage=20 so armor still has room to reduce damage after
    // the current loadout's armor is accounted for. Under the decoupled model,
    // accessories (travelers-cloak, sturdy-belt, leather-gloves) contribute
    // zero armor; only armor-kind bases (iron-helm=2, steel-pauldrons=2,
    // iron-greaves=3, iron-visor=1) total=8 contribute. At incomingHitDamage=8
    // defense is already at the min-1 floor, so we need a higher fixture.
    const defensiveEncounter = { ...SINGLE_TARGET, incomingHitDamage: 20 };
    const defensive = evaluateEquipmentLoadoutCandidates({
      ...inputShape(current, [candidate(armor)], [defensiveEncounter]),
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

  it.each([
    ['base stat', { baseStats: { ...BASE_STATS, strength: Number.NaN } }],
    ['core stat point', { coreStatPoints: { ...CORE_STATS, strength: Number.POSITIVE_INFINITY } }],
  ])('rejects a non-finite %s before scoring', (_label, currentOverride) => {
    const input = inputShape([], [candidate(generated('iron-helm', 'erv-non-finite-stats'))]);

    expect(() =>
      evaluateEquipmentLoadoutCandidates({
        ...input,
        current: { ...input.current, ...currentOverride },
      }),
    ).toThrow('must be a finite number');
  });

  it('rejects finite inputs whose derived score overflows', () => {
    const input = inputShape([], [candidate(generated('iron-sword', 'erv-overflow'))]);

    expect(() =>
      evaluateEquipmentLoadoutCandidates({
        ...input,
        current: {
          ...input.current,
          baseStats: {
            ...BASE_STATS,
            damageBonus: Number.MAX_VALUE,
            damagePercent: Number.MAX_VALUE,
          },
        },
      }),
    ).toThrow('$.score.components.offense must be a finite number');
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
