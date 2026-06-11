import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeDiversity } from './diversity.js';
import type { ExpansionSkipReason } from './expand-variations.js';
import { loadBrief } from './load-brief.js';
import { postprocessWithTrace, type PostprocessOptions } from './postprocess.js';
import {
  ensureRunDirs,
  makeRunId,
  pickChosen,
  rankCandidates,
  runPaths,
  type RunSummary,
  type RunSummaryEntry,
  writeSummary,
  writeVariant,
} from './run-artifacts.js';
import { scoreCandidate } from './score-candidate.js';

export interface ReprocessProfile {
  readonly name: string;
  readonly tuning?: NonNullable<PostprocessOptions['speckle']>;
  readonly modules?: NonNullable<PostprocessOptions['modules']>;
}

interface SourceSummaryShape {
  readonly briefPath?: string;
  readonly promptHash?: string;
  readonly variations?: {
    readonly seed?: ReadonlyArray<string>;
    readonly proposed?: ReadonlyArray<string>;
    readonly final?: ReadonlyArray<string>;
    readonly minVariations?: number;
    readonly skippedReason?: string | null;
  };
}

export interface ReprocessRequest {
  readonly repoRoot: string;
  readonly sourceRunDir: string;
  readonly briefPath?: string;
  readonly profileA: ReprocessProfile;
  readonly profileB?: ReprocessProfile | null;
}

export interface ReprocessRunResult {
  readonly briefId: string;
  readonly runId: string;
  readonly runDir: string;
  readonly summaryPath: string;
  readonly profile: string;
}

export interface ReprocessResult {
  readonly sourceRunDir: string;
  readonly briefPath: string;
  readonly runs: ReadonlyArray<ReprocessRunResult>;
}

function normalizeProfile(profile: ReprocessProfile): Required<ReprocessProfile> {
  return {
    name: profile.name,
    tuning: profile.tuning ?? {},
    modules: profile.modules ?? {},
  };
}

function loadSourceSummary(runDir: string): SourceSummaryShape {
  const summaryPath = path.join(runDir, 'summary.json');
  if (!existsSync(summaryPath)) throw new Error(`Source run has no summary.json: ${runDir}`);
  return JSON.parse(readFileSync(summaryPath, 'utf8')) as SourceSummaryShape;
}

function resolveBriefPath(
  inputPath: string | undefined,
  sourceSummary: SourceSummaryShape,
): string {
  if (typeof inputPath === 'string' && inputPath.length > 0) return path.resolve(inputPath);
  if (typeof sourceSummary.briefPath === 'string' && sourceSummary.briefPath.length > 0) {
    return path.resolve(sourceSummary.briefPath);
  }
  throw new Error(
    'Unable to resolve brief path. Pass a briefPath so reprocess can load defaults/palette.',
  );
}

function listRawFiles(sourceRunDir: string): ReadonlyArray<{ index: number; file: string }> {
  const rawDir = path.join(sourceRunDir, 'raw');
  if (!existsSync(rawDir)) throw new Error(`Source run has no raw/ directory: ${sourceRunDir}`);
  const raws = readdirSync(rawDir)
    .filter((name) => /^\d+\.png$/i.test(name))
    .map((name) => ({ index: Number(name.slice(0, -4)), file: path.join(rawDir, name) }))
    .sort((a, b) => a.index - b.index);
  if (raws.length === 0) throw new Error(`No raw PNGs found under: ${rawDir}`);
  return raws;
}

function copySheetArtifacts(sourceRunDir: string, outRunDir: string): void {
  const sheetFiles = readdirSync(sourceRunDir).filter((name) => /^sheet-\d+\.png$/i.test(name));
  for (const sheet of sheetFiles) {
    copyFileSync(path.join(sourceRunDir, sheet), path.join(outRunDir, sheet));
  }
}

function createVariations(
  summary: SourceSummaryShape,
  minVariations: number,
): RunSummary['variations'] {
  const v = summary.variations;
  const skip = v?.skippedReason;
  const skippedReason: ExpansionSkipReason | null =
    skip === 'disabled' ||
    skip === 'sufficient' ||
    skip === 'no-provider' ||
    skip === 'provider-failed'
      ? skip
      : null;
  return {
    seed: Array.isArray(v?.seed) ? [...v.seed] : [],
    proposed: Array.isArray(v?.proposed) ? [...v.proposed] : [],
    final: Array.isArray(v?.final) ? [...v.final] : [],
    minVariations: typeof v?.minVariations === 'number' ? v.minVariations : minVariations,
    skippedReason,
  };
}

