/**
 * Durable authoring state for the Workflow canvas.
 *
 * This mirrors the complete DevTools QueueState contract while deliberately
 * retaining unknown fields during normalization. The Azure workflow-state blob
 * is shared with DevTools, so a canvas writer must never truncate stages or
 * fields it does not currently render.
 */

export const WORKFLOW_STAGES = Object.freeze([
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
]);

const SPRITE_TYPES = new Set([
  'weapon',
  'equipment',
  'enemy',
  'item',
  'prop',
  'tile',
  'vfx',
  'character',
]);
const SIZE_VARIANTS = new Set(['default', 'wide', 'tall', 'large']);
const STAGES = new Set(WORKFLOW_STAGES);

export function emptyQueue() {
  return { items: [], selectedId: null, nextSeq: 1 };
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value) {
  return typeof value === 'string' ? value : null;
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || typeof value.yamlPath !== 'string') return null;
  return {
    ...value,
    id: value.id,
    yamlPath: value.yamlPath,
    description: asString(value.description),
    yaml: asString(value.yaml),
  };
}

function normalizeRunCandidate(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.index)) return null;
  return {
    ...value,
    index: value.index,
    score: typeof value.score === 'number' ? value.score : 0,
    outOf: typeof value.outOf === 'number' ? value.outOf : 0,
    passed: value.passed === true,
    combinedPassed: value.combinedPassed === true,
    judge: value.judge && typeof value.judge === 'object' ? value.judge : null,
    sensors: Array.isArray(value.sensors) ? value.sensors : [],
  };
}

function normalizeRun(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.briefId !== 'string' || typeof value.runId !== 'string') return null;
  return {
    ...value,
    briefId: value.briefId,
    runId: value.runId,
    candidates: Array.isArray(value.candidates)
      ? value.candidates.map(normalizeRunCandidate).filter(Boolean)
      : [],
  };
}

export function normalizeItem(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.seq)) return null;
  const brief = asString(value.brief);
  const name = asString(value.name, brief);
  if (!name && !brief) return null;
  const requestedType = SPRITE_TYPES.has(value.requestedType) ? value.requestedType : 'auto';
  return {
    // Keep forward-compatible fields owned by DevTools rather than deleting
    // them during a canvas save to the shared Azure blob.
    ...value,
    id: asString(value.id, `item-${value.seq}`),
    seq: value.seq,
    name,
    brief,
    requestedType,
    sizeVariant: SIZE_VARIANTS.has(value.sizeVariant) ? value.sizeVariant : 'default',
    resolvedType: SPRITE_TYPES.has(value.resolvedType) ? value.resolvedType : null,
    kebabName: asString(value.kebabName, slugify(name)),
    stage: STAGES.has(value.stage) ? value.stage : 'draft',
    source: value.source === 'asset-plan' ? 'asset-plan' : 'manual',
    candidates: Array.isArray(value.candidates)
      ? value.candidates.map(normalizeCandidate).filter(Boolean)
      : [],
    chosenCandidatePath: asNullableString(value.chosenCandidatePath),
    briefPath: asNullableString(value.briefPath),
    run: normalizeRun(value.run),
    generationRequestedAt: asNullableString(value.generationRequestedAt),
    generationStartedAt: asNullableString(value.generationStartedAt),
    approvedAssetPath: asNullableString(value.approvedAssetPath),
    approvalSummary: asNullableString(value.approvalSummary),
    checkinBranch: asNullableString(value.checkinBranch),
    checkinIssueUrl: asNullableString(value.checkinIssueUrl),
    checkinIssueTitle: asNullableString(value.checkinIssueTitle),
    checkinIssueBody: asNullableString(value.checkinIssueBody),
    checkinSummary: asNullableString(value.checkinSummary),
    metadataSummary: asNullableString(value.metadataSummary),
    lastError: asNullableString(value.lastError),
    queueDurability:
      value.queueDurability === 'ok' || value.queueDurability === 'failed'
        ? value.queueDurability
        : null,
  };
}

export function normalizeQueue(value) {
  if (!value || typeof value !== 'object') return emptyQueue();
  const items = Array.isArray(value.items) ? value.items.map(normalizeItem).filter(Boolean) : [];
  const maxSeq = items.reduce((max, item) => Math.max(max, item.seq), 0);
  return {
    items,
    selectedId:
      typeof value.selectedId === 'string' && items.some((item) => item.id === value.selectedId)
        ? value.selectedId
        : (items[items.length - 1]?.id ?? null),
    nextSeq: Number.isInteger(value.nextSeq) && value.nextSeq > maxSeq ? value.nextSeq : maxSeq + 1,
  };
}

