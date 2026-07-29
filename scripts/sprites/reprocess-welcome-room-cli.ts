#!/usr/bin/env node
/**
 * Reprocess + rejudge + reapprove the welcome-room set-piece generated sprites
 * from their existing source runs (no regeneration).
 *
 * Usage:
 *   npm run sprites:reprocess:welcome-room
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadEnvLocal } from './sidecar/env-local.js';
import { loadStyleGuide } from './build-prompt.js';
import { loadRecordedReferencePngs } from './load-reference-pngs.js';
import { loadBrief } from './load-brief.js';
import { createVisionProvider } from './provider/factory.js';
import { loadRunSummary, rejudgeRun, repostprocessRun } from './rerun.js';
import type { RunSummary } from './run-artifacts.js';
import { LocalRunStore } from './store/local-store.js';
import { ApproveError, approveVariant } from './approve.js';
import { composeManifestFromShards } from './generated-shards.js';

const TARGET_SET_PIECE_ID = 'welcome-room';
const TARGET_PREFIX = 'welcome-room-';

interface SetPiecesFile {
  readonly setPieces?: ReadonlyArray<SetPiece>;
}

interface SetPiece {
  readonly id?: string;
  readonly props?: ReadonlyArray<SetPieceProp>;
}

interface SetPieceProp {
  readonly layers?: ReadonlyArray<SetPieceLayer>;
}

interface SetPieceLayer {
  readonly sprite?: {
    readonly source?: string;
    readonly spriteId?: string;
  };
}

interface ManifestFile {
  readonly entries?: Readonly<Record<string, ManifestEntry>>;
}

interface ManifestEntry {
  readonly spriteName?: string;
  readonly sourceRun?: string;
  readonly variantIndex?: number;
  readonly judgeScore?: string | null;
  readonly postprocessOverrideProfilePath?: string | null;
  readonly effectivePipelineSnapshotPath?: string | null;
  readonly effectivePipelineSnapshotYamlPath?: string | null;
}

interface SummaryCandidate {
  readonly index?: number;
  readonly judgeScorecard?: {
    readonly passed?: boolean;
    readonly minScore?: number;
  } | null;
}

interface SummaryShape {
  readonly candidates?: ReadonlyArray<SummaryCandidate>;
}

interface RunRef {
  readonly briefId: string;
  readonly runId: string;
}

interface ReprocessTarget {
  readonly spriteId: string;
  readonly variantIndex: number;
  readonly sourceRun: string;
  readonly runRef: RunRef;
  readonly runDir: string;
  readonly beforeHash: string | null;
  readonly beforeJudgeScore: string | null;
}

interface ReprocessResult {
  readonly target: ReprocessTarget;
  readonly afterHash: string | null;
  readonly judgeScore: string | null;
  readonly status: 'reapplied' | 'unchanged';
}

class ReprocessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReprocessError';
  }
}

function parseSetPieces(raw: string): SetPiecesFile {
  try {
    return JSON.parse(raw) as SetPiecesFile;
  } catch (err) {
    throw new ReprocessError(
      `set-pieces.json is not parseable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function collectWelcomeRoomSpriteIds(setPiecesFile: SetPiecesFile): string[] {
  const setPieces = setPiecesFile.setPieces ?? [];
  const setPiece = setPieces.find((entry) => entry.id === TARGET_SET_PIECE_ID);
  if (!setPiece) {
    throw new ReprocessError(`set piece "${TARGET_SET_PIECE_ID}" was not found in set-pieces.json`);
  }

  const spriteIds = new Set<string>();
  for (const prop of setPiece.props ?? []) {
    for (const layer of prop.layers ?? []) {
      const sprite = layer.sprite;
      if (!sprite || sprite.source !== 'catalog' || typeof sprite.spriteId !== 'string') continue;
      if (!sprite.spriteId.startsWith(TARGET_PREFIX)) continue;
      spriteIds.add(sprite.spriteId);
    }
  }

  const sorted = [...spriteIds].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) {
    throw new ReprocessError(
      `set piece "${TARGET_SET_PIECE_ID}" does not reference any "${TARGET_PREFIX}*" catalog sprites`,
    );
  }
  return sorted;
}

export function parseRunRefFromSourceRun(sourceRun: string): RunRef {
  const normalized = sourceRun.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)generated\/runs\/([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new ReprocessError(
      `sourceRun "${sourceRun}" is not a generated/runs/<brief>/<runId> path`,
    );
  }
  return { briefId: match[1]!, runId: match[2]! };
}

function parseVariantFromSpriteId(spriteId: string): number {
  const match = spriteId.match(/-var-(\d+)$/);
  if (!match) {
    throw new ReprocessError(
      `sprite "${spriteId}" does not end with -var-<index> and has no manifest variantIndex`,
    );
  }
  return Number.parseInt(match[1]!, 10);
}

function hashFileIfExists(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function runDirFromPipelinePath(maybePath: string | null | undefined): string | null {
  if (typeof maybePath !== 'string' || maybePath.length === 0) return null;
  const abs = path.isAbsolute(maybePath) ? maybePath : path.resolve(maybePath);
  const runDir = path.dirname(abs);
  return existsSync(path.join(runDir, 'summary.json')) ? runDir : null;
}

function resolveExistingRunDir(repoRoot: string, entry: ManifestEntry): string {
  const runDirCandidates: string[] = [];
  if (typeof entry.sourceRun === 'string' && entry.sourceRun.length > 0) {
    runDirCandidates.push(path.resolve(repoRoot, entry.sourceRun));
  }
  const fromOverrides = [
    runDirFromPipelinePath(entry.postprocessOverrideProfilePath),
    runDirFromPipelinePath(entry.effectivePipelineSnapshotPath),
    runDirFromPipelinePath(entry.effectivePipelineSnapshotYamlPath),
  ].filter((candidate): candidate is string => candidate !== null);
  runDirCandidates.push(...fromOverrides);

  for (const candidate of runDirCandidates) {
    if (existsSync(path.join(candidate, 'summary.json'))) return candidate;
  }
  throw new ReprocessError(
    `no local run directory found for sourceRun "${entry.sourceRun ?? 'missing'}"`,
  );
}

export function buildReprocessTargets(
  spriteIds: ReadonlyArray<string>,
  manifestFile: ManifestFile,
  repoRoot: string,
): ReprocessTarget[] {
  const entries = manifestFile.entries ?? {};
  return spriteIds.map((spriteId) => {
    const entry = entries[spriteId];
    if (!entry) {
      throw new ReprocessError(`manifest entry "${spriteId}" is missing`);
    }
    if (entry.spriteName !== spriteId) {
      throw new ReprocessError(
        `manifest entry "${spriteId}" has spriteName="${entry.spriteName ?? ''}" (expected exact match)`,
      );
    }
    if (!entry.sourceRun) {
      throw new ReprocessError(`manifest entry "${spriteId}" has no sourceRun`);
    }
    const variantIndex =
      typeof entry.variantIndex === 'number' && Number.isInteger(entry.variantIndex)
        ? entry.variantIndex
        : parseVariantFromSpriteId(spriteId);
    const runRef = parseRunRefFromSourceRun(entry.sourceRun);
    const runDir = resolveExistingRunDir(repoRoot, entry);
    const beforeHash = hashFileIfExists(
      path.join(repoRoot, 'public', 'assets', 'generated', `${spriteId}.png`),
    );
    return {
      spriteId,
      variantIndex,
      sourceRun: entry.sourceRun,
      runRef,
      runDir,
      beforeHash,
      beforeJudgeScore: entry.judgeScore ?? null,
    };
  });
}

function judgeCandidate(summary: SummaryShape | undefined, variantIndex: number): string | null {
  const candidate = summary?.candidates?.find((entry) => entry.index === variantIndex);
  const minScore = candidate?.judgeScorecard?.minScore;
  if (typeof minScore === 'number') return String(minScore);
  return null;
}

function assertJudgeNotOdd(
  summary: SummaryShape | undefined,
  variantIndex: number,
  spriteId: string,
): void {
  const candidate = summary?.candidates?.find((entry) => entry.index === variantIndex);
  if (!candidate || !candidate.judgeScorecard) {
    throw new ReprocessError(
      `judge did not return a scorecard for ${spriteId} variant ${variantIndex}`,
    );
  }
  if (candidate.judgeScorecard.passed !== true) {
    throw new ReprocessError(
      `judge flagged oddity for ${spriteId} variant ${variantIndex} (passed=false, minScore=${String(
        candidate.judgeScorecard.minScore ?? 'n/a',
      )})`,
    );
  }
}

async function reprocessOne(
  target: ReprocessTarget,
  repoRoot: string,
  visionProvider: NonNullable<ReturnType<typeof createVisionProvider>>,
  styleGuide: string,
  referenceSnapshotByAbsPath: ReadonlyMap<string, Buffer>,
  batchSpriteIds: ReadonlySet<string>,
): Promise<ReprocessResult> {
  const runsRoot = path.resolve(target.runDir, '..', '..');
  const legacyRepoRoot = path.resolve(runsRoot, '..', '..');
  const store = new LocalRunStore(runsRoot);
  const summary = await loadRunSummary(store, target.runRef.briefId, target.runRef.runId);
  const briefPath = summary.briefPath;
  if (!briefPath) {
    throw new ReprocessError(
      `run ${target.runRef.briefId}/${target.runRef.runId} has no briefPath`,
    );
  }
  const resolvedBriefPath = (() => {
    if (path.isAbsolute(briefPath)) return briefPath;
    const localPath = path.join(repoRoot, briefPath);
    if (existsSync(localPath)) return localPath;
    const legacyPath = path.join(legacyRepoRoot, briefPath);
    return legacyPath;
  })();
  const briefProjectRoot =
    !path.isAbsolute(briefPath) && existsSync(path.join(repoRoot, briefPath))
      ? repoRoot
      : legacyRepoRoot;
  const loaded = loadBrief(resolvedBriefPath, {
    projectRoot: briefProjectRoot,
  });
  const repost = await repostprocessRun({
    store,
    briefId: target.runRef.briefId,
    runId: target.runRef.runId,
    summary,
    brief: loaded.brief,
    palette: loaded.palette,
    optionsMode: 'persisted',
    allowGridDrift: true,
  });
  const references = loadRecordedReferencePngs({
    summary: maskBatchReferenceHashes(repost.summary, batchSpriteIds),
    repoRoot,
    readReference: (absPath) =>
      referenceSnapshotByAbsPath.get(path.resolve(absPath)) ?? readFileSync(absPath),
    assetExists: (absPath) =>
      referenceSnapshotByAbsPath.has(path.resolve(absPath)) || existsSync(absPath),
  });
  const rejudged = await rejudgeRun({
    store,
    briefId: target.runRef.briefId,
    runId: target.runRef.runId,
    summary: repost.summary,
    brief: loaded.brief,
    referencePngs: references,
    styleGuide,
    visionProvider,
  });
  assertJudgeNotOdd(rejudged.summary, target.variantIndex, target.spriteId);
  const judgeScoreFromJudge = judgeCandidate(rejudged.summary, target.variantIndex);

  let approveStatus: 'approved' | 'unchanged' = 'approved';
  try {
    approveVariant({
      runDir: target.runDir,
      variantIndex: target.variantIndex,
      manifestPath: path.join(repoRoot, 'public', 'assets', 'generated', 'manifest.json'),
      catalogPath: path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json'),
      publicAssetsDir: path.join(repoRoot, 'public', 'assets'),
      repoRoot,
    });
  } catch (err) {
    if (!(err instanceof ApproveError) || err.kind !== 'already-approved') {
      throw err;
    }
    approveStatus = 'unchanged';
  }

  const afterHash = hashFileIfExists(
    path.join(repoRoot, 'public', 'assets', 'generated', `${target.spriteId}.png`),
  );
  const status =
    approveStatus === 'unchanged' && target.beforeHash === afterHash ? 'unchanged' : 'reapplied';
  const judgeScore = judgeScoreFromJudge ?? target.beforeJudgeScore;
  return {
    target,
    afterHash,
    judgeScore,
    status,
  };
}

function maskBatchReferenceHashes(
  summary: Pick<RunSummary, 'brief' | 'referenceSprites'>,
  batchSpriteIds: ReadonlySet<string>,
): Pick<RunSummary, 'brief' | 'referenceSprites'> {
  const refs = summary.referenceSprites;
  if (!refs || refs.selected.length === 0) return summary;
  return {
    brief: summary.brief,
    referenceSprites: {
      ...refs,
      selected: refs.selected.map((ref) =>
        batchSpriteIds.has(ref.spriteName) ? { ...ref, contentHash: null } : ref,
      ),
    },
  };
}

function printBeforeReport(targets: ReadonlyArray<ReprocessTarget>): void {
  process.stdout.write('before:\n');
  for (const target of targets) {
    process.stdout.write(
      `  - ${target.spriteId} | run=${target.runRef.briefId}/${target.runRef.runId} | variant=${target.variantIndex} | hash=${target.beforeHash ?? 'missing'} | judge=${target.beforeJudgeScore ?? 'n/a'}\n`,
    );
  }
}

function printAfterReport(results: ReadonlyArray<ReprocessResult>): void {
  process.stdout.write('after:\n');
  for (const result of results) {
    process.stdout.write(
      `  - ${result.target.spriteId} | status=${result.status} | hash=${result.afterHash ?? 'missing'} | judge=${result.judgeScore ?? 'n/a'}\n`,
    );
  }
}

function verifySetPieceStillReferences(
  repoRoot: string,
  expectedSpriteIds: ReadonlyArray<string>,
): void {
  const setPiecesPath = path.join(repoRoot, 'src', 'shared', 'data', 'set-pieces.json');
  const setPieces = parseSetPieces(readFileSync(setPiecesPath, 'utf8'));
  const actual = collectWelcomeRoomSpriteIds(setPieces);
  const expected = [...expectedSpriteIds].sort((a, b) => a.localeCompare(b));
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new ReprocessError(
      `welcome-room set-piece references changed during reapply; expected ${expected.join(', ')}, got ${actual.join(', ')}`,
    );
  }
}

export async function main(cwd: string): Promise<number> {
  const repoRoot = cwd;
  loadEnvLocal(repoRoot);
  const manifestPath = path.join(repoRoot, 'public', 'assets', 'generated', 'manifest.json');
  const setPiecesPath = path.join(repoRoot, 'src', 'shared', 'data', 'set-pieces.json');
  // Source of truth is the per-asset shard set (`entries/<key>.json`); the
  // aggregate `manifest.json` is a build artifact and is not read here.
  const manifest = composeManifestFromShards(path.dirname(manifestPath)) as ManifestFile;
  const setPieces = parseSetPieces(readFileSync(setPiecesPath, 'utf8'));
  const spriteIds = collectWelcomeRoomSpriteIds(setPieces);
  const targets = buildReprocessTargets(spriteIds, manifest, repoRoot);
  const batchSpriteIds = new Set(targets.map((target) => target.spriteId));
  const referenceSnapshotByAbsPath = new Map<string, Buffer>();
  for (const target of targets) {
    const absPath = path.resolve(
      repoRoot,
      'public',
      'assets',
      'generated',
      `${target.spriteId}.png`,
    );
    if (existsSync(absPath)) {
      referenceSnapshotByAbsPath.set(absPath, readFileSync(absPath));
    }
  }

  printBeforeReport(targets);
  const visionProvider = createVisionProvider({ env: process.env });
  if (!visionProvider) {
    throw new ReprocessError(
      'No vision provider configured. Set AZURE_OPENAI_VISION_DEPLOYMENT and SPRITES_VISION_PROVIDER=azure-openai.',
    );
  }
  const styleGuide = loadStyleGuide(repoRoot);

  const results: ReprocessResult[] = [];
  for (const target of targets) {
    process.stdout.write(
      `reprocess: ${target.spriteId} (${target.runRef.briefId}/${target.runRef.runId}, variant ${target.variantIndex})\n`,
    );
    results.push(
      await reprocessOne(
        target,
        repoRoot,
        visionProvider,
        styleGuide,
        referenceSnapshotByAbsPath,
        batchSpriteIds,
      ),
    );
  }

  verifySetPieceStillReferences(repoRoot, spriteIds);
  printAfterReport(results);
  const reappliedCount = results.filter((entry) => entry.status === 'reapplied').length;
  process.stdout.write(
    `result: ${results.length} processed, ${reappliedCount} reapplied, ${results.length - reappliedCount} unchanged\n`,
  );
  return 0;
}

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  void main(process.cwd()).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(
        `reprocess failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
