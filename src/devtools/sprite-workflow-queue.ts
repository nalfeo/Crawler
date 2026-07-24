/**
 * Pure state machine for the DevTools sprite-generation workflow queue.
 *
 * The queue is the single source of truth for the string-driven workflow: each
 * item carries a one-line brief, its resolved sprite type, and every artifact
 * produced as it advances from a raw idea to a tagged catalog sprite. All
 * functions here are pure and DOM-free so they can be unit tested and so the
 * UI layer (`devtools-main.ts`) can persist/restore state across refreshes.
 */

export const SPRITE_TYPES = [
  'weapon',
  'equipment',
  'enemy',
  'item',
  'prop',
  'tile',
  'vfx',
  'character',
] as const;
export type SpriteType = (typeof SPRITE_TYPES)[number];

/** A requested type may be `auto`, in which case synthesis infers the type. */
export type RequestedType = SpriteType | 'auto';

/**
 * Output size variants. A sprite's *type* fixes a square house-style footprint;
 * the size variant scales that footprint independently — `default` (1×1),
 * `wide` (2×1), `tall` (1×2), `large` (2×2). Mirrors the canonical list in
 * `scripts/sprites/size-variants.ts`, kept local so the devtools (`src/`) layer
 * does not import across the `src/` ↔ `scripts/` boundary.
 */
export const SIZE_VARIANTS = ['default', 'wide', 'tall', 'large'] as const;
export type SizeVariant = (typeof SIZE_VARIANTS)[number];
export const DEFAULT_SIZE_VARIANT: SizeVariant = 'default';

export function isSizeVariant(value: unknown): value is SizeVariant {
  return typeof value === 'string' && (SIZE_VARIANTS as readonly string[]).includes(value);
}

/**
 * Lifecycle stages for a single queue item. `*-ing` stages are transient
 * "busy" states held while a sidecar request is in flight. The flow is
 * Synthesize → Choose → Generate (raw sheet only) → PostProcess → Judge →
 * Approve → (optional) Check in → Tag; brief promotion folds into the
 * Choose→Generate transition, so there is no standalone Promote stage.
 */
