/**
 * generateOne — the sprite-generation orchestrator.
 *
 * Single entry point used by both the CLI and tests. Given a brief path,
 * a provider, and some IO hooks, runs the pipeline end-to-end:
 *
 *   1. Load + validate brief, resolve palette, load reference PNGs
 *   2. Load style guide and build the sheet prompt
 *   3. Call provider -> raw multi-variant sheet PNG
 *   4. Slice into variants
 *   5. Post-process each variant
 *   6. Score each variant via the universal + family sensors
 *   7. Write all artifacts under generated/runs/<brief>/<run-id>/
 *   8. Return a ranked summary
 *
 * Retry policy (bounded, 1-3 attempts):
 *   - On `bad-grid`, `non-png`: re-issue the same prompt up to maxAttempts
 *     because models occasionally drop a cell or emit a junk byte stream
 *     and the next attempt usually succeeds.
 *   - On `auth`: fail immediately. A wrong key won't fix itself.
 *   - On `network`, `rate-limit`, `provider-error`: fail. The CLI surfaces
 *     the kind so the human can decide whether to re-run.
 *   - On a "no variant passed" outcome: do NOT auto-retry. The artifacts
 *     are still useful (the human reviews the sheet to see what went wrong);
 *     the orchestrator returns the summary with `passed = []` and the CLI
 *     prints a clear "no candidate passed all sensors" line and exits
 *     non-zero. Re-running with a tweaked prompt is a human decision.
 *
 * Everything here is impure (network + filesystem). The pure pieces it
 * composes (`loadBrief`, `buildSheetPrompt`, `sliceSheet`, `postprocess`,
 * `scoreCandidate`) all live in their own modules with their own unit tests.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { variantCount } from './brief-schema.js';
import { buildSheetPrompt, loadStyleGuide } from './build-prompt.js';
import { loadBrief, type LoadedBrief } from './load-brief.js';
import { postprocess } from './postprocess.js';
import { scoreCandidate } from './score-candidate.js';
import { sliceSheetFromBrief } from './slice-sheet.js';
import type { ImageProvider, ProviderErrorKind } from './provider/types.js';
import { ProviderError } from './provider/types.js';
import {
  ensureRunDirs,
  makeRunId,
  pickChosen,
  rankCandidates,
  runPaths,
  writeSheet,
  writeSummary,
  writeVariant,
  type RunSummary,
  type RunSummaryEntry,
} from './run-artifacts.js';

export interface GenerateOneOptions {
  readonly briefPath: string;
  readonly provider: ImageProvider;
  /** Repository root used to resolve the style guide + reference PNGs. */
  readonly repoRoot: string;
  /** Output directory for run artifacts. Defaults to `<repoRoot>/generated`. */
  readonly outputRoot?: string;
  /** Max provider attempts on `bad-grid` / `non-png`. Defaults to 2. */
  readonly maxAttempts?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  /** Reference PNG loader injection; defaults to `fs.readFileSync`. */
  readonly readReference?: (absolutePath: string) => Buffer;
  /** Optional brief override (avoid re-loading from disk in tests). */
  readonly preloaded?: LoadedBrief;
}

export interface GenerateOneResult {
  readonly summary: RunSummary;
  readonly summaryPath: string;
  readonly runDir: string;
  readonly attempts: number;
}

const RETRYABLE_PROVIDER_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['bad-grid', 'non-png']);

export async function generateOne(options: GenerateOneOptions): Promise<GenerateOneResult> {
  const repoRoot = options.repoRoot;
  const outputRoot = options.outputRoot ?? path.join(repoRoot, 'generated');
  const maxAttempts = options.maxAttempts ?? 2;
  const now = options.now ?? (() => new Date());
  const readReference = options.readReference ?? ((p) => readFileSync(p));

  const loaded = options.preloaded ?? loadBrief(options.briefPath);
  const brief = loaded.brief;
  const palette = loaded.palette;
  const expected = variantCount(brief);

  const styleGuide = loadStyleGuide(repoRoot);
  const prompt = buildSheetPrompt(brief, styleGuide);

  // Reference PNG paths are repo-relative in briefs; resolve against repoRoot.
  const referencePngs = brief.references.map((ref) =>
    readReference(path.resolve(repoRoot, ref.path)),
  );

  const runId = makeRunId(now(), `${brief.name}|${prompt}`);
  const paths = runPaths(outputRoot, brief, runId);
  ensureRunDirs(paths);

  // --- Generate the sheet, with bounded retries on transient grid issues. ---
  let attempts = 0;
  let lastError: ProviderError | undefined;
  let sliced: Buffer[] | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++;
    try {
      const sheet = await options.provider.generateSheet({
        brief,
        prompt,
        referencePngs,
        variants: expected,
      });
      writeSheet(paths, attempt, sheet);
      const cells = sliceSheetFromBrief(sheet, brief);
      if (cells.length !== expected) {
        throw new ProviderError(
          'bad-grid',
          `expected ${expected} cells, slicer produced ${cells.length}`,
        );
      }
      sliced = cells;
      break;
    } catch (err) {
      const provErr = asProviderError(err);
      lastError = provErr;
      if (!RETRYABLE_PROVIDER_KINDS.has(provErr.kind)) throw provErr;
      if (attempt + 1 >= maxAttempts) throw provErr;
    }
  }
  if (!sliced) {
    throw lastError ?? new Error('generateOne: no sheet produced and no error captured');
  }

  // --- Postprocess + score each variant. ---
  const entries: RunSummaryEntry[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const raw = sliced[i]!;
    const processed = postprocess(raw, brief, palette);
    const scorecard = scoreCandidate(processed, brief, palette);
    const { rawPath, processedPath, scorecardPath, anchorSidecarPath } = writeVariant(
      paths,
      i,
      raw,
      processed,
      scorecard,
    );
    entries.push({
      index: i,
      score: scorecard.score,
      outOf: scorecard.outOf,
      passed: scorecard.passed,
      rawPath,
      processedPath,
      scorecardPath,
      derivedAnchor: scorecard.derivedAnchor,
      anchorSidecarPath,
    });
  }

  const ranked = rankCandidates(entries);
  const chosen = pickChosen(ranked, brief);
  const summary: RunSummary = {
    brief: brief.name,
    briefPath: loaded.briefPath,
    runId,
    createdAt: now().toISOString(),
    promptHash: shortPromptHash(prompt),
    attempts,
    variantCount: expected,
    candidates: ranked,
    chosen,
  };
  const summaryPath = writeSummary(paths, summary);

  return { summary, summaryPath, runDir: paths.briefDir, attempts };
}

function shortPromptHash(prompt: string): string {
  // Re-use the same hashing helper indirectly via run-artifacts.makeRunId
  // logic. Inlined here to avoid exporting an extra helper.
  return makeRunId(new Date(0), prompt).slice(20);
}

function asProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError('provider-error', message, err ? { cause: err } : undefined);
}

// (No public re-exports — each consumer imports directly from the relevant
// pure module. Keeps the orchestrator surface area minimal.)
