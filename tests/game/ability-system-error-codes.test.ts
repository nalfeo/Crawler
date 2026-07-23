/**
 * abilitySystem — AbilityGrantError error-code paths.
 *
 * The existing ability-grants.test.ts exercises `invalid-source`,
 * `source-conflict`, and `source-mismatch` codes but leaves `unknown-ability`
 * and `kind-mismatch` untested.  These tests pin those two codes and cover
 * the `memorizeSpell` error branches as well.
 */
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  AbilityGrantError,
  grantAbilitySources,
  memorizeSpell,
} from '../../src/game/systems/abilitySystem.js';
import { learnedAbilityGrantSourceId } from '../../src/shared/abilities.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('abilitySystem — AbilityGrantError codes', () => {
  describe('unknown-ability', () => {
    it('throws AbilityGrantError with code unknown-ability when the ability id does not exist', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);

      let caught: unknown;
      try {
        grantAbilitySources(world, player, [
          {
            kind: 'active',
            abilityId: 'completely-nonexistent-ability-xyz',
            sourceId: learnedAbilityGrantSourceId('completely-nonexistent-ability-xyz'),
          },
        ]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(AbilityGrantError);
      expect((caught as AbilityGrantError).code).toBe('unknown-ability');
      expect((caught as AbilityGrantError).message).toMatch(/completely-nonexistent-ability-xyz/);
    });
  });

  describe('kind-mismatch', () => {
    it('throws AbilityGrantError with code kind-mismatch when granting a passive ability as active', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);

      // 'combat-flow' is kind:'passive' — cannot be granted as kind:'active'.
      let caught: unknown;
      try {
        grantAbilitySources(world, player, [
          {
            kind: 'active',
            abilityId: 'combat-flow',
            sourceId: learnedAbilityGrantSourceId('combat-flow'),
          },
        ]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(AbilityGrantError);
      expect((caught as AbilityGrantError).code).toBe('kind-mismatch');
      expect((caught as AbilityGrantError).message).toMatch(/combat-flow/);
    });

    it('throws AbilityGrantError with code kind-mismatch when granting an active ability as passive', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);

      // 'battle-focus' is kind:'active' — cannot be granted as kind:'passive'.
      let caught: unknown;
      try {
        grantAbilitySources(world, player, [
          {
            kind: 'passive',
            abilityId: 'battle-focus',
            sourceId: learnedAbilityGrantSourceId('battle-focus'),
          },
        ]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(AbilityGrantError);
      expect((caught as AbilityGrantError).code).toBe('kind-mismatch');
      expect((caught as AbilityGrantError).message).toMatch(/battle-focus/);
    });
  });
});

describe('memorizeSpell — error paths', () => {
  it('throws when the ability id is not in the catalog', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    expect(() => memorizeSpell(world, player, 'nonexistent-spell-abc')).toThrow(
      /Unknown ability id/,
    );
  });

  it('throws when the ability exists but is not a spell (kind is active, not spell)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    // 'battle-focus' is kind:'active' — memorizeSpell only accepts kind:'spell'.
    expect(() => memorizeSpell(world, player, 'battle-focus')).toThrow(/not a spell/i);
  });

  it('throws when the ability exists but is passive rather than a spell', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    // 'combat-flow' is kind:'passive' — also not a spell.
    expect(() => memorizeSpell(world, player, 'combat-flow')).toThrow(/not a spell/i);
  });
});
