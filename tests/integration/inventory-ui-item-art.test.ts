/**
 * Headless observation of the REAL inventory UI render path (rule #10).
 *
 * This is the "observe before done" artifact for the item-sprite normalization:
 * it drives the production `createInventoryUI` factory — the exact
 * `InventoryUI.ts` render branch shipped to players — against the REAL shipped
 * `public/assets/generated/manifest.json`, and records which texture the panel
 * actually renders for each of the 14 previously-stuck item icons (+ the
 * `bone-club` → `baseball-bat` weaponId alias).
 *
 * A green resolver unit test alone does NOT satisfy rule #10: it proves the
 * helper picks real art, not that the panel renders it. This test closes that
 * gap deterministically and headlessly (no Phaser, no browser, no LLM judge):
 *   - the real `renderItems()` decision (`InventoryUI.ts` ~598-624) chooses
 *     `scene.add.image(textureKey)` iff `resolveItemSprite(...)` returns a real
 *     entry AND `scene.textures.exists(textureKey)`, else falls back to a
 *     2-character placeholder text;
 *   - the recording scene stub faithfully models `textures.exists(key)` as "key
 *     is a loaded generated texture" (the preloader queues every registry
 *     entry's `textureKey`), so the image branch is exercised exactly as in game.
 *
 * POSITIVE: with the real registry, the panel renders each stuck item's
 * resolver-chosen texture as an image, and no `*-placeholder` texture is drawn.
 * NEGATIVE CONTROL: with an empty registry, zero images are drawn (every item
 * falls to the text fallback) — proving the harness exercises the real branch
 * rather than unconditionally recording images.
 */

import { describe, expect, it } from 'vitest';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
} from '../../src/engine/generatedAssets/index.js';
import {
  buildGeneratedSpriteRegistry,
  emptyGeneratedSpriteRegistry,
  GENERATED_MANIFEST_VERSION,
  type GeneratedSpriteRegistry,
} from '../../src/shared/generated-assets.js';
import { _isPlaceholderEntry, resolveItemSprite } from '../../src/shared/item-sprites.js';
import { hashStringToSeed } from '../../src/shared/random.js';
import { createInventoryUI } from '../../src/engine/InventoryUI.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { addGeneratedEquipmentToBag } from '../../src/core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import { createInventoryBag } from '../../src/shared/inventory.js';
import { generatedEquipmentRunKeyFromSeed } from '../../src/shared/generated-equipment-types.js';
import {
  loadShippedManifestRaw,
  shippedManifestShardsExist,
} from '../helpers/generated-manifest.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';

/** The 14 active single-lineage item icons + the bat weaponId alias. */
const ITEM_ART_EXPECTATIONS: ReadonlyArray<{ itemId: string; concept: string }> = [
  { itemId: 'bone-shard', concept: 'bone-shard' },
  { itemId: 'camera-lens', concept: 'camera-lens' },
  { itemId: 'classified-dossier', concept: 'classified-dossier' },
  { itemId: 'copper-ore', concept: 'copper-ore' },
  { itemId: 'crystal-fiber', concept: 'crystal-fiber' },
  { itemId: 'directors-cue-card', concept: 'directors-cue-card' },
  { itemId: 'dragon-scale', concept: 'dragon-scale' },
  { itemId: 'flame-dagger', concept: 'flame-dagger' },
  { itemId: 'glistening-rat-tail', concept: 'glistening-rat-tail' },
  { itemId: 'iron-ore', concept: 'iron-ore' },
  { itemId: 'merchants-stained-charm', concept: 'merchants-stained-charm' },
  { itemId: 'old-sock', concept: 'old-sock' },
  { itemId: 'pebble', concept: 'pebble' },
  { itemId: 'rusted-scrap', concept: 'rusted-scrap' },
  // The bat's item id is `bone-club`; art is keyed `baseball-bat-*` and resolves
  // via the equipment weaponId alias, not a bare `bone-club` texture.
  { itemId: 'bone-club', concept: 'baseball-bat' },
];

