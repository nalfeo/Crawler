/**
 * Execution/review/publication orchestration for the phased theme-equipment
 * set pipeline (ADR 0073). `theme-equipment-set.ts` stays a pure state/schema
 * module with zero IO and zero provider knowledge; this module is where the
 * per-item executor, the collection judges (vision + text), and the single
 * atomic publish step are wired together.
 *
 * Three pieces:
 *
 *   1. `runThemeEquipmentSetPhase` — drives ONE phase pass: executes every
 *      currently-unresolved item (never a frozen/up-reviewed one) through an
 *      injected per-item executor, records its artifacts/evidence, then
 *      judges the FULL current collection (including untouched frozen/up
 *      items) exactly once through an injected collection judge. Fails
 *      closed — any executor/judge/mutation failure throws and the caller
 *      gets nothing back (never a half-updated state).
 *
 *   2. Two collection-judge helpers: a deterministic contact-sheet builder
 *      plus a vision-provider-backed judge for `sprite-sheets`/
 *      `variant-approval`, and a narrow text-provider-backed judge for
 *      `roster`/`briefs`. Both demand `{score, rationale}` and stamp their
 *      own `provenance`.
 *
 *   3. `publishThemeEquipmentSet` — the ONE atomic publish path. Validates
 *      every gate (phase complete, publication held, every item carries
 *      1-3 approved-variant artifacts, the caller's asset array matches the
 *      set exactly) BEFORE touching the network, invokes `runQueueCommit`
 *      exactly once with the narrow `theme-equipment-publisher` CI
 *      capability, and only marks the set published after that call
 *      resolves. No partial state on error.
 */

import { PNG } from 'pngjs';
import { z } from 'zod';
import type { CheckinAsset } from './checkin.js';
import { isCiEnv, isThemeEquipmentPipelineBypassed } from './ci-bypass.js';
import type { EvaluateRequest, VisionProvider } from './provider/vision-types.js';
import type { QueueCommitDeps, QueueCommitOptions } from './queue-commit.js';
import { runQueueCommit } from './queue-commit.js';
import {
  applyThemeSetPhaseCollectionJudge,
  isReviewPhase,
  isThemeSetItemResolvedForPhase,
  markThemeEquipmentSetPublished,
  parseThemeEquipmentSetState,
  recordThemeSetItemPhaseArtifacts,
  THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
  THEME_EQUIPMENT_MAX_APPROVED_VARIANTS,
  THEME_EQUIPMENT_MIN_APPROVED_VARIANTS,
  THEME_EQUIPMENT_SET_REVIEW_PHASES,
  type ThemeEquipmentArtifactEvidence,
  type ThemeEquipmentCollectionJudgeResult,
  type ThemeEquipmentSetItem,
  type ThemeEquipmentSetState,
} from './theme-equipment-set.js';

/**
 * Error kinds:
 *   - `executor-failed` / `judge-failed`: the injected callback itself threw
 *     (rethrown as the ORIGINAL error, not wrapped — see `runThemeEquipmentSetPhase`).
 *   - `mutation-rejected`: a pure `theme-equipment-set.ts` mutation returned
 *     `{ ok: false }` (e.g. the executor tried to record artifacts for an
 *     item that became resolved mid-run).
 *   - `ci-refused`: a collection judge helper ran under CI without the
 *     ADR-0043-style bypass.
 *   - `malformed`: a provider returned valid JSON that failed the judge
 *     response schema.
 *   - `empty-contact-sheet` / `contact-sheet-too-large`: contact-sheet input
 *     violated the 1..32 tile bound.
 */
export class ThemeEquipmentPipelineError extends Error {
  override readonly name = 'ThemeEquipmentPipelineError';
  constructor(
    readonly kind:
      | 'mutation-rejected'
      | 'ci-refused'
      | 'malformed'
      | 'empty-contact-sheet'
      | 'contact-sheet-too-large'
      | 'not-a-review-phase',
    message: string,
  ) {
    super(message);
  }
}

