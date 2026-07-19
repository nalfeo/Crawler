#!/usr/bin/env node
/**
 * ci-approve-equipment-weapon.cjs
 *
 * CI-side approval script for Floor 2 equipment weapon sprites generated via
 * the local sprites:run pipeline.  Picks the best passing variant from a
 * generated run, copies the PNG into the equipment/weapon asset tree, and
 * upserts the manifest + catalog entries using the flat `equipment/weapon/<name>`
 * key format (matching the rest of the floor-2 equipment manifest entries).
 *
 * Usage (called by the generate-war-fan.yml workflow):
 *   node scripts/sprites/ci-approve-equipment-weapon.cjs \
 *     --brief-name war-fan \
 *     --stable-id weapon.war-fan \
 *     --family thrown \
 *     --production-wave floor2-equipment-weapon-thrown
 *
 * Exits 0 on success, 1 on error.
 * Writes variant_index=N, sensor_score=X/Y, combined_passed=true|false to stdout
 * so the workflow can pipe them into GITHUB_OUTPUT.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 ? args[idx + 1] : null;
}

const briefName = getArg('brief-name');
const stableId = getArg('stable-id');
const family = getArg('family') || 'thrown';
const productionWave = getArg('production-wave');

if (!briefName || !stableId) {
  console.error(
    'Usage: ci-approve-equipment-weapon.cjs --brief-name <name> --stable-id <stableId> [--family <family>] [--production-wave <waveId>]',
  );
  process.exit(1);
}

// Derive equipment fields from stableId (format: category.name)
const sepIdx = stableId.indexOf('.');
if (sepIdx <= 0) {
  console.error('Invalid stable-id format (expected category.name):', stableId);
  process.exit(1);
}
const category = stableId.slice(0, sepIdx);
const slot = category; // weapon -> weapon slot
const itemName = stableId.slice(sepIdx + 1);
const runtimeKey = 'equipment/' + category + '/' + itemName;

const repoRoot = path.resolve(__dirname, '..', '..');
const runsBase = path.join(repoRoot, 'generated', 'runs', briefName);

// Locate the latest run directory
let runId;
try {
  const allEntries = fs.readdirSync(runsBase);
  const dirs = allEntries
    .filter(entry => fs.statSync(path.join(runsBase, entry)).isDirectory())
    .sort();
  if (dirs.length === 0) {
    throw new Error('No run directories found under ' + runsBase);
  }
  runId = dirs[dirs.length - 1];
} catch (err) {
  console.error('No runs found under', runsBase, ':', err.message);
  process.exit(1);
}
const runDir = path.join(runsBase, runId);
console.log('Using run:', runDir);

// Read summary.json
const summaryPath = path.join(runDir, 'summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error('No summary.json at', summaryPath);
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const candidates = summary.candidates || [];
if (!candidates.length) {
  console.error('No candidates in summary.json');
  process.exit(1);
}

// Pick best variant: prefer passing, then highest score
const passing = candidates.filter(function (c) {
  return c.combinedPassed;
});
const pool = passing.length > 0 ? passing : candidates;
const best = pool.slice().sort(function (a, b) {
  return (b.score || 0) - (a.score || 0);
})[0];
const variantIndex = best.index;
const padded = String(variantIndex).padStart(2, '0');

console.log(
  'Selected variant',
  variantIndex,
  '| combinedPassed:',
  best.combinedPassed,
  '| score:',
  best.score,
);
if (!best.combinedPassed) {
  console.warn('WARNING: No sensors-passing variant found. Using best-score fallback.');
}

// Copy PNG to the equipment/weapon tree
const srcPng = path.join(runDir, 'processed', padded + '.png');
if (!fs.existsSync(srcPng)) {
  console.error('Processed PNG not found:', srcPng);
  process.exit(1);
}
const destDir = path.join(repoRoot, 'public', 'assets', 'generated', 'equipment', category);
fs.mkdirSync(destDir, { recursive: true });
const destPng = path.join(destDir, itemName + '.png');
fs.copyFileSync(srcPng, destPng);
console.log('Copied PNG ->', path.relative(repoRoot, destPng));

// Compute content hash
const contentHash = crypto.createHash('sha256').update(fs.readFileSync(destPng)).digest('hex');

// Resolve anchor (derived sidecar > brief default)
let anchor = { x: 32, y: 48, source: 'brief' };
let anchors = { hold: anchor, centerOfGravity: null };
const anchorSidecarPath = path.join(runDir, 'processed', padded + '.anchor.json');
if (fs.existsSync(anchorSidecarPath)) {
  try {
    const a = JSON.parse(fs.readFileSync(anchorSidecarPath, 'utf8'));
    if (a.hold) {
      anchor = { ...a.hold, source: 'sidecar' };
      anchors = { hold: anchor, centerOfGravity: a.centerOfGravity || null };
    }
  } catch (e) {
    // use brief default
  }
}

// Build sensor score string
const sensorScore =
  best.sensorScore ||
  (best.sensors
    ? Object.values(best.sensors).filter(Boolean).length + '/' + Object.values(best.sensors).length
    : '?/?');

// Upsert manifest entry
const manifestPath = path.join(repoRoot, 'public', 'assets', 'generated', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.entries = manifest.entries || {};
manifest.entries[runtimeKey] = {
  briefId: runtimeKey,
  spriteName: runtimeKey,
  assetPath: 'generated/equipment/' + category + '/' + itemName + '.png',
  approvedAt: new Date().toISOString(),
  sourceRun: path.relative(repoRoot, runDir).replace(/\\/g, '/'),
  variantIndex: variantIndex,
  anchor: anchor,
  anchors: anchors,
  sensorScore: sensorScore,
  judgeScore: best.judgeScore || null,
  type: category,
  contentHash: contentHash,
  effectiveAnchorSource: anchor.source || null,
  equipment: {
    stableId: stableId,
    runtimeKey: runtimeKey,
    category: category,
    family: family,
    slot: slot,
    productionWaveId: productionWave || 'floor2-equipment-' + category + '-' + family,
  },
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Manifest updated:', manifestPath);
console.log('  key:', runtimeKey);

// Upsert sprite catalog entry
const catalogPath = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const catalogId = 'generated:' + runtimeKey;
const catalogEntry = {
  id: catalogId,
  kind: 'sprite',
  label: runtimeKey,
  description: 'Generated sprite for stable runtime key: ' + runtimeKey + '.',
  tags: [category, 'generated', 'pipeline-approved'],
  spriteId: runtimeKey,
  sheetKey: 'generated-manifest',
  assetPath: 'generated/equipment/' + category + '/' + itemName + '.png',
  frame: 0,
  col: 0,
  row: 0,
};
const catalogIdx = catalog.findIndex(function (e) {
  return e.id === catalogId;
});
if (catalogIdx >= 0) {
  catalog[catalogIdx] = catalogEntry;
} else {
  catalog.push(catalogEntry);
}
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log('Catalog updated:', catalogPath);

// Output for GITHUB_OUTPUT
console.log('OUTPUTS:');
console.log('variant_index=' + variantIndex);
console.log('sensor_score=' + sensorScore);
console.log('combined_passed=' + best.combinedPassed);
console.log('runtime_key=' + runtimeKey);