function runProfile(args: {
  readonly repoRoot: string;
  readonly sourceRunDir: string;
  readonly sourceSummary: SourceSummaryShape;
  readonly briefPath: string;
  readonly profile: Required<ReprocessProfile>;
}): ReprocessRunResult {
  const loaded = loadBrief(args.briefPath, { projectRoot: args.repoRoot });
  const sourceRunId = path.basename(args.sourceRunDir);
  const runId = makeRunId(
    new Date(),
    `${loaded.brief.name}|reprocess|${sourceRunId}|${args.profile.name}|${JSON.stringify(args.profile.tuning)}`,
  );
  const paths = runPaths(path.join(args.repoRoot, 'generated'), loaded.brief, runId);
  ensureRunDirs(paths);
  copySheetArtifacts(args.sourceRunDir, paths.briefDir);

  const rawFiles = listRawFiles(args.sourceRunDir);
  const entries: RunSummaryEntry[] = [];
  const processedBuffers: Buffer[] = [];
  for (const rawFile of rawFiles) {
    const raw = readFileSync(rawFile.file);
    const traced = postprocessWithTrace(raw, loaded.brief, loaded.palette, {
      speckle: args.profile.tuning,
      modules: args.profile.modules,
    });
    const processed = traced.finalPng;
    const scorecard = scoreCandidate(processed, loaded.brief, loaded.palette);
    const written = writeVariant(paths, rawFile.index, raw, processed, scorecard, {
      overlaySize: { width: loaded.brief.size.width, height: loaded.brief.size.height },
    });
    const id = String(rawFile.index).padStart(2, '0');
    const pipelineSteps = traced.steps.map((step, idx) => {
      const file = `${id}.step-${String(idx + 1).padStart(2, '0')}-${step.id}.png`;
      writeFileSync(path.join(paths.processedDir, file), step.png);
      return { id: step.id, label: step.label, file };
    });
    writeFileSync(
      path.join(paths.processedDir, `${id}.pipeline.json`),
      `${JSON.stringify(
        {
          sourceRunId,
          profile: args.profile.name,
          tuning: args.profile.tuning,
          modules: args.profile.modules,
          steps: pipelineSteps,
        },
        null,
        2,
      )}\n`,
    );
    processedBuffers.push(processed);
    entries.push({
      index: rawFile.index,
      score: scorecard.score,
      outOf: scorecard.outOf,
      breakdown: scorecard.breakdown,
      passed: scorecard.passed,
      rawPath: written.rawPath,
      processedPath: written.processedPath,
      scorecardPath: written.scorecardPath,
      derivedAnchor: scorecard.derivedAnchor,
      derivedAnchors: scorecard.derivedAnchors,
      anchorSidecarPath: written.anchorSidecarPath,
      centerOfGravitySidecarPath: written.centerOfGravitySidecarPath,
      anchorOverlayPath: written.anchorOverlayPath,
      judgeScorecard: null,
      judgeSkipReason: 'judge-disabled',
      combinedPassed: scorecard.passed,
    });
  }

  const ranked = rankCandidates(entries);
  const summary: RunSummary = {
    brief: loaded.brief.name,
    briefPath: loaded.briefPath,
    runId,
    createdAt: new Date().toISOString(),
    promptHash: `${args.sourceSummary.promptHash ?? 'reprocess'}:${args.profile.name}`,
    attempts: 1,
    variantCount: entries.length,
    candidates: ranked,
    diversity: computeDiversity(processedBuffers),
    variations: createVariations(args.sourceSummary, loaded.brief.minVariations),
    chosen: pickChosen(ranked, loaded.brief),
    judgeBudget: null,
    judgeCache: null,
  };
  const summaryPath = writeSummary(paths, summary);
  return {
    briefId: loaded.brief.name,
    runId,
    runDir: paths.briefDir,
    summaryPath,
    profile: args.profile.name,
  };
}

export function reprocessRuns(request: ReprocessRequest): ReprocessResult {
  const sourceRunDir = path.resolve(request.sourceRunDir);
  if (!existsSync(sourceRunDir)) throw new Error(`Source run directory not found: ${sourceRunDir}`);
  const sourceSummary = loadSourceSummary(sourceRunDir);
  const briefPath = resolveBriefPath(request.briefPath, sourceSummary);

  const outputs: ReprocessRunResult[] = [];
  outputs.push(
    runProfile({
      repoRoot: request.repoRoot,
      sourceRunDir,
      sourceSummary,
      briefPath,
      profile: normalizeProfile(request.profileA),
    }),
  );

  if (request.profileB) {
    outputs.push(
      runProfile({
        repoRoot: request.repoRoot,
        sourceRunDir,
        sourceSummary,
        briefPath,
        profile: normalizeProfile(request.profileB),
      }),
    );
  }

  return {
    sourceRunDir,
    briefPath,
    runs: outputs,
  };
}
