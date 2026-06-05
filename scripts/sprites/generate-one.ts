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
import { computeDiversity } from './diversity.js';
import { expandVariations } from './expand-variations.js';
import { loadBrief, type LoadedBrief } from './load-brief.js';
import { postprocess } from './postprocess.js';
import { scoreCandidate } from './score-candidate.js';
import { sliceSheetFromBrief } from './slice-sheet.js';
import type { ImageProvider, ProviderErrorKind } from './provider/types.js';
import { ProviderError } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import {
  ensureRunDirs,
  makeRunId,
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
  /**
   * Optional text provider for variation expansion. When `null`/omitted
   * the orchestrator skips the expansion pass (the brief's seed
   * `variations` flow through untouched) and emits a single warning iff
   * the brief actually wanted more variations than the seed provides.
   */
  readonly textProvider?: TextProvider | null;
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
  /** Warning sink (mainly for expand-variations). Defaults to console.warn. */
  readonly warn?: (message: string) => void;
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

  const loaded = options.preloaded ?? loadBrief(options.briefPath, { projectRoot: repoRoot });
  const brief = loaded.brief;
  const palette = loaded.palette;
  const expected = variantCount(brief);

  // Expansion runs once per orchestrator invocation, before prompt
  // construction, because the prompt embeds the final variations list.
  // Graceful degradation: when no text provider is configured or the
  // call fails, we use the author's seed unchanged — the run still
  // produces sprites, just without the LLM-brainstormed extras.
  const expansion = await expandVariations({
    brief,
    provider: options.textProvider ?? null,
    ...(options.warn ? { warn: options.warn } : {}),
  });
  // Shallow brief copy with the resolved variations list so downstream
  // pure code (build-prompt, run-summary) doesn't need to know an
  // expansion step happened. Original brief object stays untouched.
  const effectiveBrief = { ...brief, variations: [...expansion.variations] };

  const styleGuide = loadStyleGuide(repoRoot);
  const prompt = buildSheetPrompt(effectiveBrief, styleGuide);

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
  // Keep the post-processed buffers alongside `entries` so the diversity
  // pass doesn't have to re-read every variant from disk. Same byte
  // sequences either way — `writeVariant` writes exactly what we hand it.
  const processedBuffers: Buffer[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const raw = sliced[i]!;
    const processed = postprocess(raw, brief, palette);
    const scorecard = scoreCandidate(processed, brief, palette);
    const { rawPath, processedPath, scorecardPath } = writeVariant(
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
    });
    processedBuffers.push(processed);
  }

  const ranked = rankCandidates(entries);
  const diversity = computeDiversity(processedBuffers);
  const summary: RunSummary = {
    brief: brief.name,
    briefPath: loaded.briefPath,
    runId,
    createdAt: now().toISOString(),
    promptHash: shortPromptHash(prompt),
    attempts,
    variantCount: expected,
    candidates: ranked,
    diversity,
    variations: {
      seed: expansion.seed,
      proposed: expansion.proposed,
      final: expansion.variations,
      minVariations: brief.minVariations,
      skippedReason: expansion.skippedReason,
    },
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
