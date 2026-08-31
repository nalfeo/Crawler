import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getAiFeatureFlagControls,
  resolveAiFeatureFlags,
} from '../../../src/game/ai/feature-flags.js';

describe('AI feature flag registry', () => {
  it('is the complete ordered source for AI runner feature controls', () => {
    expect(getAiFeatureFlagControls().map(({ key }) => key)).toEqual([
      'weaponPersonas',
      'optionalPurchases',
      'settlementReturnRouting',
    ]);
    expect(getAiFeatureFlagControls().every(({ label }) => label.length > 0)).toBe(true);
  });

  it('preserves lab defaults', () => {
    expect(resolveAiFeatureFlags({}, { surface: 'lab', floorId: 'floor1' })).toEqual({
      weaponPersonas: true,
      optionalPurchases: true,
      settlementReturnRouting: true,
    });
  });

  it('preserves headless floor-aware defaults', () => {
    expect(resolveAiFeatureFlags({}, { surface: 'headless', floorId: 'floor1' })).toEqual({
      weaponPersonas: true,
      optionalPurchases: true,
      settlementReturnRouting: true,
    });
    expect(resolveAiFeatureFlags({}, { surface: 'headless', floorId: 'floor2' })).toEqual({
      weaponPersonas: true,
      optionalPurchases: true,
      settlementReturnRouting: false,
    });
  });

  it('honors explicit canonical overrides', () => {
    expect(
      resolveAiFeatureFlags(
        {
          weaponPersonas: false,
          optionalPurchases: false,
          settlementReturnRouting: false,
        },
        { surface: 'lab', floorId: 'floor1' },
      ),
    ).toEqual({
      weaponPersonas: false,
      optionalPurchases: false,
      settlementReturnRouting: false,
    });
  });

  it('retains deprecated optional-purchase migration semantics', () => {
    expect(
      resolveAiFeatureFlags(
        { merchantWeaponPurchase: false },
        { surface: 'lab', floorId: 'floor1' },
      ).optionalPurchases,
    ).toBe(false);
    expect(
      resolveAiFeatureFlags({ spellBrokerPurchase: true }, { surface: 'lab', floorId: 'floor1' })
        .optionalPurchases,
    ).toBe(true);
    expect(
      resolveAiFeatureFlags(
        { optionalPurchases: false, merchantWeaponPurchase: true },
        { surface: 'lab', floorId: 'floor1' },
      ).optionalPurchases,
    ).toBe(false);
  });

  it('reports resolved headless flags in debug configuration', () => {
    const source = readFileSync('src/game/ai/headless-runner.ts', 'utf8');

    expect(source).toContain(
      "logger.info('Starting headless run', { ...mergedConfig, ...featureFlags });",
    );
  });

  it('drives the headless CLI banner from the registry instead of CLI-local defaults', () => {
    const source = readFileSync('src/game/ai/headless-runner-cli.ts', 'utf8');

    expect(source).toContain('for (const control of getAiFeatureFlagControls())');
    expect(source).not.toContain('weaponPersonas: args.weaponPersonas');
    expect(source).not.toContain('optionalPurchases: args.optionalPurchases');
  });
});
