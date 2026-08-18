#!/usr/bin/env tsx
/**
 * ci-harvest-approve.ts — CI-only script.
 *
 * Downloads all completed G2-B asset runs from Azure Blob Storage,
 * then approves the best (ranked first in summary.json candidates) variant
 * of each. Called by the g2b-harvest-approve.yml workflow.
 *
 * Requirements:
 *  - AZURE_STORAGE_ACCOUNT
 *  - AZURE_STORAGE_KEY
 *  - AZURE_STORAGE_RUNS_CONTAINER (optional, defaults to 'generated-runs')
 *  - G2B_BRIEF_FILTER (optional comma-separated list; default = all 70)
 *
 * Does NOT call sprites:checkin. The workflow commits the approve output
 * directly and opens the stacked PR itself.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AzureBlobRunStore } from './store/azure-store.js';
import { approveVariant, ApproveError } from './approve.js';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const generatedRunsDir = path.join(repoRoot, 'generated', 'runs');
const manifestPath = path.join(repoRoot, 'public', 'assets', 'generated', 'manifest.json');
const publicAssetsDir = path.join(repoRoot, 'public', 'assets');

/** All 70 G2-B canonical brief IDs (after -v1 strip). */
const G2B_BRIEF_IDS = new Set([
  // Wave 1: blade
  'iron-cleaver',
  'bone-saw',
  'dueling-saber',
  'venom-dirk',
  'void-rapier',
  // Wave 2: axe
  'war-pick',
  'butcher-hook',
  'rune-axe',
  'boarding-axe',
  'ice-pick',
  // Wave 3: bludgeon
  'chain-flail',
  'stone-maul',
  'sun-hammer',
  'baseball-bat',
  'brass-knuckles',
  // Wave 4: polearm
  'quarterstaff',
  'blood-lance',
  'grave-shovel',
  'tower-spear',
  'crescent-glaive',
  // Wave 5: bow
  'ashwood-bow',
  'hand-crossbow',
  'storm-sling',
  'hunting-bola',
  'siege-bow',
  // Wave 6: firearm
  'musketeer-rifle',
  'cog-pistol',
  'crystal-cannon',
  'rivet-gun',
  'harpoon-gun',
  // Wave 7: thrown
  'throwing-knives',
  'twin-katar',
  'war-fan',
  'acid-flask',
  'bone-chakram',
  // Wave 8: magic-focus
  'ember-wand',
  'frost-crook',
  'moon-scythe',
  'ritual-dagger',
  'plague-censer',
  // Wave 9: beam
  'alchemist-sprayer',
  'thorn-whip',
  'shock-baton',
  'flame-tongs',
  'echo-bell',
  // Wave 10: trap
  'sawblade-launcher',
  'oil-lantern',
  'spike-shield',
  'powder-keg',
  'meteor-hammer',
  // Wave 11: head armor
  'iron-visor',
  'quartermaster-cap',
  'batfolk-hood',
  'alchemist-goggles',
  // Wave 12: torso armor
  'chain-hauberk',
  'velvet-coat',
  'scavenger-harness',
  'runed-cuirass',
  // Wave 13: hands armor
  'duelist-gloves',
  'thorn-gauntlets',
  'tinker-grips',
  // Wave 14: feet armor
  'iron-greaves',
  'shadow-boots',
  'merchant-sandals',
  // Wave 15: accessories
  'blood-vial',
  'compass-charm',
  'lucky-feather',
  'gearwork-locket',
  'warding-bell',
  'surveyor-map',
]);