/** One item's freshly-produced current-phase artifacts/evidence. */
export interface ThemeEquipmentItemExecutionResult {
  readonly artifacts: readonly ThemeEquipmentArtifactEvidence[];
  readonly evidence: readonly ThemeEquipmentArtifactEvidence[];
}

/**
 * Injected per-item executor. Called ONCE per unresolved item per phase
 * pass, with the item's live record and the state as of just before this
 * item's turn (so an executor can, in principle, react to earlier items in
 * the same pass — none of the current helpers need this, but the runner
 * always has the latest state on hand anyway).
 */
export type ThemeEquipmentItemExecutor = (
  item: ThemeEquipmentSetItem,
  state: ThemeEquipmentSetState,
) => Promise<ThemeEquipmentItemExecutionResult>;

/**
 * Injected collection judge. Called exactly once per phase pass, against
 * the FULLY updated collection (every item's current-phase artifacts,
 * including items skipped this pass because they were already
 * frozen/up-reviewed).
 */
export type ThemeEquipmentCollectionJudgeFn = (
  state: ThemeEquipmentSetState,
) => Promise<ThemeEquipmentCollectionJudgeResult>;

/**
 * Run one phase pass over `state`:
 *
 *   1. For every item NOT already resolved for `state.phase` (see
 *      `isThemeSetItemResolvedForPhase` — up-reviewed or frozen items are
 *      skipped, never re-executed or clobbered), call `executeItem` and
 *      record its result via `recordThemeSetItemPhaseArtifacts`.
 *   2. Call `judgeCollection` exactly once against the resulting state
 *      (which now reflects every newly-recorded item AND every untouched
 *      frozen/up item) and record the result via
 *      `applyThemeSetPhaseCollectionJudge`.
 *
 * Never mutates `state` — every step produces a new state object via the
 * pure mutations in `theme-equipment-set.ts`. Fails closed: an executor or
 * judge callback that throws propagates its ORIGINAL error unchanged (so
 * callers can still distinguish e.g. a `VisionProviderError` from a
 * `ThemeEquipmentPipelineError`); a mutation that returns `{ ok: false }`
 * (a gate rejection, not a thrown error) is converted to a thrown
 * `ThemeEquipmentPipelineError('mutation-rejected', ...)` so this function
 * never returns a half-applied result.
 */
export async function runThemeEquipmentSetPhase(
  state: ThemeEquipmentSetState,
  executeItem: ThemeEquipmentItemExecutor,
  judgeCollection: ThemeEquipmentCollectionJudgeFn,
): Promise<ThemeEquipmentSetState> {
  if (!isReviewPhase(state.phase)) {
    throw new ThemeEquipmentPipelineError(
      'not-a-review-phase',
      `runThemeEquipmentSetPhase cannot run during phase "${state.phase}" — there is no ` +
        'review phase to execute or judge',
    );
  }
  const phase = state.phase;
  let current = state;

  for (const original of state.items) {
    // Re-fetch the item from the running state: an earlier iteration in
    // this same loop cannot change ANOTHER item's resolved-ness, but this
    // keeps the executor input honest if that ever changes.
    const live = current.items.find((candidate) => candidate.id === original.id);
    if (!live) {
      // Items are never added/removed by any mutation this runner drives;
      // this can only happen if the caller handed us a state whose item
      // list disagrees with itself, which parseThemeEquipmentSetState
      // would already have rejected on the way in.
      continue;
    }
    if (isThemeSetItemResolvedForPhase(live, phase)) {
      continue;
    }

    const result = await executeItem(live, current);
    const mutation = recordThemeSetItemPhaseArtifacts(
      current,
      live.id,
      result.artifacts,
      result.evidence,
    );
    if (!mutation.ok) {
      throw new ThemeEquipmentPipelineError(
        'mutation-rejected',
        `Recording phase artifacts for item "${live.id}" was rejected: ` +
          mutation.reasons.map((reason) => reason.message).join('; '),
      );
    }
    current = mutation.state;
  }

  const judgeResult = await judgeCollection(current);
  const judgeMutation = applyThemeSetPhaseCollectionJudge(current, judgeResult);
  if (!judgeMutation.ok) {
    throw new ThemeEquipmentPipelineError(
      'mutation-rejected',
      `Recording collection judge result was rejected: ` +
        judgeMutation.reasons.map((reason) => reason.message).join('; '),
    );
  }
  return judgeMutation.state;
}

