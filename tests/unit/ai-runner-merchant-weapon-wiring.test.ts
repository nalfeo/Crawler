import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner merchant weapon purchase wiring', () => {
  it('keeps the lab toggle default-off and passes it into the shared world intent', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toMatch(
      /merchantWeaponPurchase:\s*persisted\?\.aiConfig\?\.merchantWeaponPurchase\s*\?\?\s*false/,
    );
    expect(source).toMatch(
      /configureMerchantWeaponPurchase\(world,\s*aiConfig\.merchantWeaponPurchase\)\s*;\s*configureSpellBrokerPurchase\(world,\s*aiConfig\.spellBrokerPurchase\)\s*;\s*autoFloor1ProgressionSystem\(world,\s*playerEid,\s*ai,\s*aiConfig\.weaponPersonas\)/s,
    );
    expect(source).toMatch(/\.add\(aiConfig,\s*'merchantWeaponPurchase'\)/);
  });
});
