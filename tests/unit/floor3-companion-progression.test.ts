import { addComponent, removeEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, Team } from '../../src/core/components.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { clearEntityStores } from '../../src/core/spawners/entity-core.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { applyDamage, type DamageOptions } from '../../src/core/apply-damage.js';
import {
  companionLearnedAbilityIds,
  companionProgressionSystem,
} from '../../src/core/systems/companionProgressionSystem.js';
import { AI_TYPE } from '../../src/game/index.js';
import { TeamId } from '../../src/shared/constants.js';
import { speciesTokenForId } from '../../src/shared/data/floor3/species.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Floor 3 slice 5 — combat-XP attribution, per-creature evolution, and
 * ability unlocks (ADR 0071, `.specify/specs/floor3-companion-league.md`
 * R7). `companionProgressionSystem` is wired into `runCoreSimulationStep`
 * (see `src/core/simulation-core-step.ts`), the same shared pipeline used by
 * the real game and the headless runner.
 */
describe('companionProgressionSystem', () => {
  const HIT_OPTIONS: DamageOptions = {
    origin: 'enemy',
    affinity: 'physical',
    scaleWithPrimary: false,
    canCrit: false,
  };

  function spawnCompanion(
    world: ReturnType<typeof createTestWorld>,
    x: number,
    speciesId = 'ember-charger',
    teamId: number = TeamId.PLAYER,
    knockedOut = 0,
  ): number {
    const eid = spawnBehaviorEnemy(world, x, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, eid, set(Team, { id: teamId }));
    addComponent(
      world.ecs,
      eid,
      set(Companion, {
        speciesToken: speciesTokenForId(speciesId),
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: teamId,
        knockedOut,
      }),
    );
    return eid;
  }

  it('is a no-op when nothing has been tracked', () => {
    const world = createTestWorld();
    expect(() => companionProgressionSystem(world)).not.toThrow();
  });

  it('awards a solo Companion the full kill-XP pool and clears the ledger entry', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0);
    const target = spawnEnemy(world, 10, 0, 40);

    applyDamage(world, target, 40, 10, 0, { ...HIT_OPTIONS, sourceEid: companion });
    expect(world.companionDamageContribution.get(target)?.get(companion)).toBe(40);

    companionProgressionSystem(world);

    expect(world.stores.companion.xp[companion]).toBeCloseTo(20); // tuning.floor3Companion.killXpBase
    expect(world.companionDamageContribution.has(target)).toBe(false);
  });

  it('splits merit XP damage-weighted across contributing teammates', () => {
    const world = createTestWorld();
    const heavyHitter = spawnCompanion(world, 0);
    const lightHitter = spawnCompanion(world, 1);
    const target = spawnEnemy(world, 10, 0, 100);

    applyDamage(world, target, 75, 10, 0, { ...HIT_OPTIONS, sourceEid: heavyHitter });
    applyDamage(world, target, 25, 10, 0, { ...HIT_OPTIONS, sourceEid: lightHitter });

    companionProgressionSystem(world);

    // killXpBase=20, assistFloorShare=0.2 => assistPool=4 split across the 2
    // living teammates (2 each) + meritPool=16 split 75/25.
    expect(world.stores.companion.xp[heavyHitter]).toBeCloseTo(2 + 16 * 0.75);
    expect(world.stores.companion.xp[lightHitter]).toBeCloseTo(2 + 16 * 0.25);
  });

  it('gives a non-contributing living teammate only the assist-floor share', () => {
    const world = createTestWorld();
    const attacker = spawnCompanion(world, 0);
    const bystander = spawnCompanion(world, 1);
    const knockedOutTeammate = spawnCompanion(world, 2, 'ember-charger', TeamId.PLAYER, 1);
    const target = spawnEnemy(world, 10, 0, 40);

    applyDamage(world, target, 40, 10, 0, { ...HIT_OPTIONS, sourceEid: attacker });
    companionProgressionSystem(world);

    // assistPool=4 split across the 2 living teammates (attacker + bystander) = 2 each;
    // meritPool=16 goes entirely to the sole contributor.
    expect(world.stores.companion.xp[attacker]).toBeCloseTo(2 + 16);
    expect(world.stores.companion.xp[bystander]).toBeCloseTo(2);
    expect(world.stores.companion.xp[knockedOutTeammate]).toBe(0);
  });

  it('never awards Companion XP for player- or environment-sourced kills', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0);
    const target = spawnEnemy(world, 10, 0, 40);

    applyDamage(world, target, 40, 10, 0, HIT_OPTIONS); // no sourceEid at all
    expect(world.companionDamageContribution.size).toBe(0);
    companionProgressionSystem(world);
    expect(world.stores.companion.xp[companion]).toBe(0);
  });

  it('does not process a target until its health actually reaches 0', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0);
    const target = spawnEnemy(world, 10, 0, 100);

    applyDamage(world, target, 40, 10, 0, { ...HIT_OPTIONS, sourceEid: companion });
    companionProgressionSystem(world);

    expect(world.stores.companion.xp[companion]).toBe(0);
    expect(world.companionDamageContribution.has(target)).toBe(true);
  });

  it('levels up, evolves form, and unlocks milestone abilities as XP accumulates', () => {
    const world = createTestWorld();
    const companion = spawnCompanion(world, 0, 'ember-charger');

    expect(world.stores.companion.form[companion]).toBe(0);
    expect(companionLearnedAbilityIds(world, companion)).toHaveLength(1);

    // xpThresholdForLevel grows geometrically; repeatedly kill fresh targets
    // until the Companion reaches its level-10 evolution milestone.
    for (let i = 0; i < 50 && (world.stores.companion.level[companion] ?? 0) < 10; i++) {
      const target = spawnEnemy(world, 10, 0, 1);
      applyDamage(world, target, 1, 10, 0, { ...HIT_OPTIONS, sourceEid: companion });
      companionProgressionSystem(world);
    }

    expect(world.stores.companion.level[companion]).toBeGreaterThanOrEqual(10);
    expect(world.stores.companion.form[companion]).toBe(1);
    expect(companionLearnedAbilityIds(world, companion)).toHaveLength(2);
  });

  it('returns no abilities for a Companion with an unset/unknown species token', () => {
    const world = createTestWorld();
    const eid = spawnBehaviorEnemy(world, 0, 0, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, eid, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      eid,
      set(Companion, { speciesToken: 0, form: 0, level: 1, xp: 0, ownerTeam: 0, knockedOut: 0 }),
    );
    expect(companionLearnedAbilityIds(world, eid)).toEqual([]);
  });
});