// ---------------------------------------------------------------------------
// Deterministic contact sheet
// ---------------------------------------------------------------------------

/** Maximum tiles a single contact sheet may contain. */
export const CONTACT_SHEET_MAX_TILES = 32;

/** One labeled PNG tile to place on the contact sheet. */
export interface ContactSheetTile {
  readonly label: string;
  readonly png: Buffer;
}

export interface ContactSheetResult {
  /** The composed contact-sheet PNG bytes. */
  readonly png: Buffer;
  readonly columns: number;
  readonly rows: number;
  /** Per-tile cell size (the max width/height across all input tiles). */
  readonly tileWidth: number;
  readonly tileHeight: number;
  /**
   * Tile labels in row-major placement order (index 0 is top-left, index 1
   * is immediately to its right, etc). This is metadata, not rendered
   * pixels — the sheet itself does not draw text (no font-rendering
   * dependency is available), so a judge prompt embeds this order alongside
   * the image to let the model refer to tiles by label/position.
   */
  readonly order: readonly string[];
}

const CONTACT_SHEET_PADDING = 4;
/** Neutral dark background — distinct from judge.ts's readability-preview
 * floor color so a contact sheet is never mistaken for a readability
 * composite in a mixed-image prompt. */
const CONTACT_SHEET_BACKGROUND = { r: 30, g: 30, b: 36 } as const;

/**
 * Compose a deterministic grid contact sheet from labeled PNG tiles.
 *
 * Deterministic: given the same input array (same bytes, same order), the
 * output PNG bytes are byte-identical every time — no timestamps, no
 * randomness, no reliance on iteration order of anything other than the
 * input array itself. Tiles are placed in the EXACT order supplied
 * (row-major, left-to-right, top-to-bottom): callers control ordering by
 * controlling the input array, this function never re-sorts.
 *
 * Layout: a near-square grid (`columns = ceil(sqrt(n))`,
 * `rows = ceil(n / columns)`), each cell sized to the largest input tile
 * (smaller tiles are placed top-left within their cell, not stretched, to
 * avoid distorting aspect ratio), separated by a fixed padding gutter on a
 * neutral dark background. Alpha-aware: fully transparent source pixels
 * leave the background showing through; any other pixel is copied opaque
 * (matching the post-processor's hard alpha threshold used elsewhere in
 * the sprite pipeline).
 *
 * Throws `ThemeEquipmentPipelineError('empty-contact-sheet')` for zero
 * tiles, and `('contact-sheet-too-large')` for more than
 * `CONTACT_SHEET_MAX_TILES`.
 */
