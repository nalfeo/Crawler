/**
 * generateOne — the GENERATE stage of the sprite pipeline (Option B, ADR 0024).
 *
 * Produces and stores the raw multi-variant sheet ONLY. It does NOT
 * post-process, score, or judge — those are explicit, re-runnable stages
 * (`repostprocessRun` / `rejudgeRun`, ADR 0023) the operator drives over the
 * stored sheet. Flow:
 *
 *   1. Load + validate brief, resolve palette, load reference PNGs
 *   2. Expand variations + build the sheet prompt
 *   3. Call provider -> raw multi-variant sheet PNG (bounded retries)
 *   4. Slice the sheet DATA-DRIVEN as a structural gate: it cuts only at real
 *      detected gutters (never inventing cuts), trims runt edge cells, and emits
 *      the sheet's HONEST grid at its real count. The gate rejects only a
 *      structural failure (zero cells), retrying generation; a count that differs
 *      from the brief's commanded count is accepted and carried to human gallery
 *      review (ADR 0052). The sliced cells are NOT
 *      post-processed here — slicing is cheap and a single content-aware path
 *      (ADR 0018), so the gate stays in Generate while the heavy per-variant work
 *      moves to PostProcess.
 *   5. Store the raw sheet(s) + a minimal sheet-only `summary.json`
 *      (no candidates / diversity / chosen / judge fields).
 *
 * The full one-shot pipeline the CLI (`sprites:run`) and batch tools use lives
 * in `run-full.ts` (`runFull`); it reuses `generateSheetCore` here plus the
 * shared `run-pipeline.ts` helpers so a one-shot run and a
 * generate→postprocess→judge sequence produce byte-identical artifacts.
 *
 * Retry policy (bounded, 1-3 attempts):
 *   - On `bad-grid`, `non-png`: re-issue the same prompt up to maxAttempts
 *     because models occasionally drop a cell or emit a junk byte stream
 *     and the next attempt usually succeeds.
 *   - On `request-error`, `auth`: fail immediately; retries cannot fix the request.
 *   - On `network`, `rate-limit`, `server-error`, or unexpected `provider-error`:
 *     surface the kind so the queue worker can apply bounded redelivery.
 *
 * Everything here is impure (network + filesystem). The pure pieces it
 * composes (`loadBrief`, `buildSheetPrompt`, `sliceSheetFromBrief`) live in
 * their own modules with their own unit tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { variantCount } from './brief-schema.js';
import type { Brief, PaletteColors } from './brief-schema.js';
import { buildPrompt, buildSheetPrompt, loadStyleGuide } from './build-prompt.js';
import { expandVariations } from './expand-variations.js';
import { loadGeneratedManifest } from './generated-shards.js';
import { loadBrief, type LoadedBrief } from './load-brief.js';
import { sliceSheetFromBrief, type BriefSliceResult } from './slice-sheet.js';
import type { ImageProvider, ProviderErrorKind } from './provider/types.js';
import { ProviderError } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import { LocalRunStore } from './store/local-store.js';
import type { RunStore } from './store/types.js';
import {
  makeRunId,
  type ReferenceSpriteRef,
  type ReferenceSpriteSelection,
  type RunSummary,
} from './run-artifacts.js';
import {
  REFERENCE_COUNT,
  referenceSelectorSeed,
  selectReferences,
  SELECTOR_VERSION,
} from './reference-selector.js';
import { type ManifestEntry } from '../../src/shared/generated-assets.js';
import { isSpriteType } from '../../src/shared/sprite-types.js';
import { assertResolvedUnderGenerated, isSafeGeneratedAssetPath } from './generated-asset-path.js';

export interface GenerateOneOptions {
  readonly briefPath: string;
  readonly provider: ImageProvider;
  /**
   * Optional text provider for variation expansion. When `null`/omitted
   * the orchestrator skips the expansion pass (the brief's seed
   * `variations` flow through untouched) and emits a single warning iff
   * the brief actually wanted more variations than the seed provides.
   *
   * Variation expansion is part of GENERATE (the prompt embeds the final
   * variations), so the text provider stays here — unlike the vision
   * provider, which belongs to the explicit Judge stage (`run-full.ts`).
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
  /**
   * Absolute path to the generated-sprite manifest the reference selector
   * draws from. Defaults to `<repoRoot>/public/assets/generated/manifest.json`.
   * Ignored when `loadReferenceCandidates` is provided.
   */
  readonly manifestPath?: string;
  /**
   * Candidate loader injection for the reference selector (tests). Defaults to
   * reading + parsing {@link manifestPath} and returning its entries. Kenney is
   * NOT a candidate source — references are our own approved generated sprites.
   */
  readonly loadReferenceCandidates?: () => readonly ManifestEntry[];
  /** Asset-level disliked annotation loader injection for reference hygiene. */
  readonly loadDislikedReferenceNames?: () => ReadonlySet<string>;
  /**
   * Asset-existence check injection (tests). Defaults to `fs.existsSync`. Used
   * to pre-filter manifest entries to those whose PNG is actually on disk
   * before the pure selector runs.
   */
  readonly referenceAssetExists?: (absolutePath: string) => boolean;
  /** How many references to select. Defaults to {@link REFERENCE_COUNT}. */
  readonly referenceCount?: number;
  /** Optional brief override (avoid re-loading from disk in tests). */
  readonly preloaded?: LoadedBrief;
  /** Warning sink (mainly for expand-variations). Defaults to logger.warn. */
  readonly warn?: (message: string) => void;
  /**
   * RunStore for writing all artifacts. Defaults to a `LocalRunStore` rooted
   * at `<outputRoot>/runs` so existing local workflows are unaffected.
   * Pass an `AzureBlobRunStore` to write artifacts to Azure Blob Storage.
   */
  readonly store?: RunStore;
}

