/**
 * Pure state machine for the DevTools sprite-generation workflow queue.
 *
 * The queue is the single source of truth for the string-driven workflow: each
 * item carries a one-line brief, its resolved sprite type, and every artifact
 * produced as it advances from a raw idea to a tagged catalog sprite. All
 * functions here are pure and DOM-free so they can be unit tested and so the
 * UI layer (`devtools-main.ts`) can persist/restore state across refreshes.
 */

export const SPRITE_TYPES = ['weapon', 'enemy', 'item', 'tile', 'vfx', 'character'] as const;
export type SpriteType = (typeof SPRITE_TYPES)[number];

/** A requested type may be `auto`, in which case synthesis infers the type. */
export type RequestedType = SpriteType | 'auto';

/**
 * Lifecycle stages for a single queue item. `*-ing` stages are transient
 * "busy" states held while a sidecar request is in flight.
 */
export const WORKFLOW_STAGES = [
  'draft',
  'synthesizing',
  'candidates',
  'promoting',
  'promoted',
  'generating',
  'variants',
  'approved',
  'tagging',
  'done',
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/** Human-facing milestone steps shown in the per-item stepper. */
export const STEP_LABELS = [
  'Synthesize',
  'Choose',
  'Promote',
  'Generate',
  'Approve',
  'Tag',
] as const;

/** Index of the active stepper milestone for a given stage (6 === all done). */
const STAGE_ACTIVE_STEP: Readonly<Record<WorkflowStage, number>> = {
  draft: 0,
  synthesizing: 0,
  candidates: 1,
  promoting: 2,
  promoted: 3,
  generating: 3,
  variants: 4,
  approved: 5,
  tagging: 5,
  done: 6,
};

const BUSY_STAGES: ReadonlySet<WorkflowStage> = new Set<WorkflowStage>([
  'synthesizing',
  'promoting',
  'generating',
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
  /** Raw free-text brief, e.g. "Purple Potion Bottle". */
  brief: string;
  requestedType: RequestedType;
  resolvedType: SpriteType | null;
  /** Kebab-case slug derived from the brief, used as the brief id. */
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
  brief: string,
  requestedType: RequestedType,
  source: QueueItem['source'],
): QueueItem {
  const trimmed = brief.trim();
  return {
    id: `item-${seq}`,
    seq,
    brief: trimmed,
    requestedType,
    resolvedType: requestedType === 'auto' ? null : requestedType,
    kebabName: slugify(trimmed),
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
    metadataSummary: null,
    lastError: null,
  };
}

/**
 * Append a new item built from a free-text brief and select it. Returns the
 * state unchanged when the brief does not normalise to a valid slug.
 */
export function addItem(
  state: QueueState,
  brief: string,
  requestedType: RequestedType = 'auto',
  source: QueueItem['source'] = 'manual',
): QueueState {
  if (slugify(brief) === '') {
    return state;
  }
  const item = makeItem(state.nextSeq, brief, requestedType, source);
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
      return 'Promote chosen candidate';
    case 'promoted':
      return 'Generate run';
    case 'approved':
      return 'Tag (generate metadata)';
    default:
      return null;
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
    styleMatch: num(j.styleMatch),
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
  return {
    id: typeof raw.id === 'string' ? raw.id : `item-${raw.seq}`,
    seq: raw.seq,
    brief: raw.brief,
    requestedType,
    resolvedType: isSpriteType(raw.resolvedType) ? raw.resolvedType : null,
    kebabName: typeof raw.kebabName === 'string' ? raw.kebabName : slugify(raw.brief),
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
    metadataSummary: typeof raw.metadataSummary === 'string' ? raw.metadataSummary : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
  };
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
    ? obj.items.map(sanitizeItem).filter((item): item is QueueItem => item !== null)
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