export function buildThemeEquipmentContactSheet(
  tiles: readonly ContactSheetTile[],
): ContactSheetResult {
  if (tiles.length === 0) {
    throw new ThemeEquipmentPipelineError(
      'empty-contact-sheet',
      'buildThemeEquipmentContactSheet requires at least one tile',
    );
  }
  if (tiles.length > CONTACT_SHEET_MAX_TILES) {
    throw new ThemeEquipmentPipelineError(
      'contact-sheet-too-large',
      `buildThemeEquipmentContactSheet received ${tiles.length} tiles, exceeding the ` +
        `max of ${CONTACT_SHEET_MAX_TILES}`,
    );
  }

  const decoded = tiles.map((tile) => PNG.sync.read(tile.png));
  const tileWidth = Math.max(...decoded.map((png) => png.width));
  const tileHeight = Math.max(...decoded.map((png) => png.height));

  const columns = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / columns);

  const sheetWidth = columns * tileWidth + (columns + 1) * CONTACT_SHEET_PADDING;
  const sheetHeight = rows * tileHeight + (rows + 1) * CONTACT_SHEET_PADDING;

  const sheet = new PNG({ width: sheetWidth, height: sheetHeight });
  for (let i = 0; i < sheet.data.length; i += 4) {
    sheet.data[i] = CONTACT_SHEET_BACKGROUND.r;
    sheet.data[i + 1] = CONTACT_SHEET_BACKGROUND.g;
    sheet.data[i + 2] = CONTACT_SHEET_BACKGROUND.b;
    sheet.data[i + 3] = 255;
  }

  decoded.forEach((src, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const originX = CONTACT_SHEET_PADDING + col * (tileWidth + CONTACT_SHEET_PADDING);
    const originY = CONTACT_SHEET_PADDING + row * (tileHeight + CONTACT_SHEET_PADDING);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const srcIdx = (y * src.width + x) * 4;
        const alpha = src.data[srcIdx + 3];
        if (!alpha) continue; // fully transparent: leave the background showing
        const dstX = originX + x;
        const dstY = originY + y;
        const dstIdx = (dstY * sheetWidth + dstX) * 4;
        sheet.data[dstIdx] = src.data[srcIdx]!;
        sheet.data[dstIdx + 1] = src.data[srcIdx + 1]!;
        sheet.data[dstIdx + 2] = src.data[srcIdx + 2]!;
        sheet.data[dstIdx + 3] = 255;
      }
    }
  });

  return {
    png: PNG.sync.write(sheet),
    columns,
    rows,
    tileWidth,
    tileHeight,
    order: tiles.map((tile) => tile.label),
  };
}

// ---------------------------------------------------------------------------
// Collection judges
// ---------------------------------------------------------------------------

const collectionJudgeResponseSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    rationale: z.string().trim().min(1),
  })
  .strict();

function refuseUnbypassedCi(env: NodeJS.ProcessEnv): void {
  if (isCiEnv(env) && !isThemeEquipmentPipelineBypassed(env)) {
    throw new ThemeEquipmentPipelineError(
      'ci-refused',
      'Theme-equipment collection judges are local-only — they cost Azure credits and are ' +
        'non-deterministic. Unset the CI environment variable to run locally, or set ' +
        'SPRITES_ALLOW_CI_THEME_PIPELINE=true from the trusted theme-equipment workflow.',
    );
  }
}

/**
 * Build the shared instructions every collection judge (vision or text)
 * sends: the set's fixed, human-authored design language, and an explicit
 * two-part ask — overall cohesion AND any individual outlier(s) — so the
 * model cannot satisfy the prompt by only ever reporting an aggregate
 * score.
 *
 * The prompt is deliberately grounded to suppress hallucinated
 * false-negatives: the judge must score only what is clearly visible, must
 * not infer unseen surface properties (polish, reflectivity, sheen) or
 * penalize an item's inherent form (a bow is curved), and may only flag an
 * outlier that contradicts a named clause of the design language with visible
 * evidence. Scoring is graduated (a single minor deviation must not drop below
 * 3) rather than hard-capping at 2 on any claimed outlier — the old cap turned
 * one hallucinated defect into a full-collection veto.
 */