export interface GenerateOneResult {
  readonly summary: RunSummary;
  readonly summaryPath: string;
  readonly runDir: string;
  readonly attempts: number;
  /**
   * The fully-loaded brief used for this run. Exposed so the CLI (and other
   * orchestrator callers) can make brief-aware decisions — e.g. whether the
   * brief opted into `sensors.anchor.derive` — without re-reading the YAML.
   */
  readonly brief: Brief;
}

/**
 * The run-identity fields shared by every `summary.json`, whatever stage wrote
 * it. `generateOne` writes these plus null/empty pipeline fields; `runFull`
 * (and the explicit PostProcess/Judge re-runs) write these plus the computed
 * candidates / diversity / chosen / judge fields.
 */
export type RunSummaryIdentity = Pick<
  RunSummary,
  | 'brief'
  | 'briefPath'
  | 'runId'
  | 'createdAt'
  | 'promptHash'
  | 'attempts'
  | 'variantCount'
  | 'grid'
  | 'variations'
> & {
  readonly referenceSprites?: RunSummary['referenceSprites'];
  readonly frameSequence?: RunSummary['frameSequence'];
};

/**
 * Everything `generateSheetCore` produces: a stored raw sheet, the
 * gate-validated cells (reused — not re-sliced — by `runFull`), and the
 * resolved inputs (`brief`, `palette`, `referencePngs`, `styleGuide`) the
 * downstream post-process / judge stages need. Deliberately NO `summary.json`
 * is written here — the caller decides whether it's a sheet-only summary
 * (`generateOne`) or a full one (`runFull`).
 */
