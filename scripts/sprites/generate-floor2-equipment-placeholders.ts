import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Floor2EquipmentArtDefinition,
  Floor2EquipmentRuntimeKey,
} from '../../src/shared/floor2-equipment-art.js';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  getFloor2EquipmentArtDefinition,
} from '../../src/shared/floor2-equipment-art.js';
import type { GeneratedManifest, ManifestEntry } from '../../src/shared/generated-assets.js';
import { parseGeneratedManifest } from '../../src/shared/generated-assets.js';
import { composeFloor2EquipmentPlaceholder } from './floor2-equipment-placeholder-composer.js';

export const FLOOR2_PLACEHOLDER_PROVENANCE = 'floor2-equipment-placeholder/v1';
export const FLOOR2_PLACEHOLDER_TIMESTAMP = '2026-07-17T00:00:00.000Z';

export type Floor2EquipmentManifestEntry = ManifestEntry & {
  readonly equipment: {
    readonly stableId: string;
    readonly runtimeKey: Floor2EquipmentRuntimeKey;
    readonly category: string;
    readonly family: string;
    readonly slot: string;
    readonly productionWaveId: string;
  };
};

function isPlaceholder(entry: ManifestEntry): boolean {
  return (
    entry.sourceRun === FLOOR2_PLACEHOLDER_PROVENANCE ||
    entry.sourceRun === 'placeholder' ||
    entry.sensorScore === 'placeholder' ||
    entry.assetPath.endsWith('-placeholder.png')
  );
}

function assertCanonicalEntry(
  runtimeKey: Floor2EquipmentRuntimeKey,
  entry: Floor2EquipmentManifestEntry,
): void {
  const definition = getFloor2EquipmentArtDefinition(runtimeKey);
  if (!definition) {
    throw new Error(`Cannot upsert unreserved Floor 2 equipment art key: ${runtimeKey}`);
  }
  if (
    entry.briefId !== runtimeKey ||
    entry.spriteName !== runtimeKey ||
    entry.equipment.runtimeKey !== runtimeKey ||
    entry.equipment.stableId !== definition.stableId
  ) {
    throw new Error(
      `Manifest entry does not preserve canonical Floor 2 art identity: ${runtimeKey}`,
    );
  }
}

export function upsertCanonicalFloor2EquipmentEntry(
  manifest: GeneratedManifest,
  runtimeKey: Floor2EquipmentRuntimeKey,
  entry: Floor2EquipmentManifestEntry,
): 'inserted' | 'updated-placeholder' | 'promoted' | 'preserved-production' {
  assertCanonicalEntry(runtimeKey, entry);
  const existing = manifest.entries[runtimeKey];
  if (!existing) {
    manifest.entries[runtimeKey] = entry;
    return 'inserted';
  }
  if (!isPlaceholder(existing) && isPlaceholder(entry)) {
    return 'preserved-production';
  }
  if (!isPlaceholder(existing) && !isPlaceholder(entry)) {
    return 'preserved-production';
  }
  const outcome =
    isPlaceholder(existing) && !isPlaceholder(entry) ? 'promoted' : 'updated-placeholder';
  manifest.entries[runtimeKey] = entry;
  return outcome;
}

export function createFloor2PlaceholderManifestEntry(
  definition: Floor2EquipmentArtDefinition,
): Floor2EquipmentManifestEntry {
  return {
    briefId: definition.runtimeKey,
    spriteName: definition.runtimeKey,
    assetPath: definition.placeholderAssetPath,
    approvedAt: FLOOR2_PLACEHOLDER_TIMESTAMP,
    sourceRun: FLOOR2_PLACEHOLDER_PROVENANCE,
    variantIndex: 0,
    anchor: null,
    sensorScore: 'placeholder',
    judgeScore: null,
    type: definition.spriteType,
    equipment: {
      stableId: definition.stableId,
      runtimeKey: definition.runtimeKey,
      category: definition.category,
      family: definition.family,
      slot: definition.slot,
      productionWaveId: definition.productionWaveId,
    },
  };
}

export interface GenerateFloor2PlaceholderOptions {
  readonly repoRoot: string;
  readonly manifestPath?: string;
  readonly assetsRoot?: string;
  readonly dryRun?: boolean;
}

export interface GenerateFloor2PlaceholderResult {
  readonly written: number;
  readonly preservedProduction: number;
}

function loadManifestPreservingEntryFieldOrder(manifestPath: string): GeneratedManifest {
  if (!fs.existsSync(manifestPath)) {
    return parseGeneratedManifest({ version: 1, entries: {} });
  }
  const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  parseGeneratedManifest(raw);
  // Validation above proves this exact raw object satisfies GeneratedManifest.
  // Retaining it avoids reordering fields on unrelated passthrough entries.
  return raw as GeneratedManifest;
}

export function generateFloor2EquipmentPlaceholders(
  options: GenerateFloor2PlaceholderOptions,
): GenerateFloor2PlaceholderResult {
  const manifestPath =
    options.manifestPath ??
    path.join(options.repoRoot, 'public', 'assets', 'generated', 'manifest.json');
  const assetsRoot = options.assetsRoot ?? path.join(options.repoRoot, 'public', 'assets');
  const manifest = loadManifestPreservingEntryFieldOrder(manifestPath);

  const outputs = FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((definition) => ({
    definition,
    buffer: composeFloor2EquipmentPlaceholder(definition),
  }));
  const byteSignatures = new Set(outputs.map(({ buffer }) => buffer.toString('base64')));
  if (byteSignatures.size !== outputs.length) {
    throw new Error('Floor 2 placeholder composition produced duplicate PNG bytes');
  }

  let written = 0;
  let preservedProduction = 0;
  for (const { definition, buffer } of outputs) {
    const entry = createFloor2PlaceholderManifestEntry(definition);
    const outcome = upsertCanonicalFloor2EquipmentEntry(manifest, definition.runtimeKey, entry);
    if (outcome === 'preserved-production') {
      preservedProduction++;
      continue;
    }
    written++;
    if (!options.dryRun) {
      const outputPath = path.join(assetsRoot, definition.placeholderAssetPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buffer);
    }
  }

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { written, preservedProduction };
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const result = generateFloor2EquipmentPlaceholders({
    repoRoot,
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(
    `Floor 2 equipment placeholders: ${result.written} written, ` +
      `${result.preservedProduction} production entries preserved.`,
  );
}
