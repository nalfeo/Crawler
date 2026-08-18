/**
 * Tests for the shared `optionalPurchases` feature flag in HeadlessRunnerConfig.
 *
 * Requirements validated:
 *  1. Default is ON — both purchase systems are armed when no flag is set.
 *  2. `optionalPurchases: true` arms BOTH the merchant-weapon and spell-broker
 *     purchase systems identically.
 *  3. The flag takes precedence over the individual deprecated fields when
 *     supplied.
 *  4. Deprecated fields work independently when `optionalPurchases` is absent
 *     (backward compatibility for existing callers/tests).
 */

import { describe, expect, it } from 'vitest';
import { resolveOptionalPurchases } from '../../../src/game/ai/optional-purchases.js';

describe('optionalPurchases flag — default behaviour', () => {
  it('is on by default: both purchase systems are enabled', () => {
    expect(resolveOptionalPurchases({})).toBe(true);
  });
});

describe('optionalPurchases flag — enabling', () => {
  it('optionalPurchases:true arms both merchant-weapon and spell-broker systems', () => {
    expect(resolveOptionalPurchases({ optionalPurchases: true })).toBe(true);
  });

  it('optionalPurchases:false keeps both systems disabled', () => {
    expect(resolveOptionalPurchases({ optionalPurchases: false })).toBe(false);
  });
});

describe('optionalPurchases flag — precedence over deprecated fields', () => {
  it('optionalPurchases:true overrides merchantWeaponPurchase:false', () => {
    expect(
      resolveOptionalPurchases({ optionalPurchases: true, merchantWeaponPurchase: false }),
    ).toBe(true);
  });

  it('optionalPurchases:false overrides merchantWeaponPurchase:true', () => {
    expect(
      resolveOptionalPurchases({ optionalPurchases: false, merchantWeaponPurchase: true }),
    ).toBe(false);
  });
});

describe('optionalPurchases flag — backward compat (deprecated fields)', () => {
  it('an explicit legacy false still disables both when optionalPurchases is absent', () => {
    expect(resolveOptionalPurchases({ merchantWeaponPurchase: false })).toBe(false);
  });

  it('merchantWeaponPurchase:true still arms both when optionalPurchases is absent', () => {
    expect(resolveOptionalPurchases({ merchantWeaponPurchase: true })).toBe(true);
  });

  it('spellBrokerPurchase:true still arms both when optionalPurchases is absent', () => {
    expect(resolveOptionalPurchases({ spellBrokerPurchase: true })).toBe(true);
  });
});

describe('optionalPurchases flag — persisted lab state', () => {
  it('preserves an explicit legacy opt-out when the canonical field is absent', () => {
    const persistedAiConfig = { merchantWeaponPurchase: false };

    expect(resolveOptionalPurchases(persistedAiConfig)).toBe(false);
  });
});
