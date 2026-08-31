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
      'attackWaves',
      'floor1Spawners',
    ]);
    expect(getAiFeatureFlagControls().every(({ label }) => label.length > 0)).toBe(true);
  });

  it('marks only the world-init-time flags as reload-required', () => {
    const byKey = Object.fromEntries(
      getAiFeatureFlagControls().map((control) => [control.key, control.reloadRequired]),
    );
    expect(byKey).toEqual({
      weaponPersonas: false,
      optionalPurchases: false,
      settlementReturnRouting: false,
      attackWaves: true,
      floor1Spawners: true,
    });
  });

  it('preserves lab defaults', () => {
    expect(resolveAiFeatureFlags({}, { surface: 'lab', floorId: 'floor1' })).toEqual({
      weaponPersonas: true,
      optionalPurchases: true,
      settlementReturnRouting: true,
      attackWaves: false,
      floor1Spawners: false,
    });
  });

  it('preserves headless floor-aware defaults', () => {
    expect(resolveAiFeatureFlags({}, { surface: 'headless', floorId: 'floor1' })).toEqual({
      weaponPersonas: true,
      optionalPurchases: true,
      settlementReturnRouting: true,
      attackWaves: false,
      floor1Spawners: false,
    });
    expect(resolveAiFeatureFlags({}, { surface: 'headless', floorId: 'floor2' })).toEqual({
      weaponPersonas: true,
      optionalPurchases: true,
      settlementReturnRouting: false,
      attackWaves: false,
      floor1Spawners: false,
    });
  });

  it('defaults attackWaves and floor1Spawners to false on every surface/floor combination', () => {
    for (const surface of ['lab', 'headless'] as const) {
      for (const floorId of ['floor1', 'floor2', 'floor3', 'floor4', 'floor5']) {
        const resolved = resolveAiFeatureFlags({}, { surface, floorId });
        expect(resolved.attackWaves, `${surface}/${floorId} attackWaves`).toBe(false);
        expect(resolved.floor1Spawners, `${surface}/${floorId} floor1Spawners`).toBe(false);
      }
    }
  });

  it('honors explicit canonical overrides', () => {
    expect(
      resolveAiFeatureFlags(
        {
          weaponPersonas: false,
          optionalPurchases: false,
          settlementReturnRouting: false,
          attackWaves: true,
          floor1Spawners: true,
        },
        { surface: 'lab', floorId: 'floor1' },
      ),
    ).toEqual({
      weaponPersonas: false,
      optionalPurchases: false,
      settlementReturnRouting: false,
      attackWaves: true,
      floor1Spawners: true,
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

  describe('applicability metadata', () => {
    it('always marks the three live AI-only flags applicable, regardless of floor or target', () => {
      for (const key of [
        'weaponPersonas',
        'optionalPurchases',
        'settlementReturnRouting',
      ] as const) {
        expect(
          getAiFeatureFlagControls({ surface: 'lab', floorId: 'floor1' }).find(
            (control) => control.key === key,
          )?.applicable,
        ).toBe(true);
        expect(
          getAiFeatureFlagControls({ surface: 'lab', floorId: 'floor2' }).find(
            (control) => control.key === key,
          )?.applicable,
        ).toBe(true);
        expect(
          getAiFeatureFlagControls({
            surface: 'lab',
            floorId: 'floor1',
            isRealFloorTarget: false,
          }).find((control) => control.key === key)?.applicable,
        ).toBe(true);
      }
    });

    it('masks persisted inapplicable world-init flags and marks their controls unavailable', () => {
      expect(
        resolveAiFeatureFlags(
          { attackWaves: true, floor1Spawners: true },
          { surface: 'lab', floorId: 'floor1', isRealFloorTarget: false },
        ),
      ).toMatchObject({ attackWaves: false, floor1Spawners: false });
      expect(
        getAiFeatureFlagControls({ surface: 'headless', floorId: 'floor1' }).find(
          (control) => control.key === 'attackWaves',
        )?.applicable,
      ).toBe(true);
      expect(
        resolveAiFeatureFlags(
          { attackWaves: true, floor1Spawners: true },
          { surface: 'lab', floorId: 'floor1', isRealFloorTarget: true },
        ),
      ).toMatchObject({ attackWaves: true, floor1Spawners: true });
      expect(
        getAiFeatureFlagControls({ surface: 'headless', floorId: 'floor2' }).find(
          (control) => control.key === 'attackWaves',
        )?.applicable,
      ).toBe(false);
      expect(
        getAiFeatureFlagControls({
          surface: 'lab',
          floorId: 'floor1',
          isRealFloorTarget: false,
        }).find((control) => control.key === 'attackWaves')?.applicable,
      ).toBe(false);
      expect(
        getAiFeatureFlagControls({ surface: 'headless', floorId: 'floor1' }).find(
          (control) => control.key === 'floor1Spawners',
        )?.applicable,
      ).toBe(true);
      expect(
        getAiFeatureFlagControls({ surface: 'headless', floorId: 'floor2' }).find(
          (control) => control.key === 'floor1Spawners',
        )?.applicable,
      ).toBe(false);
    });
  });
});
