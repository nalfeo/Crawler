import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner optional purchases wiring', () => {
  it('resolves all persisted feature flags through the shared registry', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toContain('resolveAiFeatureFlags(');
    expect(source).toContain('...persisted?.featureFlags');
  });

  it('passes registry-derived flags into every behavior consumer', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toMatch(
      /configureMerchantWeaponPurchase\(world,\s*featureFlags\.optionalPurchases\)/,
    );
    expect(source).toMatch(
      /configureSpellBrokerPurchase\(world,\s*featureFlags\.optionalPurchases\)/,
    );
    expect(source).toMatch(
      /autoFloor1ProgressionSystem\(world,\s*playerEid,\s*ai,\s*featureFlags\.weaponPersonas\)/,
    );
    expect(source).toMatch(
      /syncAiRunnerSettlementReturnRouting\(\s*world,\s*!manualControl,\s*featureFlags\.settlementReturnRouting,\s*\)/,
    );
  });

  it('builds a dedicated Feature Flags folder from every registry control', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

    expect(source).toContain("gui.addFolder('Feature Flags')");
    expect(source).toContain(
      'for (const control of getAiFeatureFlagControls(aiFeatureFlagContext()))',
    );
    expect(source).toContain('.add(featureFlags, control.key)');
    expect(source).not.toMatch(
      /\.add\(aiConfig,\s*'(optionalPurchases|settlementReturnRouting|weaponPersonas)'\)/,
    );
  });
});