interface RenderRecord {
  /** Texture keys handed to `scene.add.image(...)` while rendering the panel. */
  readonly imageKeys: string[];
  /** Strings handed to `scene.add.text(...)` (labels, quantities, placeholders). */
  readonly textStrings: string[];
}

/**
 * A single fluent GameObject stand-in. Every method returns the stub (Phaser's
 * builder chaining idiom), and the few numeric props the render path reads
 * (`width`/`height` for `fitScaleForBox`) return a fixed 64px so icon scaling
 * is well-defined. This never influences WHICH texture is chosen — only layout
 * math we do not assert on.
 */
function makeGameObjectStub(): unknown {
  const stub: unknown = new Proxy(function () {} as unknown as object, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined; // never a thenable
      if (
        prop === 'width' ||
        prop === 'height' ||
        prop === 'displayWidth' ||
        prop === 'displayHeight'
      ) {
        return 64;
      }
      if (
        prop === 'x' ||
        prop === 'y' ||
        prop === 'depth' ||
        prop === 'scaleX' ||
        prop === 'scaleY' ||
        prop === 'originX' ||
        prop === 'originY' ||
        prop === 'rotation' ||
        prop === 'alpha'
      ) {
        return 0;
      }
      if (prop === 'visible') return true;
      return () => stub;
    },
    set() {
      return true;
    },
    apply() {
      return stub;
    },
  });
  return stub;
}

/**
 * Minimal recording scene that satisfies every `scene.*` access
 * `createInventoryUI` makes (enumerated from `InventoryUI.ts`). `textures.exists`
 * is backed by the registry's texture keys — the faithful model of
 * `preloadGeneratedSprites`, which queues one texture per registry entry.
 */
function makeRecordingScene(registry: GeneratedSpriteRegistry, record: RenderRecord): unknown {
  const stub = makeGameObjectStub();
  const loadedTextures = new Set(registry.entries().map((entry) => entry.textureKey));
  return {
    cameras: { main: { roundPixels: false } },
    add: {
      container: () => stub,
      rectangle: () => stub,
      image: (_x: number, _y: number, key: string) => {
        record.imageKeys.push(key);
        return stub;
      },
      text: (_x: number, _y: number, text: string) => {
        record.textStrings.push(String(text));
        return stub;
      },
    },
    game: {
      registry: {
        get: (key: string) => (key === GENERATED_SPRITE_REGISTRY_KEY ? registry : undefined),
      },
    },
    input: { keyboard: { on: () => {}, off: () => {} } },
    // Design-size display → uiScale 1; only affects layout, not texture choice.
    scale: { displaySize: { width: 1280, height: 720 }, on: () => {}, off: () => {} },
    textures: { exists: (key: string) => loadedTextures.has(key) },
    time: { now: 0 },
  };
}

function seedWorldWithStuckItems(): GameWorld {
  const world = createTestWorld();
  world.inventories.clear();
  world.inventories.set(1, {
    slots: ITEM_ART_EXPECTATIONS.map((expectation) => ({
      itemId: expectation.itemId,
      quantity: 1,
    })),
  });
  return world;
}

function seedWorldWithGeneratedOnlyBag(): GameWorld {
  const world = createTestWorld({
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(42),
  });
  world.inventories.clear();
  world.inventories.set(1, createInventoryBag());
  const generated = createGeneratedEquipmentInstance(
    world,
    generatedEquipmentInput({
      baseId: MERCHANTS_CHARM_DEF.id,
      slots: ['neck'],
    }),
  );
  const added = addGeneratedEquipmentToBag(world, 1, generated.instanceId);
  expect(added.ok).toBe(true);
  return world;
}

/** Mirror of `InventoryUI.selectGeneratedEntry`'s per-item seed derivation. */
function uiSeedFor(itemId: string, world: GameWorld): number {
  return (hashStringToSeed(itemId) ^ (world.seed | 0)) | 0;
}

