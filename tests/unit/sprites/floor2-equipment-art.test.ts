import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  FLOOR2_EQUIPMENT_PRODUCTION_WAVES,
  FLOOR2_EQUIPMENT_STABLE_IDS,
  FLOOR2_WEAPON_FAMILIES,
  runtimeKeyForFloor2Equipment,
} from '../../../src/shared/floor2-equipment-art.js';
import {
  buildGeneratedSpriteRegistry,
  parseGeneratedManifest,
  type GeneratedManifest,
} from '../../../src/shared/generated-assets.js';
import { composeFloor2EquipmentPlaceholder } from '../../../scripts/sprites/floor2-equipment-placeholder-composer.js';
import {
  createFloor2PlaceholderManifestEntry,
  generateFloor2EquipmentPlaceholders,
  upsertCanonicalFloor2EquipmentEntry,
  type Floor2EquipmentManifestEntry,
} from '../../../scripts/sprites/generate-floor2-equipment-placeholders.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PLAN_PATH = path.join(
  REPO_ROOT,
  'docs',
  'knowledge',
  'epics',
  'floor-2-equipment',
  'PLAN.md',
);
const SHIPPED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'public',
  'assets',
  'generated',
  'manifest.json',
);

function canonicalPlanSpriteIds(): readonly string[] {
  const plan = fs.readFileSync(PLAN_PATH, 'utf8');
  const contract = /<!-- EPIC-CONTRACT:BEGIN -->[\s\S]*?```json\s*([\s\S]*?)\s*```/.exec(plan);
  if (!contract?.[1]) throw new Error('Floor 2 equipment PLAN contract is missing');
  const parsed = JSON.parse(contract[1]) as { catalog?: { sprite_ids?: unknown } };
  if (!Array.isArray(parsed.catalog?.sprite_ids)) {
    throw new Error('Floor 2 equipment PLAN catalog.sprite_ids is missing');
  }
  return parsed.catalog.sprite_ids as string[];
}

describe('Floor 2 equipment art manifest', () => {
  it('exactly matches the ordered canonical PLAN sprite manifest and runtime-key formula', () => {
    expect(FLOOR2_EQUIPMENT_STABLE_IDS).toEqual(canonicalPlanSpriteIds());
    expect(FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => entry.stableId)).toEqual(
      canonicalPlanSpriteIds(),
    );
    for (const entry of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
      const expected = `equipment/${entry.stableId.replace('.', '/')}`;
      expect(entry.runtimeKey).toBe(expected);
      expect(runtimeKeyForFloor2Equipment(entry.stableId)).toBe(expected);
    }
  });

  it('has exact counts, unique identities and paths, and approved slot/category coverage', () => {
    expect(FLOOR2_EQUIPMENT_ART_DEFINITIONS).toHaveLength(70);
    const weapons = FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter((entry) => entry.category === 'weapon');
    expect(weapons).toHaveLength(50);
    expect(
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter((entry) => entry.category !== 'weapon'),
    ).toHaveLength(20);
    for (const values of [
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => entry.stableId),
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => entry.runtimeKey),
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => entry.placeholderAssetPath),
    ]) {
      expect(new Set(values).size).toBe(values.length);
    }
    expect(
      Object.fromEntries(
        ['head', 'torso', 'hands', 'feet', 'accessory'].map((slot) => [
          slot,
          FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter((entry) => entry.slot === slot).length,
        ]),
      ),
    ).toEqual({ head: 4, torso: 4, hands: 3, feet: 3, accessory: 6 });
  });

  it('assigns exactly five weapon bases to every A1-approved family', () => {
    for (const family of FLOOR2_WEAPON_FAMILIES) {
      expect(
        FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter(
          (entry) => entry.category === 'weapon' && entry.family === family,
        ),
      ).toHaveLength(5);
    }
  });

  it('partitions every key into one non-overlapping weapon-family or UI-slot production wave', () => {
    expect(FLOOR2_EQUIPMENT_PRODUCTION_WAVES).toHaveLength(15);
    const waveEntries = FLOOR2_EQUIPMENT_PRODUCTION_WAVES.flatMap((wave) => wave.entries);
    expect(waveEntries).toHaveLength(70);
    expect(new Set(waveEntries.map((entry) => entry.runtimeKey)).size).toBe(70);
    expect(waveEntries.map((entry) => entry.runtimeKey).sort()).toEqual(
      FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => entry.runtimeKey).sort(),
    );
    for (const wave of FLOOR2_EQUIPMENT_PRODUCTION_WAVES) {
      expect(wave.entries.every((entry) => entry.productionWaveId === wave.id)).toBe(true);
      expect(wave.entries.every((entry) => entry.briefInput.name.length > 0)).toBe(true);
      expect(
        wave.entries.every((entry) => entry.briefInput.description.includes(entry.runtimeKey)),
      ).toBe(true);
    }
  });
});

