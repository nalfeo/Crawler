import { describe, expect, it } from 'vitest';
import {
  FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS,
  getFloor1StarterWeaponPool,
  isFloor1ExperimentalStarterOptionsEnabled,
} from '../../src/shared/floor1-starter-weapons.js';

const BASE_STARTERS = ['sword', 'bow', 'baseball-bat', 'pistol', 'throwing-knife', 'fireball'];

describe('getFloor1StarterWeaponPool', () => {
  it('returns only the base starters when enableExperimental is omitted', () => {
    const pool = getFloor1StarterWeaponPool(BASE_STARTERS);
    expect(pool).toEqual(BASE_STARTERS);
  });

  it('returns only the base starters when enableExperimental is false', () => {
    const pool = getFloor1StarterWeaponPool(BASE_STARTERS, { enableExperimental: false });
    expect(pool).toEqual(BASE_STARTERS);
  });

  it('appends experimental weapons when enableExperimental is true', () => {
    const pool = getFloor1StarterWeaponPool(BASE_STARTERS, { enableExperimental: true });
    expect(pool).toEqual([...BASE_STARTERS, ...FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS]);
    for (const id of FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS) {
      expect(pool).toContain(id);
    }
  });

  it('preserves base weapon order with experimental appended at the end', () => {
    const pool = getFloor1StarterWeaponPool(['bow', 'sword'], { enableExperimental: true });
    expect(pool.indexOf('bow')).toBe(0);
    expect(pool.indexOf('sword')).toBe(1);
    expect(pool.indexOf(FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS[0])).toBeGreaterThan(1);
  });

  it('deduplicates: does not add an experimental weapon already in the base pool', () => {
    const alreadyIncludesExperimental = ['sword', ...FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS];
    const pool = getFloor1StarterWeaponPool(alreadyIncludesExperimental, {
      enableExperimental: true,
    });
    // Each experimental ID should appear exactly once
    for (const id of FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS) {
      expect(pool.filter((w) => w === id)).toHaveLength(1);
    }
    expect(pool).toHaveLength(alreadyIncludesExperimental.length);
  });

  it('deduplicates duplicate IDs in the base pool itself', () => {
    const pool = getFloor1StarterWeaponPool(['sword', 'sword', 'bow']);
    expect(pool).toEqual(['sword', 'bow']);
  });
});

describe('isFloor1ExperimentalStarterOptionsEnabled', () => {
  it('returns false when called with no argument', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled()).toBe(false);
  });

  it('returns false when called with null', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled(null)).toBe(false);
  });

  it('returns false when called with an empty string', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('')).toBe(false);
  });

  it('returns false when the param is absent from the query string', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?other=1')).toBe(false);
  });

  it('returns true for truthy value "1"', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters=1')).toBe(true);
  });

  it('returns true for truthy value "true"', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters=true')).toBe(
      true,
    );
  });

  it('returns true for truthy value "yes"', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters=yes')).toBe(true);
  });

  it('returns true for truthy value "on"', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters=on')).toBe(true);
  });

  it('returns false for falsy value "0"', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters=0')).toBe(false);
  });

  it('returns false for falsy value "false"', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters=false')).toBe(
      false,
    );
  });

  it('accepts a URLSearchParams instance', () => {
    const params = new URLSearchParams('floor1ExperimentalStarters=1');
    expect(isFloor1ExperimentalStarterOptionsEnabled(params)).toBe(true);
  });

  it('handles case-insensitive and whitespace-trimmed values', () => {
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters=TRUE')).toBe(
      true,
    );
    expect(isFloor1ExperimentalStarterOptionsEnabled('?floor1ExperimentalStarters= 1 ')).toBe(true);
  });
});