const WORKFLOW_STAGES = [
  'draft',
  'synthesizing',
  'candidates',
  'generating',
  'sheet',
  'postprocessing',
  'postprocessed',
  'judging',
  'variants',
  'approved',
  'checked-in',
  'tagging',
  'done',
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/** Human-facing milestone steps shown in the per-item stepper. */
const STEP_LABELS = [
  'Synthesize',
  'Choose',
  'Generate',
  'PostProcess',
  'Judge',
  'Approve',
  'Tag',
] as const;

/** Index of the active stepper milestone for a given stage (7 === all done). */
const STAGE_ACTIVE_STEP: Readonly<Record<WorkflowStage, number>> = {
  draft: 0,
  synthesizing: 0,
  candidates: 1,
  generating: 2,
  sheet: 3,
  postprocessing: 3,
  postprocessed: 4,
  judging: 4,
  variants: 5,
  approved: 6,
  'checked-in': 6,
  tagging: 6,
  done: 7,
};

const BUSY_STAGES: ReadonlySet<WorkflowStage> = new Set<WorkflowStage>([
  'synthesizing',
  'generating',
  'postprocessing',
  'judging',
  'tagging',
]);

export interface QueueSynthCandidate {
  readonly id: string;
  readonly yamlPath: string;
  readonly description: string;
  readonly yaml: string;
}

/**
 * Per-axis VLM judge summary, persisted alongside each run candidate so the
 * advisory scores (and the human-override decision they inform) survive a
 * refresh or restart.
 */
export interface QueueJudgeSummary {
  readonly passed: boolean;
  readonly minScore: number;
  readonly designLanguage?: number;
  readonly referenceStyleMatch?: number;
  readonly styleMatch: number;
  readonly briefMatch: number;
  readonly readability: number;
  readonly rejectedBy: readonly string[];
}

/**
 * One sensor's result for a run candidate, persisted so the PostProcess/Judge
 * stages can surface WHICH sensors failed and why after a refresh — not just a
 * pass/fail tally. Mirrors `SensorResult` from the sprite pipeline
 * (`scripts/sprites/sensors/common.ts`): `ok` is the pass flag, `reason` is the
 * stable short failure string (null when the sensor passed), and `pixelCount`
 * is the optional count of offending pixels as a lightweight magnitude hint.
 */
export interface QueueSensorResult {
  readonly sensor: string;
  readonly ok: boolean;
  readonly reason: string | null;
  readonly pixelCount: number | null;
}

export interface QueueRunCandidate {
  readonly index: number;
  readonly score: number;
  readonly outOf: number;
  readonly passed: boolean;
  readonly combinedPassed: boolean;
  /** Advisory judge axis scores. Null when the judge was disabled/skipped. */
  readonly judge: QueueJudgeSummary | null;
  /**
   * Per-sensor pass/fail breakdown mirrored from the candidate scorecard, so the
   * PostProcess/Judge UI can show which sensors failed and why. Empty when the
   * sidecar summary carried no breakdown (e.g. older runs).
   */
  readonly sensors: readonly QueueSensorResult[];
}

export interface QueueRun {
  readonly briefId: string;
  readonly runId: string;
  readonly candidates: QueueRunCandidate[];
}

export interface QueueItem {
  readonly id: string;
  readonly seq: number;
  /**
   * Short human name, e.g. "Purple Potion". Slugified into `kebabName` (the
   * brief id / asset identity). Kept separate from `brief` so a more
   * descriptive one-liner can be supplied without bloating the asset id.
   */
  name: string;
  /**
   * One-line description fed to synthesis as extra direction, e.g. "a corked
   * glass vial of glowing purple liquid with a cork stopper". Optional — empty
   * when the name alone is enough. Never embedded in `kebabName`.
   */
  brief: string;
  requestedType: RequestedType;
  /**
   * Output size variant baked into the synthesized brief — scales the per-type
   * default footprint (see {@link SIZE_VARIANTS}). Chosen in the composer before
   * Synthesize and sent to the sidecar so the candidate YAML carries it.
   */
  sizeVariant: SizeVariant;
  resolvedType: SpriteType | null;
  /** Kebab-case slug derived from the name, used as the brief id. */
  kebabName: string;
  stage: WorkflowStage;
  source: 'manual' | 'asset-plan';
  candidates: QueueSynthCandidate[];
  chosenCandidatePath: string | null;
  briefPath: string | null;
  run: QueueRun | null;
  generationRequestedAt: string | null;
  /**
   * ISO timestamp marking when the *client* kicked off generation. Unlike
   * `generationRequestedAt` (the server-assigned enqueue time used for run
   * matching), this is set the instant the Generate button is pressed for both
   * the synchronous and queued paths, so the UI can show a live elapsed timer
   * that survives a page reload. Null whenever the item is not generating.
   */
  generationStartedAt: string | null;
  approvedAssetPath: string | null;
  approvalSummary: string | null;
  checkinBranch: string | null;
  checkinIssueUrl: string | null;
  checkinIssueTitle: string | null;
  checkinIssueBody: string | null;
  checkinSummary: string | null;
  metadataSummary: string | null;
  lastError: string | null;
}

export interface QueueState {
  items: QueueItem[];
  selectedId: string | null;
  nextSeq: number;
}

export const QUEUE_STORAGE_KEY = 'crawler.devtools.sprite-workflow-queue.v1';

export function createEmptyQueue(): QueueState {
  return { items: [], selectedId: null, nextSeq: 1 };
}

/** Normalise an arbitrary brief into a kebab-case slug (≤64 chars). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function isSpriteType(value: unknown): value is SpriteType {
  return typeof value === 'string' && (SPRITE_TYPES as readonly string[]).includes(value);
}

function isRequestedType(value: unknown): value is RequestedType {
  return value === 'auto' || isSpriteType(value);
}

function makeItem(
  seq: number,
  name: string,
  brief: string,
  requestedType: RequestedType,
  source: QueueItem['source'],
): QueueItem {
  const trimmedName = name.trim();
  const trimmedBrief = brief.trim();
  // The slug (identity) comes from the name; fall back to the brief when a
  // caller supplied only a one-liner (e.g. asset-plan import with no name).
  const slugSource = trimmedName !== '' ? trimmedName : trimmedBrief;
  return {
    id: `item-${seq}`,
    seq,
    name: trimmedName !== '' ? trimmedName : trimmedBrief,
    brief: trimmedBrief,
    requestedType,
    sizeVariant: DEFAULT_SIZE_VARIANT,
    resolvedType: requestedType === 'auto' ? null : requestedType,
    kebabName: slugify(slugSource),
    stage: 'draft',
    source,
    candidates: [],
    chosenCandidatePath: null,
    briefPath: null,
    run: null,
    generationRequestedAt: null,
    generationStartedAt: null,
    approvedAssetPath: null,
    approvalSummary: null,
    checkinBranch: null,
    checkinIssueUrl: null,
    checkinIssueTitle: null,
    checkinIssueBody: null,
    checkinSummary: null,
    metadataSummary: null,
    lastError: null,
  };
}

/**
 * Append a new item built from a name (+ optional one-line brief) and select
 * it. Returns the state unchanged when neither field normalises to a valid
 * slug. `brief` is extra synthesis direction and is never part of the slug.
 */
export function addItem(
  state: QueueState,
  name: string,
  brief = '',
  requestedType: RequestedType = 'auto',
  source: QueueItem['source'] = 'manual',
): QueueState {
  const slugSource = name.trim() !== '' ? name : brief;
  if (slugify(slugSource) === '') {
    return state;
  }
  const item = makeItem(state.nextSeq, name, brief, requestedType, source);
  return {
    items: [...state.items, item],
    selectedId: item.id,
    nextSeq: state.nextSeq + 1,
  };
}

export function updateItem(state: QueueState, id: string, patch: Partial<QueueItem>): QueueState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    changed = true;
    return { ...item, ...patch };
  });
  if (!changed) return state;
  return { ...state, items };
}