async function loadRealShippedRegistry(): Promise<GeneratedSpriteRegistry> {
  const raw = loadShippedManifestRaw();
  const fetcher = (async () =>
    new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return fetchGeneratedSpriteRegistry({ url: '/assets/generated/manifest.json', fetcher });
}

describe('InventoryUI real render path over the shipped manifest (observe-before-done)', () => {
  it('renders each normalized item to its resolver-chosen real texture, never a placeholder', async () => {
    if (!shippedManifestShardsExist()) {
      // Fresh checkout with no generated art on disk — nothing to observe.
      return;
    }
    const registry = await loadRealShippedRegistry();
    const record: RenderRecord = { imageKeys: [], textStrings: [] };
    const scene = makeRecordingScene(registry, record);
    const world = seedWorldWithStuckItems();

    // A tall panel guarantees all 15 cells render (4 rows) rather than paginating.
    const ui = createInventoryUI(scene as never, { height: 2000 });
    ui.toggle(world); // open + applyLayout + renderItems

    for (const { itemId, concept } of ITEM_ART_EXPECTATIONS) {
      const entry = resolveItemSprite(registry, itemId, uiSeedFor(itemId, world));
      expect(entry, `resolver returned null for "${itemId}"`).not.toBeNull();
      expect(_isPlaceholderEntry(entry!), `"${itemId}" resolved to a placeholder`).toBe(false);
      // The panel drew EXACTLY the texture the resolver chose (same seed formula).
      expect(
        record.imageKeys,
        [
          `InventoryUI did not render real art for "${itemId}"`,
          `(expected image "${entry!.textureKey}")`,
        ].join(' '),
      ).toContain(entry!.textureKey);
      // And it belongs to the expected concept lineage (bare or legacy `-vN`).
      const bareMatch = entry!.briefId === concept;
      const versionedMatch = new RegExp(`^${concept}-v\\d+$`).test(entry!.briefId);
      expect(
        bareMatch || versionedMatch,
        `"${itemId}" rendered briefId "${entry!.briefId}", not a "${concept}" lineage`,
      ).toBe(true);
    }

    // No placeholder texture was drawn in the panel at all.
    for (const key of record.imageKeys) {
      expect(key.endsWith('-placeholder'), `a placeholder texture was rendered: "${key}"`).toBe(
        false,
      );
    }
    // The image branch actually ran for every seeded item (not the text fallback).
    expect(record.imageKeys.length).toBeGreaterThanOrEqual(ITEM_ART_EXPECTATIONS.length);
  });

  it('negative control: an empty registry renders zero images (every item falls to text)', () => {
    const record: RenderRecord = { imageKeys: [], textStrings: [] };
    const scene = makeRecordingScene(emptyGeneratedSpriteRegistry(), record);
    const world = seedWorldWithStuckItems();

    const ui = createInventoryUI(scene as never, { height: 2000 });
    ui.toggle(world);

    // Proves the harness exercises the real image/text decision: with no loaded
    // textures, `renderItems` must take the placeholder-text branch for all cells.
    expect(record.imageKeys, 'empty registry must not render any generated-art images').toEqual([]);
    expect(record.textStrings.length, 'placeholder text fallback should have run').toBeGreaterThan(
      0,
    );
  });

  it('renders a generated-only bag through the real InventoryUI path', () => {
    const record: RenderRecord = { imageKeys: [], textStrings: [] };
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'merchants-stained-charm-ui-test': {
          briefId: MERCHANTS_CHARM_DEF.id,
          spriteName: 'merchants-stained-charm-ui-test',
          assetPath: 'generated/merchants-stained-charm-ui-test.png',
          anchor: { x: 8, y: 8, source: 'brief' },
          approvedAt: '2026-07-30T00:00:00.000Z',
          sourceRun: 'ui-test',
          variantIndex: 0,
          sensorScore: '0.99',
          judgeScore: '0.99',
          facingDirection: 'right',
        },
      },
    });
    const scene = makeRecordingScene(registry, record);
    const world = seedWorldWithGeneratedOnlyBag();

    const ui = createInventoryUI(scene as never, { height: 800 });
    ui.toggle(world);

    expect(ui.getCellScreenBounds(0)).not.toBeNull();
    expect(ui.getCellIndexForItem(MERCHANTS_CHARM_DEF.id)).toBe(0);
    expect(record.imageKeys).toContain('merchants-stained-charm-ui-test');
  });
});
