import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../../scripts/sprites/gen-placeholders.js';
import {
  FLOOR2_EQUIPMENT_ART_ENTRIES,
  floor2EquipmentPipelineBriefId,
  floor2EquipmentPlaceholderKey,
  floor2EquipmentPlaceholderPng,
} from '../../../src/shared/floor2-equipment-art-keys.js';
import { ITEM_CATALOG } from '../../../src/shared/items.js';

interface ManifestEntry {
  briefId: string;
  spriteName: string;
  assetPath: string;
  approvedAt: string;
  sourceRun: string;
  variantIndex: number;
  anchor: null;
  sensorScore: string;
  judgeScore: null;
}

interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

const TOTAL_PLACEHOLDERS = ITEM_CATALOG.length + FLOOR2_EQUIPMENT_ART_ENTRIES.length;

function createWorkspace(): { root: string; generatedDir: string; manifestPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'crawler-gen-placeholders-'));
  const generatedDir = path.join(root, 'public', 'assets', 'generated');
  mkdirSync(generatedDir, { recursive: true });
  return {
    root,
    generatedDir,
    manifestPath: path.join(generatedDir, 'manifest.json'),
  };
}

function loadManifest(manifestPath: string): Manifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

describe('gen-placeholders run()', () => {
  it('generates Floor 2 placeholder entries with canonical pipeline brief ids', () => {
    const { root, generatedDir, manifestPath } = createWorkspace();
    try {
      const result = run({ dryRun: false, force: false, generatedDir, manifestPath });
      expect(result).toEqual({ added: TOTAL_PLACEHOLDERS, skipped: 0 });

      const artKey = 'weapon.iron-cleaver';
      const manifest = loadManifest(manifestPath);
      const placeholder = manifest.entries[floor2EquipmentPlaceholderKey(artKey)];
      expect(placeholder?.briefId).toBe(floor2EquipmentPipelineBriefId(artKey));
      expect(placeholder?.spriteName).toBe(floor2EquipmentPipelineBriefId(artKey));
      expect(placeholder?.assetPath).toBe(`generated/${floor2EquipmentPlaceholderPng(artKey)}`);
      expect(existsSync(path.join(generatedDir, floor2EquipmentPlaceholderPng(artKey)))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips reruns without force and leaves files untouched on force dry-run', () => {
    const { root, generatedDir, manifestPath } = createWorkspace();
    try {
      run({ dryRun: false, force: false, generatedDir, manifestPath });
      const firstManifest = readFileSync(manifestPath, 'utf8');

      const rerun = run({ dryRun: false, force: false, generatedDir, manifestPath });
      expect(rerun).toEqual({ added: 0, skipped: TOTAL_PLACEHOLDERS });
      expect(readFileSync(manifestPath, 'utf8')).toBe(firstManifest);

      const dryForce = run({ dryRun: true, force: true, generatedDir, manifestPath });
      expect(dryForce).toEqual({ added: TOTAL_PLACEHOLDERS, skipped: 0 });
      expect(readFileSync(manifestPath, 'utf8')).toBe(firstManifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes placeholder entries on force but never writes a Floor 2 placeholder over a real approval', () => {
    const { root, generatedDir, manifestPath } = createWorkspace();
    try {
      const placeholderArtKey = 'weapon.iron-cleaver';
      const realArtKey = 'weapon.ashwood-bow';
      const oldApprovedAt = '2000-01-01T00:00:00.000Z';
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            version: 1,
            entries: {
              [floor2EquipmentPlaceholderKey(placeholderArtKey)]: {
                briefId: floor2EquipmentPipelineBriefId(placeholderArtKey),
                spriteName: floor2EquipmentPipelineBriefId(placeholderArtKey),
                assetPath: `generated/${floor2EquipmentPlaceholderPng(placeholderArtKey)}`,
                approvedAt: oldApprovedAt,
                sourceRun: 'placeholder',
                variantIndex: 0,
                anchor: null,
                sensorScore: 'placeholder',
                judgeScore: null,
              },
              [`${floor2EquipmentPipelineBriefId(realArtKey)}-var-0`]: {
                briefId: floor2EquipmentPipelineBriefId(realArtKey),
                spriteName: `${floor2EquipmentPipelineBriefId(realArtKey)}-var-0`,
                assetPath: `generated/${floor2EquipmentPipelineBriefId(realArtKey)}-var-0.png`,
                approvedAt: '2026-07-18T00:00:00.000Z',
                sourceRun: `generated/runs/${floor2EquipmentPipelineBriefId(realArtKey)}/run-1`,
                variantIndex: 0,
                anchor: null,
                sensorScore: '7/7',
                judgeScore: null,
              },
            },
          } satisfies Manifest,
          null,
          2,
        ),
      );

      const result = run({ dryRun: false, force: true, generatedDir, manifestPath });
      expect(result).toEqual({ added: TOTAL_PLACEHOLDERS - 1, skipped: 1 });

      const manifest = loadManifest(manifestPath);
      expect(
        manifest.entries[floor2EquipmentPlaceholderKey(placeholderArtKey)]?.approvedAt,
      ).not.toBe(oldApprovedAt);
      expect(manifest.entries[floor2EquipmentPlaceholderKey(realArtKey)]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