export function removeItem(state: QueueState, id: string): QueueState {
  const items = state.items.filter((item) => item.id !== id);
  if (items.length === state.items.length) return state;
  const selectedId =
    state.selectedId === id ? (items[items.length - 1]?.id ?? null) : state.selectedId;
  return { ...state, items, selectedId };
}

export function selectItem(state: QueueState, id: string | null): QueueState {
  if (id !== null && !state.items.some((item) => item.id === id)) return state;
  if (state.selectedId === id) return state;
  return { ...state, selectedId: id };
}

export function clearQueue(state: QueueState): QueueState {
  return { items: [], selectedId: null, nextSeq: state.nextSeq };
}

export function getSelectedItem(state: QueueState): QueueItem | null {
  return state.items.find((item) => item.id === state.selectedId) ?? null;
}

export function getItem(state: QueueState, id: string): QueueItem | null {
  return state.items.find((item) => item.id === id) ?? null;
}

export function stageActiveStep(stage: WorkflowStage): number {
  return STAGE_ACTIVE_STEP[stage];
}

export function isBusyStage(stage: WorkflowStage): boolean {
  return BUSY_STAGES.has(stage);
}

export type StepStatus = 'done' | 'active' | 'todo';

export interface StepperCell {
  readonly label: string;
  readonly status: StepStatus;
  readonly busy: boolean;
}

/** Compute the stepper presentation for an item's current stage. */
export function stepperFor(stage: WorkflowStage): StepperCell[] {
  const active = stageActiveStep(stage);
  const busy = isBusyStage(stage);
  return STEP_LABELS.map((label, index) => {
    let status: StepStatus;
    if (index < active) status = 'done';
    else if (index === active) status = 'active';
    else status = 'todo';
    return { label, status, busy: busy && status === 'active' };
  });
}

/** Label for the primary contextual action available at a stage, if any. */
export function primaryActionLabel(stage: WorkflowStage): string | null {
  switch (stage) {
    case 'draft':
      return 'Synthesize';
    case 'candidates':
      return 'Generate run';
    case 'sheet':
      return 'PostProcess';
    case 'postprocessed':
      return 'Judge';
    case 'approved':
    case 'checked-in':
      return 'Tag (generate metadata)';
    default:
      return null;
  }
}

/** Inputs needed to describe a freshly-approved (or already-approved) variant. */
export interface ApprovedVariantInfo {
  readonly briefId: string;
  readonly variantIndex: number;
  /** `generated/<briefId>-var-<index>.png` — the catalog asset path. */
  readonly assetPath: string;
  /**
   * Sensor score string from the approve response, e.g. `"6/7"`. Omitted on the
   * already-approved (sidecar 409) path, which has no fresh response body.
   */
  readonly sensorScore?: string;
  readonly judgeScore?: string | null;
  /** The variant was approved past a judge rejection ("Approve anyway"). */
  readonly judgeOverride?: boolean;
  /**
   * The sidecar reported this exact variant is already in the catalog with
   * byte-identical content (HTTP 409). Still a valid approved state — it must
   * advance the item to `approved` so Tag unlocks rather than dead-end.
   */
  readonly alreadyApproved?: boolean;
  /**
   * The sidecar's durable `assets/queue` push failed after the catalog write
   * succeeded (PR1). When true, the approval summary carries a persistent warning
   * so the operator keeps the worktree until the edit is durable.
   */
  readonly queueCommitFailed?: boolean;
  /** Human-readable reason for the failed queue push, when available. */
  readonly queueCommitError?: string;
}

