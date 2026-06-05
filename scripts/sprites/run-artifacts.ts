/**
 * Run artifact layout + writers for the sprite generation pipeline.
 *
 * Every invocation of `generateOne` (or its CLI front-end) produces a
 * directory of artifacts under `generated/runs/<brief-name>/<run-id>/`. The
 * directory layout is the contract between the orchestrator, the CLI's
 * `--pick` flag, and a future Phase 3 lab/UI:
 *
 *   generated/runs/<brief-name>/<run-id>/
 *     run.json               -- metadata: brief id, prompt hash, timestamp, attempt count
 *     sheet-00.png           -- raw multi-variant sheet from the provider (one per attempt)
 *     raw/NN.png             -- raw N-th slice, before postprocessing
 *     processed/NN.png       -- post-processed 16x16 PNG
 *     processed/NN.scorecard.json  -- sensor scorecard for processed/NN.png
 *     summary.json           -- ranked candidates: passed-first, then by sensor score
 *     selection.json         -- written ONLY when the user runs `sprites:run --pick N`
 *
 * Run IDs are timestamp + short hash so two runs of the same brief are easy
 * to compare and don't collide. The orchestrator is impure (network + IO)
 * so the clock is fine to use here.
 *
 * Symlinks are deliberately NOT used because Windows symlink support is
 * inconsistent. The CLI writes a small JSON manifest instead.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Brief } from './brief-schema.js';
import type { DiversitySummary } from './diversity.js';
import type { Scorecard } from './score-candidate.js';

export interface RunPaths {
  readonly root: string;
  readonly runId: string;
  readonly briefDir: string;
  readonly rawDir: string;
  readonly processedDir: string;
}

export interface RunSummaryEntry {
  readonly index: number;
  readonly score: number;
  readonly outOf: number;
  readonly passed: boolean;
  readonly rawPath: string;
  readonly processedPath: string;
  readonly scorecardPath: string;
}

export interface RunSummary {
  readonly brief: string;
  readonly briefPath: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly promptHash: string;
  readonly attempts: number;
  readonly variantCount: number;
  /** Candidates ranked best-first: passed first, then by sensor score desc. */
  readonly candidates: ReadonlyArray<RunSummaryEntry>;
  /** Pairwise perceptual-hash diversity across processed variants; null when n < 2. */
  readonly diversity: DiversitySummary | null;
}

/**
 * Compose the path structure for a run. Pure given (root, brief, runId).
 */
export function runPaths(root: string, brief: Brief, runId: string): RunPaths {
  const briefDir = path.join(root, 'runs', brief.name, runId);
  return {
    root,
    runId,
    briefDir,
    rawDir: path.join(briefDir, 'raw'),
    processedDir: path.join(briefDir, 'processed'),
  };
}

/** Pure run-id builder. Caller supplies `now` and the prompt so tests are deterministic. */
export function makeRunId(now: Date, prompt: string): string {
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 8);
  return `${ts}-${hash}`;
}

/** Create the run directory tree. Impure. */
export function ensureRunDirs(paths: RunPaths): void {
  mkdirSync(paths.briefDir, { recursive: true });
  mkdirSync(paths.rawDir, { recursive: true });
  mkdirSync(paths.processedDir, { recursive: true });
}

/** Write the raw multi-variant sheet PNG for a given attempt index. */
export function writeSheet(paths: RunPaths, attemptIndex: number, sheet: Buffer): string {
  const file = path.join(paths.briefDir, `sheet-${String(attemptIndex).padStart(2, '0')}.png`);
  writeFileSync(file, sheet);
  return file;
}

/** Write one variant's raw + processed PNGs and its scorecard. Returns paths. */
export function writeVariant(
  paths: RunPaths,
  index: number,
  raw: Buffer,
  processed: Buffer,
  scorecard: Scorecard,
): { readonly rawPath: string; readonly processedPath: string; readonly scorecardPath: string } {
  const id = String(index).padStart(2, '0');
  const rawPath = path.join(paths.rawDir, `${id}.png`);
  const processedPath = path.join(paths.processedDir, `${id}.png`);
  const scorecardPath = path.join(paths.processedDir, `${id}.scorecard.json`);
  writeFileSync(rawPath, raw);
  writeFileSync(processedPath, processed);
  writeFileSync(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  return { rawPath, processedPath, scorecardPath };
}

/** Write run summary JSON. Returns path. */
export function writeSummary(paths: RunPaths, summary: RunSummary): string {
  const file = path.join(paths.briefDir, 'summary.json');
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  return file;
}

/**
 * Rank candidates: passed-first, then by score descending, with stable tie-break
 * on index ascending. Pure.
 */
export function rankCandidates(entries: ReadonlyArray<RunSummaryEntry>): RunSummaryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
}