function buildCollectionJudgeInstructions(
  state: ThemeEquipmentSetState,
  order: readonly string[],
): { readonly systemInstructions: string; readonly userPrompt: string } {
  const systemInstructions =
    'You are a fair but rigorous art director scoring one themed equipment/weapon collection ' +
    'for a top-down action game. Score 1 (incoherent) to 5 (flawless, ship-ready) as an ' +
    'integer. Always return a single JSON object of the exact shape {"score": <integer 1-5>, ' +
    '"rationale": <string>} and nothing else — no markdown, no surrounding prose.';
  const userPrompt =
    `Theme: "${state.displayName}" (set id "${state.id}").\n` +
    `Authored design language (the fixed standard to judge against): ${state.themeDesignLanguage}\n\n` +
    `Items in this pass, in order: ${order.map((label, i) => `${i + 1}. ${label}`).join('; ')}\n\n` +
    'Judge the collection as a whole against the design language above. Your rationale MUST ' +
    'explicitly address BOTH: (1) overall theme cohesion across every item, and (2) any ' +
    'individual item(s) that read as outliers breaking the design language (name them by ' +
    'label/position, or state plainly that none do).\n\n' +
    'Grounding rules — follow all of them:\n' +
    '- Judge ONLY what is clearly and unambiguously visible. Do NOT infer material or surface ' +
    'properties you cannot directly see — finish, polish, reflectivity, sheen, gloss, ' +
    'weight, temperature, or wear. A normal metallic highlight on a small sprite is not ' +
    '"polished" or "reflective"; matte-vs-glossy is usually indeterminable at this scale, so ' +
    'do not treat it as a defect.\n' +
    "- Do NOT penalize an item's inherent, correct form. A bow is curved, a blade tapers, a " +
    'ring is round, an axe has a wide head — these are the natural shapes of the objects and ' +
    'are NOT deviations unless the design language explicitly forbids them.\n' +
    '- Flag an item as an outlier ONLY when it clearly and specifically contradicts a stated ' +
    'clause of the authored design language above. Name the clause it violates and the ' +
    'visible evidence for it. If you cannot point to a specific violated clause backed by ' +
    'something you can actually see, do NOT flag it.\n' +
    '- Minor sprite-scale rendering artifacts and anti-aliasing are not design-language ' +
    'violations.\n\n' +
    'Scoring guidance: the score should reflect the proportion and severity of genuine, ' +
    'clearly-visible deviations. A single minor deviation in an otherwise-cohesive set should ' +
    'not drop the score below 3. Reserve 1-2 for collections where multiple items, or a ' +
    'dominant central item, plainly and visibly break the design language.';
  return { systemInstructions, userPrompt };
}

export interface JudgeThemeEquipmentCollectionWithVisionOptions {
  readonly state: ThemeEquipmentSetState;
  /** Labeled current-phase artifact PNGs to compose into one contact sheet. */
  readonly tiles: readonly ContactSheetTile[];
  readonly provider: VisionProvider;
  /** Env consulted for the CI refusal. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Judge a theme-equipment collection with a vision-capable provider
 * (`sprite-sheets` / `variant-approval` phases). Builds exactly ONE contact
 * sheet from `options.tiles` and sends exactly one `evaluate` call at
 * `temperature: 0` (near-deterministic). Parses the response with Zod and
 * throws `ThemeEquipmentPipelineError('malformed')` on any shape mismatch —
 * a judge never silently downgrades a malformed response into a default
 * score.
 */
export async function judgeThemeEquipmentCollectionWithVision(
  options: JudgeThemeEquipmentCollectionWithVisionOptions,
): Promise<ThemeEquipmentCollectionJudgeResult> {
  const env = options.env ?? process.env;
  refuseUnbypassedCi(env);

  const sheet = buildThemeEquipmentContactSheet(options.tiles);
  const { systemInstructions, userPrompt } = buildCollectionJudgeInstructions(
    options.state,
    sheet.order,
  );

  const request: EvaluateRequest = {
    systemInstructions,
    userPrompt,
    images: [{ png: sheet.png, label: 'contact-sheet' }],
    temperature: 0,
  };
  const response = await options.provider.evaluate(request);

  const parsed = collectionJudgeResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new ThemeEquipmentPipelineError(
      'malformed',
      `Vision collection judge response failed schema validation:\n${issues}\n` +
        `Raw: ${JSON.stringify(response.json).slice(0, 300)}`,
    );
  }

  return {
    score: parsed.data.score,
    rationale: parsed.data.rationale,
    provenance: `vision:${response.modelDeployment}`,
  };
}

