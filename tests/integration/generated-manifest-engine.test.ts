/**
 * Integration test for the engine-side manifest loader.
 *
 * Exercises the full chain:
 *   1. on-disk `manifest.json` (and its referenced PNGs)
 *   2. `fetchGeneratedSpriteRegistry` via a file-backed fetcher
 *   3. `preloadGeneratedSprites` against a recording loader
 *   4. assert the queued URLs resolve to the actual files we wrote
 *
 * Grounds the loader in real filesystem behaviour without booting Phaser.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fetchGeneratedSpriteRegistry,
  preloadGeneratedSprites,
} from '../../src/engine/generatedAssets/index.js';
import { GENERATED_MANIFEST_VERSION } from '../../src/shared/generated-assets.js';
import { getSetPieceDef, installDefaultSetPiecePacks } from '../../src/shared/set-piece-types.js';
import {
  GENERATED_KEY_BY_NPC_DEF,
  generatedBriefIdForHarvestable,
  pickGeneratedHarvestableTextureKey,
} from '../../src/engine/phaser-bridge/sprite-kind.js';
import {
  HARVESTABLE_DEFS,
  FLOOR2_HARVESTABLE_START_INDEX,
} from '../../src/shared/harvestableDefs.js';
import { isPlaceholderEntry, resolveItemSprite } from '../../src/shared/item-sprites.js';
import { FLOOR2_BASIC_LEATHER_STABLE_IDS } from '../../src/shared/data/floor2-basic-leather-bases.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../src/shared/data/floor2-equipment-art.js';
import {
  loadShippedManifestRaw,
  shippedManifestShardsExist,
} from '../helpers/generated-manifest.js';

// Only used for `path.dirname(...)` to resolve shipped PNG paths; the aggregate
// file itself is a build artifact and is never read here (see the shard helper).
const REPO_MANIFEST = path.resolve(__dirname, '../../public/assets/generated/manifest.json');

/**
 * File-backed fetcher: maps `/assets/...` URLs to files under
 * `<workspace>/assets/...`. Returns 404 for missing files so we can
 * exercise the soft-fail path with real disk semantics.
 */
function createFileFetcher(workspaceRoot: string): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    // We only model `/assets/...` URLs.
    const rel = url.startsWith('/assets/') ? url.slice('/assets/'.length) : url;
    const abs = path.join(workspaceRoot, 'assets', rel);
    if (!existsSync(abs)) {
      return new Response('not found', { status: 404 });
    }
    const body = readFileSync(abs);
    const isJson = abs.endsWith('.json');
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': isJson ? 'application/json' : 'application/octet-stream' },
    });
  }) as unknown as typeof fetch;
}

