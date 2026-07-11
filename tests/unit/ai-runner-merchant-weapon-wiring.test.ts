import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner merchant weapon purchase wiring', () => {
  it('keeps the lab toggle default-off and passes it into the shared world intent', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toContain(
      'merchantWeaponPurchase: persisted?.aiConfig?.merchantWeaponPurchase ?? false',
    );
    expect(source).toContain(
      'configureMerchantWeaponPurchase(world, aiConfig.merchantWeaponPurchase)',
    );
    expect(source).toContain(".add(aiConfig, 'merchantWeaponPurchase')");
  });
});
