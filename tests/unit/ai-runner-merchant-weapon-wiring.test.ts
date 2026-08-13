import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner optional purchases wiring', () => {
  it('exposes a single optionalPurchases flag defaulting to true', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    // Single field default on
    expect(source).toMatch(
      /optionalPurchases:\s*persisted\?\.aiConfig\?\.optionalPurchases\s*\?\?\s*true/,
    );
  });

  it('passes optionalPurchases into both purchase intent configurators', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toMatch(
      /configureMerchantWeaponPurchase\(world,\s*aiConfig\.optionalPurchases\)/,
    );
    expect(source).toMatch(/configureSpellBrokerPurchase\(world,\s*aiConfig\.optionalPurchases\)/);
  });

  it('GUI is wired to the single optionalPurchases field', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toMatch(/\.add\(aiConfig,\s*'optionalPurchases'\)/);
    // The two old independent fields must not have their own separate GUI toggles
    expect(source).not.toMatch(/\.add\(aiConfig,\s*'merchantWeaponPurchase'\)/);
    expect(source).not.toMatch(/\.add\(aiConfig,\s*'spellBrokerPurchase'\)/);
  });
});