describe('generated manifest -> engine chain (fixture)', () => {
  let workspace: string;
  let assetsDir: string;
  let generatedDir: string;
  let manifestPath: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'crawler-engine-manifest-'));
    assetsDir = path.join(workspace, 'assets');
    generatedDir = path.join(assetsDir, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    manifestPath = path.join(generatedDir, 'manifest.json');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('loads an approved entry end-to-end: fetch -> registry -> preload -> texture key', async () => {
    // Write a one-entry manifest + the referenced PNG.
    writeFileSync(path.join(generatedDir, 'iron-sword.png'), Buffer.from('FAKE-PNG-IRON-SWORD'));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: GENERATED_MANIFEST_VERSION,
        entries: {
          'iron-sword': {
            briefId: 'iron-sword',
            spriteName: 'iron-sword',
            assetPath: 'generated/iron-sword.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/iron-sword/2026-06-08T12-00-00-deadbeef',
            variantIndex: 1,
            anchor: { x: 8, y: 13, source: 'brief' },
            sensorScore: '7/7',
            judgeScore: '4',
          },
        },
      }),
    );

    const fetcher = createFileFetcher(workspace);
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    expect(registry.size).toBe(1);
    expect(registry.lookup('iron-sword')?.textureKey).toBe('iron-sword');

    const queued: Array<{ textureKey: string; url: string }> = [];
    preloadGeneratedSprites({ image: (k, u) => queued.push({ textureKey: k, url: u }) }, registry);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual({
      textureKey: 'iron-sword',
      url: '/assets/generated/iron-sword.png',
    });

    // The URL the loader would request must resolve back to a real file.
    const loadResp = await fetcher(queued[0]!.url);
    expect(loadResp.status).toBe(200);
    const bytes = Buffer.from(await loadResp.arrayBuffer());
    expect(bytes.toString()).toBe('FAKE-PNG-IRON-SWORD');
  });

  it('handles a missing manifest as an empty registry (no entries to preload)', async () => {
    // Note: no manifest written.
    const fetcher = createFileFetcher(workspace);
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });
    expect(registry.size).toBe(0);

    const queued: Array<{ textureKey: string; url: string }> = [];
    preloadGeneratedSprites({ image: (k, u) => queued.push({ textureKey: k, url: u }) }, registry);
    expect(queued).toEqual([]);
  });

  it('handles multiple entries and preserves anchors', async () => {
    writeFileSync(path.join(generatedDir, 'iron-sword.png'), Buffer.from('PNG-1'));
    writeFileSync(path.join(generatedDir, 'throwing-star.png'), Buffer.from('PNG-2'));
    writeFileSync(path.join(generatedDir, 'baseball-bat.png'), Buffer.from('PNG-3'));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: GENERATED_MANIFEST_VERSION,
        entries: {
          'iron-sword': {
            briefId: 'iron-sword',
            spriteName: 'iron-sword',
            assetPath: 'generated/iron-sword.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/iron-sword/x',
            variantIndex: 0,
            anchor: { x: 8, y: 13, source: 'brief' },
            sensorScore: '7/7',
            judgeScore: null,
          },
          'throwing-star': {
            briefId: 'throwing-star',
            spriteName: 'throwing-star',
            assetPath: 'generated/throwing-star.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/throwing-star/x',
            variantIndex: 0,
            // Anchor failed to derive — engine must fall back to center.
            anchor: null,
            sensorScore: '6/7',
            judgeScore: '3',
          },
          'baseball-bat': {
            briefId: 'baseball-bat',
            spriteName: 'baseball-bat',
            assetPath: 'generated/baseball-bat.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/baseball-bat/x',
            variantIndex: 0,
            anchor: { x: 6, y: 14, source: 'derived' },
            sensorScore: '7/7',
            judgeScore: '5',
          },
        },
      }),
    );

    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher: createFileFetcher(workspace),
    });

    expect(registry.size).toBe(3);
    expect(registry.lookup('iron-sword')?.anchor).toEqual({ x: 8, y: 13 });
    expect(registry.lookup('throwing-star')?.anchor).toEqual({ x: 8, y: 8 });
    expect(registry.lookup('throwing-star')?.anchorIsDefault).toBe(true);
    expect(registry.lookup('baseball-bat')?.anchor).toEqual({ x: 6, y: 14 });

    const queued: Array<{ textureKey: string }> = [];
    preloadGeneratedSprites({ image: (k) => queued.push({ textureKey: k }) }, registry);
    expect(queued.map((q) => q.textureKey).sort()).toEqual([
      'baseball-bat',
      'iron-sword',
      'throwing-star',
    ]);
  });
});

