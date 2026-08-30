import { describe, expect, it } from 'vitest';
import {
  AI_FEATURE_FLAG_DEFINITIONS,
  getAiFeatureFlagControls,
  resolveAiFeatureFlags,
} from '../../../src/game/ai/feature-flags.js';

describe('AI feature flag registry', () => {
  it('is the complete ordered source for AI runner feature controls', () => {
    expect(AI_FEATURE_FLAG_DEFINITIONS.map(({ key }) => key)).toEqual([
      'weaponPersonas',
      'optionalPurchases',
      'settlementReturnRouting',
    ]);
    expect(getAiFeatureFlagControls()).toEqual(
      AI_FEATURE_FLAG_DEFINITIONS.map(({ key, label }) => ({ key, label })),
    );
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
});