/**
 * Narrow text-completion provider interface for the `roster`/`briefs`
 * collection judges, deliberately distinct from `TextProvider`
 * (`./provider/text-types.js`) — that interface's ONLY method,
 * `expandVariations`, brainstorms additional brief variation strings and has
 * no notion of judging a collection. Reusing/misusing it here would force
 * every `TextProvider` implementation to also pretend to be a judge.
 */
export interface ThemeEquipmentTextJudgeProvider {
  /** Deployment name this provider hits — echoed into `provenance`. */
  readonly modelDeployment: string;
  complete(request: {
    readonly systemInstructions: string;
    readonly userPrompt: string;
    readonly temperature: number;
  }): Promise<{ readonly json: unknown; readonly modelDeployment: string }>;
}

export interface JudgeThemeEquipmentCollectionWithTextOptions {
  readonly state: ThemeEquipmentSetState;
  /** Labeled current-phase text summaries (e.g. roster concepts, brief prose). */
  readonly summaries: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  readonly provider: ThemeEquipmentTextJudgeProvider;
  /** Env consulted for the CI refusal. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Judge a theme-equipment collection with a narrow text provider
 * (`roster` / `briefs` phases, where there is no image to look at yet).
 * Same contract as the vision judge otherwise: one call, `temperature: 0`,
 * strict `{score, rationale}` Zod parse, `provenance` stamped with the
 * deployment.
 */
export async function judgeThemeEquipmentCollectionWithText(
  options: JudgeThemeEquipmentCollectionWithTextOptions,
): Promise<ThemeEquipmentCollectionJudgeResult> {
  const env = options.env ?? process.env;
  refuseUnbypassedCi(env);

  const order = options.summaries.map((summary) => summary.label);
  const { systemInstructions, userPrompt: promptPreamble } = buildCollectionJudgeInstructions(
    options.state,
    order,
  );
  const userPrompt =
    `${promptPreamble}\n\nFull item text follows:\n` +
    options.summaries.map((summary) => `--- ${summary.label} ---\n${summary.text}`).join('\n\n');

  const response = await options.provider.complete({
    systemInstructions,
    userPrompt,
    temperature: 0,
  });

  const parsed = collectionJudgeResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new ThemeEquipmentPipelineError(
      'malformed',
      `Text collection judge response failed schema validation:\n${issues}\n` +
        `Raw: ${JSON.stringify(response.json).slice(0, 300)}`,
    );
  }

  return {
    score: parsed.data.score,
    rationale: parsed.data.rationale,
    provenance: `text:${response.modelDeployment}`,
  };
}

// ---------------------------------------------------------------------------
// Atomic publication
// ---------------------------------------------------------------------------

export class ThemeEquipmentPublishError extends Error {
  override readonly name = 'ThemeEquipmentPublishError';
  constructor(
    readonly kind:
      | 'not-complete'
      | 'already-published'
      | 'phase-gates-not-satisfied'
      | 'variant-count-invalid'
      | 'asset-mismatch',
    message: string,
  ) {
    super(message);
  }
}

export interface PublishThemeEquipmentSetOptions {
  /** Repo root git operations run in (the caller's real working tree). */
  readonly repoRoot: string;
  /**
   * Prepared, fully-staged source tree the assets are copied FROM. Callers
   * are responsible for having already written/validated every PNG +
   * manifest/catalog entry here before calling this function — this
   * function's own responsibility starts and ends at the state/asset-shape
   * gates plus the single `runQueueCommit` call.
   */
  readonly sourceRoot: string;
  /** Every asset being published, covering every item's approved variants. */
  readonly assets: readonly CheckinAsset[];
  readonly deps: QueueCommitDeps;
  readonly message: string;
  readonly now: () => Date;
  readonly maxAttempts?: number;
  readonly queueBranch?: QueueCommitOptions['queueBranch'];
  readonly baseBranch?: QueueCommitOptions['baseBranch'];
  readonly remote?: QueueCommitOptions['remote'];
  readonly validateDestination?: QueueCommitOptions['validateDestination'];
}