describe('generated manifest -> engine chain (real repo manifest)', () => {
  // Build the real-manifest registry ONCE for the table-driven item cases below,
  // rather than re-reading + re-parsing the on-disk manifest for every row.
  let sharedRealRegistry: Awaited<ReturnType<typeof fetchGeneratedSpriteRegistry>> | null = null;
  beforeAll(async () => {
    if (!shippedManifestShardsExist()) {
      return;
    }
    const raw = loadShippedManifestRaw();
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    sharedRealRegistry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });
  });

  it('parses the checked-in manifest without throwing', async () => {
    if (!shippedManifestShardsExist()) {
      // First boot in a fresh checkout. The loader must still soft-fail.
      return;
    }
    const raw = loadShippedManifestRaw();
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });
    // Whatever count it has, it must be a valid registry.
    expect(registry.version).toBe(GENERATED_MANIFEST_VERSION);
    expect(typeof registry.size).toBe('number');
  });

  it('preloads real approved Basic Leather art under every generated-equipment runtime key', () => {
    if (!sharedRealRegistry) return;

    const queued: Array<{ textureKey: string; url: string }> = [];
    preloadGeneratedSprites(
      { image: (textureKey, url) => queued.push({ textureKey, url }) },
      sharedRealRegistry,
    );

    const expectedDefinitions = FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter((definition) =>
      FLOOR2_BASIC_LEATHER_STABLE_IDS.includes(definition.stableId),
    );
    expect(expectedDefinitions).toHaveLength(18);

    for (const definition of expectedDefinitions) {
      const alias = queued.find((entry) => entry.textureKey === definition.runtimeKey);
      expect(
        alias,
        `missing real-art preload alias for ${definition.stableId} (${definition.runtimeKey})`,
      ).toBeDefined();
      expect(alias!.url).not.toContain('placeholder');
      const pngPath = path.resolve(
        path.dirname(REPO_MANIFEST),
        '..',
        alias!.url.slice('/assets/'.length),
      );
      expect(existsSync(pngPath), `missing Basic Leather PNG on disk: ${pngPath}`).toBe(true);
    }
  });

  // Every migratable Floor-1 item must resolve — BY ITEM ID — to its real,
  // approved generated art, never the 2×2 placeholder. This is the deterministic
  // real-artifact gate for the "one item sprite, no separate icon" change
  // (ADR 0051): it loads the SHIPPED manifest and exercises `resolveItemSprite`,
  // the exact resolution path the inventory + equipment panels use. It is
  // migration-state agnostic — it holds BEFORE the on-disk rename (resolver
  // returns the real `<concept>-vN` key) and AFTER (resolver returns the bare
  // `<concept>` key), because `resolveItemSprite` de-prioritizes placeholders and
  // is version-tolerant. `bone-club` deliberately has no item-id art of its own;
  // it must resolve through its weapon alias (`baseball-bat`).
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
    // The baseball bat's item id is `bone-club`; its art is keyed `baseball-bat-*`
    // and it resolves via the weaponId alias, not a bare `bone-club` texture.
    { itemId: 'bone-club', concept: 'baseball-bat' },
  ];

  it.each(ITEM_ART_EXPECTATIONS)(
    'resolves item "$itemId" to real approved art, never a placeholder',
    ({ itemId, concept }) => {
      if (!sharedRealRegistry) {
        // Fresh checkout without generated art on disk — nothing to observe.
        return;
      }
      const registry = sharedRealRegistry;

      // Resolution is deterministic per (itemId, seed); across seeds it must stay
      // on real art (placeholders are fallback-only).
      for (const seed of [0, 1, 7, 42]) {
        const entry = resolveItemSprite(registry, itemId, seed);
        expect(entry, `no generated art resolved for "${itemId}" (seed ${seed})`).not.toBeNull();
        expect(
          isPlaceholderEntry(entry!),
          `"${itemId}" resolved to a placeholder (${entry!.textureKey}) at seed ${seed}`,
        ).toBe(false);
        expect(entry!.assetPath).not.toContain('placeholder');

        // briefId is the bare concept (post-migration) or `<concept>-vN` (pre-migration).
        const bareMatch = entry!.briefId === concept;
        const versionedMatch = new RegExp(`^${concept}-v\\d+$`).test(entry!.briefId);
        expect(
          bareMatch || versionedMatch,
          `"${itemId}" resolved to briefId "${entry!.briefId}", not a "${concept}" lineage`,
        ).toBe(true);

        // The resolved art's PNG is checked-in on disk (assetPath is relative to public/assets/).
        const pngPath = path.resolve(path.dirname(REPO_MANIFEST), '..', entry!.assetPath);
        expect(existsSync(pngPath), `missing PNG on disk: ${pngPath}`).toBe(true);
      }
    },
  );

  it('wires the welcome-room set-piece props to shipped generated art (no placeholders)', async () => {
    if (!shippedManifestShardsExist()) {
      // Fresh checkout without generated art on disk — nothing to observe.
      return;
    }
    const raw = loadShippedManifestRaw();
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    // The exact approved variant keys the welcome-room layers pin. Variant
    // indices are whatever the sprite run's judged winner happened to be, so
    // they are deliberately heterogeneous (var-0 through var-12) — do NOT
    // "normalise" them. Kept in lockstep with `set-pieces.json` (cross-checked
    // below) so a rename on EITHER side — the wiring or the shipped manifest —
    // fails loudly here instead of silently degrading to a labeled placeholder
    // box in-engine.
    const expectedKeys = [
      'welcome-room-bookcase-var-0',
      'welcome-room-bunk-bed-var-6',
      'welcome-room-call-sheet-var-3',
      'welcome-room-camera-rig-var-4',
      'welcome-room-carpet-var-4',
      'welcome-room-chair-turned-var-0',
      'welcome-room-chore-rota-var-2',
      'welcome-room-desk-var-0',
      'welcome-room-door-var-2',
      'welcome-room-exit-sign-wall-var-2',
      'welcome-room-floor-runner-var-10',
      'welcome-room-floor-seam-var-9',
      'welcome-room-history-board-var-3',
      'welcome-room-kitchenette-var-0',
      'welcome-room-laundry-line-var-0',
      'welcome-room-lounge-stool-var-1',
      'welcome-room-merchant-board-var-6',
      'welcome-room-mini-fridge-var-2',
      'welcome-room-potted-plant-var-0',
      'welcome-room-rug-var-0',
      'welcome-room-shop-table-var-0',
      'welcome-room-show-poster-var-0',
      'welcome-room-side-table-var-12',
      'welcome-room-stanchion-pair-var-4',
      'welcome-room-trash-bin-var-0',
      'welcome-room-velvet-rope-var-2',
      'welcome-room-wall-banner-var-6',
      'welcome-room-wall-shelf-var-0',
    ];

    // 1) The shipped manifest carries each key as its own texture, resolving to
    //    real (non-placeholder) art. Mirrors the engine's catalog-resolution
    //    path: `scene.textures.exists(spriteId)` against the bare manifest key.
    const byTextureKey = new Map(registry.entries().map((entry) => [entry.textureKey, entry]));
    for (const key of expectedKeys) {
      const entry = byTextureKey.get(key);
      expect(entry, `shipped manifest is missing generated key "${key}"`).toBeDefined();
      expect(entry!.assetPath).toContain(key);
      expect(entry!.assetPath).not.toContain('placeholder');
    }

    // 2) The welcome-room wiring still pins exactly those generated keys, so the
    //    guard above cannot drift out of sync with `set-pieces.json`.
    installDefaultSetPiecePacks();
    const room = getSetPieceDef('welcome-room')!;
    const wiredGeneratedKeys: string[] = [];
    for (const prop of room.props) {
      for (const layer of prop.layers) {
        const sprite = layer.sprite;
        if (sprite.source === 'catalog' && sprite.spriteId.startsWith('welcome-room-')) {
          wiredGeneratedKeys.push(sprite.spriteId);
        }
      }
    }
    expect(new Set(wiredGeneratedKeys)).toEqual(new Set(expectedKeys));
  });

  it('wires each welcome-room NPC to its own shipped generated sprite (no placeholders)', async () => {
    if (!shippedManifestShardsExist()) {
      // Fresh checkout without generated art on disk — nothing to observe.
      return;
    }
    const raw = loadShippedManifestRaw();
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    // The exact pinned generated keys each welcome-room NPC resolves to. The
    // approved variants differ per NPC (Goon var-1, Merchant var-3, Broker
    // var-1) — pinned per def id (not a variant roll) so this stays
    // deterministic. Cross-checked against GENERATED_KEY_BY_NPC_DEF below so a
    // rename on EITHER side — the wiring map or the shipped manifest — fails
    // loudly here.
    const expectedByDef: Record<string, string> = {
      'tutorial-goon': 'welcome-goon-v3-var-1',
      shopkeeper: 'sweaty-merchant-v3-var-3',
      'spell-quest-giver': 'npc-spell-broker-var-1',
    };

    // 1) Each pinned key exists in the shipped manifest as its own texture and
    //    resolves to real (non-placeholder) art. Mirrors the engine's
    //    resolveNpcTexture gate: `scene.textures.exists(key)` on the bare key.
    const byTextureKey = new Map(registry.entries().map((entry) => [entry.textureKey, entry]));
    for (const key of Object.values(expectedByDef)) {
      const entry = byTextureKey.get(key);
      expect(entry, `shipped manifest is missing generated NPC key "${key}"`).toBeDefined();
      expect(entry!.assetPath).toContain(key);
      expect(entry!.assetPath).not.toContain('placeholder');
    }

    // 2) The three keys are distinct (the feature's core requirement: three
    //    distinct sprites, not one shared villager).
    expect(new Set(Object.values(expectedByDef)).size).toBe(3);

    // 3) The engine wiring map pins exactly those def→key mappings, so the guard
    //    above cannot drift out of sync with GENERATED_KEY_BY_NPC_DEF.
    expect(GENERATED_KEY_BY_NPC_DEF).toEqual(expectedByDef);
  });

  it('wires all Floor-1 harvestable nodes to real approved art, not placeholders', async () => {
    if (!shippedManifestShardsExist()) {
      // Fresh checkout without generated art on disk — nothing to observe.
      return;
    }
    const raw = loadShippedManifestRaw();
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    // Success gate: every Floor-1 harvestable node type must resolve to a
    // real, non-placeholder generated sprite (else it renders the procedural
    // fallback circle in-game). This is the manifest-coverage half of the gate;
    // the pure resolver mapping is unit-tested in phaser-bridge-sprite-kind.
    // Floor 2 nodes (indices >= FLOOR2_HARVESTABLE_START_INDEX) have brief IDs
    // wired but their art is generated in a separate pipeline step — they are
    // excluded here until approved art lands in the manifest.
    const floor1Defs = HARVESTABLE_DEFS.slice(0, FLOOR2_HARVESTABLE_START_INDEX);
    for (const def of floor1Defs) {
      const briefId = generatedBriefIdForHarvestable(def.id);
      expect(briefId, `harvestable "${def.id}" has no wired briefId`).toBeDefined();

      const variants = registry.variants(briefId!);
      expect(
        variants.length,
        `no approved art for harvestable "${def.id}" (brief ${briefId})`,
      ).toBeGreaterThan(0);
      for (const entry of variants) {
        expect(entry.assetPath).toContain(briefId!);
        expect(entry.assetPath).not.toContain('placeholder');
      }

      // Deterministic pick mirrors the runtime PhaserBridge resolution path.
      const textureKey = pickGeneratedHarvestableTextureKey(registry, def.id, 0);
      expect(textureKey, `harvestable "${def.id}" resolved no texture key`).not.toBeNull();
      expect(textureKey).toContain(briefId!);
    }
  });
});
