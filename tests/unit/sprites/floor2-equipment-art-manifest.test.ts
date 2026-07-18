import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLOOR2_EQUIPMENT_ART_ENTRIES,
  FLOOR2_WEAPON_FAMILIES,
  FLOOR2_EQUIPMENT_ART_KEY_SET,
  FLOOR2_WEAPON_ART_ENTRIES,
  FLOOR2_ARMOR_ART_ENTRIES,
  floor2EquipmentPipelineBriefId,
  floor2EquipmentPlaceholderKey,
  floor2EquipmentPlaceholderPng,
} from '../../../src/shared/floor2-equipment-art-keys.js';
import { loadAssetPlan } from '../../../scripts/sprites/asset-plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const manifestPath = path.join(repoRoot, 'public', 'assets', 'generated', 'manifest.json');
const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
const weaponsPlanPath = path.join(repoRoot, 'plans', 'floor2-equipment', 'floor2-weapons.art.yaml');
const armorPlanPath = path.join(repoRoot, 'plans', 'floor2-equipment', 'floor2-armor.art.yaml');

interface ManifestEntry {
  briefId: string;
  spriteName: string;
  assetPath: string;
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

function loadManifest(): Manifest {
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as Manifest;
}

/**
 * Guards the Floor 2 equipment art-key manifest:
 *   - Validates the 70-key stable manifest structure and counts.
 *   - Validates weapon family coverage (10 families × 5 weapons each).
 *   - Validates slot coverage across head/torso/hands/feet/accessory.
 *   - Validates that every key has a deterministic placeholder in the generated manifest.
 *   - Validates that every placeholder PNG exists on disk.
 */
describe('floor2 equipment art-key manifest', () => {
  describe('entry count and structure', () => {
    it('has exactly 70 stable art-key entries', () => {
      expect(FLOOR2_EQUIPMENT_ART_ENTRIES.length).toBe(70);
    });

    it('has exactly 50 weapon entries', () => {
      expect(FLOOR2_WEAPON_ART_ENTRIES.length).toBe(50);
    });

    it('has exactly 20 armor/accessory entries', () => {
      expect(FLOOR2_ARMOR_ART_ENTRIES.length).toBe(20);
    });

    it('every entry has a non-empty artKey in type.base-name format', () => {
      const invalid: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]+$/.test(entry.artKey)) {
          invalid.push(entry.artKey);
        }
      }
      expect(
        invalid,
        `entries with invalid artKey format (expected type.base-name): ${invalid.join(', ')}`,
      ).toEqual([]);
    });

    it('all art keys are globally unique', () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        if (seen.has(entry.artKey)) {
          duplicates.push(entry.artKey);
        }
        seen.add(entry.artKey);
      }
      expect(duplicates, `duplicate art keys: ${duplicates.join(', ')}`).toEqual([]);
    });

    it('every entry runtimeKey matches equipment/<type>/<base-name> convention', () => {
      const wrong: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        const [typePart, basePart] = entry.artKey.split('.');
        const expected = `equipment/${typePart}/${basePart}`;
        if (entry.runtimeKey !== expected) {
          wrong.push(`${entry.artKey}: runtimeKey=${entry.runtimeKey} expected=${expected}`);
        }
      }
      expect(wrong, `entries with incorrect runtimeKey: ${wrong.join('; ')}`).toEqual([]);
    });

    it('every entry has a non-empty label and description', () => {
      const missing: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        if (!entry.label.trim() || !entry.description.trim()) {
          missing.push(entry.artKey);
        }
      }
      expect(missing, `entries with empty label or description: ${missing.join(', ')}`).toEqual([]);
    });

    it('weapon entries have type "weapon" and non-null family', () => {
      const invalid: string[] = [];
      for (const entry of FLOOR2_WEAPON_ART_ENTRIES) {
        if (entry.type !== 'weapon' || entry.family === null) {
          invalid.push(entry.artKey);
        }
      }
      expect(
        invalid,
        `weapon entries with wrong type or null family: ${invalid.join(', ')}`,
      ).toEqual([]);
    });

    it('armor/accessory entries have type "item" and null family', () => {
      const invalid: string[] = [];
      for (const entry of FLOOR2_ARMOR_ART_ENTRIES) {
        if (entry.type !== 'item' || entry.family !== null) {
          invalid.push(entry.artKey);
        }
      }
      expect(
        invalid,
        `armor entries with wrong type or non-null family: ${invalid.join(', ')}`,
      ).toEqual([]);
    });
  });

  describe('weapon family coverage', () => {
    it('has exactly 10 weapon families', () => {
      expect(FLOOR2_WEAPON_FAMILIES.length).toBe(10);
    });

    it('each weapon family has exactly 5 weapons', () => {
      const wrongSize: string[] = [];
      for (const family of FLOOR2_WEAPON_FAMILIES) {
        if (family.weapons.length !== 5) {
          wrongSize.push(`${family.id}: ${family.weapons.length} weapons`);
        }
      }
      expect(wrongSize, `families with wrong weapon count: ${wrongSize.join('; ')}`).toEqual([]);
    });

    it('all 50 weapon art entries have a family listed in the family registry', () => {
      const familyIds = new Set(FLOOR2_WEAPON_FAMILIES.map((f) => f.id));
      const unknownFamily: string[] = [];
      for (const entry of FLOOR2_WEAPON_ART_ENTRIES) {
        if (entry.family !== null && !familyIds.has(entry.family)) {
          unknownFamily.push(`${entry.artKey}: family=${entry.family}`);
        }
      }
      expect(
        unknownFamily,
        `entries referencing unknown families: ${unknownFamily.join('; ')}`,
      ).toEqual([]);
    });

    it('each family weapon list maps to actual art entries', () => {
      const artKeySet = FLOOR2_EQUIPMENT_ART_KEY_SET;
      const missing: string[] = [];
      for (const family of FLOOR2_WEAPON_FAMILIES) {
        for (const baseName of family.weapons) {
          const artKey = `weapon.${baseName}`;
          if (!artKeySet.has(artKey)) {
            missing.push(`${family.id}: weapon.${baseName}`);
          }
        }
      }
      expect(
        missing,
        `family weapon base names with no matching art entry: ${missing.join('; ')}`,
      ).toEqual([]);
    });

    it('weapon family lists are internally non-overlapping', () => {
      const seen = new Map<string, string>();
      const conflicts: string[] = [];
      for (const family of FLOOR2_WEAPON_FAMILIES) {
        for (const baseName of family.weapons) {
          const artKey = `weapon.${baseName}`;
          if (seen.has(artKey)) {
            conflicts.push(`${artKey} in both ${seen.get(artKey)} and ${family.id}`);
          }
          seen.set(artKey, family.id);
        }
      }
      expect(
        conflicts,
        `weapons appearing in more than one family: ${conflicts.join('; ')}`,
      ).toEqual([]);
    });

    it('each weapon entry family matches the family registry assignment', () => {
      const entryFamilyByKey = new Map<string, string | null>(
        FLOOR2_WEAPON_ART_ENTRIES.map((e) => [e.artKey, e.family]),
      );
      const mismatches: string[] = [];
      for (const family of FLOOR2_WEAPON_FAMILIES) {
        for (const baseName of family.weapons) {
          const artKey = `weapon.${baseName}`;
          const entryFamily = entryFamilyByKey.get(artKey);
          if (entryFamily !== family.id) {
            mismatches.push(
              `${artKey}: entry.family=${entryFamily}, family registry says ${family.id}`,
            );
          }
        }
      }
      expect(mismatches, `family assignment mismatches: ${mismatches.join('; ')}`).toEqual([]);
    });
  });

  describe('slot coverage', () => {
    it('covers head, torso, hands, feet, and accessory slots', () => {
      const requiredSlots = ['head', 'torso', 'hands', 'feet', 'accessory'];
      const coveredSlots = new Set(FLOOR2_ARMOR_ART_ENTRIES.map((e) => e.slot));
      const missing = requiredSlots.filter((s) => !coveredSlots.has(s));
      expect(missing, `required non-weapon slots with no coverage: ${missing.join(', ')}`).toEqual(
        [],
      );
    });

    it('has at least 3 head slot entries', () => {
      const count = FLOOR2_ARMOR_ART_ENTRIES.filter((e) => e.slot === 'head').length;
      expect(count).toBeGreaterThanOrEqual(3);
    });

    it('has at least 3 torso slot entries', () => {
      const count = FLOOR2_ARMOR_ART_ENTRIES.filter((e) => e.slot === 'torso').length;
      expect(count).toBeGreaterThanOrEqual(3);
    });

    it('has at least 2 hands slot entries', () => {
      const count = FLOOR2_ARMOR_ART_ENTRIES.filter((e) => e.slot === 'hands').length;
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('has at least 2 feet slot entries', () => {
      const count = FLOOR2_ARMOR_ART_ENTRIES.filter((e) => e.slot === 'feet').length;
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('has at least 4 accessory slot entries', () => {
      const count = FLOOR2_ARMOR_ART_ENTRIES.filter((e) => e.slot === 'accessory').length;
      expect(count).toBeGreaterThanOrEqual(4);
    });
  });

  describe('generated manifest placeholder coverage', () => {
    it('manifest file exists', () => {
      expect(existsSync(manifestPath)).toBe(true);
    });

    it('every Floor 2 art key has a placeholder entry in the generated manifest', () => {
      const manifest = loadManifest();
      const missing: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        const key = floor2EquipmentPlaceholderKey(entry.artKey);
        if (!manifest.entries[key]) {
          missing.push(entry.artKey);
        }
      }
      expect(
        missing,
        `art keys missing a placeholder manifest entry: ${missing.join(', ')}`,
      ).toEqual([]);
    });

    it('every Floor 2 placeholder manifest entry has sourceRun "placeholder"', () => {
      const manifest = loadManifest();
      const wrongSourceRun: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        const key = floor2EquipmentPlaceholderKey(entry.artKey);
        const manifestEntry = manifest.entries[key];
        if (manifestEntry && manifestEntry.sourceRun !== 'placeholder') {
          wrongSourceRun.push(`${entry.artKey}: sourceRun=${manifestEntry.sourceRun}`);
        }
      }
      expect(
        wrongSourceRun,
        `placeholder entries with unexpected sourceRun: ${wrongSourceRun.join('; ')}`,
      ).toEqual([]);
    });

    it('every Floor 2 placeholder manifest entry has the correct briefId', () => {
      const manifest = loadManifest();
      const wrongBriefId: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        const key = floor2EquipmentPlaceholderKey(entry.artKey);
        const manifestEntry = manifest.entries[key];
        const expectedBriefId = floor2EquipmentPipelineBriefId(entry.artKey);
        if (manifestEntry && manifestEntry.briefId !== expectedBriefId) {
          wrongBriefId.push(
            `${entry.artKey}: briefId=${manifestEntry.briefId} expected=${expectedBriefId}`,
          );
        }
      }
      expect(
        wrongBriefId,
        `placeholder entries with wrong briefId: ${wrongBriefId.join('; ')}`,
      ).toEqual([]);
    });

    it('every Floor 2 placeholder PNG file exists on disk', () => {
      const missingFiles: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        const pngPath = path.join(generatedDir, floor2EquipmentPlaceholderPng(entry.artKey));
        if (!existsSync(pngPath)) {
          missingFiles.push(entry.artKey);
        }
      }
      expect(
        missingFiles,
        `art keys with missing placeholder PNG files: ${missingFiles.join(', ')}`,
      ).toEqual([]);
    });

    it('placeholder manifest entries use the correct assetPath convention', () => {
      const manifest = loadManifest();
      const wrongPath: string[] = [];
      for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
        const key = floor2EquipmentPlaceholderKey(entry.artKey);
        const manifestEntry = manifest.entries[key];
        const expectedAssetPath = `generated/${floor2EquipmentPlaceholderPng(entry.artKey)}`;
        if (manifestEntry && manifestEntry.assetPath !== expectedAssetPath) {
          wrongPath.push(
            `${entry.artKey}: assetPath=${manifestEntry.assetPath} expected=${expectedAssetPath}`,
          );
        }
      }
      expect(wrongPath, `entries with wrong assetPath: ${wrongPath.join('; ')}`).toEqual([]);
    });
  });

  describe('plan ↔ placeholder naming contract', () => {
    it('uses canonical pipeline brief ids across both Floor 2 plan files', () => {
      const plans = [loadAssetPlan(weaponsPlanPath), loadAssetPlan(armorPlanPath)];
      const actualIds = new Set<string>();
      for (const plan of plans) {
        for (const asset of plan.assets) {
          actualIds.add(asset.briefId ?? asset.id);
        }
      }
      const expectedIds = new Set(
        FLOOR2_EQUIPMENT_ART_ENTRIES.map((entry) => floor2EquipmentPipelineBriefId(entry.artKey)),
      );
      expect([...actualIds].sort()).toEqual([...expectedIds].sort());
    });

    it('intentionally leaves Floor 2 plan integration targets unset until runtime wiring exists', () => {
      const plans = [loadAssetPlan(weaponsPlanPath), loadAssetPlan(armorPlanPath)];
      const unexpectedTargets: string[] = [];
      for (const plan of plans) {
        for (const asset of plan.assets) {
          if (asset.integration !== undefined) {
            unexpectedTargets.push(`${plan.id}:${asset.id}`);
          }
        }
      }
      expect(
        unexpectedTargets,
        `plan assets that still claim live integration targets: ${unexpectedTargets.join('; ')}`,
      ).toEqual([]);
    });
  });
});