/** Fields an approval writes onto a queue item (advancing it to `approved`). */
export interface ApprovedItemPatch {
  readonly stage: 'approved';
  readonly approvedAssetPath: string;
  readonly approvalSummary: string;
  readonly checkinBranch: null;
  readonly checkinIssueUrl: null;
  readonly checkinIssueTitle: null;
  readonly checkinIssueBody: null;
  readonly checkinSummary: null;
  readonly generationRequestedAt: null;
  readonly lastError: null;
}

/**
 * Build the queue patch that advances an item into the `approved` stage once a
 * variant is in the catalog. Shared by the fresh-approval path **and** the
 * already-approved (sidecar 409) path: an already-approved variant is genuinely
 * approved, so re-approving it must still unlock Tag instead of dead-ending on
 * the Approve step (which left operators unable to reach Tag/Done). Pure so the
 * transition is unit-testable without a DOM or a live sidecar.
 */
export function approvedItemPatch(info: ApprovedVariantInfo): ApprovedItemPatch {
  let approvalSummary: string;
  if (info.alreadyApproved) {
    approvalSummary =
      `Variant ${info.briefId}-var-${info.variantIndex} is already approved with identical ` +
      `content -> ${info.assetPath}. Tag to add catalog metadata, or re-post-process to ` +
      'change the image first.';
  } else {
    const overrideSuffix = info.judgeOverride ? ' (judge override)' : '';
    const scoreSuffix =
      info.sensorScore === undefined
        ? ''
        : ` (${info.sensorScore}${info.judgeScore ? `, judge ${info.judgeScore}` : ''})`;
    approvalSummary =
      `Approved ${info.briefId} variant ${info.variantIndex}${overrideSuffix} -> ` +
      `${info.assetPath}${scoreSuffix}. Now Tag to add catalog metadata.`;
  }
  if (info.queueCommitFailed) {
    approvalSummary +=
      ' \u26a0 Durable queue push FAILED \u2014 keep this worktree; the approval is not yet ' +
      'safe across sessions' +
      (info.queueCommitError ? ` (${info.queueCommitError})` : '') +
      '.';
  }
  return {
    stage: 'approved',
    approvedAssetPath: info.assetPath,
    approvalSummary,
    checkinBranch: null,
    checkinIssueUrl: null,
    checkinIssueTitle: null,
    checkinIssueBody: null,
    checkinSummary: null,
    generationRequestedAt: null,
    lastError: null,
  };
}

// ── Restart points (Brief / Sheet) ───────────────────────────────────────────
// Pure transitions that rewind an item to one of the two operator-facing
// restart points. They return a `Partial<QueueItem>` patch for `updateItem`, so
// the UI never has to know which fields a restart clears. Kept here so the
// reset semantics are unit-testable without a DOM or a live sidecar.

/**
 * Rewind an item to the **Brief** step (Synthesize / Choose). Clears every
 * artifact produced from synthesis onward — candidates, the chosen brief, the
 * generated sheet/run, and all approval/metadata — but keeps the operator's
 * `name`, `brief`, and `requestedType` so they can re-synthesize from scratch.
 * `resolvedType` resets to the requested type (null when auto) since a
 * re-synthesis may reclassify.
 */
export function restartToBriefPatch(item: QueueItem): Partial<QueueItem> {
  return {
    stage: 'draft',
    resolvedType: item.requestedType === 'auto' ? null : item.requestedType,
    candidates: [],
    chosenCandidatePath: null,
    briefPath: null,
    run: null,
    generationRequestedAt: null,
    generationStartedAt: null,
    approvedAssetPath: null,
    approvalSummary: null,
    checkinBranch: null,
    checkinIssueUrl: null,
    checkinIssueTitle: null,
    checkinIssueBody: null,
    checkinSummary: null,
    metadataSummary: null,
    lastError: null,
  };
}

/**
 * Rewind an item to the **Sheet** step. The generated sheet (`run`) is the
 * expensive AI artifact, so it is preserved and the item lands at `sheet` —
 * PostProcess becomes the next action and re-uses the existing sheet by default
 * (OpenAI is only called again on an explicit Generate). Every post-sheet
 * artifact (approval/metadata) is cleared. When no run exists to reuse, falls
 * back to the earliest stage that can still produce a sheet: `candidates` when a
 * brief/choice is present, else `draft`.
 */