export interface GenerateSheetCoreResult {
  readonly runId: string;
  readonly store: RunStore;
  /** Maps a run-relative path (e.g. `summary.json`) to a full store key. */
  readonly storeKey: (rel: string) => string;
  readonly runDir: string;
  /** Original (un-expanded) brief — drives variantCount, postprocess + judge. */
  readonly brief: Brief;
  readonly palette: PaletteColors;
  readonly referencePngs: Buffer[];
  readonly styleGuide: string;
  /**
   * The variant cells extracted from the stored sheet, in reading order. Generate
   * slices the sheet DATA-DRIVEN (never inventing cuts) and gates only on a
   * structural failure (zero cells); `runFull` reuses these buffers so the full
   * pipeline never re-reads the sheet from the store. Count is the ACTUAL sliced
   * count (`identity.variantCount`), which may differ from the commanded count.
   */
  readonly sliced: Buffer[];
  readonly attempts: number;
  /**
   * `variantCount(brief)` — the brief's COMMANDED cell count. Retained for
   * telemetry/logging and as the provider `variants` hint; it is NO LONGER a hard
   * gate (the slicer emits the sheet's honest count instead). See
   * ADR 0052.
   */
  readonly expected: number;
  readonly identity: RunSummaryIdentity;
}

const RETRYABLE_PROVIDER_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['bad-grid', 'non-png']);
const ANNOTATION_PARSE_ATTEMPTS = 3;

/**
 * Project a selected manifest entry into the auditable run-summary shape. The
 * selector only ever returns typed entries, so an untyped one here is a bug —
 * fail loudly rather than silently write an invalid summary.
 */
function toReferenceSpriteRef(entry: ManifestEntry): ReferenceSpriteRef {
  if (!isSpriteType(entry.type)) {
    throw new Error(
      `generateSheetCore: selected reference "${entry.spriteName}" (${entry.assetPath}) ` +
        `has no valid sprite type — the reference selector must not return untyped entries.`,
    );
  }
  return {
    briefId: entry.briefId,
    spriteName: entry.spriteName,
    type: entry.type,
    assetPath: entry.assetPath,
    sensorScore: entry.sensorScore,
    judgeScore: entry.judgeScore ?? null,
    contentHash: entry.contentHash ?? null,
  };
}

function loadDislikedSpriteNamesFromAnnotations(annotationsPath: string): ReadonlySet<string> {
  for (let attempt = 0; attempt < ANNOTATION_PARSE_ATTEMPTS; attempt += 1) {
    try {
      const raw = JSON.parse(readFileSync(annotationsPath, 'utf8')) as {
        readonly sprites?: unknown;
      };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Set<string>();
      const sprites = raw.sprites;
      if (!sprites || typeof sprites !== 'object' || Array.isArray(sprites))
        return new Set<string>();
      const disliked = new Set<string>();
      for (const [spriteName, note] of Object.entries(sprites as Record<string, unknown>)) {
        if (!note || typeof note !== 'object' || Array.isArray(note)) continue;
        if ((note as { readonly disliked?: unknown }).disliked === true) {
          disliked.add(spriteName);
        }
      }
      return disliked;
    } catch {
      // Concurrent sprite-editor writes can expose a transient truncated snapshot.
      // Retry a bounded number of times, then fail-safe to an empty disliked set.
    }
  }
  return new Set<string>();
}

