import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { applyDamage } from '../../src/core/apply-damage.js';
import { Companion, EnemyProjectile, PartySlot, Team } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import {
  companionLearnedAbilityIds,
  companionProgressionSystem,
} from '../../src/core/systems/companionProgressionSystem.js';
import { selectFloor3LoadoutOption } from '../../src/game/floor3Scenario.js';
import { companionAISystem } from '../../src/game/systems/companionAISystem.js';
import {
  companionCombatSystem,
  getCompanionAttackState,
} from '../../src/game/systems/companionCombatSystem.js';
import { TeamId } from '../../src/shared/constants.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';
import { createTestWorld } from '../helpers/world-factory.js';

type TestWorld = ReturnType<typeof createTestWorld>;

/** Exercise the actual poach stat resolver without unrelated map encounters. */
function recruit(speciesId = 'ember-charger', level = 1) {
  const world = createTestWorld({ seed: 42, floor: 3 });
  world.floorId = 'floor3';
  spawnPlayer(world, 0, 0);
  world.state = 'loadout';
  // The shipped starter begins at L25; poach's explicit roster level exercises
  // the same production stat resolver for babies and adults alike.
  world.floorExtendedState = {
    floor3PoachOffer: {
      encounterId: 'growth-fixture',
      encounterName: 'Growth fixture',
      candidates: [{ speciesId, level }],
      slotsRemaining: 6,
    },
  };
  selectFloor3LoadoutOption(world, 0);
  const eid = query(world.ecs, [Companion, PartySlot])[0]!;
  expect(eid).toBeDefined();
  return { world, eid };
}

/** Prime the next milestone, then earn it through the real combat-credit ledger. */
function earnLevel(world: TestWorld, eid: number, level: number): void {
  world.stores.companion.xp[eid] = xpRequiredForLevel(level - 1) - 1;
  const target = spawnEnemy(world, 100, 100, 1);
  applyDamage(world, target, 1, 100, 100, {
    origin: 'enemy',
    affinity: 'physical',
    sourceEid: eid,
    scaleWithPrimary: false,
    canCrit: false,
  });
  expect(world.companionDamageContribution.get(target)?.get(eid)).toBe(1);
  companionProgressionSystem(world);
  expect(world.stores.companion.level[eid]).toBe(level);
  expect(world.companionDamageContribution.has(target)).toBe(false);
}

function stats(world: TestWorld, eid: number): number[] {
  return [
    world.stores.health.max[eid]!,
    world.stores.health.current[eid]!,
    world.stores.enemyBehavior.speed[eid]!,
    world.stores.enemyBehavior.attackRange[eid]!,
    world.stores.sprite.sizeScale[eid]!,
  ];
}

function nearbyTarget(world: TestWorld, eid: number): number {
  const target = spawnEnemy(
    world,
    world.stores.position.x[eid]! + 1,
    world.stores.position.y[eid]!,
    10_000,
  );
  addComponent(world.ecs, target, set(Team, { id: TeamId.ENEMY }));
  return target;
}

function automaticHit(world: TestWorld, target: number): number {
  const before = world.stores.health.current[target]!;
  companionAISystem(world);
  companionCombatSystem(world);
  return before - world.stores.health.current[target]!;
}

function firstAttackDamage(world: TestWorld, eid: number): number {
  const damage = automaticHit(world, nearbyTarget(world, eid));
  const projectile = query(world.ecs, [EnemyProjectile])[0];
  return projectile === undefined ? damage : world.stores.damage.amount[projectile]!;
}