export function restartToSheetPatch(item: QueueItem): Partial<QueueItem> {
  const hasSheet = item.run !== null;
  const canGenerate = item.chosenCandidatePath !== null || item.briefPath !== null;
  const stage: WorkflowStage = hasSheet ? 'sheet' : canGenerate ? 'candidates' : 'draft';
  return {
    stage,
    generationRequestedAt: null,
    generationStartedAt: null,
    approvedAssetPath: null,
    approvalSummary: null,
    checkinBranch: null,
    checkinIssueUrl: null,
    checkinIssueTitle: null,
    checkinIssueBody: null,
    checkinSummary: null,
    metadataSummary: null,
    lastError: null,
  };
}

// ── Sensor-failure presentation + force-judge eligibility (PR2c) ──────────────
// Pure, DOM-free helpers the devtools UI uses to render WHICH sensors failed and
// why (not just a pass/fail tally) and to decide when the "force judge" override
// (which judges past a failing sensor gate) is offered. Kept here so the
// rendering/wiring logic is unit-testable without a DOM.

/** The sensors on a candidate that did not pass. Preserves source order. */
export function failingSensors(candidate: QueueRunCandidate): QueueSensorResult[] {
  return candidate.sensors.filter((sensor) => !sensor.ok);
}

/**
 * One-line human label for a single sensor result, e.g.
 *   `transparency: bg-not-transparent (1234px)` — failed, with reason + the
 *     optional pixelCount magnitude hint.
 *   `silhouette: passed`                         — passed.
 * A failed sensor with no `reason` falls back to `failed`; the `(Npx)` hint is
 * appended only when `pixelCount` is present.
 */
export function formatSensorResult(sensor: QueueSensorResult): string {
  if (sensor.ok) return `${sensor.sensor}: passed`;
  const reason = sensor.reason ?? 'failed';
  const magnitude = sensor.pixelCount !== null ? ` (${sensor.pixelCount}px)` : '';
  return `${sensor.sensor}: ${reason}${magnitude}`;
}

/** A candidate's sensor outcome condensed for the variant card header. */
export interface SensorSummary {
  /** Total sensors that ran for the candidate. */
  readonly total: number;
  /** How many of them failed. */
  readonly failed: number;
  /** `formatSensorResult` labels for the failing sensors, in source order. */
  readonly failingLabels: readonly string[];
}

/**
 * Summarise a candidate's sensors for the UI, or `null` when no sensor detail
 * is available (older runs persisted an empty `sensors[]`) so the caller can
 * omit the block entirely rather than render an empty "0 sensors" line.
 */
export function sensorSummary(candidate: QueueRunCandidate): SensorSummary | null {
  if (candidate.sensors.length === 0) return null;
  const failing = failingSensors(candidate);
  return {
    total: candidate.sensors.length,
    failed: failing.length,
    failingLabels: failing.map(formatSensorResult),
  };
}

/**
 * A candidate is eligible for a per-variant "force judge" override when it has
 * at least one failing sensor (so the normal sensor gate would skip it) and it
 * is not already a combined pass. The override judges it anyway via the judge
 * endpoint's `force` flag scoped to this `variantIndexes`.
 */
export function candidateForceEligible(candidate: QueueRunCandidate): boolean {
  return !candidate.combinedPassed && candidate.sensors.some((sensor) => !sensor.ok);
}

/**
 * Whether a run has any candidate the normal judge would gate out on a failing
 * sensor — i.e. whether the run-level "Force judge (ignore sensor gate)"
 * override is worth offering.
 */
export function runHasSensorFailures(run: QueueRun): boolean {
  return run.candidates.some(candidateForceEligible);
}

/** Coarse pipeline outcome used to label a variant card. */
export type CandidateStatusKind = 'pass' | 'sensor-failed' | 'judge-rejected' | 'unjudged';

export interface CandidateStatus {
  readonly kind: CandidateStatusKind;
  /** Short human label for the card header (e.g. `judge fail`). */
  readonly label: string;
}

/**
 * Minimal candidate shape the status derivation needs. Both the persisted
 * `QueueRunCandidate` and the devtools `WorkflowRunCandidate` satisfy it
 * structurally, so the UI and the pure tests share one classifier.
 */
export interface CandidateStatusInput {
  /** Sensor gate result — authoritative, independent of per-sensor detail. */
  readonly passed: boolean;
  /** Combined sensor + judge gate. */
  readonly combinedPassed: boolean;
  /** Judge verdict, or null when the judge did not run for this candidate. */
  readonly judge: { readonly passed: boolean } | null;
}