export async function generateSheetCore(
  options: GenerateOneOptions,
): Promise<GenerateSheetCoreResult> {
  const repoRoot = options.repoRoot;
  const outputRoot = options.outputRoot ?? path.join(repoRoot, 'generated');
  const maxAttempts = options.maxAttempts ?? 2;
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const readReference = options.readReference ?? ((p) => readFileSync(p));
  // Default to a local store rooted at <outputRoot>/runs — same layout as before.
  const store: RunStore = options.store ?? new LocalRunStore(path.join(outputRoot, 'runs'));

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
  const singleVariantPrompt = buildPrompt(effectiveBrief, styleGuide);

  // References are OUR own highest-quality approved sprites, chosen
  // deterministically per brief — Kenney placeholder spritesheets are retired.
  // The pure selector does no IO, so we load the manifest and pre-filter to
  // entries whose PNG actually exists on disk here, then hand the survivors
  // to `selectReferences`, which favours the brief's own `type` (with injected,
  // seeded randomness) and broadens to other high-quality generated art when
  // the same-type pool is thin.
  const supportsReferenceImages = options.provider.capabilities?.referenceImages !== false;
  const referenceCount = options.referenceCount ?? REFERENCE_COUNT;
  const publicAssetsRoot = path.resolve(repoRoot, 'public', 'assets');
  const resolveAssetPath = (assetPath: string) => path.resolve(publicAssetsRoot, assetPath);
  const referenceAssetExists =
    options.referenceAssetExists ?? ((absolutePath) => existsSync(absolutePath));
  const loadReferenceCandidates =
    options.loadReferenceCandidates ??
    (() => {
      const manifestPath =
        options.manifestPath ?? path.join(publicAssetsRoot, 'generated', 'manifest.json');
      // The aggregate manifest.json is a gitignored build artifact; compose the
      // reference pool directly from the committed per-asset shards (the source
      // of truth), falling back to a legacy aggregate file when no shards exist.
      // A cold start with neither yields an empty pool so the zero-eligible
      // guard below raises its actionable error instead of an opaque ENOENT.
      const manifest = loadGeneratedManifest(path.dirname(manifestPath));
      return Object.values(manifest.entries);
    });
  const loadDislikedReferenceNames =
    options.loadDislikedReferenceNames ??
    (() => {
      const annotationsPath = path.join(
        publicAssetsRoot,
        'generated',
        'sprite-editor-annotations.json',
      );
      if (!existsSync(annotationsPath)) return new Set<string>();
      return loadDislikedSpriteNamesFromAnnotations(annotationsPath);
    });

  let referencePngs: Buffer[] = [];
  let referenceSprites: ReferenceSpriteSelection | undefined;
  if (supportsReferenceImages) {
    const presentCandidates = loadReferenceCandidates().filter(
      (entry) =>
        isSafeGeneratedAssetPath(entry.assetPath) &&
        referenceAssetExists(resolveAssetPath(entry.assetPath)),
    );
    const selection = selectReferences({
      candidates: presentCandidates,
      briefName: brief.name,
      briefType: brief.type,
      count: referenceCount,
      seed: referenceSelectorSeed(brief.name),
      dislikedSpriteNames: loadDislikedReferenceNames(),
    });
    if (selection.selected.length === 0) {
      throw new Error(
        `generateSheetCore: no eligible generated reference sprites for brief "${brief.name}" ` +
          `(type="${brief.type}"). Generation now sends our own approved sprites as references ` +
          `(Kenney placeholders are retired), but the generated manifest has none that clear the ` +
          `quality floor with an on-disk PNG. Approve at least one high-quality sprite first.`,
      );
    }
    referencePngs = selection.selected.map((entry) => {
      const absolutePath = resolveAssetPath(entry.assetPath);
      assertResolvedUnderGenerated(absolutePath, publicAssetsRoot, 'generateSheetCore');
      return readReference(absolutePath);
    });
    referenceSprites = {
      selectorVersion: SELECTOR_VERSION,
      seed: selection.seed,
      requestedCount: selection.requestedCount,
      eligibleCount: selection.eligibleCount,
      sameTypeCount: selection.sameTypeCount,
      selected: selection.selected.map(toReferenceSpriteRef),
    };
  }

  const runId = makeRunId(createdAt, `${brief.name}|${prompt}`);
  // Store-key helper: returns a key relative to the store root.
  const storeKey = (rel: string) => `${brief.name}/${runId}/${rel}`;
  const pad2 = (n: number) => String(n).padStart(2, '0');

  // --- Generate the sheet, with bounded retries on transient grid issues. ---
  let attempts = 0;
  let lastError: ProviderError | undefined;
  let sliceResult: BriefSliceResult | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++;
    try {
      const sheet = await options.provider.generateSheet({
        brief: effectiveBrief,
        prompt,
        singleVariantPrompt,
        referencePngs,
        variants: expected,
      });
      await store.put(storeKey(`sheet-${pad2(attempt)}.png`), sheet);
      const slice = sliceSheetFromBrief(sheet, brief);
      // Structural-only gate (ADR 0052): the slicer
      // is data-driven and never invents cuts, so it emits the sheet's HONEST
      // grid at its real count — which may differ from the brief's commanded
      // count when the model drew a runt edge or a gappy subject. We therefore
      // NO LONGER reject on a count mismatch (that reversed 2026-07-07 decision
      // force-fit the count by cutting through art). We reject only a structural
      // failure — zero cells — and carry the honest grid to human gallery review.
      if (slice.cells.length === 0) {
        throw new ProviderError(
          'bad-grid',
          `slicer produced 0 cells from the generated sheet (structural failure)`,
        );
      }
      sliceResult = slice;
      break;
    } catch (err) {
      const provErr = asProviderError(err);
      lastError = provErr;
      if (!RETRYABLE_PROVIDER_KINDS.has(provErr.kind)) throw provErr;
      if (attempt + 1 >= maxAttempts) throw provErr;
    }
  }
  if (!sliceResult) {
    throw lastError ?? new Error('generateSheetCore: no sheet produced and no error captured');
  }

  // Convert absolute briefPath to repo-relative with forward slashes (required by validation)
  const repoRelativeBriefPath = path.relative(repoRoot, loaded.briefPath).replace(/\\/g, '/');

  const identity: RunSummaryIdentity = {
    brief: brief.name,
    briefPath: repoRelativeBriefPath,
    runId,
    createdAt: createdAt.toISOString(),
    promptHash: shortPromptHash(prompt),
    attempts,
    // ACTUAL non-empty cell count the slicer produced (data-driven), not the
    // brief's commanded count. Carried to the gallery + downstream indexing.
    variantCount: sliceResult.variantCount,
    // ACTUAL data-driven grid the slicer landed on (see slice-sheet.ts). Persisted
    // so re-postprocess re-slices the stored sheet the same way; may differ from
    // brief.generation.sheet when a runt edge was trimmed / a spurious gutter merged.
    grid: {
      rows: sliceResult.grid.rows,
      cols: sliceResult.grid.cols,
      emptyCells: sliceResult.grid.emptyCells,
    },
    variations: {
      seed: expansion.seed,
      proposed: expansion.proposed,
      final: expansion.variations,
      minVariations: brief.minVariations,
      skippedReason: expansion.skippedReason,
    },
    ...(referenceSprites ? { referenceSprites } : {}),
    ...(brief.frameSequence.enabled
      ? {
          frameSequence: {
            frameCount: brief.frameSequence.frameCount,
            frameRate: brief.frameSequence.frameRate,
            loop: brief.frameSequence.loop,
          },
        }
      : {}),
  };

  return {
    runId,
    store,
    storeKey,
    runDir: store.resolve(`${brief.name}/${runId}`),
    brief,
    palette,
    referencePngs,
    styleGuide,
    sliced: sliceResult.cells,
    attempts,
    expected,
    identity,
  };
}

/**
 * GENERATE stage (Option B, ADR 0024): produce + store the raw sheet only,
 * plus a minimal sheet-only `summary.json` (empty candidates, null
 * diversity/chosen/judge fields). Post-process / score / judge are explicit,
 * re-runnable stages over the stored sheet — see `run-full.ts` for the
 * one-shot full pipeline and `rerun.ts` for the operator-driven re-runs.
 *
 * The slice inside `generateSheetCore` is a quality GATE only (retry on a bad
 * grid); it does not post-process or persist the sliced cells.
 */
export async function generateOne(options: GenerateOneOptions): Promise<GenerateOneResult> {
  const core = await generateSheetCore(options);
  const { store, storeKey, runDir, brief, attempts, identity } = core;

  const summary: RunSummary = {
    ...identity,
    candidates: [],
    diversity: null,
    chosen: null,
    judgeBudget: null,
    judgeCache: null,
  };

  const summaryKey = storeKey('summary.json');
  await store.put(summaryKey, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`));
  const summaryPath = store.resolve(summaryKey);

  return { summary, summaryPath, runDir, attempts, brief };
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