export interface PublishThemeEquipmentSetResult {
  readonly state: ThemeEquipmentSetState;
  readonly queueResult: Awaited<ReturnType<typeof runQueueCommit>>;
}

/**
 * Build the expected `{briefId}::{variantIndex}` key set from every approved
 * artifact. These are the exact identities returned by the existing sprite
 * run; generated variant indexes can be sparse and synthesized brief ids can
 * differ from the roster item id, so publication must never infer either one
 * from array position.
 */
function expectedApprovedVariantKeys(state: ThemeEquipmentSetState): {
  readonly keys: ReadonlySet<string>;
  readonly reasons: string[];
} {
  const keys = new Set<string>();
  const reasons: string[] = [];

  for (const item of state.items) {
    const approved = item.phases['variant-approval'].artifacts.filter(
      (artifact) => artifact.kind === THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
    );
    if (
      approved.length < THEME_EQUIPMENT_MIN_APPROVED_VARIANTS ||
      approved.length > THEME_EQUIPMENT_MAX_APPROVED_VARIANTS
    ) {
      reasons.push(
        `Item "${item.id}" has ${approved.length} approved-variant artifact(s); publication ` +
          `requires ${THEME_EQUIPMENT_MIN_APPROVED_VARIANTS}-${THEME_EQUIPMENT_MAX_APPROVED_VARIANTS}`,
      );
      continue;
    }
    approved.forEach((artifact) => {
      if (artifact.briefId === undefined || artifact.variantIndex === undefined) {
        reasons.push(
          `Item "${item.id}" approved artifact "${artifact.id}" is missing briefId or variantIndex publication metadata`,
        );
        return;
      }
      const key = `${artifact.briefId}::${artifact.variantIndex}`;
      if (keys.has(key)) {
        reasons.push(
          `Item "${item.id}" approved artifact "${artifact.id}" duplicates publication key "${key}"`,
        );
        return;
      }
      keys.add(key);
    });
  }

  return { keys, reasons };
}

/**
 * Publish a `complete`-phase, still-`held` theme equipment set: validates
 * every gate BEFORE any IO, invokes `runQueueCommit` exactly ONCE with the
 * full combined asset array under the narrow `theme-equipment-publisher`
 * CI capability, and — ONLY after that call resolves successfully — marks
 * the set's publication record `published` via the pure
 * `markThemeEquipmentSetPublished` mutation.
 *
 * On ANY failure (a validation gate, or `runQueueCommit` itself throwing)
 * this function throws without ever having called
 * `markThemeEquipmentSetPublished` — there is no code path that mutates
 * `publication` before the queue commit has already succeeded, so the
 * input state is never left in a partially-published condition.
 */