/**
 * Classify a candidate for the variant card. Distinguishes the four real states
 * so the UI never mislabels a sensor-passing-but-unjudged variant as a sensor
 * failure:
 *   - `pass`           — cleared the combined sensor + judge gate.
 *   - `sensor-failed`  — a sensor gate failed (red).
 *   - `judge-rejected` — sensors passed but the judge rejected it (red).
 *   - `unjudged`       — sensors passed and no judge verdict exists yet (neutral,
 *                        NOT a failure). Reached when the judge was capped,
 *                        budget-skipped, disabled, or simply not run.
 *
 * Uses the authoritative `passed` sensor flag rather than re-deriving from the
 * per-sensor list, so it stays correct for older runs that persisted an empty
 * `sensors[]`.
 */
export function candidateStatus(candidate: CandidateStatusInput): CandidateStatus {
  if (candidate.combinedPassed) return { kind: 'pass', label: 'PASS' };
  if (!candidate.passed) return { kind: 'sensor-failed', label: 'sensor fail' };
  if (candidate.judge && !candidate.judge.passed) {
    return { kind: 'judge-rejected', label: 'judge fail' };
  }
  return { kind: 'unjudged', label: 'not judged' };
}

/**
 * Why a candidate carries no judge verdict, phrased for an operator. `reason` is
 * the sidecar's `judgeSkipReason` for the variant (null when the judge ran or
 * the field is absent); `judged` is whether a scorecard exists. Returns null
 * when there is nothing to explain (the candidate WAS judged).
 */
export function describeJudgeSkipReason(reason: string | null, judged: boolean): string | null {
  if (judged) return null;
  switch (reason) {
    case 'sensor-failed':
      return 'Not judged — this run used legacy sensor-gated judging.';
    case 'over-cap':
      return 'Not judged — only the top variants (by sensor score) are judged to bound cost. Raise the brief’s judge.maxVariants to judge more.';
    case 'over-budget':
      return 'Not judged — the run’s judge budget was exhausted.';
    case 'judge-disabled':
      return 'Not judged — judging is disabled for this brief.';
    default:
      return 'Not judged yet — run Judge to score this variant.';
  }
}

export function serializeQueue(state: QueueState): string {
  return JSON.stringify(state);
}

function sanitizeJudgeSummary(value: unknown): QueueJudgeSummary | null {
  if (!value || typeof value !== 'object') return null;
  const j = value as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    passed: j.passed === true,
    minScore: num(j.minScore),
    ...(typeof j.designLanguage === 'number' ? { designLanguage: num(j.designLanguage) } : {}),
    ...(typeof j.referenceStyleMatch === 'number'
      ? { referenceStyleMatch: num(j.referenceStyleMatch) }
      : {}),
    styleMatch: num(j.styleMatch ?? j.referenceStyleMatch),
    briefMatch: num(j.briefMatch),
    readability: num(j.readability),
    rejectedBy: Array.isArray(j.rejectedBy)
      ? j.rejectedBy.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

function sanitizeSensorResults(value: unknown): QueueSensorResult[] {
  if (!Array.isArray(value)) return [];
  const out: QueueSensorResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.sensor !== 'string') continue;
    out.push({
      sensor: s.sensor,
      ok: s.ok === true,
      reason: typeof s.reason === 'string' ? s.reason : null,
      pixelCount:
        typeof s.pixelCount === 'number' && Number.isFinite(s.pixelCount) ? s.pixelCount : null,
    });
  }
  return out;
}

function sanitizeRunCandidate(value: unknown): QueueRunCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.index !== 'number') return null;
  return {
    index: c.index,
    score: typeof c.score === 'number' ? c.score : 0,
    outOf: typeof c.outOf === 'number' ? c.outOf : 0,
    passed: c.passed === true,
    combinedPassed: c.combinedPassed === true,
    judge: sanitizeJudgeSummary(c.judge),
    sensors: sanitizeSensorResults(c.sensors),
  };
}

function sanitizeRun(value: unknown): QueueRun | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.briefId !== 'string' || typeof r.runId !== 'string') return null;
  const candidates = Array.isArray(r.candidates)
    ? r.candidates.map(sanitizeRunCandidate).filter((c): c is QueueRunCandidate => c !== null)
    : [];
  return { briefId: r.briefId, runId: r.runId, candidates };
}

function sanitizeSynthCandidate(value: unknown): QueueSynthCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.yamlPath !== 'string') return null;
  return {
    id: c.id,
    yamlPath: c.yamlPath,
    description: typeof c.description === 'string' ? c.description : '',
    yaml: typeof c.yaml === 'string' ? c.yaml : '',
  };
}