// Also check the versioned forms (iron-cleaver etc.) in case
// canonicalization didn't strip the suffix.
function isG2BBrief(rawBriefId: string): boolean {
  // Direct match (bare key)
  if (G2B_BRIEF_IDS.has(rawBriefId)) return true;
  // Versioned: strip -vN suffix
  const match = /^(.+)-v\d+$/.exec(rawBriefId);
  if (match !== null && G2B_BRIEF_IDS.has(match[1]!)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

interface RunResult {
  briefId: string;
  runId: string;
  variantIndex: number;
  status: 'approved' | 'already-approved' | 'skipped' | 'error';
  message?: string;
}

async function main(): Promise<void> {
  const account = process.env['AZURE_STORAGE_ACCOUNT'];
  const key = process.env['AZURE_STORAGE_KEY'];
  if (!account || !key) {
    throw new Error('Missing AZURE_STORAGE_ACCOUNT or AZURE_STORAGE_KEY');
  }
  const container = process.env['AZURE_STORAGE_RUNS_CONTAINER'] ?? 'generated-runs';
  const store = AzureBlobRunStore.fromOptions({
    accountName: account,
    accountKey: key,
    containerName: container,
  });

  console.log('Listing all blobs in Azure run store...');
  const allKeys = await store.list('');
  const summaryKeys = allKeys.filter((k) => k.endsWith('/summary.json'));

  // Group by briefId/runId (key = briefId/runId/summary.json)
  const runs: Array<{ briefId: string; runId: string }> = [];
  for (const key of summaryKeys) {
    const parts = key.split('/');
    if (parts.length === 3) {
      runs.push({ briefId: parts[0]!, runId: parts[1]! });
    }
  }

  console.log(`Found ${runs.length} total runs. Filtering to G2-B assets...`);

  // Filter: keep only runs matching our 70 G2-B brief IDs
  // Also keep only the LATEST run per briefId (sort by runId desc, take first)
  const runsByBrief = new Map<string, string>();
  for (const { briefId, runId } of runs) {
    if (!isG2BBrief(briefId)) continue;
    // The canonical key for matching/dedup is the base brief name
    const base = /^(.+)-v\d+$/.exec(briefId)?.[1] ?? briefId;
    const existing = runsByBrief.get(base);
    if (!existing || runId > existing) {
      runsByBrief.set(base, runId);
    }
  }

  console.log(`G2-B runs found: ${runsByBrief.size} / 70`);

  const results: RunResult[] = [];

  for (const [baseBriefId, runId] of runsByBrief) {
    // Try both versioned and unversioned brief paths
    const briefId = `${baseBriefId}-v1`;
    const runPrefix = `${briefId}/${runId}/`;
    const runKeys = allKeys.filter((k) => k.startsWith(runPrefix));

    if (runKeys.length === 0) {
      results.push({
        briefId,
        runId,
        variantIndex: 0,
        status: 'skipped',
        message: 'No files found in store',
      });
      continue;
    }

    // Download run to local directory
    const runDir = path.join(generatedRunsDir, briefId, runId);
    fs.mkdirSync(path.join(generatedRunsDir, briefId), { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });

    console.log(`Downloading ${briefId}/${runId} (${runKeys.length} files)...`);
    for (const blobKey of runKeys) {
      const relativePath = blobKey.slice(runPrefix.length);
      const localPath = path.join(runDir, relativePath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      const data = await store.get(blobKey);
      fs.writeFileSync(localPath, data);
    }

    // Read summary.json to find the best variant
    const summaryPath = path.join(runDir, 'summary.json');
    if (!fs.existsSync(summaryPath)) {
      results.push({
        briefId,
        runId,
        variantIndex: 0,
        status: 'skipped',
        message: 'No summary.json',
      });
      continue;
    }

    let summary: {
      candidates?: Array<{ index: number; combinedPassed?: boolean; score?: number }>;
    };
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as typeof summary;
    } catch {
      results.push({
        briefId,
        runId,
        variantIndex: 0,
        status: 'error',
        message: 'Failed to parse summary.json',
      });
      continue;
    }

    // candidates array is already ranked best-first by the worker
    const bestCandidate = summary.candidates?.[0];
    if (!bestCandidate) {
      results.push({
        briefId,
        runId,
        variantIndex: 0,
        status: 'skipped',
        message: 'No candidates in summary.json',
      });
      continue;
    }

    const variantIndex = bestCandidate.index;

    // Approve the best variant
    try {
      approveVariant({
        runDir,
        variantIndex,
        manifestPath,
        publicAssetsDir,
        repoRoot,
      });
      console.log(`✅ Approved ${briefId} variant ${variantIndex}`);
      results.push({ briefId, runId, variantIndex, status: 'approved' });
    } catch (err) {
      if (err instanceof ApproveError && err.kind === 'already-approved') {
        console.log(`⏭️  Already approved: ${briefId} variant ${variantIndex}`);
        results.push({ briefId, runId, variantIndex, status: 'already-approved' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ Failed to approve ${briefId}: ${message}`);
        results.push({ briefId, runId, variantIndex, status: 'error', message });
      }
    }
  }

  // Summary report
  const approved = results.filter((r) => r.status === 'approved').length;
  const alreadyApproved = results.filter((r) => r.status === 'already-approved').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors = results.filter((r) => r.status === 'error');

  console.log('\n══ HARVEST+APPROVE SUMMARY ══');
  console.log(`Total runs found:   ${runsByBrief.size} / 70`);
  console.log(`Approved:           ${approved}`);
  console.log(`Already approved:   ${alreadyApproved}`);
  console.log(`Skipped:            ${skipped}`);
  console.log(`Errors:             ${errors.length}`);

  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const e of errors) {
      console.log(`  - ${e.briefId}: ${e.message}`);
    }
  }

  const missing = 70 - runsByBrief.size;
  if (missing > 0) {
    console.log(`\n⚠️  Missing runs: ${missing} of 70 assets not yet generated.`);
    console.log('   Pipeline may still be running. Re-trigger after pipeline drains.');
    // Report which G2-B briefs are missing
    const found = new Set(runsByBrief.keys());
    const missingBriefs = [...G2B_BRIEF_IDS].filter((b) => !found.has(b));
    console.log('   Missing: ' + missingBriefs.join(', '));
  }

  // Write results as JSON for downstream use
  const resultsPath = path.join(repoRoot, 'g2b-harvest-results.json');
  fs.writeFileSync(
    resultsPath,
    JSON.stringify(
      { results, missing, approved, alreadyApproved, skipped, errors: errors.length },
      null,
      2,
    ),
  );
  console.log(`\nResults written to: ${resultsPath}`);

  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