export async function publishThemeEquipmentSet(
  state: ThemeEquipmentSetState,
  options: PublishThemeEquipmentSetOptions,
): Promise<PublishThemeEquipmentSetResult> {
  // Re-validate the state shape defensively — this function is meant to be
  // the last gate before a real remote mutation, so it never trusts a
  // caller-held reference without re-parsing it.
  const validated = parseThemeEquipmentSetState(state);

  if (validated.phase !== 'complete') {
    throw new ThemeEquipmentPublishError(
      'not-complete',
      `Cannot publish theme set "${validated.id}": phase is "${validated.phase}", not "complete"`,
    );
  }
  if (validated.publication.status !== 'held') {
    throw new ThemeEquipmentPublishError(
      'already-published',
      `Theme set "${validated.id}" publication is already "${validated.publication.status}"`,
    );
  }

  // Re-validate all historical phase gates — re-parsing proves only schema
  // shape. A forged or corrupt state with phase='complete' but null reviews
  // must not reach runQueueCommit.
  const phaseGateErrors: string[] = [];
  for (const phase of THEME_EQUIPMENT_SET_REVIEW_PHASES) {
    for (const item of validated.items) {
      if (item.phases[phase].review.verdict !== 'up') {
        phaseGateErrors.push(`Item "${item.id}" does not have an up review for phase "${phase}"`);
      }
    }
    const phaseReview = validated.phases[phase];
    if (phaseReview.humanReview.verdict !== 'up') {
      phaseGateErrors.push(`Set-level human review is not up for phase "${phase}"`);
    }
    if (phaseReview.collectionJudge === null) {
      phaseGateErrors.push(`Collection judge score is missing for phase "${phase}"`);
    } else if (phaseReview.collectionJudge.score < 3) {
      phaseGateErrors.push(
        `Collection judge score ${phaseReview.collectionJudge.score}/5 is below 3/5 for phase "${phase}"`,
      );
    }
  }
  if (phaseGateErrors.length > 0) {
    throw new ThemeEquipmentPublishError(
      'phase-gates-not-satisfied',
      `Theme set "${validated.id}" has unsatisfied phase gates:\n${phaseGateErrors.join('\n')}`,
    );
  }

  const { keys: expectedKeys, reasons: variantCountReasons } =
    expectedApprovedVariantKeys(validated);
  if (variantCountReasons.length > 0) {
    throw new ThemeEquipmentPublishError(
      'variant-count-invalid',
      `Theme set "${validated.id}" is not publishable:\n${variantCountReasons.join('\n')}`,
    );
  }

  const actualKeys = options.assets.map((asset) => `${asset.briefId}::${asset.variantIndex}`);
  const actualKeySet = new Set(actualKeys);
  const mismatchReasons: string[] = [];
  if (actualKeySet.size !== actualKeys.length) {
    mismatchReasons.push(
      `Asset list contains duplicate (briefId, variantIndex) entries: ` +
        `${actualKeys.length} assets but only ${actualKeySet.size} distinct keys`,
    );
  }
  if (actualKeySet.size !== expectedKeys.size) {
    mismatchReasons.push(
      `Expected exactly ${expectedKeys.size} approved-variant asset(s), got ${actualKeySet.size} ` +
        `distinct asset(s)`,
    );
  }
  for (const expected of expectedKeys) {
    if (!actualKeySet.has(expected)) {
      const [itemId, variantIndex] = expected.split('::');
      mismatchReasons.push(
        `Missing asset for item "${itemId}" approved-variant index ${variantIndex} ` +
          `(expected the exact briefId and source-run variantIndex recorded on the approved artifact)`,
      );
    }
  }
  for (const actual of actualKeySet) {
    if (!expectedKeys.has(actual)) {
      const [itemId, variantIndex] = actual.split('::');
      mismatchReasons.push(
        `Unexpected asset with briefId "${itemId}" variantIndex ${variantIndex}: no matching ` +
          `approved-variant artifact at that position`,
      );
    }
  }
  if (mismatchReasons.length > 0) {
    throw new ThemeEquipmentPublishError(
      'asset-mismatch',
      `Theme set "${validated.id}" asset list does not match its approved variants:\n` +
        mismatchReasons.join('\n'),
    );
  }

  const queueResult = await runQueueCommit(options.repoRoot, options.assets, options.deps, {
    message: options.message,
    sourceRoot: options.sourceRoot,
    maxAttempts: options.maxAttempts,
    queueBranch: options.queueBranch,
    baseBranch: options.baseBranch,
    remote: options.remote,
    validateDestination: options.validateDestination,
    ciAuthorization: { caller: 'theme-equipment-publisher' },
  });

  const mutation = markThemeEquipmentSetPublished(validated, {
    publishedAt: options.now().toISOString(),
    queueCommit: queueResult.commit ?? null,
  });
  if (!mutation.ok) {
    // Unreachable in practice (we just checked phase/publication above and
    // never mutated `validated` in between), but fail loudly rather than
    // silently swallow a would-be gate rejection after a real side effect
    // already landed.
    throw new ThemeEquipmentPublishError(
      'already-published',
      `Publication mutation was unexpectedly rejected after a successful queue commit: ` +
        mutation.reasons.map((reason) => reason.message).join('; '),
    );
  }

  return { state: mutation.state, queueResult };
}