function sanitizeItem(value: unknown): QueueItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.seq !== 'number' || typeof raw.brief !== 'string') return null;
  const stage = (WORKFLOW_STAGES as readonly string[]).includes(raw.stage as string)
    ? (raw.stage as WorkflowStage)
    : 'draft';
  const requestedType = isRequestedType(raw.requestedType) ? raw.requestedType : 'auto';
  // Back-compat: items persisted before the name/brief split carry only
  // `brief`. Derive `name` from the stored name when present, else fall back to
  // the brief so the slug/identity is unchanged. `kebabName` is preserved
  // as-stored, so no asset identity migrates.
  const brief = raw.brief;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : brief;
  return {
    id: typeof raw.id === 'string' ? raw.id : `item-${raw.seq}`,
    seq: raw.seq,
    name,
    brief,
    requestedType,
    sizeVariant: isSizeVariant(raw.sizeVariant) ? raw.sizeVariant : DEFAULT_SIZE_VARIANT,
    resolvedType: isSpriteType(raw.resolvedType) ? raw.resolvedType : null,
    kebabName: typeof raw.kebabName === 'string' ? raw.kebabName : slugify(name),
    stage,
    source: raw.source === 'asset-plan' ? 'asset-plan' : 'manual',
    candidates: Array.isArray(raw.candidates)
      ? raw.candidates
          .map(sanitizeSynthCandidate)
          .filter((c): c is QueueSynthCandidate => c !== null)
      : [],
    chosenCandidatePath:
      typeof raw.chosenCandidatePath === 'string' ? raw.chosenCandidatePath : null,
    briefPath: typeof raw.briefPath === 'string' ? raw.briefPath : null,
    run: sanitizeRun(raw.run),
    generationRequestedAt:
      typeof raw.generationRequestedAt === 'string' ? raw.generationRequestedAt : null,
    generationStartedAt:
      typeof raw.generationStartedAt === 'string' ? raw.generationStartedAt : null,
    approvedAssetPath: typeof raw.approvedAssetPath === 'string' ? raw.approvedAssetPath : null,
    approvalSummary: typeof raw.approvalSummary === 'string' ? raw.approvalSummary : null,
    checkinBranch: typeof raw.checkinBranch === 'string' ? raw.checkinBranch : null,
    checkinIssueUrl: typeof raw.checkinIssueUrl === 'string' ? raw.checkinIssueUrl : null,
    checkinIssueTitle: typeof raw.checkinIssueTitle === 'string' ? raw.checkinIssueTitle : null,
    checkinIssueBody: typeof raw.checkinIssueBody === 'string' ? raw.checkinIssueBody : null,
    checkinSummary: typeof raw.checkinSummary === 'string' ? raw.checkinSummary : null,
    metadataSummary: typeof raw.metadataSummary === 'string' ? raw.metadataSummary : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
  };
}

/**
 * Roll any interrupted transient step back to its last stable stage.
 *
 * The `*-ing` stages are "busy" states held only while a sidecar request is in
 * flight, backed by an in-memory `AbortController` in the UI layer. That
 * controller never survives a page reload (or an Azure state restore), so an
 * item persisted mid-step would otherwise rehydrate as permanently "in
 * progress" — with no in-flight request to finish it and (for synthesize/tag)
 * not even a Cancel affordance. On load we therefore revert each interrupted
 * step to the stable stage it came from so the user can simply re-trigger it.
 *
 * The sole exception is a *queued* generation (`generating` with a
 * `generationRequestedAt`): that run lives on the server/worker and the UI
 * resumes polling for it on reload, so it is left intact.
 */
export function recoverInterruptedItem(item: QueueItem): QueueItem {
  switch (item.stage) {
    case 'synthesizing':
      // First synth comes from a raw draft; a re-synth already has candidates.
      return { ...item, stage: item.candidates.length > 0 ? 'candidates' : 'draft' };
    case 'generating':
      // A queued run resumes via polling; only the synchronous in-flight POST
      // is orphaned by a reload. Mirror the generate error path back to
      // `candidates`, where Generate is available, and drop the live timer.
      if (item.generationRequestedAt !== null) return item;
      return { ...item, stage: 'candidates', generationStartedAt: null };
    case 'postprocessing':
      // A re-run keeps the already-sliced variants; a first run only has the
      // raw sheet to fall back to.
      return {
        ...item,
        stage: item.run && item.run.candidates.length > 0 ? 'postprocessed' : 'sheet',
      };
    case 'judging':
      // Judging always operates on post-processed variants; land back where
      // Judge and Approve are both available (defensive fallback to `sheet`
      // if the run somehow carries no variants).
      return {
        ...item,
        stage: item.run && item.run.candidates.length > 0 ? 'postprocessed' : 'sheet',
      };
    case 'tagging':
      // Tagging runs after approval/check-in; land back on whichever stable
      // pre-tag state existed so the item does not lose check-in state on refresh.
      return {
        ...item,
        stage: item.metadataSummary ? 'done' : item.checkinIssueUrl ? 'checked-in' : 'approved',
      };
    default:
      return item;
  }
}

