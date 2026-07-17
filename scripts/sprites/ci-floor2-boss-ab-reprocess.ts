#!/usr/bin/env node
/**
 * Ephemeral Floor 2 boss prompt A/B artifact exporter.
 *
 * Reprocesses and judges the newest generated run for each of the five bosses,
 * then exports old/new sheets, summaries, and all new run artifacts. It never
 * approves or checks in an asset.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadStyleGuide } from './build-prompt.js';
import { materializeBriefFromStore } from './brief-durability.js';
import { loadBrief } from './load-brief.js';
import { loadRecordedReferencePngs } from './load-reference-pngs.js';
import { createVisionProvider } from './provider/factory.js';
import { selectReferences } from './reference-selector.js';
import { loadRunSummary, rejudgeRun, repostprocessRun } from './rerun.js';
import type { RunSummary } from './run-artifacts.js';
import { createRunStore } from './store/index.js';
import { parseGeneratedManifest } from '../../src/shared/generated-assets.js';

const BASELINES = [
  {
    family: 'batfolk',
    briefId: 'batfolk-boss-v1',
    briefPath: 'briefs/draft/enemies/batfolk-boss.yaml',
    oldRunId: '2026-07-16T21-44-01-630c9ae4',
  },
  {
    family: 'beetlefolk',
    briefId: 'beetlefolk-boss-v1',
    briefPath: 'briefs/draft/enemies/beetlefolk-boss.yaml',
    oldRunId: '2026-07-16T21-47-13-d84bf4c9',
  },
  {
    family: 'cactusfolk',
    briefId: 'cactusfolk-boss-v1',
    briefPath: 'briefs/draft/enemies/cactusfolk-boss.yaml',
    oldRunId: '2026-07-16T21-45-48-ab22fc16',
  },
  {
    family: 'faerie',
    briefId: 'faerie-boss-v1',
    briefPath: 'briefs/draft/enemies/faerie-boss.yaml',
    oldRunId: '2026-07-16T21-50-50-e48c978a',
  },
  {
    family: 'geese',
    briefId: 'geese-boss-v2',
    briefPath: 'briefs/draft/enemies/geese-boss.yaml',
    oldRunId: '2026-07-16T21-48-53-dd98eefe',
  },
] as const;

async function listRunIds(
  store: ReturnType<typeof createRunStore>,
  briefId: string,
): Promise<string[]> {
  const prefix = `${briefId}/`;
  const keys = await store.list(prefix);
  return [
    ...new Set(
      keys
        .map((key) => key.slice(prefix.length).split('/')[0])
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
}

async function exportPrefix(
  store: ReturnType<typeof createRunStore>,
  prefix: string,
  destination: string,
): Promise<void> {
  const keys = await store.list(prefix);
  for (const key of keys) {
    const relative = key.slice(prefix.length);
    const target = path.resolve(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, await store.get(key));
  }
}

async function reprocess(
  store: ReturnType<typeof createRunStore>,
  repoRoot: string,
  briefId: string,
  runId: string,
): Promise<RunSummary> {
  const summary = await loadRunSummary(store, briefId, runId);
  if (summary.candidates.length > 0) return summary;
  const briefPath = summary.briefPath;
  const absoluteBriefPath = path.resolve(repoRoot, briefPath);
  if (!(await materializeBriefFromStore(store, repoRoot, absoluteBriefPath))) {
    throw new Error(`Cannot materialize ${briefPath}`);
  }
  const loaded = loadBrief(absoluteBriefPath, { projectRoot: repoRoot });
  const repost = await repostprocessRun({
    store,
    briefId,
    runId,
    summary,
    brief: loaded.brief,
    palette: loaded.palette,
  });
  const visionProvider = createVisionProvider({ env: process.env });
  if (!visionProvider) throw new Error('Azure vision provider is required for this A/B');
  return (
    await rejudgeRun({
      store,
      briefId,
      runId,
      summary: repost.summary,
      brief: loaded.brief,
      referencePngs: loadRecordedReferencePngs({ summary: repost.summary, repoRoot }),
      styleGuide: loadStyleGuide(repoRoot),
      visionProvider,
      env: process.env,
    })
  ).summary;
}

async function preflight(
  store: ReturnType<typeof createRunStore>,
  repoRoot: string,
): Promise<void> {
  const manifest = parseGeneratedManifest(
    JSON.parse(readFileSync(path.join(repoRoot, 'public/assets/generated/manifest.json'), 'utf8')),
  );
  const candidates = Object.values(manifest.entries).filter((entry) =>
    existsSync(path.join(repoRoot, 'public/assets', entry.assetPath)),
  );
  const parity: Record<string, unknown> = {};
  for (const baseline of BASELINES) {
    const absoluteBriefPath = path.resolve(repoRoot, baseline.briefPath);
    if (!(await materializeBriefFromStore(store, repoRoot, absoluteBriefPath))) {
      throw new Error(`Cannot materialize ${baseline.briefPath}`);
    }
    const brief = loadBrief(absoluteBriefPath, { projectRoot: repoRoot }).brief;
    const oldSummary = await loadRunSummary(store, baseline.briefId, baseline.oldRunId);
    if (brief.name !== baseline.briefId) {
      throw new Error(`${baseline.family}: brief name ${brief.name} != ${baseline.briefId}`);
    }
    if (JSON.stringify(brief.variations) !== JSON.stringify(oldSummary.variations.seed)) {
      throw new Error(`${baseline.family}: exact variation seeds do not match the prior run`);
    }
    if (brief.minVariations > brief.variations.length) {
      throw new Error(`${baseline.family}: variation expansion would change the prompt inputs`);
    }
    const oldReferences = oldSummary.referenceSprites;
    if (!oldReferences) throw new Error(`${baseline.family}: prior reference selection is missing`);
    const replay = selectReferences({
      candidates,
      briefName: brief.name,
      briefType: brief.type,
      count: oldReferences.requestedCount,
      seed: oldReferences.seed,
    });
    const expectedNames = oldReferences.selected.map((entry) => entry.spriteName);
    const replayNames = replay.selected.map((entry) => entry.spriteName);
    if (
      replay.eligibleCount !== oldReferences.eligibleCount ||
      replay.sameTypeCount !== oldReferences.sameTypeCount ||
      JSON.stringify(replayNames) !== JSON.stringify(expectedNames)
    ) {
      throw new Error(`${baseline.family}: exact recorded reference selection cannot be replayed`);
    }
    parity[baseline.family] = {
      briefId: brief.name,
      type: brief.type,
      floor: brief.floor,
      size: brief.size,
      grid: brief.generation.sheet,
      minVariations: brief.minVariations,
      variations: brief.variations,
      referenceSeed: oldReferences.seed,
      references: replayNames,
    };
  }
  process.stdout.write(`${JSON.stringify(parity, null, 2)}\n`);
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const outputRoot = path.resolve(repoRoot, 'generated/floor2-boss-family-ab');
  const store = createRunStore({ repoRoot, env: process.env });
  if (store.backend !== 'azure-blob') {
    throw new Error(`Azure blob run store required; got ${store.backend}`);
  }
  if (process.argv.includes('--preflight')) {
    await preflight(store, repoRoot);
    return;
  }
  const comparison: Record<string, unknown> = {};
  for (const baseline of BASELINES) {
    const runIds = await listRunIds(store, baseline.briefId);
    const newRunId = runIds.at(-1);
    if (!newRunId || newRunId === baseline.oldRunId) {
      throw new Error(`No new run found for ${baseline.briefId}`);
    }
    const newSummary = await reprocess(store, repoRoot, baseline.briefId, newRunId);
    const oldSummary = await loadRunSummary(store, baseline.briefId, baseline.oldRunId);
    const familyRoot = path.join(outputRoot, baseline.family);
    await exportPrefix(
      store,
      `${baseline.briefId}/${newRunId}/`,
      path.join(familyRoot, 'new', newRunId),
    );
    mkdirSync(path.join(familyRoot, 'old', baseline.oldRunId), { recursive: true });
    writeFileSync(
      path.join(familyRoot, 'old', baseline.oldRunId, 'sheet-00.png'),
      await store.get(`${baseline.briefId}/${baseline.oldRunId}/sheet-00.png`),
    );
    writeFileSync(
      path.join(familyRoot, 'old', baseline.oldRunId, 'summary.json'),
      Buffer.from(`${JSON.stringify(oldSummary, null, 2)}\n`),
    );
    comparison[baseline.family] = {
      briefId: baseline.briefId,
      oldRunId: baseline.oldRunId,
      newRunId,
      oldPromptHash: oldSummary.promptHash,
      newPromptHash: newSummary.promptHash,
      variationParity:
        JSON.stringify(oldSummary.variations) === JSON.stringify(newSummary.variations),
      referenceParity:
        JSON.stringify(oldSummary.referenceSprites) === JSON.stringify(newSummary.referenceSprites),
    };
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(
    path.join(outputRoot, 'comparison.json'),
    `${JSON.stringify(comparison, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
