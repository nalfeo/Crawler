import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { EffectiveStats } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { applyDamage, type DamageOptions } from '../../src/core/apply-damage.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Floor 3 slice 2 — the `AFFINITY_MATRIX` damage-multiplier hook consumed by
 * `applyDamage` (ADR 0071 D3, spec `floor3-companion-league.md` R3). No
 * `Companion`/`PartySlot` component exists yet (slice 3), so this only proves
 * the pure hook: it fires whenever both `attackerTemperament`/
 * `defenderTemperament` are supplied on `DamageOptions`, and is a total
 * no-op — the fail-closed default — otherwise.
 */
describe('applyDamage — Floor 3 Temperament (affinity) multiplier hook', () => {
  const BASE_OPTIONS: DamageOptions = {
    origin: 'enemy',
    affinity: 'physical',
    scaleWithPrimary: false,
    canCrit: false,
  };

  it('is a no-op when neither Temperament is supplied', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 0, 100);
    const dealt = applyDamage(world, target, 40, 0, 0, BASE_OPTIONS);
    expect(dealt).toBe(40);
  });

  it('is a no-op when only one side supplies a Temperament (fail-closed)', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 0, 100);
    const dealt = applyDamage(world, target, 40, 0, 0, {
      ...BASE_OPTIONS,
      attackerTemperament: 'ember',
    });
    expect(dealt).toBe(40);
  });

  it('doubles damage on a super-effective Temperament matchup (ember beats bloom)', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 0, 100);
    const dealt = applyDamage(world, target, 40, 0, 0, {
      ...BASE_OPTIONS,
      attackerTemperament: 'ember',
      defenderTemperament: 'bloom',
    });
    expect(dealt).toBe(80);
  });

  it('halves damage on a resisted Temperament matchup (bloom resisted by ember)', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 0, 100);
    const dealt = applyDamage(world, target, 40, 0, 0, {
      ...BASE_OPTIONS,
      attackerTemperament: 'bloom',
      defenderTemperament: 'ember',
    });
    expect(dealt).toBe(20);
  });

  it('leaves damage unscaled on a neutral Temperament matchup (self)', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 0, 100);
    const dealt = applyDamage(world, target, 40, 0, 0, {
      ...BASE_OPTIONS,
      attackerTemperament: 'ember',
      defenderTemperament: 'ember',
    });
    expect(dealt).toBe(40);
  });

  it('composes with player-sourced typed-primary scaling rather than replacing it', () => {
    const world = createTestWorld();
    const target = spawnEnemy(world, 0, 0, 1000);
    const player = spawnPlayer(world, 0, 0);
    addComponent(world.ecs, player, EffectiveStats);
    world.stores.effectiveStats.strength[player] = 10;
    const dealt = applyDamage(world, target, 40, 0, 0, {
      origin: 'player',
      affinity: 'physical',
      scaleWithPrimary: true,
      canCrit: false,
      attackerTemperament: 'ember',
      defenderTemperament: 'bloom',
    });
    // Base 40 * STR-physical (1 + 10 * 0.01 = 1.1) * affinity (ember>bloom = 2) = 88.
    expect(dealt).toBe(88);
  });
});