/** Parse persisted queue JSON leniently, dropping any malformed items. */
export function deserializeQueue(raw: string | null | undefined): QueueState {
  if (!raw) return createEmptyQueue();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createEmptyQueue();
  }
  if (!parsed || typeof parsed !== 'object') return createEmptyQueue();
  const obj = parsed as Record<string, unknown>;
  const items = Array.isArray(obj.items)
    ? obj.items
        .map(sanitizeItem)
        .filter((item): item is QueueItem => item !== null)
        .map(recoverInterruptedItem)
    : [];
  const maxSeq = items.reduce((max, item) => Math.max(max, item.seq), 0);
  const nextSeq =
    typeof obj.nextSeq === 'number' && obj.nextSeq > maxSeq ? obj.nextSeq : maxSeq + 1;
  const selectedId =
    typeof obj.selectedId === 'string' && items.some((item) => item.id === obj.selectedId)
      ? obj.selectedId
      : (items[items.length - 1]?.id ?? null);
  return { items, selectedId, nextSeq };
}

/**
 * After this much wall-clock time on the *queued* (worker) path with no run
 * adopted yet, the progress line appends a hint that a worker may not be
 * running. Worded as a possibility — a busy worker can legitimately take this
 * long — but it surfaces the single most common cause of an apparent hang
 * (`npm run sprites:worker` was never started).
 */
export const GENERATION_QUEUED_STALL_HINT_MS = 60_000;

/**
 * After this much wall-clock time on the *synchronous* (noop/local) path the
 * progress line warns that the image/vision provider may be slow or
 * unreachable, since that request blocks the whole generate call.
 */
export const GENERATION_SYNC_STALL_HINT_MS = 120_000;

/**
 * Render a coarse elapsed duration like `0s`, `45s`, `2m 13s`, or `1h 03m`.
 * Non-finite or negative inputs clamp to `0s` so a clock skew can never print
 * a nonsense value.
 */
export function formatGenerationElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (totalMinutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

export interface GenerationProgressInput {
  /** Free-text brief, used only for display. */
  readonly brief: string;
  /** Wall-clock ms since generation began (from `generationStartedAt`). */
  readonly elapsedMs: number;
  /**
   * Number of poll attempts so far on the queued path, or `null` for the
   * synchronous path (which makes a single blocking request, no polling).
   */
  readonly pollAttempts: number | null;
  /** Sidecar queue backend (`noop`, `azure-queue`) if known, else null. */
  readonly queueBackend: string | null;
  /**
   * When true, the caller renders a richer, context-specific recovery hint (the
   * in-app "Launch worker" button), so the generic `npm run sprites:worker`
   * stall hint is suppressed to avoid showing two conflicting remediations.
   */
  readonly suppressQueuedStallHint?: boolean;
}

/**
 * Build the human-readable progress message shown while an item is generating.
 * Pure so the messaging (including the stall hints) is unit-testable without a
 * DOM. The UI re-invokes this on a 1s interval to keep the elapsed clock live.
 */
export function describeGenerationProgress(input: GenerationProgressInput): string {
  const elapsed = formatGenerationElapsed(input.elapsedMs);
  const isQueued = input.pollAttempts !== null;
  let line = `⏳ Generating "${input.brief}" — ${elapsed} elapsed`;
  if (isQueued) {
    const backend = input.queueBackend ? `, queue: ${input.queueBackend}` : '';
    line += ` · polled ${input.pollAttempts}×${backend}`;
  }
  if (
    isQueued &&
    input.elapsedMs >= GENERATION_QUEUED_STALL_HINT_MS &&
    !input.suppressQueuedStallHint
  ) {
    line +=
      '\n⚠ No result yet. If this keeps climbing, make sure a worker is running: ' +
      'npm run sprites:worker';
  } else if (!isQueued && input.elapsedMs >= GENERATION_SYNC_STALL_HINT_MS) {
    line +=
      '\n⚠ Still working. The image/vision provider may be slow or unreachable — ' +
      'you can Cancel and retry.';
  }
  return line;
}
