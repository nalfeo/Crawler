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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fetchGeneratedSpriteRegistry,
  preloadGeneratedSprites,
} from '../../src/engine/generatedAssets/index.js';
import {
  GENERATED_MANIFEST_VERSION,
  pickGeneratedVariant,
} from '../../src/shared/generated-assets.js';
import { getItemById } from '../../src/shared/items.js';
import { getSetPieceDef, installDefaultSetPiecePacks } from '../../src/shared/set-piece-types.js';
import { GENERATED_KEY_BY_NPC_DEF } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { HARVESTABLE_DEFS } from '../../src/shared/harvestableDefs.js';
import {
  generatedBriefIdForHarvestable,
  pickGeneratedHarvestableTextureKey,
} from '../../src/engine/phaser-bridge/sprite-kind.js';

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
  it('parses the checked-in manifest without throwing', async () => {
    if (!existsSync(REPO_MANIFEST)) {
      // First boot in a fresh checkout. The loader must still soft-fail.
      return;
    }
    const raw = readFileSync(REPO_MANIFEST, 'utf8');
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

  it('wires the classified-dossier item to real approved art, not the placeholder', async () => {
    if (!existsSync(REPO_MANIFEST)) {
      // Fresh checkout without generated art on disk — nothing to observe.
      return;
    }
    const raw = readFileSync(REPO_MANIFEST, 'utf8');
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    // The item must point its icon at the versioned brief that carries real art.
    const item = getItemById('classified-dossier');
    expect(item?.icon).toBe('classified-dossier-v1');

    // AFTER (wired): the versioned brief resolves to real, approved variants —
    // every resolved asset path is checked-in art, never a placeholder.
    const wired = registry.variants('classified-dossier-v1');
    expect(wired.length).toBeGreaterThan(0);
    for (const entry of wired) {
      expect(entry.assetPath).toContain('classified-dossier-v1');
      expect(entry.assetPath).not.toContain('placeholder');
    }
    // Deterministic pick (mirrors the runtime InventoryUI resolution) is real.
    const picked = pickGeneratedVariant(registry, item!.icon, 0);
    expect(picked?.assetPath).toContain('classified-dossier-v1');
    expect(picked?.assetPath).not.toContain('placeholder');

    // Historical context (deliberately NOT asserted — scoped to today's manifest
    // shape): before this fix the item resolved via its bare id
    // `classified-dossier`, whose only manifest entry is the 16×16 placeholder,
    // so the inventory rendered a placeholder. The durable guards are the ones
    // above (icon override → versioned brief → real, non-placeholder art); we
    // avoid asserting the bare concept's manifest internals so a future pipeline
    // change (alias generation, concept-collapsing) can't false-fail this test.
  });

  it('wires the welcome-room set-piece props to shipped generated art (no placeholders)', async () => {
    if (!existsSync(REPO_MANIFEST)) {
      // Fresh checkout without generated art on disk — nothing to observe.
      return;
    }
    const raw = readFileSync(REPO_MANIFEST, 'utf8');
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    // The exact approved variant keys the welcome-room base layers pin (the
    // velvet rope shipped as var-2, the rest as var-0). Kept in lockstep with
    // `set-pieces.json` (cross-checked below) so a rename on EITHER side — the
    // wiring or the shipped manifest — fails loudly here instead of silently
    // degrading to a labeled placeholder box in-engine.
    const expectedKeys = [
      'welcome-room-rug-var-0',
      'welcome-room-desk-var-0',
      'welcome-room-shop-table-var-0',
      'welcome-room-bookcase-var-0',
      'welcome-room-velvet-rope-var-2',
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
    if (!existsSync(REPO_MANIFEST)) {
      // Fresh checkout without generated art on disk — nothing to observe.
      return;
    }
    const raw = readFileSync(REPO_MANIFEST, 'utf8');
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
    // Spell Broker shipped as var-1 while the Goon/Merchant are var-0 — pinned
    // per def id (not a variant roll) so this stays deterministic. Cross-checked
    // against GENERATED_KEY_BY_NPC_DEF below so a rename on EITHER side — the
    // wiring map or the shipped manifest — fails loudly here.
    const expectedByDef: Record<string, string> = {
      'tutorial-goon': 'npc-welcome-goon-var-0',
      shopkeeper: 'npc-sweaty-merchant-var-0',
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
    if (!existsSync(REPO_MANIFEST)) {
      // Fresh checkout without generated art on disk — nothing to observe.
      return;
    }
    const raw = readFileSync(REPO_MANIFEST, 'utf8');
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    // Success gate: every registered harvestable node type must resolve to a
    // real, non-placeholder generated sprite (else it renders the procedural
    // fallback circle in-game). This is the manifest-coverage half of the gate;
    // the pure resolver mapping is unit-tested in phaser-bridge-sprite-kind.
    for (const def of HARVESTABLE_DEFS) {
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
