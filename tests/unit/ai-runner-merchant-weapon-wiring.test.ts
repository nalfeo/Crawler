import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner optional purchases wiring', () => {
  it('uses the shared optional-purchases resolver for persisted state', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toMatch(
      /optionalPurchases:\s*resolveOptionalPurchases\(persisted\?\.aiConfig\s*\?\?\s*\{\}\)/,
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