describe('Floor 3 live companion form growth', () => {
  it.each(['ember-charger', 'ember-slinger'])(
    '%s has equivalent production stats when recruited adult or evolved 1 → 10 → 25',
    (speciesId) => {
      const evolved = recruit(speciesId);
      const baby = stats(evolved.world, evolved.eid);
      earnLevel(evolved.world, evolved.eid, 10);
      expect(evolved.world.stores.companion.form[evolved.eid]).toBe(1);
      earnLevel(evolved.world, evolved.eid, 25);
      const adult = recruit(speciesId, 25);
      const expected = stats(adult.world, adult.eid);
      const actual = stats(evolved.world, evolved.eid);
      actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 4));
      expect(actual[0]).toBeCloseTo(baby[0]! * 2.4, 4);
      expect(actual[2]).toBeCloseTo(baby[2]! * Math.sqrt(2.4), 4);
      expect(actual[4]).toBeCloseTo(baby[4]! * Math.sqrt(2.4), 4);
      expect(evolved.world.stores.companion.form[evolved.eid]).toBe(2);
      if (speciesId === 'ember-charger') {
        expect(actual[3]).toBe(0); // AI's melee marker must survive evolution.
      } else {
        expect(baby[3]).toBeGreaterThan(0);
        expect(actual[3]).toBeCloseTo(baby[3]! * Math.sqrt(2.4), 4);
      }
      const evolvedDamage = firstAttackDamage(evolved.world, evolved.eid);
      expect(evolvedDamage).toBeGreaterThan(0);
      expect(evolvedDamage).toBeCloseTo(firstAttackDamage(adult.world, adult.eid), 4);
    },
  );

  it('preserves the wounded health fraction through both form thresholds', () => {
    const { world, eid } = recruit();
    world.stores.health.current[eid] = world.stores.health.max[eid]! * 0.35;
    for (const level of [10, 25]) {
      earnLevel(world, eid, level);
      expect(world.stores.health.current[eid]! / world.stores.health.max[eid]!).toBeCloseTo(
        0.35,
        6,
      );
    }
  });

  it.each([
    { current: 0, knockedOut: 0, label: 'same-tick death' },
    { current: 1, knockedOut: 1, label: 'KO sentinel' },
  ])('does not revive a $label when previously dealt damage earns merit XP', (state) => {
    const { world, eid } = recruit();
    const maximum = world.stores.health.max[eid]!;
    world.stores.health.current[eid] = state.current;
    world.stores.companion.knockedOut[eid] = state.knockedOut;
    earnLevel(world, eid, 10);
    expect(world.stores.health.max[eid]).toBeCloseTo(maximum * 1.6, 4);
    expect(world.stores.health.current[eid]).toBe(state.current);
    expect(world.stores.companion.knockedOut[eid]).toBe(state.knockedOut);
  });

  it('a multi-milestone XP jump enables all four learned attacks in automatic combat', () => {
    const { world, eid } = recruit();
    expect(companionLearnedAbilityIds(world, eid)).toEqual(['f3.ember-charger.l1']);
    earnLevel(world, eid, 25);
    const learned = companionLearnedAbilityIds(world, eid);
    expect(learned).toEqual([
      'f3.ember-charger.l1',
      'f3.ember-charger.l8',
      'f3.ember-charger.l16',
      'f3.ember-charger.l25',
    ]);
    const target = nearbyTarget(world, eid);
    const observed: Array<string | undefined> = [];
    const damage: number[] = [];
    for (let attack = 0; attack < learned.length; attack++) {
      world.elapsedMs = attack * 10_000;
      damage.push(automaticHit(world, target));
      observed.push(getCompanionAttackState(world, eid)?.lastAbilityId);
    }
    expect(observed).toEqual(learned);
    expect(damage[0]).toBeCloseTo(30 * 2.4, 4);
    expect(damage[3]).toBeGreaterThan(damage[0]!);
  });

  it('does not apply Floor 3 stat or automatic attack growth to a Floor 4 kept companion', () => {
    const { world, eid } = recruit();
    world.floorId = 'floor4';
    const before = stats(world, eid);
    const target = nearbyTarget(world, eid);
    const babyDamage = automaticHit(world, target);
    expect(babyDamage).toBeGreaterThan(0);
    earnLevel(world, eid, 25);
    expect(stats(world, eid)).toEqual(before);
    world.elapsedMs += 10_000;
    expect(automaticHit(world, target)).toBe(babyDamage);
    expect(getCompanionAttackState(world, eid)?.lastAbilityId).toBeUndefined();
  });
});