describe('Floor 2 equipment placeholder composition', () => {
  it('is byte-deterministic and unique for all 70 keys', () => {
    const hashes = new Set<string>();
    for (const definition of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
      const first = composeFloor2EquipmentPlaceholder(definition);
      const second = composeFloor2EquipmentPlaceholder(definition);
      expect(first.equals(second)).toBe(true);
      hashes.add(crypto.createHash('sha256').update(first).digest('hex'));
    }
    expect(hashes.size).toBe(70);
  });

  it('generates a parseable manifest whose exact runtime keys resolve to placeholder textures', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floor2-equipment-art-'));
    try {
      const result = generateFloor2EquipmentPlaceholders({ repoRoot: root });
      expect(result).toEqual({ written: 70, preservedProduction: 0 });
      const manifestPath = path.join(root, 'public', 'assets', 'generated', 'manifest.json');
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifest = parseGeneratedManifest(raw);
      const registry = buildGeneratedSpriteRegistry(manifest);
      expect(registry.size).toBe(70);
      for (const definition of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
        const entry = registry.lookup(definition.runtimeKey);
        expect(entry?.textureKey).toBe(definition.runtimeKey);
        expect(entry?.sourceRun).toBe('floor2-equipment-placeholder/v1');
        expect(
          fs.existsSync(path.join(root, 'public', 'assets', definition.placeholderAssetPath)),
        ).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('promotes production art in place and never lets a placeholder overwrite it', () => {
    const definition = FLOOR2_EQUIPMENT_ART_DEFINITIONS[0]!;
    const manifest: GeneratedManifest = { version: 1, entries: {} };
    const placeholder = createFloor2PlaceholderManifestEntry(definition);
    expect(upsertCanonicalFloor2EquipmentEntry(manifest, definition.runtimeKey, placeholder)).toBe(
      'inserted',
    );
    const production: Floor2EquipmentManifestEntry = {
      ...placeholder,
      assetPath: 'generated/equipment/weapon/iron-cleaver.png',
      sourceRun: 'approved-run',
      sensorScore: '7/7',
    };
    expect(upsertCanonicalFloor2EquipmentEntry(manifest, definition.runtimeKey, production)).toBe(
      'promoted',
    );
    expect(Object.keys(manifest.entries)).toEqual([definition.runtimeKey]);
    expect(manifest.entries[definition.runtimeKey]?.assetPath).toBe(production.assetPath);
    expect(upsertCanonicalFloor2EquipmentEntry(manifest, definition.runtimeKey, placeholder)).toBe(
      'preserved-production',
    );
    expect(manifest.entries[definition.runtimeKey]?.assetPath).toBe(production.assetPath);
    const secondProduction: Floor2EquipmentManifestEntry = {
      ...production,
      assetPath: 'generated/equipment/weapon/iron-cleaver-second.png',
      sourceRun: 'approved-run-2',
    };
    expect(
      upsertCanonicalFloor2EquipmentEntry(manifest, definition.runtimeKey, secondProduction),
    ).toBe('preserved-production');
    expect(manifest.entries[definition.runtimeKey]?.assetPath).toBe(production.assetPath);
  });

  it('preserves field order for unrelated production manifest entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floor2-equipment-art-order-'));
    try {
      const manifestPath = path.join(root, 'public', 'assets', 'generated', 'manifest.json');
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      const manifest = {
        version: 1,
        entries: {
          unrelated: {
            briefId: 'unrelated-v1',
            spriteName: 'unrelated-v1-var-0',
            assetPath: 'generated/unrelated-v1-var-0.png',
            approvedAt: '2026-01-01T00:00:00.000Z',
            sourceRun: 'approved-run',
            variantIndex: 0,
            anchor: null,
            sensorScore: '7/7',
            judgeScore: null,
            type: 'item',
            contentHash: 'abc123',
            anchors: { hold: null, centerOfGravity: null },
          },
        },
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const entryBefore = JSON.stringify(manifest.entries.unrelated);
      generateFloor2EquipmentPlaceholders({ repoRoot: root });
      const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        entries: Record<string, unknown>;
      };
      expect(JSON.stringify(after.entries['unrelated'])).toBe(entryBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ships every placeholder file and manifest entry under the reserved canonical key', () => {
    const manifest = parseGeneratedManifest(
      JSON.parse(fs.readFileSync(SHIPPED_MANIFEST_PATH, 'utf8')),
    );
    const registry = buildGeneratedSpriteRegistry(manifest);
    for (const definition of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
      const entry = registry.lookup(definition.runtimeKey);
      expect(entry?.textureKey).toBe(definition.runtimeKey);
      expect(entry?.sourceRun).toBe('floor2-equipment-placeholder/v1');
      expect(
        fs.existsSync(path.join(REPO_ROOT, 'public', 'assets', definition.placeholderAssetPath)),
      ).toBe(true);
    }
  });
});
