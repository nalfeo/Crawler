#!/usr/bin/env node
import { QUEEN_MAB_ART_MANIFEST, loadQueenMabArtManifest } from './queen-mab-art-manifest-lib.js';

// Re-run the loader so a malformed manifest fails the CLI loudly (the module
// constant is already validated at import time, but calling it here makes the
// validation the explicit purpose of this executable).
const manifest = loadQueenMabArtManifest();
void QUEEN_MAB_ART_MANIFEST;

const lines: string[] = [
  `Queen Mab generated-art manifest: ${manifest.schemaVersion}`,
  `Scope: ${manifest.generatedArtScope} | reviewed ${manifest.lastReviewedAt}`,
  `Boss: ${manifest.boss.bossId} (${manifest.boss.bossArchetypeId})`,
  '',
  `Required visual phases: ${manifest.requiredVisualPhases.length} (all with procedural fallbacks)`,
  ...manifest.requiredVisualPhases.map(
    (phase) => `  [fallback] ${phase.phaseId} — ${phase.proceduralFallback}`,
  ),
  '',
  `Generated-art assets: ${manifest.assets.length} (all non-blocking for arena)`,
  ...manifest.assets.map(
    (asset) =>
      `  [${asset.state}] ${asset.assetId} (${asset.kind}) requiredFor=${asset.requiredFor}`,
  ),
  '',
  '✅ Queen Mab art manifest valid; every required visual phase has a procedural fallback.',
];

process.stdout.write(`${lines.join('\n')}\n`);
