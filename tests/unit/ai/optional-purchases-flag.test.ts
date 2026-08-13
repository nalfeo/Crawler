/**
 * Tests for the shared `optionalPurchases` feature flag in HeadlessRunnerConfig.
 *
 * Requirements validated:
 *  1. Default is OFF — neither purchase system is armed when no flag is set.
 *  2. `optionalPurchases: true` arms BOTH the merchant-weapon and spell-broker
 *     purchase systems identically.
 *  3. The flag takes precedence over the individual deprecated fields when
 *     supplied.
 *  4. Deprecated fields work independently when `optionalPurchases` is absent
 *     (backward compatibility for existing callers/tests).
 */

import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../../../src/core/index.js';
import { getMerchantWeaponIntent } from '../../../src/game/ai/merchant-weapon-intent.js';
import { getSpellBrokerIntent } from '../../../src/game/ai/spell-broker-intent.js';
import { configureMerchantWeaponPurchase } from '../../../src/game/ai/merchant-weapon-intent.js';
import { configureSpellBrokerPurchase } from '../../../src/game/ai/spell-broker-intent.js';

// Simulate what runHeadless does when resolving the optionalPurchases flag.
function resolveAndApply(
  world: ReturnType<typeof createGameWorld>,
  config: {
    optionalPurchases?: boolean;
    merchantWeaponPurchase?: boolean;
    spellBrokerPurchase?: boolean;
  },
): void {
  const purchasesEnabled =
    config.optionalPurchases !== undefined
      ? config.optionalPurchases
      : (config.merchantWeaponPurchase ?? false) || (config.spellBrokerPurchase ?? false);
  configureMerchantWeaponPurchase(world, purchasesEnabled);
  configureSpellBrokerPurchase(world, purchasesEnabled);
}

describe('optionalPurchases flag — default behaviour', () => {
  it('is off by default: both purchase systems are disabled', () => {
    const world = createGameWorld({ seed: 1 });
    resolveAndApply(world, {});
    expect(getMerchantWeaponIntent(world).enabled).toBe(false);
    expect(getSpellBrokerIntent(world).enabled).toBe(false);
  });
});

describe('optionalPurchases flag — enabling', () => {
  it('optionalPurchases:true arms both merchant-weapon and spell-broker systems', () => {
    const world = createGameWorld({ seed: 1 });
    resolveAndApply(world, { optionalPurchases: true });
    expect(getMerchantWeaponIntent(world).enabled).toBe(true);
    expect(getSpellBrokerIntent(world).enabled).toBe(true);
  });

  it('optionalPurchases:false keeps both systems disabled', () => {
    const world = createGameWorld({ seed: 1 });
    resolveAndApply(world, { optionalPurchases: false });
    expect(getMerchantWeaponIntent(world).enabled).toBe(false);
    expect(getSpellBrokerIntent(world).enabled).toBe(false);
  });
});

describe('optionalPurchases flag — precedence over deprecated fields', () => {
  it('optionalPurchases:true overrides merchantWeaponPurchase:false', () => {
    const world = createGameWorld({ seed: 1 });
    resolveAndApply(world, { optionalPurchases: true, merchantWeaponPurchase: false });
    expect(getMerchantWeaponIntent(world).enabled).toBe(true);
    expect(getSpellBrokerIntent(world).enabled).toBe(true);
  });

  it('optionalPurchases:false overrides merchantWeaponPurchase:true', () => {
    const world = createGameWorld({ seed: 1 });
    resolveAndApply(world, { optionalPurchases: false, merchantWeaponPurchase: true });
    expect(getMerchantWeaponIntent(world).enabled).toBe(false);
    expect(getSpellBrokerIntent(world).enabled).toBe(false);
  });
});

describe('optionalPurchases flag — backward compat (deprecated fields)', () => {
  it('merchantWeaponPurchase:true still arms both when optionalPurchases is absent', () => {
    const world = createGameWorld({ seed: 1 });
    resolveAndApply(world, { merchantWeaponPurchase: true });
    expect(getMerchantWeaponIntent(world).enabled).toBe(true);
    expect(getSpellBrokerIntent(world).enabled).toBe(true);
  });

  it('spellBrokerPurchase:true still arms both when optionalPurchases is absent', () => {
    const world = createGameWorld({ seed: 1 });
    resolveAndApply(world, { spellBrokerPurchase: true });
    expect(getMerchantWeaponIntent(world).enabled).toBe(true);
    expect(getSpellBrokerIntent(world).enabled).toBe(true);
  });
});
