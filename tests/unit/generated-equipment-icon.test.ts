import { describe, expect, it, vi } from 'vitest';
import {
  createGeneratedEquipmentIcon,
  resolveEquipmentIconSpec,
} from '../../src/engine/generated-equipment-icon.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { FLOOR2_BASIC_LEATHER_WEAPON_IDS } from '../../src/shared/data/floor2-basic-leather-bases.js';
import { FLOOR2_WEAPON_WAVE_A_BASE_IDS } from '../../src/shared/data/floor2-weapon-bases.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Regression coverage for the reward-opening icon-resolution bridge
 * (`resolveEquipmentIconSpec` / `createGeneratedEquipmentIcon`).
 *
 * Every Floor 2 generated-equipment base is intentionally kept out of
 * `equipmentDefs.ts` (ADR 0068) and its `baseId` is a dotted stable id
 * (`weapon.iron-dagger`, `accessory.leather-collar`, ...). That id never
 * matches a `resolveItemSprite` registry entry's `briefId` (verified against
 * the real shipped sprite manifest during this slice's investigation), so the
 * legacy `resolveItemSprite`-via-`baseId` lookup alone silently falls back to
 * a text-abbreviation icon for every one of the reward pool's 88 bases,
 * including all 18 new Basic Leather bases — not a regression this slice
 * introduced (the pre-existing 70 bases have identical behavior), but a real
 * gap in reward-opening reachability the correction asked to confirm.
 *
 * `EquipmentUI.ts`/`InventoryUI.ts` (owned by a concurrent slice) fixed the
 * equivalent gap for the equip/bag screens by preferring the instance's own
 * `frozen.artKey` as a literal, preloaded Phaser texture key. This test
 * proves `generated-equipment-icon.ts` — the reward-opening presentation's
 * icon resolver — now does the same, so a Floor 2 reward's icon is reachable
 * via the identical `artKey` contract the equip screen uses, and never
 * silently regresses back to `resolveItemSprite`-only resolution.
 */

function createFakeScene(loadedTextureKeys: ReadonlySet<string>): import('phaser').Scene {
  const images: Array<{ x: number; y: number; key: string }> = [];
  return {
    add: {
      image: vi.fn((x: number, y: number, key: string) => {
        images.push({ x, y, key });
        const image = {
          x,
          y,
          key,
          width: 32,
          height: 32,
          setOrigin: vi.fn(function (this: unknown) {
            return this;
          }),
          setScale: vi.fn(function (this: unknown) {
            return this;
          }),
        };
        return image;
      }),
      text: vi.fn((x: number, y: number, text: string) => ({
        x,
        y,
        text,
        setOrigin: vi.fn(function (this: unknown) {
          return this;
        }),
      })),
    },
    textures: {
      exists: vi.fn((key: string) => loadedTextureKeys.has(key)),
    },
  } as unknown as import('phaser').Scene;
}

function grantAndResolve(baseId: string) {
  const world = createTestWorld({
    seed: 11,
    floor: 2,
    generatedEquipmentRunKey: `icon-bridge-${baseId}`,
  });
  const instance = generateEquipmentInstance(
    world,
    { baseId, itemLevel: 1, rarity: 'uncommon' },
    { rng: world.rng, allowedEffectKinds: ['stat'] },
  );
  const spec = resolveEquipmentIconSpec(world, instance.instanceId)!;
  return { world, spec, instance };
}

describe('generated-equipment-icon reward-opening bridge', () => {
  it('exposes the frozen artKey on the resolved icon spec for a Wave A base', () => {
    const baseId = FLOOR2_WEAPON_WAVE_A_BASE_IDS[0]!;
    const { spec, instance } = grantAndResolve(baseId);
    expect(spec.artKey).toBe(instance.frozen.artKey);
    expect(spec.itemName).toBe(instance.frozen.displayName);
    expect(spec.artKey.length).toBeGreaterThan(0);
  });

  it('exposes the frozen artKey on the resolved icon spec for a Basic Leather base', () => {
    const baseId = FLOOR2_BASIC_LEATHER_WEAPON_IDS[0]!;
    const { spec, instance } = grantAndResolve(baseId);
    expect(spec.artKey).toBe(instance.frozen.artKey);
    expect(spec.itemName).toBe(instance.frozen.displayName);
    expect(spec.artKey.length).toBeGreaterThan(0);
  });

  it('renders the real preloaded texture under artKey when it exists, for both a Wave A and a Basic Leather base', () => {
    for (const baseId of [FLOOR2_WEAPON_WAVE_A_BASE_IDS[0]!, FLOOR2_BASIC_LEATHER_WEAPON_IDS[0]!]) {
      const { world, spec } = grantAndResolve(baseId);
      const scene = createFakeScene(new Set([spec.artKey]));
      const icon = createGeneratedEquipmentIcon(scene, world, spec, 10, 20, 48) as unknown as {
        key: string;
      };
      expect(scene.add.image).toHaveBeenCalledWith(10, 20, spec.artKey);
      expect(icon.key).toBe(spec.artKey);
    }
  });

  it('falls back to the text-abbreviation icon (never resolveItemSprite-only) when artKey has no loaded texture', () => {
    const baseId = FLOOR2_BASIC_LEATHER_WEAPON_IDS[0]!;
    const { world, spec } = grantAndResolve(baseId);
    // No textures loaded at all — mirrors the empirically-confirmed real
    // shipped-manifest state today, where `resolveItemSprite` cannot match a
    // dotted Floor 2 stableId either. Must degrade to the text fallback, not
    // throw and not silently render nothing.
    const scene = createFakeScene(new Set());
    const icon = createGeneratedEquipmentIcon(scene, world, spec, 10, 20, 48) as unknown as {
      text: string;
    };
    expect(scene.add.image).not.toHaveBeenCalled();
    expect(scene.add.text).toHaveBeenCalled();
    expect(icon.text.length).toBe(2);
  });
});