export function createRequestItem(state, input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('A short asset name is required.');
  const seq = state.nextSeq;
  const requestedType = SPRITE_TYPES.has(input.type) ? input.type : 'auto';
  return {
    id: `item-${seq}`,
    seq,
    name,
    brief: String(input.brief ?? '').trim(),
    requestedType,
    sizeVariant: SIZE_VARIANTS.has(input.sizeVariant) ? input.sizeVariant : 'default',
    resolvedType: requestedType === 'auto' ? null : requestedType,
    kebabName: slugify(name),
    stage: 'draft',
    source: 'manual',
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
    queueDurability: null,
  };
}

export function addRequest(state, input) {
  const item = createRequestItem(state, input);
  return {
    state: {
      ...state,
      items: [...state.items, item],
      selectedId: item.id,
      nextSeq: item.seq + 1,
    },
    item,
  };
}

export function updateItem(state, itemId, patch) {
  return {
    ...state,
    items: state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
  };
}

export function selectedItem(state) {
  return state.items.find((item) => item.id === state.selectedId) ?? null;
}

export function selectItem(state, itemId) {
  return {
    ...state,
    selectedId: state.items.some((item) => item.id === itemId) ? itemId : state.selectedId,
  };
}

export function toQueueRun(briefId, runId, candidates) {
  return {
    briefId,
    runId,
    candidates: (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
      index: candidate.index,
      score: candidate.score,
      outOf: candidate.outOf,
      passed: candidate.passed,
      combinedPassed: candidate.combinedPassed,
      judge: candidate.judge,
      sensors: candidate.sensors,
    })),
  };
}

function clearApproval() {
  return {
    approvedAssetPath: null,
    approvalSummary: null,
    checkinBranch: null,
    checkinIssueUrl: null,
    checkinIssueTitle: null,
    checkinIssueBody: null,
    checkinSummary: null,
    metadataSummary: null,
    queueDurability: null,
    lastError: null,
  };
}

/** Pointer-only rewind matching DevTools: durable Azure artifacts are retained. */
export function rewindItem(item, target) {
  if (target === 'brief') {
    return {
      ...item,
      stage: 'draft',
      resolvedType: item.requestedType === 'auto' ? null : item.requestedType,
      candidates: [],
      chosenCandidatePath: null,
      briefPath: null,
      run: null,
      generationRequestedAt: null,
      generationStartedAt: null,
      ...clearApproval(),
    };
  }
  if (target === 'sheet') {
    const stage = item.run
      ? 'sheet'
      : item.chosenCandidatePath || item.briefPath
        ? 'candidates'
        : 'draft';
    return {
      ...item,
      stage,
      generationRequestedAt: null,
      generationStartedAt: null,
      ...clearApproval(),
    };
  }
  if (target === 'postprocess') {
    const stage = item.run?.candidates?.length ? 'postprocessed' : item.run ? 'sheet' : 'draft';
    return { ...item, stage, ...clearApproval() };
  }
  throw new Error(`Unknown rewind target: ${target}`);
}

/**
 * Merge exactly one locally-mutated item into a newly-read remote queue.
 * `changedFields` is deliberately a patch rather than a full local item: two
 * clients may advance different fields of the same DevTools item concurrently.
 * Unrelated remote items and unknown fields remain untouched.
 */
export function mergeChangedItem(
  remoteValue,
  localValue,
  itemId,
  changedFields = null,
  { select = false } = {},
) {
  const remote = normalizeQueue(remoteValue);
  const local = normalizeQueue(localValue);
  if (itemId === null) {
    return {
      ...remote,
      selectedId: select ? local.selectedId : remote.selectedId,
      nextSeq: Math.max(remote.nextSeq, local.nextSeq),
    };
  }
  const changed = local.items.find((item) => item.id === itemId);
  if (!changed) throw new Error(`Workflow item ${itemId} is missing from local state.`);
  const index = remote.items.findIndex((item) => item.id === itemId);
  const items = [...remote.items];
  if (index >= 0) items[index] = { ...items[index], ...(changedFields ?? changed) };
  else items.push(changed);
  return {
    items,
    selectedId: select ? local.selectedId : remote.selectedId,
    nextSeq: Math.max(remote.nextSeq, local.nextSeq),
  };
}
