import { ITEM_CATALOG } from './shared/items.js';
import { SPRITES } from './engine/sprites/index.js';
import { renderLaunchContextBanner } from './launch-context-banner.js';
import { DEVTOOLS_INDEX_ENTRIES } from './devtools/index.js';
import {
  ACHIEVEMENT_ART_BACKLOG,
  FLOOR1_ACHIEVEMENTS,
  LOOT_BOX_TIERS,
  type AchievementDef,
  type AchievementReward,
  type LootBoxTier,
} from './shared/achievements.js';
import {
  STATUS_ORDER,
  buildFloorArtPlanReport,
  parseApprovedSprites,
  parseCommittedBriefKeys,
  parseDraftBriefKeys,
  parseFloorArtPlans,
  type FloorArtPlanReport,
  type FloorArtStatus,
} from './devtools/art-plan-model.js';
import { briefKey } from './shared/art-plan-status.js';
import {
  extractVariantIndices,
  fetchLatestRunForBriefSince,
  fetchRunSummary,
  listSidecarRuns,
  deleteSidecarRun,
  postApprove,
  postCheckin,
  prepareCheckin,
  ApproveRequestError,
  CheckinRequestError,
  STALE_SIDECAR_HINT,
  isSidecarRouteMissing,
  type CheckinPrepareResponse,
  type SidecarRunListEntry,
  type SidecarStorageRunEntry,
  type StorageRunEnrichment,
  archiveStorageRuns,
  deleteStorageRunsBatch,
  enrichStorageRuns,
  listStorageRuns,
} from './devtools/sprite-approval-api.js';
import {
  RUN_CACHE_STORAGE_KEY,
  normalizePromotedFilter,
  readRunCache,
  resolveRunPickerSelection,
  writeRunCache,
  type PromotedFilter,
} from './devtools/sprite-run-cache.js';
import { getSpriteSidecarBaseUrl } from './shared/session-server-env.js';
import {
  QUEUE_STORAGE_KEY,
  SPRITE_TYPES,
  SIZE_VARIANTS,
  DEFAULT_SIZE_VARIANT,
  addItem as queueAddItem,
  candidateForceEligible,
  candidateStatus,
  clearQueue as queueClear,
  createEmptyQueue,
  applyMetadataTagResult,
  approvedItemPatch,
  describeGenerationProgress,
  describeJudgeSkipReason,
  deserializeQueue,
  getSelectedItem,
  isBusyStage,
  isSizeVariant,
  primaryActionLabel,
  removeItem as queueRemoveItem,
  restartToBriefPatch,
  restartToSheetPatch,
  runHasSensorFailures,
  selectItem as queueSelectItem,
  sensorSummary,
  serializeQueue,
  slugify,
  stepperFor,
  updateItem as queueUpdateItem,
  type CandidateStatusKind,
  type QueueItem,
  type QueueState,
  type RequestedType,
  type SizeVariant,
  type SpriteType,
  type WorkflowStage,
} from './devtools/sprite-workflow-queue.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SIDECAR_BASE = getSpriteSidecarBaseUrl();
const DEVTOOLS_PAGE_HOME = 'home';
const DEVTOOLS_PAGE_SPRITE_WORKFLOW = 'sprite-generation-workflow';
const DEVTOOLS_PAGE_FLOOR_ART_LEGACY = 'floor-art';
const DEVTOOLS_PAGE_SPRITE_REVIEW = 'sprite-review';
const DEVTOOLS_PAGE_POSTPROCESS = 'postprocess';
const DEVTOOLS_PAGE_ACHIEVEMENTS = 'achievements';
const DEVTOOLS_PAGE_STORAGE = 'storage';
const QUEUED_RUN_POLL_MS = 2000;
type DevtoolsPage =
  | typeof DEVTOOLS_PAGE_HOME
  | typeof DEVTOOLS_PAGE_SPRITE_WORKFLOW
  | typeof DEVTOOLS_PAGE_SPRITE_REVIEW
  | typeof DEVTOOLS_PAGE_POSTPROCESS
  | typeof DEVTOOLS_PAGE_ACHIEVEMENTS
  | typeof DEVTOOLS_PAGE_STORAGE;
const STATUS_COLORS: Readonly<Record<FloorArtStatus, string>> = {
  ready: '#16a34a',
  approved: '#0284c7',
  'approved-not-integrated': '#d97706',
  'approved-missing-file': '#dc2626',
  'brief-ready': '#4f46e5',
  'brief-ready-placeholder': '#7c3aed',
  'draft-ready': '#0f766e',
  'draft-ready-placeholder': '#0d9488',
  'needs-art-placeholder': '#b91c1c',
  planned: '#475569',
};

renderLaunchContextBanner();

// @ts-expect-error Vite provides import.meta.glob at runtime.
const planSources = import.meta.glob('../plans/**/*.art.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// @ts-expect-error Vite provides import.meta.glob at runtime.
const briefSources = import.meta.glob('../briefs/**/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface WorkflowSynthCandidate {
  id: string;
  yamlPath: string;
  description: string;
  yaml: string;
}

interface WorkflowJudgeSummary {
  passed: boolean;
  minScore: number;
  designLanguage: number;
  referenceStyleMatch: number;
  styleMatch: number;
  briefMatch: number;
  readability: number;
  rejectedBy: string[];
}

interface WorkflowSensorResult {
  sensor: string;
  ok: boolean;
  reason: string | null;
  pixelCount: number | null;
}

interface WorkflowRunCandidate {
  index: number;
  score: number;
  outOf: number;
  passed: boolean;
  combinedPassed: boolean;
  judge: WorkflowJudgeSummary | null;
  sensors: WorkflowSensorResult[];
}

/** Raw per-candidate shape returned by the sidecar generate summary. */
interface RawGenerateCandidate {
  index: number;
  score: number;
  outOf: number;
  passed: boolean;
  combinedPassed: boolean;
  judgeScorecard: {
    passed: boolean;
    minScore: number;
    designLanguage?: { score: number };
    referenceStyleMatch?: { score: number };
    styleMatch?: { score: number };
    briefMatch?: { score: number };
    readability?: { score: number };
    rejectedBy?: string[];
  } | null;
  /**
   * Per-sensor breakdown mirrored from the candidate scorecard
   * (`SensorResult[]` from the sprite pipeline). Optional for forward-compat
   * with older sidecar summaries that omitted it.
   */
  breakdown?: Array<{
    ok?: boolean;
    sensor?: string;
    reason?: string;
    pixels?: ReadonlyArray<unknown>;
  }>;
}

function toJudgeSummary(raw: RawGenerateCandidate['judgeScorecard']): WorkflowJudgeSummary | null {
  if (!raw) return null;
  return {
    passed: raw.passed === true,
    minScore: typeof raw.minScore === 'number' ? raw.minScore : 0,
    designLanguage: raw.designLanguage?.score ?? raw.styleMatch?.score ?? 0,
    referenceStyleMatch: raw.referenceStyleMatch?.score ?? raw.styleMatch?.score ?? 0,
    styleMatch: raw.styleMatch?.score ?? raw.referenceStyleMatch?.score ?? 0,
    briefMatch: raw.briefMatch?.score ?? 0,
    readability: raw.readability?.score ?? 0,
    rejectedBy: Array.isArray(raw.rejectedBy) ? raw.rejectedBy : [],
  };
}

function toSensorResults(raw: RawGenerateCandidate['breakdown']): WorkflowSensorResult[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkflowSensorResult[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.sensor !== 'string') continue;
    out.push({
      sensor: entry.sensor,
      ok: entry.ok === true,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      pixelCount: Array.isArray(entry.pixels) ? entry.pixels.length : null,
    });
  }
  return out;
}

interface WorkflowRunState {
  briefId: string;
  runId: string;
  candidates: WorkflowRunCandidate[];
}

interface WorkflowGenerateCompletedResponse {
  status: 'completed';
  briefId: string;
  runId: string;
  summary: { candidates: RawGenerateCandidate[] };
}

interface WorkflowGenerateQueuedResponse {
  status: 'queued';
  briefId: string;
  briefPath: string;
  requestedAt: string;
  queueBackend: string;
}

interface PipelineStepManifest {
  id?: string;
  label?: string;
  file?: string;
}

interface PipelineManifest {
  profile?: string;
  sourceRunId?: string;
  steps?: PipelineStepManifest[];
}

interface SidecarSheetsResponse {
  files: string[];
}

interface AssetRequestManifestEntry {
  key: string;
  issueNumber: number;
  fingerprint: string;
  name: string;
  briefSentence: string;
  state: 'pending' | 'claimed' | 'rejected';
  claimedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  isOpen: boolean;
}

interface AssetRequestManifestResponse {
  entries: AssetRequestManifestEntry[];
}

interface SliceBboxEntry {
  index: number;
  row: number;
  col: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  empty: boolean;
}

interface SliceMapResponse {
  sheetW: number;
  sheetH: number;
  rows: number;
  cols: number;
  cellW: number;
  cellH: number;
  rowOffsets: number[];
  colOffsets: number[];
  cells: SliceBboxEntry[];
  sheetFile: string;
  algorithm?: string;
  /**
   * False when the slice map was computed WITHOUT the brief's `emptyCells`
   * (the brief was unavailable). In that degraded mode cells are renumbered
   * sequentially, so `cell.index` no longer maps to a run's `variantIndex` and
   * must not be trusted for selection / highlight / raw-cell cropping.
   */
  emptyCellsApplied?: boolean;
}

interface PostprocessDebugTarget {
  briefId: string;
  runId: string;
  variantIndex: number;
}

interface PersistedFloorArtWorkflowState {
  selectedAssetId: string | null;
  queuedAssetIds: string[];
  selectedCandidatePath: string | null;
  promotedBriefPath: string | null;
  currentRun: WorkflowRunState | null;
  debugTarget: PostprocessDebugTarget | null;
  oneLinerValue: string;
  selectedPlanId: string | null;
  selectedStatus: string;
  searchQuery: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    readonly text?: string;
    readonly className?: string;
    readonly title?: string;
    readonly style?: Partial<CSSStyleDeclaration>;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  if (options.title !== undefined) node.title = options.title;
  if (options.style) Object.assign(node.style, options.style);
  return node;
}

function spriteUrl(briefId: string, runId: string, filename: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/processed/${encodeURIComponent(filename)}`;
}

function rawSpriteUrl(briefId: string, runId: string, filename: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/raw/${encodeURIComponent(filename)}`;
}

function sheetsUrl(briefId: string, runId: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/sheets`;
}

function sheetUrl(briefId: string, runId: string, filename: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/sheet/${encodeURIComponent(filename)}`;
}

function sliceMapUrl(briefId: string, runId: string, sheetFile?: string): string {
  const query =
    typeof sheetFile === 'string' && sheetFile.length > 0
      ? `?sheet=${encodeURIComponent(sheetFile)}`
      : '';
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/slice-map${query}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail: string;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.message ?? body.error ?? '';
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status} ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

interface LivePostprocessResult {
  readonly finalPng: string;
  readonly steps: ReadonlyArray<{ id: string; label: string; png: string }>;
}

interface LivePostprocessOptions {
  readonly background?: {
    readonly colorToleranceSq?: number;
    readonly fringeToleranceSq?: number;
  };
}

type FacingDirection = 'left' | 'right';

// NOTE: These defaults MUST stay identical to the generation-side post-process
// constants BACKGROUND_B_COLOR_TOLERANCE_SQ / BACKGROUND_B_FRINGE_TOLERANCE_SQ
// in scripts/sprites/postprocess.ts. If they drift, the workflow grid
// thumbnails (generation) and this debugger preview will diverge. A guard test
// in tests/unit/bg-remove.test.ts locks the generation-side values to 4000 /
// 12000. (We can't import them here — devtools is a browser bundle and must not
// pull in Node/pngjs.)
const DEFAULT_BACKGROUND_TWEAKS = {
  colorToleranceSq: 4000,
  fringeToleranceSq: 12000,
} as const;
const MAX_BACKGROUND_TOLERANCE_SQ = 255 * 255 * 3;

interface BackgroundTweakState {
  colorToleranceSq: number;
  fringeToleranceSq: number;
}

interface ManualAnchorState {
  variantIndex: number;
  x: number;
  y: number;
  applyToAllVariants?: boolean;
}

interface AnchorMarkerState {
  x: number;
  y: number;
  source: 'manual' | 'derived' | 'brief';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function livePostprocess(
  rawPngSource: string,
  briefPath: string,
  options?: LivePostprocessOptions,
): Promise<LivePostprocessResult> {
  // Fetch raw PNG as blob
  const pngRes = await fetch(rawPngSource);
  if (!pngRes.ok) {
    throw new Error(`Failed to fetch raw PNG: ${pngRes.status} ${pngRes.statusText}`);
  }
  const pngBlob = await pngRes.arrayBuffer();
  const pngBase64 = arrayBufferToBase64(pngBlob);

  // Call /api/postprocess
  const result = await fetchJson<LivePostprocessResult>(`${SIDECAR_BASE}/api/postprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      briefPath,
      rawPng: pngBase64,
      ...(options ? { options } : {}),
    }),
  });
  return result;
}

function setButtonBusy(
  button: HTMLButtonElement,
  busy: boolean,
  idleText: string,
  busyText: string,
): void {
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function currentDevtoolsPage(): DevtoolsPage {
  const value = new URLSearchParams(window.location.search).get('page');
  if (value === DEVTOOLS_PAGE_HOME) return DEVTOOLS_PAGE_HOME;
  if (value === DEVTOOLS_PAGE_SPRITE_WORKFLOW || value === DEVTOOLS_PAGE_FLOOR_ART_LEGACY) {
    return DEVTOOLS_PAGE_SPRITE_WORKFLOW;
  }
  if (value === DEVTOOLS_PAGE_SPRITE_REVIEW) return DEVTOOLS_PAGE_SPRITE_REVIEW;
  if (value === DEVTOOLS_PAGE_ACHIEVEMENTS) return DEVTOOLS_PAGE_ACHIEVEMENTS;
  if (value === DEVTOOLS_PAGE_STORAGE) return DEVTOOLS_PAGE_STORAGE;
  return value === DEVTOOLS_PAGE_POSTPROCESS ? DEVTOOLS_PAGE_POSTPROCESS : DEVTOOLS_PAGE_HOME;
}

function devtoolsPageHref(page: DevtoolsPage, params?: Record<string, string>): string {
  if (page === DEVTOOLS_PAGE_HOME) return 'devtools.html';
  const searchParams = new URLSearchParams();
  searchParams.set('page', page);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
  }
  return `devtools.html?${searchParams.toString()}`;
}

function postprocessDebuggerHref(briefId: string, runId: string, variantIndex: number): string {
  return devtoolsPageHref(DEVTOOLS_PAGE_POSTPROCESS, {
    briefId,
    runId,
    variantIndex: String(variantIndex),
  });
}

function reviewHrefForApprovedAsset(asset: {
  readonly briefId: string;
  readonly sourceRun: string | null;
  readonly variantIndex: number | null;
  readonly approvedAssetExists: boolean;
}): string | null {
  if (!asset.approvedAssetExists || !asset.sourceRun || asset.variantIndex === null) {
    return null;
  }
  const runId = asset.sourceRun.split('/').filter(Boolean).at(-1);
  if (!runId) {
    return null;
  }
  return devtoolsPageHref(DEVTOOLS_PAGE_SPRITE_REVIEW, {
    briefId: asset.briefId,
    runId,
    variantIndex: String(asset.variantIndex),
  });
}

function formatReviewStatus(status: FloorArtStatus): string {
  if (status === 'approved') return 'Reviewed';
  if (status === 'approved-not-integrated') return 'Reviewed not integrated';
  if (status === 'approved-missing-file') return 'Reviewed missing file';
  return status;
}

function parseDebugTargetFromUrl(): {
  briefId: string;
  runId: string;
  variantIndex: number;
} | null {
  const params = new URLSearchParams(window.location.search);
  const briefId = params.get('briefId');
  const runId = params.get('runId');
  const variantIndexRaw = params.get('variantIndex');
  if (!briefId || !runId || !variantIndexRaw) return null;
  const variantIndex = Number.parseInt(variantIndexRaw, 10);
  if (!Number.isFinite(variantIndex) || variantIndex < 0) return null;
  return { briefId, runId, variantIndex };
}

const ACHIEVEMENT_EDITOR_STORAGE_KEY = 'crawler.devtools.achievement-overrides.v1';

interface AchievementOverridePatch {
  title?: string;
  popupText?: string;
  unlockCriteria?: string;
  details?: string;
  directorFlavor?: string;
  iconId?: string;
  reward?: AchievementReward;
}

type AchievementOverrideMap = Record<string, AchievementOverridePatch>;

function loadAchievementOverrides(): AchievementOverrideMap {
  try {
    const raw = window.localStorage.getItem(ACHIEVEMENT_EDITOR_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as AchievementOverrideMap;
  } catch {
    return {};
  }
}

function saveAchievementOverrides(overrides: AchievementOverrideMap): void {
  window.localStorage.setItem(ACHIEVEMENT_EDITOR_STORAGE_KEY, JSON.stringify(overrides));
}

function mergeAchievementWithOverride(
  achievement: AchievementDef,
  overrides: AchievementOverrideMap,
): AchievementDef {
  const patch = overrides[achievement.id];
  if (!patch) return achievement;
  return {
    ...achievement,
    ...patch,
    reward: patch.reward ?? achievement.reward,
  };
}

function renderAchievementsEditorPage(shell: HTMLElement): void {
  const overrides = loadAchievementOverrides();
  let selectedId = FLOOR1_ACHIEVEMENTS[0]?.id ?? null;
  let query = '';

  const panel = el('section', {
    style: {
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '10px',
      background: '#0b1220',
      padding: '12px',
      display: 'grid',
      gap: '10px',
    },
  });
  shell.append(panel);

  const controls = el('div', {
    style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  });
  const search = el('input', {
    style: {
      flex: '1 1 220px',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  }) as HTMLInputElement;
  search.type = 'search';
  search.placeholder = 'Filter by id/title/criteria';
  const resetSelectedBtn = el('button', {
    text: 'Reset selected',
    style: {
      padding: '7px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#1f2937',
      color: '#e5e7eb',
      cursor: 'pointer',
    },
  }) as HTMLButtonElement;
  const resetAllBtn = el('button', {
    text: 'Reset all overrides',
    style: {
      padding: '7px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(248,113,113,0.45)',
      background: '#3f1d1d',
      color: '#fecaca',
      cursor: 'pointer',
    },
  }) as HTMLButtonElement;
  controls.append(search, resetSelectedBtn, resetAllBtn);
  panel.append(controls);

  const summary = el('p', { style: { fontSize: '12px', color: '#93c5fd' } });
  panel.append(summary);

  const workspace = el('div', {
    style: {
      display: 'grid',
      gap: '10px',
      gridTemplateColumns: 'minmax(260px, 1fr) minmax(360px, 2fr)',
    },
  });
  const listHost = el('div', {
    style: {
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '8px',
      background: '#0f172a',
      maxHeight: '58svh',
      overflow: 'auto',
      padding: '8px',
      display: 'grid',
      gap: '6px',
    },
  });
  const editorHost = el('div', {
    style: {
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '8px',
      background: '#0f172a',
      padding: '10px',
      display: 'grid',
      gap: '8px',
    },
  });
  workspace.append(listHost, editorHost);
  panel.append(workspace);

  const artPanel = el('div', {
    style: {
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '8px',
      background: '#0f172a',
      padding: '10px',
      display: 'grid',
      gap: '6px',
    },
  });
  panel.append(artPanel);

  const exportPanel = el('div', {
    style: {
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '8px',
      background: '#0f172a',
      padding: '10px',
      display: 'grid',
      gap: '8px',
    },
  });
  panel.append(exportPanel);

  const exportText = el('textarea', {
    style: {
      width: '100%',
      minHeight: '180px',
      background: '#020617',
      color: '#e2e8f0',
      border: '1px solid rgba(148,163,184,0.35)',
      borderRadius: '8px',
      padding: '8px',
      fontFamily: 'monospace',
      fontSize: '12px',
    },
  }) as HTMLTextAreaElement;
  exportText.readOnly = true;
  const refreshExportBtn = el('button', {
    text: 'Refresh export JSON',
    style: {
      padding: '7px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#082f49',
      color: '#e0f2fe',
      cursor: 'pointer',
      width: 'fit-content',
    },
  }) as HTMLButtonElement;
  exportPanel.append(
    el('h3', { text: 'Export (base + local overrides)' }),
    refreshExportBtn,
    exportText,
  );

  function getMergedAchievements(): AchievementDef[] {
    return FLOOR1_ACHIEVEMENTS.map((achievement) =>
      mergeAchievementWithOverride(achievement, overrides),
    );
  }

  function updateExport(): void {
    exportText.value = JSON.stringify(getMergedAchievements(), null, 2);
  }

  function renderList(): void {
    const merged = getMergedAchievements();
    const filtered = merged.filter((achievement) => {
      const haystack =
        `${achievement.id} ${achievement.title} ${achievement.unlockCriteria}`.toLowerCase();
      return haystack.includes(query);
    });
    summary.textContent = `Floor 1 achievements: ${merged.length} total · ${Object.keys(overrides).length} overridden locally · ${filtered.length} shown`;

    listHost.replaceChildren();
    for (const achievement of filtered) {
      const isSelected = achievement.id === selectedId;
      const hasOverride = Boolean(overrides[achievement.id]);
      const row = el('button', {
        style: {
          width: '100%',
          textAlign: 'left',
          padding: '8px',
          borderRadius: '8px',
          border: isSelected ? '1px solid rgba(56,189,248,0.7)' : '1px solid rgba(148,163,184,0.3)',
          background: isSelected ? '#082f49' : '#111827',
          color: '#e5e7eb',
          cursor: 'pointer',
        },
      }) as HTMLButtonElement;
      row.append(
        el('div', {
          text: `${achievement.title}${hasOverride ? ' *' : ''}`,
          style: { fontWeight: '600', fontSize: '13px' },
        }),
        el('code', { text: achievement.id, style: { fontSize: '11px', color: '#7dd3fc' } }),
        el('div', {
          text: achievement.unlockCriteria,
          style: { marginTop: '4px', fontSize: '11px', color: '#cbd5e1' },
        }),
      );
      row.addEventListener('click', () => {
        selectedId = achievement.id;
        renderList();
        renderEditor();
      });
      listHost.append(row);
    }
  }

  function createLabeledField(labelText: string): HTMLLabelElement {
    const wrap = el('label', {
      style: { display: 'grid', gap: '4px', fontSize: '12px', color: '#bfdbfe' },
    }) as HTMLLabelElement;
    wrap.append(el('span', { text: labelText }));
    return wrap;
  }

  function readRewardOverride(
    rewardTypeValue: string,
    tierValue: string,
    itemValue: string,
    messageValue: string,
  ): AchievementReward {
    if (rewardTypeValue === 'lootBox') {
      const tier = tierValue.trim().toLowerCase();
      const safeTier = LOOT_BOX_TIERS.includes(tier as LootBoxTier)
        ? (tier as LootBoxTier)
        : 'common';
      // This devtools canvas only ever edits Floor 1 achievements (see the
      // FLOOR1_ACHIEVEMENTS-only scoping elsewhere in this file), so the
      // loot table is always Floor 1's.
      return { type: 'lootBox', lootTable: 'floor1-materials', tier: safeTier };
    }
    if (rewardTypeValue === 'item') {
      return { type: 'item', itemId: itemValue.trim() };
    }
    if (rewardTypeValue === 'directorMessage') {
      return { type: 'directorMessage', message: messageValue.trim() };
    }
    return { type: 'none' };
  }

  function renderEditor(): void {
    editorHost.replaceChildren();
    const achievement = getMergedAchievements().find((entry) => entry.id === selectedId) ?? null;
    if (!achievement) {
      editorHost.append(el('p', { text: 'No achievement selected.' }));
      return;
    }

    const base = FLOOR1_ACHIEVEMENTS.find((entry) => entry.id === achievement.id) ?? achievement;
    const patch: AchievementOverridePatch = { ...(overrides[achievement.id] ?? {}) };
    const makeInput = (labelText: string, value: string): HTMLInputElement => {
      const wrap = createLabeledField(labelText);
      const input = el('input', {
        style: {
          padding: '7px 9px',
          borderRadius: '8px',
          border: '1px solid rgba(148,163,184,0.35)',
          background: '#020617',
          color: '#e5e7eb',
        },
      }) as HTMLInputElement;
      input.value = value;
      wrap.append(input);
      editorHost.append(wrap);
      return input;
    };
    const makeArea = (labelText: string, value: string, minHeight = 70): HTMLTextAreaElement => {
      const wrap = createLabeledField(labelText);
      const area = el('textarea', {
        style: {
          minHeight: `${minHeight}px`,
          padding: '7px 9px',
          borderRadius: '8px',
          border: '1px solid rgba(148,163,184,0.35)',
          background: '#020617',
          color: '#e5e7eb',
        },
      }) as HTMLTextAreaElement;
      area.value = value;
      wrap.append(area);
      editorHost.append(wrap);
      return area;
    };

    editorHost.append(
      el('h3', { text: `${achievement.title} (${achievement.id})` }),
      el('p', {
        text: `Difficulty: ${achievement.difficulty} · Reward: ${achievement.reward.type === 'lootBox' ? achievement.reward.tier : achievement.reward.type}`,
        style: { fontSize: '12px', color: '#93c5fd' },
      }),
    );
    const titleInput = makeInput('Title', achievement.title);
    const popupInput = makeInput('Popup text', achievement.popupText);
    const criteriaInput = makeInput('Unlock criteria', achievement.unlockCriteria);
    const iconInput = makeInput('Icon placeholder ID', achievement.iconId);
    const detailsInput = makeArea('Details', achievement.details);
    const flavorInput = makeArea('Director flavor', achievement.directorFlavor, 110);

    const rewardTypeWrap = el('label', {
      style: { display: 'grid', gap: '4px', fontSize: '12px', color: '#bfdbfe' },
    });
    const rewardType = el('select', {
      style: {
        padding: '7px 9px',
        borderRadius: '8px',
        border: '1px solid rgba(148,163,184,0.35)',
        background: '#020617',
        color: '#e5e7eb',
      },
    }) as HTMLSelectElement;
    for (const type of ['lootBox', 'item', 'directorMessage', 'none']) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      rewardType.append(option);
    }
    const rewardTier = makeInput(
      'Reward loot-box tier (if lootBox)',
      achievement.reward.type === 'lootBox' ? achievement.reward.tier : LOOT_BOX_TIERS[0],
    );
    const rewardItem = makeInput(
      'Reward item ID (if item)',
      achievement.reward.type === 'item' ? achievement.reward.itemId : '',
    );
    const rewardMessage = makeArea(
      'Reward message (if directorMessage)',
      achievement.reward.type === 'directorMessage' ? achievement.reward.message : '',
      56,
    );
    rewardType.value = achievement.reward.type;
    rewardTypeWrap.append(el('span', { text: 'Reward type' }), rewardType);
    editorHost.append(rewardTypeWrap);

    const actions = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    const saveBtn = el('button', {
      text: 'Save override',
      style: {
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(34,197,94,0.55)',
        background: '#052e16',
        color: '#bbf7d0',
        cursor: 'pointer',
      },
    }) as HTMLButtonElement;
    const revertBtn = el('button', {
      text: 'Revert selected',
      style: {
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(251,113,133,0.55)',
        background: '#3f1d2e',
        color: '#fecdd3',
        cursor: 'pointer',
      },
    }) as HTMLButtonElement;
    const saveStatus = el('span', { style: { color: '#93c5fd', fontSize: '12px' } });
    actions.append(saveBtn, revertBtn, saveStatus);
    editorHost.append(actions);

    saveBtn.addEventListener('click', () => {
      const reward = readRewardOverride(
        rewardType.value,
        rewardTier.value,
        rewardItem.value,
        rewardMessage.value,
      );

      patch.title = titleInput.value.trim();
      patch.popupText = popupInput.value.trim();
      patch.unlockCriteria = criteriaInput.value.trim();
      patch.details = detailsInput.value.trim();
      patch.directorFlavor = flavorInput.value.trim();
      patch.iconId = iconInput.value.trim();
      patch.reward = reward;
      overrides[achievement.id] = patch;
      saveAchievementOverrides(overrides);
      saveStatus.textContent = 'Saved override in localStorage.';
      renderList();
      updateExport();
    });

    revertBtn.addEventListener('click', () => {
      delete overrides[achievement.id];
      saveAchievementOverrides(overrides);
      selectedId = base.id;
      renderList();
      renderEditor();
      updateExport();
    });
  }

  function renderArtBacklog(): void {
    artPanel.replaceChildren(
      el('h3', { text: 'Placeholder art backlog (icons + loot boxes)' }),
      el('p', {
        text: `${ACHIEVEMENT_ART_BACKLOG.length} placeholder packs tracked for replacement.`,
        style: { color: '#93c5fd', fontSize: '12px' },
      }),
    );
    const list = el('div', { style: { display: 'grid', gap: '6px' } });
    for (const item of ACHIEVEMENT_ART_BACKLOG) {
      list.append(
        el('div', {
          style: {
            border: '1px solid rgba(148,163,184,0.3)',
            borderRadius: '8px',
            padding: '8px',
            background: '#111827',
          },
        }),
      );
      const card = list.lastChild as HTMLElement;
      card.append(
        el('div', {
          text: `${item.kind === 'lootBox' ? '📦' : '🧷'} ${item.placeholderId}`,
          style: { fontWeight: '600' },
        }),
        el('div', { text: item.description, style: { fontSize: '12px', color: '#cbd5e1' } }),
        el('div', {
          text: `Used by ${item.usedByAchievementIds.length} achievement(s)`,
          style: { fontSize: '11px', color: '#94a3b8', marginTop: '2px' },
        }),
      );
    }
    artPanel.append(list);
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderList();
  });
  resetSelectedBtn.addEventListener('click', () => {
    if (!selectedId) return;
    delete overrides[selectedId];
    saveAchievementOverrides(overrides);
    renderList();
    renderEditor();
    updateExport();
  });
  resetAllBtn.addEventListener('click', () => {
    for (const key of Object.keys(overrides)) delete overrides[key];
    saveAchievementOverrides(overrides);
    renderList();
    renderEditor();
    updateExport();
  });
  refreshExportBtn.addEventListener('click', updateExport);

  renderList();
  renderEditor();
  renderArtBacklog();
  updateExport();
}

function keyForStorageRun(scope: 'active' | 'archive', run: SidecarStorageRunEntry): string {
  return `${scope === 'archive' ? 'archive/' : ''}${run.briefId}/${run.runId}`;
}

function renderStorageLifecyclePage(shell: HTMLElement): void {
  const panel = el('section', {
    style: {
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '10px',
      background: '#0b1220',
      padding: '12px',
      display: 'grid',
      gap: '10px',
    },
  });
  shell.append(panel);

  const status = el('div', {
    text: 'Loading…',
    style: { color: '#93c5fd', fontSize: '13px' },
  });

  const fieldStyle: Partial<CSSStyleDeclaration> = {
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid rgba(229,231,235,0.3)',
    background: '#111827',
    color: '#e5e7eb',
  };
  const buttonStyle: Partial<CSSStyleDeclaration> = {
    padding: '8px 12px',
    borderRadius: '8px',
    border: '1px solid rgba(126,224,255,0.4)',
    background: 'rgba(30,41,59,0.95)',
    color: '#7ee0ff',
    cursor: 'pointer',
  };

  const controls = el('div', {
    style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  });
  const scopeSelect = el('select', { style: fieldStyle });
  for (const [value, label] of [
    ['active', 'Active runs'],
    ['archive', 'Archive'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    scopeSelect.append(option);
  }
  const searchInput = el('input', { style: { ...fieldStyle, flex: '1 1 220px' } });
  searchInput.type = 'search';
  searchInput.placeholder = 'Search brief or run id';
  const refreshBtn = el('button', { text: 'Refresh', style: buttonStyle });
  const archiveBtn = el('button', { text: 'Archive selected', style: buttonStyle });
  const deleteBtn = el('button', { text: 'Delete selected', style: buttonStyle });
  controls.append(scopeSelect, searchInput, refreshBtn, archiveBtn, deleteBtn);

  const sortSelect = el('select', { style: fieldStyle, title: 'Sort order' });
  for (const [value, label] of [
    ['newest', 'Sort: Newest first'],
    ['oldest', 'Sort: Oldest first'],
    ['brief', 'Sort: Brief (A–Z)'],
    ['approved', 'Sort: Most approved'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    sortSelect.append(option);
  }
  const filterSelect = el('select', { style: fieldStyle, title: 'Filter runs' });
  for (const [value, label] of [
    ['all', 'Show: All runs'],
    ['approved', 'Show: Has approved'],
    ['unapproved', 'Show: No approved'],
    ['brief-stored', 'Show: Brief stored'],
    ['brief-missing', 'Show: Brief missing'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    filterSelect.append(option);
  }
  const controls2 = el('div', {
    style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  });
  controls2.append(sortSelect, filterSelect);

  const listHost = el('div', { style: { overflowX: 'auto' } });
  panel.append(status, controls, controls2, listHost);

  let selected = new Set<string>();
  let currentRuns: readonly SidecarStorageRunEntry[] = [];
  let enrichment = new Map<string, StorageRunEnrichment>();

  const currentScope = (): 'active' | 'archive' =>
    scopeSelect.value === 'archive' ? 'archive' : 'active';
  const runKey = (run: SidecarStorageRunEntry): string => `${run.briefId}/${run.runId}`;

  const cellStyle: Partial<CSSStyleDeclaration> = {
    padding: '8px 10px',
    borderBottom: '1px solid rgba(229,231,235,0.1)',
    verticalAlign: 'middle',
  };

  const makeBadge = (text: string, kind: 'good' | 'warn' | 'muted'): HTMLElement => {
    const palette = {
      good: {
        color: '#86efac',
        border: 'rgba(134,239,172,0.4)',
        background: 'rgba(22,101,52,0.35)',
      },
      warn: {
        color: '#fcd34d',
        border: 'rgba(252,211,77,0.4)',
        background: 'rgba(120,53,15,0.35)',
      },
      muted: {
        color: '#94a3b8',
        border: 'rgba(148,163,184,0.3)',
        background: 'rgba(30,41,59,0.6)',
      },
    }[kind];
    return el('span', {
      text,
      style: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        whiteSpace: 'nowrap',
        color: palette.color,
        border: `1px solid ${palette.border}`,
        background: palette.background,
      },
    });
  };

  const makeThumb = (src: string, size: number, title: string): HTMLElement => {
    const wrap = el('span', {
      title,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: `${size}px`,
        minHeight: `${size}px`,
        color: '#64748b',
      },
    });
    const img = document.createElement('img');
    img.src = src;
    img.alt = title;
    Object.assign(img.style, {
      width: `${size}px`,
      height: `${size}px`,
      objectFit: 'contain',
      imageRendering: 'pixelated',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.2)',
      background: '#0f172a',
    });
    img.addEventListener('error', () => {
      wrap.textContent = '—';
    });
    wrap.append(img);
    return wrap;
  };

  const byRunIdDesc = (a: SidecarStorageRunEntry, b: SidecarStorageRunEntry): number =>
    a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;

  const displayRuns = (): SidecarStorageRunEntry[] => {
    const filter = filterSelect.value;
    const filtered = currentRuns.filter((run) => {
      const enr = enrichment.get(runKey(run));
      if (!enr) return true; // enrichment not loaded yet — never hide prematurely
      switch (filter) {
        case 'approved':
          return enr.approvedCount > 0;
        case 'unapproved':
          return enr.approvedCount === 0;
        case 'brief-stored':
          return enr.briefStored;
        case 'brief-missing':
          return !enr.briefStored;
        default:
          return true;
      }
    });
    const sorted = [...filtered];
    switch (sortSelect.value) {
      case 'oldest':
        sorted.sort((a, b) => -byRunIdDesc(a, b));
        break;
      case 'brief':
        sorted.sort((a, b) => a.briefId.localeCompare(b.briefId) || byRunIdDesc(a, b));
        break;
      case 'approved':
        sorted.sort(
          (a, b) =>
            (enrichment.get(runKey(b))?.approvedCount ?? -1) -
              (enrichment.get(runKey(a))?.approvedCount ?? -1) || byRunIdDesc(a, b),
        );
        break;
      default:
        sorted.sort(byRunIdDesc);
    }
    return sorted;
  };

  const renderRows = (scope: 'active' | 'archive'): void => {
    const rows = displayRuns();
    if (rows.length === 0) {
      listHost.replaceChildren(
        el('div', {
          text: currentRuns.length === 0 ? 'No runs in this scope.' : 'No runs match this filter.',
          style: { color: '#94a3b8', fontSize: '13px', padding: '10px 2px' },
        }),
      );
      return;
    }
    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
    });
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of [
      '',
      'Sheet',
      'Approved art',
      'Brief',
      'Run',
      'Timestamp',
      'Variants',
      'Brief stored',
    ]) {
      const th = document.createElement('th');
      th.textContent = label;
      Object.assign(th.style, {
        textAlign: 'left',
        padding: '8px 10px',
        borderBottom: '1px solid rgba(229,231,235,0.1)',
        color: '#cbd5e1',
        whiteSpace: 'nowrap',
      });
      headRow.append(th);
    }
    head.append(headRow);
    table.append(head);
    const body = document.createElement('tbody');
    for (const run of rows) {
      const enr = enrichment.get(runKey(run));
      const row = document.createElement('tr');
      const key = keyForStorageRun(scope, run);

      const checkCell = el('td', { style: cellStyle });
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.key = key;
      checkbox.checked = selected.has(key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(key);
        else selected.delete(key);
      });
      checkCell.append(checkbox);
      row.append(checkCell);

      // Sprite-sheet thumbnail (active scope only — archived runs live under a
      // different key prefix the image routes don't serve).
      const sheetCell = el('td', { style: cellStyle });
      if (!enr) {
        sheetCell.append(el('span', { text: '…', style: { color: '#64748b' } }));
      } else if (scope === 'active' && enr.sheetFile) {
        sheetCell.append(
          makeThumb(sheetUrl(run.briefId, run.runId, enr.sheetFile), 56, enr.sheetFile),
        );
      } else {
        sheetCell.append(el('span', { text: '—', style: { color: '#64748b' } }));
      }
      row.append(sheetCell);

      // First approved variant for the brief (from wherever it was approved).
      const approvedCell = el('td', { style: cellStyle });
      if (!enr) {
        approvedCell.append(el('span', { text: '…', style: { color: '#64748b' } }));
      } else if (enr.firstApproved) {
        const padded = String(enr.firstApproved.variantIndex).padStart(2, '0');
        approvedCell.append(
          makeThumb(
            spriteUrl(run.briefId, enr.firstApproved.runId, `${padded}.png`),
            48,
            `Approved variant #${enr.firstApproved.variantIndex} (from ${enr.firstApproved.runId})`,
          ),
        );
      } else {
        approvedCell.append(el('span', { text: '—', style: { color: '#64748b' } }));
      }
      row.append(approvedCell);

      for (const value of [run.briefId, run.runId, run.timestamp ?? '—']) {
        row.append(el('td', { text: value, style: cellStyle }));
      }

      // Variants / approved-count badge.
      const variantsCell = el('td', { style: cellStyle });
      if (!enr) {
        variantsCell.append(el('span', { text: '…', style: { color: '#64748b' } }));
      } else if (enr.approvedCount > 0) {
        variantsCell.append(
          makeBadge(
            enr.variantCount !== null
              ? `${enr.approvedCount} approved / ${enr.variantCount}`
              : `${enr.approvedCount} approved`,
            'good',
          ),
        );
      } else {
        variantsCell.append(
          makeBadge(
            enr.variantCount !== null ? `0 / ${enr.variantCount} approved` : 'none approved',
            'muted',
          ),
        );
      }
      row.append(variantsCell);

      // Brief-stored badge.
      const briefCell = el('td', { style: cellStyle });
      if (!enr) {
        briefCell.append(el('span', { text: '…', style: { color: '#64748b' } }));
      } else {
        briefCell.append(
          enr.briefStored ? makeBadge('✓ stored', 'good') : makeBadge('✗ missing', 'warn'),
        );
      }
      row.append(briefCell);

      body.append(row);
    }
    table.append(body);
    listHost.replaceChildren(table);
  };

  const loadEnrichment = async (
    scope: 'active' | 'archive',
    runs: readonly SidecarStorageRunEntry[],
  ): Promise<void> => {
    if (runs.length === 0) return;
    try {
      const payload = await enrichStorageRuns(scope, runs);
      if (currentScope() !== scope) return; // scope changed while in flight
      enrichment = new Map(
        payload.enriched.map((entry) => [`${entry.briefId}/${entry.runId}`, entry]),
      );
      renderRows(scope);
    } catch (error) {
      status.textContent = `${status.textContent} · enrichment unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const reload = async (): Promise<void> => {
    const scope = currentScope();
    status.textContent = 'Loading runs…';
    enrichment = new Map();
    try {
      const payload = await listStorageRuns(scope, searchInput.value);
      currentRuns = payload.runs;
      renderRows(scope);
      status.textContent = `Loaded ${currentRuns.length} ${scope} run(s).`;
      void loadEnrichment(scope, currentRuns);
    } catch (error) {
      status.textContent = `Failed to load runs: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  refreshBtn.addEventListener('click', () => void reload());
  scopeSelect.addEventListener('change', () => {
    selected = new Set<string>();
    void reload();
  });
  searchInput.addEventListener('change', () => void reload());
  sortSelect.addEventListener('change', () => renderRows(currentScope()));
  filterSelect.addEventListener('change', () => renderRows(currentScope()));

  archiveBtn.addEventListener('click', async () => {
    const keys = [...selected].filter((key) => !key.startsWith('archive/'));
    if (keys.length === 0) {
      status.textContent = 'Select at least one active run to archive.';
      return;
    }
    if (!window.confirm(`Archive ${keys.length} run(s)?`)) return;
    try {
      const result = await archiveStorageRuns(keys);
      status.textContent = `Archived ${result.archived.length}; skipped ${result.skipped.length}.`;
      selected = new Set<string>();
      await reload();
    } catch (error) {
      status.textContent = `Failed to archive runs: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const keys = [...selected];
    if (keys.length === 0) {
      status.textContent = 'Select at least one run to delete.';
      return;
    }
    if (!window.confirm(`Permanently delete ${keys.length} run(s)? This cannot be undone.`)) return;
    try {
      const result = await deleteStorageRunsBatch(keys);
      status.textContent = `Deleted ${result.deleted.length} run(s).`;
      selected = new Set<string>();
      await reload();
    } catch (error) {
      status.textContent = `Failed to delete runs: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  void reload();
}

function render(): void {
  const root = document.getElementById('devtools-root');
  if (!(root instanceof HTMLElement)) {
    throw new Error('Missing #devtools-root host element');
  }
  root.replaceChildren();

  const shell = el('section', { className: 'panel devtools-shell' });
  const currentPage = currentDevtoolsPage();
  const isHomePage = currentPage === DEVTOOLS_PAGE_HOME;
  const isSpriteReviewPage = currentPage === DEVTOOLS_PAGE_SPRITE_REVIEW;
  const isSpriteWorkflowPage = currentPage === DEVTOOLS_PAGE_SPRITE_WORKFLOW;
  const isPostprocessPage = currentPage === DEVTOOLS_PAGE_POSTPROCESS;
  const isAchievementsPage = currentPage === DEVTOOLS_PAGE_ACHIEVEMENTS;
  const isStoragePage = currentPage === DEVTOOLS_PAGE_STORAGE;
  const title = el('h1', { text: 'Crawler DevTools' });
  const subtitle = el('p', {
    text: LOCAL_HOSTS.has(window.location.hostname)
      ? isHomePage
        ? 'Pick a DevTool from the searchable index below.'
        : isPostprocessPage
          ? 'Postprocess debugger: inspect pipeline steps, slicing, and live postprocess traces.'
          : isSpriteReviewPage
            ? 'Sprite review — readonly viewer for approved sprite sheets.'
            : isAchievementsPage
              ? 'Achievements editor — review/edit Floor 1 achievement text + rewards and track placeholder art backlog.'
              : isStoragePage
                ? 'Azure storage lifecycle — list, search, archive, and delete sprite-run blobs.'
                : 'Sprite Generation Workflow — track backlog, synthesis, generation, approvals, and integration.'
      : 'DevTools is disabled outside localhost.',
    style: { marginBottom: '16px' },
  });
  shell.append(title, subtitle);
  root.append(shell);

  if (!LOCAL_HOSTS.has(window.location.hostname)) {
    return;
  }

  if (isHomePage) {
    const tools = DEVTOOLS_INDEX_ENTRIES;
    const compact = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
    const search = el('input', {
      style: {
        width: '100%',
        padding: compact ? '10px 12px' : '9px 12px',
        marginBottom: '16px',
        background: 'rgba(8, 12, 24, 0.5)',
        border: '1px solid rgba(255, 255, 255, 0.2)',
        borderRadius: '10px',
        color: '#e0e0e0',
        fontSize: compact ? '13px' : '14px',
      },
    }) as HTMLInputElement;
    search.type = 'search';
    search.placeholder = 'Filter DevTools (name, id, description)';
    search.setAttribute('aria-label', 'Filter DevTools');
    const count = el('p', {
      style: { color: '#7ee0ff', fontSize: compact ? '13px' : '14px', marginBottom: '12px' },
    });
    const list = el('div', { style: { display: 'grid', gap: '10px' } });
    const renderTools = (query: string): void => {
      const q = query.trim().toLowerCase();
      const filtered = q
        ? tools.filter((tool) =>
            [tool.name, tool.id, tool.description].join(' ').toLowerCase().includes(q),
          )
        : tools;
      count.textContent = `${filtered.length} DevTool${filtered.length === 1 ? '' : 's'}`;
      list.replaceChildren();
      if (filtered.length === 0) {
        list.append(
          el('div', {
            text: 'No DevTools matched your filter.',
            style: {
              padding: '16px',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '12px',
              background: 'rgba(22, 33, 62, 0.75)',
              color: '#cbd5e1',
            },
          }),
        );
        return;
      }
      for (const tool of filtered) {
        const card = el('a', {
          style: {
            width: '100%',
            display: 'block',
            padding: compact ? '12px 14px' : '16px 20px',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '12px',
            background: 'rgba(22, 33, 62, 0.9)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
            color: '#e0e0e0',
            textDecoration: 'none',
            transition: 'border-color 0.15s, transform 0.15s',
            textAlign: 'left',
            cursor: 'pointer',
          },
        });
        const href = devtoolsPageHref(tool.id);
        card.setAttribute('href', href);
        card.addEventListener('click', (event) => {
          event.preventDefault();
          window.location.assign(href);
        });
        card.addEventListener('mouseenter', () => {
          card.style.borderColor = 'rgba(126, 224, 255, 0.4)';
          card.style.transform = 'translateY(-1px)';
        });
        card.addEventListener('mouseleave', () => {
          card.style.borderColor = 'rgba(255, 255, 255, 0.12)';
          card.style.transform = 'none';
        });
        card.append(
          el('h3', {
            text: tool.name,
            style: { fontSize: compact ? '16px' : '18px', marginBottom: '4px' },
          }),
          el('p', {
            text: tool.description,
            style: {
              color: '#c9d4ff',
              lineHeight: '1.5',
              fontSize: compact ? '13px' : '14px',
              marginBottom: '8px',
            },
          }),
          el('code', { text: tool.id, style: { color: '#7ee0ff', fontSize: '12px' } }),
        );
        list.append(card);
      }
    };
    search.addEventListener('input', () => renderTools(search.value));
    renderTools('');
    shell.append(count, search, list);
    return;
  }

  if (isAchievementsPage) {
    renderAchievementsEditorPage(shell);
    return;
  }

  if (isStoragePage) {
    renderStorageLifecyclePage(shell);
    return;
  }

  const plans = parseFloorArtPlans(planSources);
  if (plans.length === 0) {
    shell.append(
      el('p', {
        text: 'No Sprite Generation Workflow plans found under plans/**/*.art.yaml.',
        style: { color: '#fca5a5' },
      }),
    );
    return;
  }

  const briefKeys = parseCommittedBriefKeys(briefSources);
  const draftBriefKeys = parseDraftBriefKeys(briefSources);
  const spriteRegistryIds = new Set(SPRITES.map((sprite) => sprite.id));
  const itemCatalogIds = new Set(ITEM_CATALOG.map((item) => item.id));

  const controls = el('div', {
    style: {
      display: 'flex',
      gap: '10px',
      flexWrap: 'wrap',
      alignItems: 'center',
      marginBottom: '14px',
    },
  });
  const planSelect = el('select', {
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  });
  // Default to an unselected placeholder so the assets table stays empty until
  // the operator explicitly picks a manifest (see renderActivePlan).
  const planPlaceholder = document.createElement('option');
  planPlaceholder.value = '';
  planPlaceholder.textContent = 'Select a manifest…';
  planSelect.append(planPlaceholder);
  for (const plan of plans) {
    const option = document.createElement('option');
    option.value = plan.id;
    option.textContent = `${plan.title} (${plan.id})`;
    planSelect.append(option);
  }

  const statusFilter = el('select', {
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  });
  for (const value of ['all', ...STATUS_ORDER]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent =
      value === 'all' ? 'All statuses' : formatReviewStatus(value as FloorArtStatus);
    statusFilter.append(option);
  }

  const searchInput = el('input', {
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
      minWidth: '240px',
    },
  });
  searchInput.placeholder = 'Filter by id, label, brief, integration';

  const refreshBtn = el('button', {
    text: 'Refresh manifest',
    style: {
      padding: '8px 12px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#1f2937',
      color: '#e5e7eb',
      cursor: 'pointer',
    },
  });

  controls.append(planSelect, statusFilter, searchInput, refreshBtn);
  shell.append(controls);

  const summary = el('div', {
    style: {
      display: 'grid',
      gap: '10px',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      marginBottom: '12px',
    },
  });
  shell.append(summary);

  const manifestState = el('p', {
    style: { fontSize: '12px', color: '#93c5fd', marginBottom: '10px' },
  });
  shell.append(manifestState);

  const tableWrap = el('div', {
    style: {
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '10px',
      overflow: 'auto',
      background: '#0f172a',
      maxHeight: '65svh',
    },
  });
  const table = el('table', { className: 'asset-table' });
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const heading of [
    'Asset',
    'Type',
    'Status',
    'Brief',
    'Placeholder',
    'Briefed',
    'Drafted',
    'Reviewed',
    'Integration',
    'Actions',
  ]) {
    headRow.append(el('th', { text: heading }));
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  tableWrap.append(table);
  shell.append(tableWrap);

  const emptyState = el('p', {
    text: 'No assets match the current filters.',
    style: { padding: '12px', color: '#cbd5e1', display: 'none' },
  });
  shell.append(emptyState);

  const workflowPanel = el('section', {
    style: {
      marginTop: '16px',
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '10px',
      background: '#0b1220',
      padding: '12px',
    },
  });
  const workflowTitle = el('h2', {
    text: 'Sprite workflow',
    style: { margin: '0 0 8px 0', fontSize: '16px', color: '#e5e7eb' },
  });
  const workflowHint = el('p', {
    text: 'Type a one-line brief (e.g. "Purple Potion Bottle"), add it to the queue, then drive it to a tagged catalog sprite. Progress is saved and survives refresh.',
    style: { margin: '0 0 10px 0', fontSize: '12px', color: '#93c5fd' },
  });

  const composerRow = el('div', {
    style: {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      alignItems: 'center',
      marginBottom: '10px',
    },
  });
  const nameInput = el('input', {
    style: {
      flex: '1 1 180px',
      minWidth: '140px',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  });
  nameInput.placeholder = 'Name, e.g. "Skull Mace"';
  const briefInput = el('input', {
    style: {
      flex: '2 1 280px',
      minWidth: '220px',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  });
  briefInput.placeholder = 'Optional one-line brief — extra detail not baked into the name';
  const typeSelect = el('select', {
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  }) as HTMLSelectElement;
  for (const value of ['auto', ...SPRITE_TYPES]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'auto' ? 'Auto-detect type' : value;
    typeSelect.append(option);
  }
  // Output size variant — scales the per-type footprint independently of type.
  // Baked into the synthesized brief, so it is chosen here (before Synthesize).
  const sizeSelect = el('select', {
    title:
      'Output size variant — scales the sprite footprint: default 1×1, wide 2×1, tall 1×2, large 2×2.',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  }) as HTMLSelectElement;
  const SIZE_VARIANT_LABELS: Readonly<Record<SizeVariant, string>> = {
    default: 'Size: default (1×1)',
    wide: 'Size: wide (2×1)',
    tall: 'Size: tall (1×2)',
    large: 'Size: large (2×2)',
  };
  for (const value of SIZE_VARIANTS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = SIZE_VARIANT_LABELS[value];
    sizeSelect.append(option);
  }
  const addToQueueBtn = el('button', {
    text: 'Add to queue',
    style: {
      padding: '8px 14px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#0c4a6e',
      color: '#e0f2fe',
      cursor: 'pointer',
      fontWeight: '600',
    },
  });
  composerRow.append(nameInput, briefInput, typeSelect, sizeSelect, addToQueueBtn);

  const queueBar = el('div', {
    style: {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      marginBottom: '10px',
      alignItems: 'center',
    },
  });
  const queueBarLabel = el('span', {
    text: 'Queue',
    style: { fontSize: '12px', color: '#94a3b8', fontWeight: '600' },
  });
  const clearQueueBtn = el('button', {
    text: 'Clear',
    style: {
      padding: '4px 8px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#1f2937',
      color: '#e5e7eb',
      cursor: 'pointer',
      fontSize: '11px',
    },
  });
  const queueList = el('div', {
    style: { display: 'flex', gap: '6px', flexWrap: 'wrap', flex: '1 1 auto' },
  });
  queueBar.append(queueBarLabel, clearQueueBtn, queueList);

  const activeItemLabel = el('p', {
    text: 'Active item: none — add a brief above to begin.',
    style: { margin: '0 0 8px 0', fontSize: '13px', color: '#cbd5e1', fontWeight: '600' },
  });

  const stepperHost = el('div', {
    style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' },
  });

  const workflowButtons = el('div', {
    style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' },
  });
  const synthBtn = el('button', {
    text: 'Synthesize',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#082f49',
      color: '#e0f2fe',
      cursor: 'pointer',
    },
  });
  const postprocessBtn = el('button', {
    text: 'PostProcess',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(34,211,238,0.5)',
      background: '#083344',
      color: '#cffafe',
      cursor: 'pointer',
    },
  });
  const judgeBtn = el('button', {
    text: 'Judge',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(167,139,250,0.5)',
      background: '#2e1065',
      color: '#ede9fe',
      cursor: 'pointer',
    },
  });
  // Override affordance: judge variants the sensor gate would otherwise skip.
  // Hidden by default (set visible in renderWorkflowSelection only when the run
  // actually has sensor-failed variants) so it reads as a deliberate override,
  // not the default path. Styled distinctly (orange) from the normal Judge.
  const forceJudgeBtn = el('button', {
    text: 'Force judge',
    title:
      'Force the LLM judge to run even on variants that failed a sensor (ignores the sensor gate).',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(251,146,60,0.6)',
      background: '#431407',
      color: '#fed7aa',
      cursor: 'pointer',
      display: 'none',
    },
  });
  const generateBtn = el('button', {
    text: 'Generate run',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(250,204,21,0.5)',
      background: '#422006',
      color: '#fef3c7',
      cursor: 'pointer',
    },
  });
  const cancelGenerateBtn = el('button', {
    text: 'Cancel',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(248,113,113,0.5)',
      background: '#3f1d1d',
      color: '#fecaca',
      cursor: 'pointer',
      display: 'none',
    },
  });
  // Abort affordance for the in-flight PostProcess / Judge step. Hidden by
  // default; shown (in renderWorkflowSelection) only while a step is running for
  // the active item. Cancelling restores the prior stage so the trigger button
  // re-enables and the step can be retried.
  const cancelStepBtn = el('button', {
    text: 'Cancel step',
    title: 'Abort the running PostProcess or Judge step. Nothing is changed; you can retry.',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(248,113,113,0.5)',
      background: '#3f1d1d',
      color: '#fecaca',
      cursor: 'pointer',
      display: 'none',
    },
  });
  const launchWorkerBtn = el('button', {
    text: 'Launch worker',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#0c4a6e',
      color: '#e0f2fe',
      cursor: 'pointer',
      display: 'none',
    },
  });
  const metadataBtn = el('button', {
    text: 'Tag (metadata)',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(167,139,250,0.5)',
      background: '#312e81',
      color: '#ede9fe',
      cursor: 'pointer',
    },
  });
  // Global publish action: pushes every locally-approved asset that differs from
  // origin/main to a dedicated branch and files the asset-checkin tracking issue.
  // Approve alone is local-only, so without this the work never reaches GitHub.
  const checkinBtn = el('button', {
    text: 'Check in to GitHub',
    title:
      'Publish all locally-approved sprites: push an assets/<slug> branch and file an asset-checkin issue (no PR).',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(132,204,22,0.5)',
      background: '#1a2e05',
      color: '#ecfccb',
      cursor: 'pointer',
    },
  });
  const removeItemBtn = el('button', {
    text: 'Remove item',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(248,113,113,0.5)',
      background: '#3f1d1d',
      color: '#fecaca',
      cursor: 'pointer',
      marginLeft: 'auto',
    },
  });
  const restartBriefBtn = el('button', {
    text: '↺ Brief',
    title:
      'Rewind to the Brief step: clears candidates, the generated sheet, and approval, keeping the name + brief so you can re-synthesize.',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(148,163,184,0.5)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      display: 'none',
    },
  });
  const restartSheetBtn = el('button', {
    text: '↺ Sheet',
    title:
      'Rewind to the Sheet step: keeps the generated sheet and re-runs PostProcess onward. Generate still calls OpenAI again for a fresh sheet.',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(148,163,184,0.5)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      display: 'none',
    },
  });
  restartBriefBtn.addEventListener('click', () => {
    const item = getSelectedItem(queueState);
    if (!item) return;
    if (
      !window.confirm(
        `Rewind "${item.name}" to the Brief step? This clears its candidates, ` +
          'generated sheet, and approval (the name + brief are kept).',
      )
    ) {
      return;
    }
    queueState = queueUpdateItem(queueState, item.id, restartToBriefPatch(item));
    writeQueueState();
    debugTarget = null;
    renderPostprocessDebugger();
    renderQueue();
    renderWorkflowSelection();
    writeWorkflowState();
    setWorkflowStatus(
      `Rewound "${item.name}" to the Brief step. Synthesize to regenerate candidates.`,
      '#cbd5e1',
    );
  });
  restartSheetBtn.addEventListener('click', () => {
    const item = getSelectedItem(queueState);
    if (!item) return;
    if (!item.run) {
      setWorkflowStatus('No generated sheet to rewind to. Generate a sheet first.', '#fca5a5');
      return;
    }
    if (
      !window.confirm(
        `Rewind "${item.name}" to the Sheet step? This keeps the generated sheet ` +
          'and clears post-processing/approval so you can redo them.',
      )
    ) {
      return;
    }
    queueState = queueUpdateItem(queueState, item.id, restartToSheetPatch(item));
    writeQueueState();
    renderQueue();
    renderWorkflowSelection();
    writeWorkflowState();
    setWorkflowStatus(
      `Rewound "${item.name}" to the Sheet step. PostProcess reuses the sheet; ` +
        'Generate calls OpenAI again.',
      '#cbd5e1',
    );
  });

  // ── Reload from Azure ──────────────────────────────────────────────────────
  // Recover a run (its generated sheet + variants) that still lives in the
  // store after a worktree wiped the local queue. Lands the item at the Sheet
  // restart point so PostProcess can re-run against the existing sheet by
  // default (Generate is the explicit "call OpenAI again" path).
  let azureRunChoices: SidecarRunListEntry[] = [];
  const reloadRow = el('div', {
    style: {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      alignItems: 'center',
      marginBottom: '10px',
    },
  });
  const reloadLabel = el('span', {
    text: 'Reload from Azure:',
    style: { fontSize: '11px', color: '#94a3b8' },
  });
  const reloadStateFilter = el('select', {
    title: 'Filter runs by whether they were promoted into checked-in generated content.',
    style: {
      padding: '6px 8px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
      fontSize: '11px',
    },
  }) as HTMLSelectElement;
  for (const [value, label] of [
    ['all', 'All runs'],
    ['not-promoted', 'Needs review/action'],
    ['promoted', 'Already promoted'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    reloadStateFilter.append(opt);
  }
  const reloadSelect = el('select', {
    style: {
      flex: '1 1 320px',
      minWidth: '220px',
      padding: '6px 8px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
      fontSize: '11px',
    },
  }) as HTMLSelectElement;
  const reloadRefreshBtn = el('button', {
    text: '↻ Runs',
    title: 'List the runs available in the sidecar store (Azure or local).',
    style: {
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#0c4a6e',
      color: '#e0f2fe',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const reloadLoadBtn = el('button', {
    text: 'Load sheet',
    title: 'Reconstruct a queue item from the selected run at the Sheet step.',
    style: {
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(34,211,238,0.5)',
      background: '#083344',
      color: '#cffafe',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const reloadStatus = el('span', {
    text: '',
    style: { fontSize: '11px', color: '#64748b' },
  });
  const deleteRunBtn = el('button', {
    text: 'Delete run',
    title:
      'Delete the selected run from the sidecar store. Removes only that run — other runs and workflow state are left untouched.',
    style: {
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(248,113,113,0.5)',
      background: '#3f1d1d',
      color: '#fecaca',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  reloadRow.append(
    reloadLabel,
    reloadStateFilter,
    reloadSelect,
    reloadRefreshBtn,
    reloadLoadBtn,
    deleteRunBtn,
    reloadStatus,
  );
  const azureRunKey = (run: SidecarRunListEntry): string => `${run.briefId}::${run.runId}`;
  // Instant-first-paint cache (localStorage) for the run list, mirroring the
  // workflow-queue convention: the sidecar stays the source of truth, this only
  // avoids a blank dropdown while the slow `GET /api/runs` (one blob GET per run)
  // revalidates after a reload/navigation. Wrappers are shared by both pickers.
  const readCachedRuns = (filter: PromotedFilter): SidecarRunListEntry[] | null => {
    try {
      return readRunCache(window.localStorage.getItem(RUN_CACHE_STORAGE_KEY), filter);
    } catch {
      return null;
    }
  };
  const writeCachedRuns = (filter: PromotedFilter, runs: readonly SidecarRunListEntry[]): void => {
    try {
      window.localStorage.setItem(
        RUN_CACHE_STORAGE_KEY,
        writeRunCache(window.localStorage.getItem(RUN_CACHE_STORAGE_KEY), filter, runs),
      );
    } catch {
      // Ignore storage quota/serialization failures; the UI still works uncached.
    }
  };
  // Shared option-builder for the reload dropdown so the cache-hydrate and the
  // network-refresh paths render identically.
  const renderAzureRunOptions = (
    runs: readonly SidecarRunListEntry[],
    previousKey: string,
  ): void => {
    reloadSelect.replaceChildren();
    if (runs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No runs found in the store';
      reloadSelect.append(opt);
      return;
    }
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a run…';
    reloadSelect.append(placeholder);
    for (const run of runs) {
      const opt = document.createElement('option');
      opt.value = azureRunKey(run);
      const ts = run.timestamp ? new Date(run.timestamp).toLocaleString() : 'unknown time';
      const promoted = run.promotionState === 'promoted' ? 'promoted' : 'needs promotion';
      opt.textContent =
        `${run.briefId} · ${run.runId}` +
        `${run.hasJudge ? ' · judged' : ''}` +
        ` · ${promoted} · ${ts}`;
      reloadSelect.append(opt);
    }
    // Restore the prior selection if it still exists. Setting `.value`
    // programmatically does not fire `change`, so a refresh never auto-loads.
    reloadSelect.value = resolveRunPickerSelection(
      previousKey,
      runs.map((run) => azureRunKey(run)),
    );
  };
  // Serialize run loads (one at a time) and drop stale periodic-refresh responses
  // so a slow list can't clobber a newer one — or overwrite a just-loaded run.
  let azureLoadInFlight = false;
  let azureRefreshToken = 0;
  const AZURE_RUNS_REFRESH_MS = 15000;
  const setAzureControlsEnabled = (enabled: boolean): void => {
    reloadSelect.disabled = !enabled;
    reloadStateFilter.disabled = !enabled;
    reloadRefreshBtn.disabled = !enabled;
    reloadLoadBtn.disabled = !enabled;
    deleteRunBtn.disabled = !enabled;
  };
  const refreshAzureRuns = async (options: { silent?: boolean } = {}): Promise<void> => {
    // `silent` (init/background) skips the transient "Loading…" and the success
    // "N run(s)." writes so a periodic poll never stomps a "Loaded X." message;
    // it still surfaces errors.
    const silent = options.silent === true;
    const token = ++azureRefreshToken;
    // Capture the filter once so a mid-flight filter change can't mis-key the
    // cache write (a stale response is dropped by the token check anyway).
    const filter = normalizePromotedFilter(reloadStateFilter.value);
    // Preserve the operator's current selection (by stable key) across rebuilds.
    const previousKey = reloadSelect.value;
    if (!silent) {
      reloadStatus.textContent = 'Loading…';
    }
    try {
      const runs = await listSidecarRuns({ promoted: filter });
      // A newer refresh started while we awaited: discard this stale response.
      if (token !== azureRefreshToken) {
        return;
      }
      azureRunChoices = runs;
      renderAzureRunOptions(runs, previousKey);
      // Persist for instant first paint on the next reload/navigation. Only on a
      // successful fetch — a failed fetch must never clobber a good cache.
      writeCachedRuns(filter, runs);
      if (runs.length === 0) {
        if (!silent) {
          reloadStatus.textContent = 'No runs available.';
        }
        return;
      }
      if (!silent) {
        reloadStatus.textContent = `${runs.length} run(s).`;
      }
    } catch (err) {
      if (token !== azureRefreshToken) {
        return;
      }
      reloadStatus.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  // Instant first paint: fill the dropdown from the last cached run list for the
  // active filter so the operator sees runs immediately after a reload, before
  // the slow `/api/runs` revalidate returns. A `null` slot (never cached) is
  // left for the network refresh; a cached empty list (`[]` — the store
  // genuinely had no runs) paints the "no runs found" state via
  // `renderAzureRunOptions` rather than leaving a blank dropdown.
  const hydrateAzureRunsFromCache = (): void => {
    const filter = normalizePromotedFilter(reloadStateFilter.value);
    const cached = readCachedRuns(filter);
    if (!cached) {
      return;
    }
    azureRunChoices = cached;
    renderAzureRunOptions(cached, reloadSelect.value);
    reloadStatus.textContent =
      cached.length === 0
        ? 'Showing cached runs (none found) — refreshing…'
        : 'Showing cached runs — refreshing…';
  };
  // Reconstruct a queue item from the selected run at the Sheet step. Selecting a
  // run in the dropdown loads it immediately; the button is an explicit fallback.
  const loadSelectedAzureRun = async (): Promise<void> => {
    if (azureLoadInFlight) {
      return;
    }
    const key = reloadSelect.value;
    const run = key ? azureRunChoices.find((choice) => azureRunKey(choice) === key) : undefined;
    if (!run) {
      reloadStatus.textContent = 'Pick a run first.';
      return;
    }
    azureLoadInFlight = true;
    // Invalidate any in-flight (init/auto) refresh so a slow list can't rebuild
    // the dropdown or stomp the load status mid-load; it bails at its token check.
    ++azureRefreshToken;
    setAzureControlsEnabled(false);
    setButtonBusy(reloadLoadBtn, true, 'Load sheet', 'Loading…');
    reloadStatus.textContent = `Loading ${run.briefId}…`;
    try {
      // Reuse an existing queue item for this briefId, else create one.
      let target: QueueItem | undefined = queueState.items.find(
        (it) => it.kebabName === run.briefId,
      );
      if (target) {
        queueState = queueSelectItem(queueState, target.id);
      } else {
        queueState = queueAddItem(queueState, run.briefId, '', 'auto', 'manual');
        target = getSelectedItem(queueState) ?? undefined;
      }
      if (!target) {
        reloadStatus.textContent = 'Could not create a queue item.';
        return;
      }
      writeQueueState();
      const summary = (await fetchRunSummary(run.briefId, run.runId)) as {
        candidates?: RawGenerateCandidate[];
      };
      applyRunToQueue(target.id, run.briefId, run.runId, summary.candidates ?? [], {
        stage: 'sheet',
        status:
          `Reloaded ${run.briefId} (${run.runId}) from the store at the Sheet step. ` +
          'PostProcess reuses this sheet; Generate calls OpenAI again.',
        resetApproval: true,
      });
      reloadStatus.textContent = `Loaded ${run.briefId}.`;
    } catch (err) {
      reloadStatus.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      // If the run vanished from the store (deleted out-of-band since the cached
      // list was painted), reconcile so the dead option can't linger selectable.
      // Silent so the "Failed: …" message is preserved on a successful re-list.
      if (err instanceof Error && /\b404\b/.test(err.message)) {
        void refreshAzureRuns({ silent: true });
      }
    } finally {
      setButtonBusy(reloadLoadBtn, false, 'Load sheet', 'Loading…');
      azureLoadInFlight = false;
      setAzureControlsEnabled(true);
    }
  };
  // Poll the store so newly generated runs appear without a manual refresh, and
  // catch up immediately when the operator returns to the tab.
  const startAzureAutoRefresh = (): void => {
    window.setInterval(() => {
      if (azureLoadInFlight || document.visibilityState !== 'visible') {
        return;
      }
      void refreshAzureRuns({ silent: true });
    }, AZURE_RUNS_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !azureLoadInFlight) {
        void refreshAzureRuns({ silent: true });
      }
    });
  };
  reloadRefreshBtn.addEventListener('click', () => {
    void refreshAzureRuns();
  });
  reloadStateFilter.addEventListener('change', () => {
    // Paint this filter's cached slot instantly (incl. a cached empty list) so
    // switching filters after a reload doesn't wait on the slow list — and a
    // failed revalidate never leaves the previous filter's runs mislabeled.
    const filter = normalizePromotedFilter(reloadStateFilter.value);
    const cached = readCachedRuns(filter);
    if (cached) {
      azureRunChoices = cached;
      renderAzureRunOptions(cached, reloadSelect.value);
      reloadStatus.textContent = 'Showing cached runs — refreshing…';
    } else {
      // Never cached for this filter yet: clear the previous filter's options so
      // the wrong-filter list is never shown while the fetch is in flight.
      azureRunChoices = [];
      reloadSelect.replaceChildren();
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Loading runs…';
      reloadSelect.append(opt);
    }
    void refreshAzureRuns();
  });
  reloadSelect.addEventListener('change', () => {
    void loadSelectedAzureRun();
  });
  reloadLoadBtn.addEventListener('click', () => {
    void loadSelectedAzureRun();
  });
  deleteRunBtn.addEventListener('click', () => {
    void (async () => {
      // Share the load path's in-flight flag so a delete can't race a
      // "Load sheet" click or the 15s background auto-refresh (both bail while
      // `azureLoadInFlight` is set), which could otherwise reload a run into the
      // local queue moments before its artifacts are deleted.
      if (azureLoadInFlight) {
        return;
      }
      const key = reloadSelect.value;
      const run = key ? azureRunChoices.find((choice) => azureRunKey(choice) === key) : undefined;
      if (!run) {
        reloadStatus.textContent = 'Pick a run to delete first.';
        return;
      }
      const ok = window.confirm(
        `Delete run ${run.briefId} · ${run.runId} from the sidecar store? ` +
          'This removes only this run and cannot be undone.',
      );
      if (!ok) return;
      azureLoadInFlight = true;
      setAzureControlsEnabled(false);
      setButtonBusy(deleteRunBtn, true, 'Delete run', 'Deleting…');
      try {
        const result = await deleteSidecarRun(run.briefId, run.runId);
        reloadStatus.textContent = `Deleted ${result.deleted}.`;
      } catch (error) {
        reloadStatus.textContent = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        setButtonBusy(deleteRunBtn, false, 'Delete run', 'Deleting…');
        azureLoadInFlight = false;
        setAzureControlsEnabled(true);
        // Reconcile the dropdown whether the delete succeeded or hit a stale
        // 404 (run already gone), so the deleted option can't linger selected.
        // Silent so the "Deleted …"/"Delete failed …" status is preserved.
        await refreshAzureRuns({ silent: true });
      }
    })();
  });

  const requestManifestSection = el('div', {
    style: {
      display: 'grid',
      gap: '8px',
      marginBottom: '10px',
      padding: '8px',
      borderRadius: '8px',
      border: '1px solid rgba(148,163,184,0.25)',
      background: '#0f172a',
    },
  });
  const requestManifestHeader = el('div', {
    style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  });
  requestManifestHeader.append(
    el('span', { text: 'Asset request manifest:', style: { fontSize: '11px', color: '#94a3b8' } }),
  );
  const requestManifestSelect = el('select', {
    style: {
      padding: '6px 8px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
      fontSize: '11px',
    },
  }) as HTMLSelectElement;
  for (const [value, label] of [
    ['', 'Select manifest view…'],
    ['pending', 'Needs action'],
    ['claimed', 'Claimed / in progress'],
    ['rejected', 'Rejected'],
    ['all', 'All requests'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    requestManifestSelect.append(opt);
  }
  const requestManifestRefreshBtn = el('button', {
    text: '↻ Requests',
    style: {
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#0c4a6e',
      color: '#e0f2fe',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const requestManifestStatus = el('span', {
    text: 'Choose a manifest view to load requests.',
    style: { fontSize: '11px', color: '#64748b' },
  });
  requestManifestHeader.append(
    requestManifestSelect,
    requestManifestRefreshBtn,
    requestManifestStatus,
  );
  const requestManifestTableWrap = el('div', {
    style: {
      display: 'none',
      border: '1px solid rgba(148,163,184,0.2)',
      borderRadius: '8px',
      overflow: 'auto',
      maxHeight: '220px',
      background: '#020617',
    },
  });
  const requestManifestTable = el('table', { className: 'asset-table' });
  const requestManifestHead = document.createElement('thead');
  const requestManifestHeadRow = document.createElement('tr');
  for (const heading of ['Issue', 'Name', 'Brief', 'Status', 'Updated', 'Actions']) {
    requestManifestHeadRow.append(el('th', { text: heading }));
  }
  requestManifestHead.append(requestManifestHeadRow);
  const requestManifestBody = document.createElement('tbody');
  requestManifestTable.append(requestManifestHead, requestManifestBody);
  requestManifestTableWrap.append(requestManifestTable);
  requestManifestSection.append(requestManifestHeader, requestManifestTableWrap);
  const loadAssetRequestManifest = async (): Promise<void> => {
    const selected = requestManifestSelect.value;
    if (selected === '') {
      requestManifestTableWrap.style.display = 'none';
      requestManifestBody.replaceChildren();
      requestManifestStatus.textContent = 'Choose a manifest view to load requests.';
      return;
    }
    requestManifestStatus.textContent = 'Loading requests…';
    requestManifestTableWrap.style.display = 'block';
    try {
      const payload = await fetchJson<AssetRequestManifestResponse>(
        `${SIDECAR_BASE}/api/workflow/asset-requests?state=${encodeURIComponent(selected)}`,
      );
      requestManifestBody.replaceChildren();
      for (const entry of payload.entries ?? []) {
        const row = document.createElement('tr');
        const updatedAt = entry.rejectedAt ?? entry.claimedAt;
        const issueLink = el('a', {
          text: `#${entry.issueNumber}`,
          style: { color: '#93c5fd', textDecoration: 'underline' },
        });
        issueLink.href = `https://github.com/nalfeo/Crawler/issues/${entry.issueNumber}`;
        issueLink.target = '_blank';
        issueLink.rel = 'noopener noreferrer';
        const actionsCell = document.createElement('td');
        if (entry.state !== 'rejected') {
          const rejectBtn = el('button', {
            text: 'Reject',
            style: {
              padding: '3px 7px',
              borderRadius: '6px',
              border: '1px solid rgba(248,113,113,0.5)',
              background: '#3f1d1d',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: '11px',
            },
          }) as HTMLButtonElement;
          rejectBtn.addEventListener('click', () => {
            void (async () => {
              const reasonRaw = window.prompt(
                `Reject request #${entry.issueNumber} permanently? Optional reason:`,
                entry.rejectionReason ?? '',
              );
              if (reasonRaw === null) return;
              setButtonBusy(rejectBtn, true, 'Reject', 'Rejecting…');
              try {
                await fetchJson<{ ok: true }>(
                  `${SIDECAR_BASE}/api/workflow/asset-requests/reject`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      issueNumber: entry.issueNumber,
                      fingerprint: entry.fingerprint,
                      ...(reasonRaw.trim() ? { reason: reasonRaw.trim() } : {}),
                    }),
                  },
                );
                await loadAssetRequestManifest();
              } catch (error) {
                requestManifestStatus.textContent = `Reject failed: ${error instanceof Error ? error.message : String(error)}`;
              } finally {
                setButtonBusy(rejectBtn, false, 'Reject', 'Rejecting…');
              }
            })();
          });
          actionsCell.append(rejectBtn);
        } else {
          actionsCell.textContent = entry.rejectionReason
            ? `Reason: ${entry.rejectionReason}`
            : '—';
        }
        const issueCell = document.createElement('td');
        issueCell.append(issueLink);
        row.append(
          issueCell,
          el('td', { text: entry.name || '—' }),
          el('td', { text: entry.briefSentence || '—' }),
          el('td', { text: `${entry.state}${entry.isOpen ? '' : ' (closed)'}` }),
          el('td', { text: updatedAt ? new Date(updatedAt).toLocaleString() : '—' }),
          actionsCell,
        );
        requestManifestBody.append(row);
      }
      requestManifestStatus.textContent = `${payload.entries?.length ?? 0} request(s).`;
    } catch (error) {
      requestManifestStatus.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
      requestManifestBody.replaceChildren();
    }
  };
  requestManifestSelect.addEventListener('change', () => {
    void loadAssetRequestManifest();
  });
  requestManifestRefreshBtn.addEventListener('click', () => {
    void loadAssetRequestManifest();
  });

  workflowButtons.append(
    synthBtn,
    generateBtn,
    postprocessBtn,
    judgeBtn,
    forceJudgeBtn,
    cancelGenerateBtn,
    cancelStepBtn,
    launchWorkerBtn,
    metadataBtn,
    restartBriefBtn,
    restartSheetBtn,
    checkinBtn,
    removeItemBtn,
  );

  const generationProgress = el('div', {
    style: {
      display: 'none',
      margin: '0 0 10px 0',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(250,204,21,0.45)',
      background: 'rgba(66,32,6,0.55)',
      color: '#fde68a',
      fontSize: '12px',
      whiteSpace: 'pre-wrap',
    },
  });

  const workflowStatus = el('pre', {
    style: {
      margin: '0 0 10px 0',
      padding: '8px',
      borderRadius: '8px',
      border: '1px solid rgba(148,163,184,0.2)',
      background: '#0f172a',
      color: '#cbd5e1',
      fontSize: '11px',
      whiteSpace: 'pre-wrap',
    },
  });
  workflowStatus.textContent = 'Sidecar status: checking...';

  // Dedicated, render-proof home for the check-in success banner + filed-issue
  // link. The shared `workflowStatus` line is rewritten roughly once a second by
  // renderWorkflowSelection's poll (e.g. "Next: Judge"), which previously
  // clobbered the check-in result — making the filed-issue link vanish within a
  // second, before the operator could click it. Rendering it here lets the
  // result (and its clickable issue link) persist.
  const checkinResult = el('div', {
    style: {
      display: 'none',
      margin: '0 0 10px 0',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(132,204,22,0.45)',
      background: 'rgba(26,46,5,0.55)',
      color: '#bef264',
      fontSize: '12px',
      whiteSpace: 'pre-wrap',
    },
  });

  const synthResultsHost = el('div', {
    style: { marginBottom: '10px', display: 'grid', gap: '6px' },
  });
  const runResultsHost = el('div', {
    style: { display: 'grid', gap: '6px' },
  });
  workflowPanel.append(
    workflowTitle,
    workflowHint,
    composerRow,
    queueBar,
    reloadRow,
    requestManifestSection,
    activeItemLabel,
    stepperHost,
    workflowButtons,
    generationProgress,
    workflowStatus,
    checkinResult,
    synthResultsHost,
    runResultsHost,
  );
  shell.append(workflowPanel);

  const debuggerPanel = el('section', {
    style: {
      marginTop: '16px',
      border: '1px solid rgba(229,231,235,0.2)',
      borderRadius: '10px',
      background: '#0b1220',
      padding: '12px',
    },
  });
  const debuggerTitle = el('h2', {
    text: 'Postprocess debugger',
    style: { margin: '0 0 8px 0', fontSize: '16px', color: '#e5e7eb' },
  });
  const debuggerHint = el('p', {
    text: 'Focused tool for pipeline steps, source-sheet slicing, and live postprocess tracing.',
    style: { margin: '0 0 10px 0', fontSize: '12px', color: '#93c5fd' },
  });
  const debuggerTargetLabel = el('div', {
    text: 'Debug target: none (click Debug on a generated candidate)',
    style: { marginBottom: '10px', fontSize: '12px', color: '#cbd5e1' },
  });
  const debuggerPickerRow = el('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr auto auto',
      gap: '6px',
      marginBottom: '6px',
      alignItems: 'end',
    },
  });
  const debuggerRunSelect = document.createElement('select');
  Object.assign(debuggerRunSelect.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  const debuggerVariantSelect = document.createElement('select');
  Object.assign(debuggerVariantSelect.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  const debuggerRefreshPickerBtn = el('button', {
    text: 'Refresh runs',
    style: {
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const debuggerLoadPickerBtn = el('button', {
    text: 'Load selected',
    style: {
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#082f49',
      color: '#e0f2fe',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  debuggerPickerRow.append(debuggerRunSelect, debuggerRefreshPickerBtn, debuggerLoadPickerBtn);
  const debuggerPickerStatus = el('div', {
    text: 'Available runs: loading…',
    style: { marginBottom: '8px', fontSize: '11px', color: '#94a3b8' },
  });
  const debuggerTargetForm = el('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 80px auto',
      gap: '6px',
      marginBottom: '10px',
      alignItems: 'end',
    },
  });
  const briefIdInput = document.createElement('input');
  briefIdInput.type = 'text';
  briefIdInput.placeholder = 'brief id';
  Object.assign(briefIdInput.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  const runIdInput = document.createElement('input');
  runIdInput.type = 'text';
  runIdInput.placeholder = 'run id';
  Object.assign(runIdInput.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  const variantIndexInput = document.createElement('input');
  variantIndexInput.type = 'number';
  variantIndexInput.min = '0';
  variantIndexInput.step = '1';
  variantIndexInput.value = '0';
  variantIndexInput.placeholder = '#';
  Object.assign(variantIndexInput.style, {
    width: '72px',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  const loadTargetBtn = el('button', {
    text: 'Load target',
    style: {
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  debuggerTargetForm.append(briefIdInput, runIdInput, variantIndexInput, loadTargetBtn);
  const tweakPanel = el('div', {
    style: {
      marginTop: '10px',
      padding: '10px',
      borderRadius: '8px',
      border: '1px solid rgba(148,163,184,0.18)',
      background: 'rgba(15,23,42,0.45)',
    },
  });
  const tweakTitle = el('div', {
    text: 'Config — background removal',
    style: { fontSize: '11px', color: '#93c5fd', marginBottom: '8px', fontWeight: '600' },
  });
  const tweakIntro = el('div', {
    text: `All values are squared Euclidean RGB distances in 8-bit channel space. 0 means exact color match; ${MAX_BACKGROUND_TOLERANCE_SQ.toLocaleString()} is the maximum possible RGB distance.`,
    style: { fontSize: '10px', color: '#94a3b8', marginBottom: '8px', lineHeight: '1.4' },
  });
  const tweakGrid = el('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
      gap: '8px',
      marginBottom: '8px',
    },
  });
  const makeTweakField = (
    label: string,
    defaultValue: number,
    description: string,
  ): { wrap: HTMLElement; input: HTMLInputElement } => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(MAX_BACKGROUND_TOLERANCE_SQ);
    input.step = '1';
    input.value = String(defaultValue);
    Object.assign(input.style, {
      width: '100%',
      padding: '4px 6px',
      borderRadius: '4px',
      border: '1px solid #475569',
      background: '#0f172a',
      color: '#e2e8f0',
      fontSize: '11px',
    });
    const wrap = el('label', {
      style: { display: 'grid', gap: '4px', fontSize: '10px', color: '#94a3b8' },
    });
    const detail = el('span', {
      text: description,
      style: { fontSize: '10px', color: '#64748b', lineHeight: '1.4' },
    });
    wrap.append(el('span', { text: label }), input, detail);
    return { wrap, input };
  };
  const colorTolField = makeTweakField(
    'Color tolerance (sq)',
    DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
    `Flood-fill background match radius before cleanup. Units: squared RGB distance. Min 0, max ${MAX_BACKGROUND_TOLERANCE_SQ.toLocaleString()}, default ${DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq.toLocaleString()}.`,
  );
  const fringeTolField = makeTweakField(
    'Fringe tolerance (sq)',
    DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
    `Edge cleanup threshold for removing near-background leftovers after flood fill. Units: squared RGB distance. Min 0, max ${MAX_BACKGROUND_TOLERANCE_SQ.toLocaleString()}, default ${DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq.toLocaleString()}.`,
  );
  tweakGrid.append(colorTolField.wrap, fringeTolField.wrap);
  const tweakButtonRow = el('div', {
    style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
  });
  const applyTweaksBtn = el('button', {
    text: 'Apply tweaks',
    style: {
      padding: '4px 8px',
      borderRadius: '6px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#082f49',
      color: '#e0f2fe',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const resetTweaksBtn = el('button', {
    text: 'Reset to defaults',
    style: {
      padding: '4px 8px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const tweakStatus = el('span', {
    text: 'Using default background-removal parameters.',
    style: { fontSize: '10px', color: '#64748b' },
  });
  tweakButtonRow.append(applyTweaksBtn, resetTweaksBtn, tweakStatus);
  tweakPanel.append(tweakTitle, tweakIntro, tweakGrid, tweakButtonRow);
  const finalAdjustStatus = el('span', {
    text: 'Click a pixel in the final image to set the anchor.',
    style: { fontSize: '10px', color: '#94a3b8' },
  });
  const manualAnchorXInput = document.createElement('input');
  manualAnchorXInput.type = 'number';
  manualAnchorXInput.step = '1';
  manualAnchorXInput.style.width = '72px';
  manualAnchorXInput.style.background = '#020617';
  manualAnchorXInput.style.color = '#e2e8f0';
  manualAnchorXInput.style.border = '1px solid rgba(148,163,184,0.4)';
  manualAnchorXInput.style.borderRadius = '6px';
  const manualAnchorYInput = document.createElement('input');
  manualAnchorYInput.type = 'number';
  manualAnchorYInput.step = '1';
  manualAnchorYInput.style.width = '72px';
  manualAnchorYInput.style.background = '#020617';
  manualAnchorYInput.style.color = '#e2e8f0';
  manualAnchorYInput.style.border = '1px solid rgba(148,163,184,0.4)';
  manualAnchorYInput.style.borderRadius = '6px';
  const manualWeaponAnchorXInput = document.createElement('input');
  manualWeaponAnchorXInput.type = 'number';
  manualWeaponAnchorXInput.step = '1';
  manualWeaponAnchorXInput.style.width = '72px';
  manualWeaponAnchorXInput.style.background = '#020617';
  manualWeaponAnchorXInput.style.color = '#e2e8f0';
  manualWeaponAnchorXInput.style.border = '1px solid rgba(148,163,184,0.4)';
  manualWeaponAnchorXInput.style.borderRadius = '6px';
  const manualWeaponAnchorYInput = document.createElement('input');
  manualWeaponAnchorYInput.type = 'number';
  manualWeaponAnchorYInput.step = '1';
  manualWeaponAnchorYInput.style.width = '72px';
  manualWeaponAnchorYInput.style.background = '#020617';
  manualWeaponAnchorYInput.style.color = '#e2e8f0';
  manualWeaponAnchorYInput.style.border = '1px solid rgba(148,163,184,0.4)';
  manualWeaponAnchorYInput.style.borderRadius = '6px';
  const applyScopeSelect = document.createElement('select');
  applyScopeSelect.style.background = '#020617';
  applyScopeSelect.style.color = '#e2e8f0';
  applyScopeSelect.style.border = '1px solid rgba(148,163,184,0.4)';
  applyScopeSelect.style.borderRadius = '6px';
  applyScopeSelect.style.fontSize = '11px';
  const scopeThisOption = document.createElement('option');
  scopeThisOption.value = 'variant';
  scopeThisOption.textContent = 'Apply to this variant';
  const scopeAllOption = document.createElement('option');
  scopeAllOption.value = 'all';
  scopeAllOption.textContent = 'Apply to all variants';
  applyScopeSelect.append(scopeThisOption, scopeAllOption);
  const facingDirectionSelect = document.createElement('select');
  facingDirectionSelect.style.background = '#020617';
  facingDirectionSelect.style.color = '#e2e8f0';
  facingDirectionSelect.style.border = '1px solid rgba(148,163,184,0.4)';
  facingDirectionSelect.style.borderRadius = '6px';
  facingDirectionSelect.style.fontSize = '11px';
  const facingRightOption = document.createElement('option');
  facingRightOption.value = 'right';
  facingRightOption.textContent = 'Facing right →';
  const facingLeftOption = document.createElement('option');
  facingLeftOption.value = 'left';
  facingLeftOption.textContent = 'Facing left ←';
  facingDirectionSelect.append(facingRightOption, facingLeftOption);
  const applyChangesBtn = el('button', {
    text: 'Apply changes',
    style: {
      padding: '4px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#082f49',
      color: '#e0f2fe',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const resetAnchorBtn = el('button', {
    text: 'Reset anchor',
    style: {
      padding: '4px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const returnToWorkflowBtn = el('button', {
    text: 'Return to workflow',
    style: {
      padding: '4px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '11px',
    },
  }) as HTMLButtonElement;
  const debuggerTraceHost = el('div', { style: { marginTop: '8px' } });
  debuggerPanel.append(
    debuggerTitle,
    debuggerHint,
    debuggerTargetLabel,
    debuggerPickerRow,
    debuggerPickerStatus,
    debuggerTargetForm,
    debuggerTraceHost,
  );
  shell.append(debuggerPanel);
  const showSpriteWorkflow = isSpriteWorkflowPage;
  controls.style.display = showSpriteWorkflow ? 'flex' : 'none';
  summary.style.display = showSpriteWorkflow ? 'grid' : 'none';
  manifestState.style.display = showSpriteWorkflow ? 'block' : 'none';
  tableWrap.style.display = showSpriteWorkflow ? 'block' : 'none';
  emptyState.style.display = showSpriteWorkflow ? emptyState.style.display : 'none';
  workflowPanel.style.display = showSpriteWorkflow ? 'block' : 'none';
  debuggerPanel.style.display = isPostprocessPage ? 'block' : 'none';

  let reports: FloorArtPlanReport[] = [];
  let manifestError: string | null = null;
  // Variant-unique keys (`<briefId>-var-<N>`) currently present in the approved
  // manifest. Refreshed by recompute(). Used to block exact-duplicate approvals
  // and to confirm before approving an additional variant for the same brief.
  let approvedVariantKeys = new Set<string>();
  let selectedAssetId: string | null = null;
  let selectedCandidatePath: string | null = null;
  let promotedBriefPath: string | null = null;
  let currentRun: WorkflowRunState | null = null;
  let debugTarget: PostprocessDebugTarget | null = null;
  let debuggerRenderToken = 0;
  let rawSheetRenderToken = 0;
  let rerenderPostprocessPipeline: (() => void) | null = null;
  let appliedBackgroundTweaks: BackgroundTweakState = {
    colorToleranceSq: DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
    fringeToleranceSq: DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
  };
  let pendingPostprocessMode: 'default' | 'replace' | 'reset' = 'default';
  let manualAnchorOverride: ManualAnchorState | null = null;
  let manualWeaponAnchorOverride: ManualAnchorState | null = null;
  let pendingManualWeaponAnchorClear = false;
  let facingDirection: FacingDirection = 'right';
  let applyScopeSelection: 'variant' | 'all' = 'variant';
  let pendingManualAnchorClear = false;
  let derivedAnchorForDebugVariant: AnchorMarkerState | null = null;
  let queueState: QueueState = createEmptyQueue();
  const pendingGenerationPolls = new Set<string>();
  // In-flight AbortControllers for the synchronous generate POST, keyed by
  // item id, so the Cancel button can abort a blocking request. Queued-path
  // polling is stopped instead by resetting the item's stage (see Cancel).
  const pendingGenerateAborts = new Map<string, AbortController>();
  // In-flight PostProcess / Judge steps, keyed by item id (mirrors
  // `pendingGenerateAborts`). Tracked so the shared Cancel button can abort the
  // blocking POST and restore that item's prior stage (enabling retry). Keyed per
  // item — not a lone field — because selecting a different queue item is ungated,
  // so a user can start a step on item A, switch to B, and start a step on B; both
  // must remain independently cancellable.
  const inFlightSteps = new Map<
    string,
    {
      readonly kind: 'postprocess' | 'judge';
      readonly abort: AbortController;
      readonly priorStage: WorkflowStage;
    }
  >();
  // Which step last failed for an item, so the status line can name it and tell
  // the user to re-click that button to requeue. Cleared when the step is
  // retried, cancelled, or succeeds.
  const lastFailedStep = new Map<string, 'postprocess' | 'judge'>();
  // Which step was last cancelled for an item. Kept sticky (like lastFailedStep)
  // so the "Canceled X — click X to retry" status survives any later re-render
  // (e.g. a slow boot task finishing after the cancel and re-deriving "Next: X").
  // Cleared when the step is retried or succeeds.
  const lastCanceledStep = new Map<string, 'postprocess' | 'judge'>();
  // Poll-attempt counters for the queued path, surfaced in the live progress
  // line. Ephemeral: cleared when generation ends or is cancelled, and reset
  // (not persisted) on reload when polling auto-resumes.
  const generationPollAttempts = new Map<string, number>();
  // Sidecar queue backend (`noop` | `azure-queue`), captured from /api/health
  // so the progress line can name it and tune the "is the worker running?"
  // hint. Null until the first health check resolves.
  let sidecarQueueBackend: string | null = null;
  // Latest in-process worker snapshot from /api/health (`worker` field). Null
  // until the first health check resolves, or when an older sidecar omits it.
  // Drives the "Launch worker" button visibility and the queued-stall hint.
  let sidecarWorker: {
    running: boolean;
    processed: number;
    failed: number;
    lastError: string | null;
  } | null = null;

  // --- Durable workflow-state sync ------------------------------------------
  // The sidecar (Azure Blob in production) is the source of truth for the
  // workflow queue; localStorage is only a cache for instant first paint and
  // offline use. `writeQueueState` keeps writing the cache AND debounces a
  // write-through PUT to the sidecar, guarded by a content-hash ETag so a
  // stale tab can't silently clobber a newer queue.
  const WORKFLOW_STATE_URL = `${SIDECAR_BASE}/api/workflow/state`;
  const WORKFLOW_STATE_SYNC_DEBOUNCE_MS = 500;
  let workflowStateEtag: string | null = null;
  let workflowStateSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let workflowStatePutInFlight = false;
  let workflowStatePending = false;

  const putWorkflowState = async (): Promise<void> => {
    // Coalesce: if a PUT is already running, mark that another is needed and
    // let the in-flight one re-fire on completion with the latest queueState.
    if (workflowStatePutInFlight) {
      workflowStatePending = true;
      return;
    }
    workflowStatePutInFlight = true;
    let retryAfterConflict = false;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (workflowStateEtag) {
        headers['If-Match'] = workflowStateEtag;
      }
      const res = await fetch(WORKFLOW_STATE_URL, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ state: queueState }),
      });
      const body = (await res.json().catch(() => null)) as { etag?: unknown } | null;
      const serverEtag = body && typeof body.etag === 'string' ? body.etag : null;
      if (res.ok) {
        workflowStateEtag = serverEtag;
      } else if (res.status === 409) {
        // Another writer won. Adopt the server's current ETag and retry once
        // (debounced) so our latest local edits win for the global queue.
        workflowStateEtag = serverEtag;
        retryAfterConflict = true;
      }
    } catch {
      // Sidecar unreachable; the localStorage cache still holds the latest
      // state and a later mutation will retry the write-through.
    } finally {
      workflowStatePutInFlight = false;
      if (workflowStatePending) {
        workflowStatePending = false;
        void putWorkflowState();
      } else if (retryAfterConflict) {
        scheduleWorkflowStateSync();
      }
    }
  };

  function scheduleWorkflowStateSync(): void {
    if (workflowStateSyncTimer !== null) {
      clearTimeout(workflowStateSyncTimer);
    }
    workflowStateSyncTimer = setTimeout(() => {
      workflowStateSyncTimer = null;
      void putWorkflowState();
    }, WORKFLOW_STATE_SYNC_DEBOUNCE_MS);
  }

  const writeQueueState = (): void => {
    try {
      window.localStorage.setItem(QUEUE_STORAGE_KEY, serializeQueue(queueState));
    } catch {
      // Ignore storage failures; the UI still works without persistence.
    }
    // Write-through to the durable sidecar store (debounced to coalesce bursts).
    scheduleWorkflowStateSync();
  };
  try {
    queueState = deserializeQueue(window.localStorage.getItem(QUEUE_STORAGE_KEY));
  } catch {
    queueState = createEmptyQueue();
  }
  const workflowStorageKey = 'crawler.devtools.sprite-generation-workflow-state.v1';
  const workflowStorageKeyLegacy = 'crawler.devtools.floor-art.workflow-state.v1';
  const readWorkflowState = (): PersistedFloorArtWorkflowState | null => {
    try {
      const raw =
        window.localStorage.getItem(workflowStorageKey) ??
        window.localStorage.getItem(workflowStorageKeyLegacy);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<PersistedFloorArtWorkflowState>;
      return {
        selectedAssetId: typeof parsed.selectedAssetId === 'string' ? parsed.selectedAssetId : null,
        queuedAssetIds: Array.isArray(parsed.queuedAssetIds)
          ? parsed.queuedAssetIds.filter((value): value is string => typeof value === 'string')
          : [],
        selectedCandidatePath:
          typeof parsed.selectedCandidatePath === 'string' ? parsed.selectedCandidatePath : null,
        promotedBriefPath:
          typeof parsed.promotedBriefPath === 'string' ? parsed.promotedBriefPath : null,
        currentRun:
          parsed.currentRun && typeof parsed.currentRun === 'object'
            ? (parsed.currentRun as WorkflowRunState)
            : null,
        debugTarget:
          parsed.debugTarget && typeof parsed.debugTarget === 'object'
            ? (parsed.debugTarget as PostprocessDebugTarget)
            : null,
        oneLinerValue: typeof parsed.oneLinerValue === 'string' ? parsed.oneLinerValue : '',
        selectedPlanId: typeof parsed.selectedPlanId === 'string' ? parsed.selectedPlanId : null,
        selectedStatus: typeof parsed.selectedStatus === 'string' ? parsed.selectedStatus : 'all',
        searchQuery: typeof parsed.searchQuery === 'string' ? parsed.searchQuery : '',
      };
    } catch {
      return null;
    }
  };
  const writeWorkflowState = (): void => {
    const snapshot: PersistedFloorArtWorkflowState = {
      selectedAssetId,
      queuedAssetIds: [],
      selectedCandidatePath,
      promotedBriefPath,
      currentRun,
      debugTarget,
      oneLinerValue: '',
      selectedPlanId: planSelect.value || null,
      selectedStatus: statusFilter.value,
      searchQuery: searchInput.value,
    };
    try {
      window.localStorage.setItem(workflowStorageKey, JSON.stringify(snapshot));
    } catch {
      // Ignore storage failures; the UI still works without persistence.
    }
  };
  const restoredWorkflowState = readWorkflowState();
  if (restoredWorkflowState) {
    selectedAssetId = restoredWorkflowState.selectedAssetId;
    selectedCandidatePath = restoredWorkflowState.selectedCandidatePath;
    promotedBriefPath = restoredWorkflowState.promotedBriefPath;
    currentRun = restoredWorkflowState.currentRun;
    debugTarget = restoredWorkflowState.debugTarget;
    if (restoredWorkflowState.selectedPlanId) {
      planSelect.value = restoredWorkflowState.selectedPlanId;
    }
    statusFilter.value = restoredWorkflowState.selectedStatus;
    searchInput.value = restoredWorkflowState.searchQuery;
  }
  const debugTargetFromUrl = parseDebugTargetFromUrl();
  if (debugTargetFromUrl) {
    briefIdInput.value = debugTargetFromUrl.briefId;
    runIdInput.value = debugTargetFromUrl.runId;
    variantIndexInput.value = String(debugTargetFromUrl.variantIndex);
    debugTarget = debugTargetFromUrl;
  }
  const syncTweakInputsFromState = (): void => {
    colorTolField.input.value = String(appliedBackgroundTweaks.colorToleranceSq);
    fringeTolField.input.value = String(appliedBackgroundTweaks.fringeToleranceSq);
    manualAnchorXInput.value = manualAnchorOverride ? String(manualAnchorOverride.x) : '';
    manualAnchorYInput.value = manualAnchorOverride ? String(manualAnchorOverride.y) : '';
    manualWeaponAnchorXInput.value = manualWeaponAnchorOverride
      ? String(manualWeaponAnchorOverride.x)
      : '';
    manualWeaponAnchorYInput.value = manualWeaponAnchorOverride
      ? String(manualWeaponAnchorOverride.y)
      : '';
    facingDirectionSelect.value = facingDirection;
    applyScopeSelect.value = applyScopeSelection;
    resetAnchorBtn.disabled = manualAnchorOverride === null && !pendingManualAnchorClear;
    finalAdjustStatus.textContent = manualAnchorOverride
      ? `Anchor set at (${manualAnchorOverride.x}, ${manualAnchorOverride.y}).`
      : derivedAnchorForDebugVariant
        ? `Current derived anchor at (${derivedAnchorForDebugVariant.x}, ${derivedAnchorForDebugVariant.y}).`
        : 'Click a pixel in the final image to set the anchor.';
  };
  const rerenderDebuggerAfterTweaks = (): void => {
    if (rerenderPostprocessPipeline) {
      rerenderPostprocessPipeline();
      return;
    }
    renderPostprocessDebugger();
  };
  const parseTweakField = (input: HTMLInputElement): number | null => {
    const parsed = Number.parseInt(input.value, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_BACKGROUND_TOLERANCE_SQ) return null;
    return parsed;
  };
  const applyBackgroundTweaksFromInputs = (): boolean => {
    const color = parseTweakField(colorTolField.input);
    const fringe = parseTweakField(fringeTolField.input);
    if (color === null || fringe === null) {
      tweakStatus.textContent = `Invalid tweak values; use integers from 0 to ${MAX_BACKGROUND_TOLERANCE_SQ.toLocaleString()}.`;
      tweakStatus.style.color = '#fca5a5';
      return false;
    }
    appliedBackgroundTweaks = {
      colorToleranceSq: color,
      fringeToleranceSq: fringe,
    };
    pendingPostprocessMode = 'replace';
    tweakStatus.textContent = 'Tweaks applied.';
    tweakStatus.style.color = '#93c5fd';
    return true;
  };
  applyTweaksBtn.addEventListener('click', () => {
    if (!applyBackgroundTweaksFromInputs()) return;
    if (debugTarget) {
      rerenderDebuggerAfterTweaks();
    }
  });
  resetTweaksBtn.addEventListener('click', () => {
    appliedBackgroundTweaks = {
      colorToleranceSq: DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
      fringeToleranceSq: DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
    };
    manualAnchorOverride = null;
    manualWeaponAnchorOverride = null;
    facingDirection = 'right';
    pendingPostprocessMode = 'reset';
    syncTweakInputsFromState();
    tweakStatus.textContent = 'Reset to defaults.';
    tweakStatus.style.color = '#93c5fd';
    if (debugTarget) {
      rerenderDebuggerAfterTweaks();
    }
  });
  const syncManualAnchorFromInputs = (): void => {
    if (!debugTarget) return;
    const x = Number.parseInt(manualAnchorXInput.value, 10);
    const y = Number.parseInt(manualAnchorYInput.value, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pendingManualAnchorClear = false;
    pendingPostprocessMode = 'replace';
    manualAnchorOverride = {
      variantIndex: debugTarget.variantIndex,
      x,
      y,
      ...(applyScopeSelection === 'all' ? { applyToAllVariants: true } : {}),
    };
    syncTweakInputsFromState();
    finalAdjustStatus.textContent = `Anchor set to (${x}, ${y}). Click Apply changes to persist.`;
    finalAdjustStatus.style.color = '#93c5fd';
    rerenderDebuggerAfterTweaks();
  };
  const syncManualWeaponAnchorFromInputs = (): void => {
    if (!debugTarget) return;
    const x = Number.parseInt(manualWeaponAnchorXInput.value, 10);
    const y = Number.parseInt(manualWeaponAnchorYInput.value, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pendingManualWeaponAnchorClear = false;
    pendingPostprocessMode = 'replace';
    manualWeaponAnchorOverride = {
      variantIndex: debugTarget.variantIndex,
      x,
      y,
      ...(applyScopeSelection === 'all' ? { applyToAllVariants: true } : {}),
    };
    syncTweakInputsFromState();
  };
  manualAnchorXInput.addEventListener('change', syncManualAnchorFromInputs);
  manualAnchorYInput.addEventListener('change', syncManualAnchorFromInputs);
  manualWeaponAnchorXInput.addEventListener('change', syncManualWeaponAnchorFromInputs);
  manualWeaponAnchorYInput.addEventListener('change', syncManualWeaponAnchorFromInputs);
  applyScopeSelect.addEventListener('change', () => {
    applyScopeSelection = applyScopeSelect.value === 'all' ? 'all' : 'variant';
    if (manualAnchorOverride) {
      pendingPostprocessMode = 'replace';
      manualAnchorOverride = {
        variantIndex: manualAnchorOverride.variantIndex,
        x: manualAnchorOverride.x,
        y: manualAnchorOverride.y,
        ...(applyScopeSelection === 'all' ? { applyToAllVariants: true } : {}),
      };
      syncTweakInputsFromState();
      finalAdjustStatus.textContent = `Anchor scope set to ${applyScopeSelection === 'all' ? 'all variants' : 'current variant'}. Click Apply changes to persist.`;
      finalAdjustStatus.style.color = '#93c5fd';
      rerenderDebuggerAfterTweaks();
    }
  });
  facingDirectionSelect.addEventListener('change', () => {
    facingDirection = facingDirectionSelect.value === 'left' ? 'left' : 'right';
    pendingPostprocessMode = 'replace';
    rerenderDebuggerAfterTweaks();
  });
  resetAnchorBtn.addEventListener('click', () => {
    manualAnchorOverride = null;
    pendingManualAnchorClear = true;
    pendingPostprocessMode = 'replace';
    syncTweakInputsFromState();
    finalAdjustStatus.textContent = 'Manual anchor reset. Click Apply changes to persist.';
    finalAdjustStatus.style.color = '#93c5fd';
    rerenderDebuggerAfterTweaks();
  });
  returnToWorkflowBtn.addEventListener('click', () => {
    if (!debugTarget) {
      window.location.href = devtoolsPageHref(DEVTOOLS_PAGE_SPRITE_WORKFLOW);
      return;
    }
    window.location.href = devtoolsPageHref(DEVTOOLS_PAGE_SPRITE_WORKFLOW, {
      briefId: debugTarget.briefId,
      runId: debugTarget.runId,
    });
  });
  syncTweakInputsFromState();
  let debuggerRuns: SidecarRunListEntry[] = [];
  const debuggerVariantCache = new Map<string, number[]>();
  const makeRunKey = (briefId: string, runId: string): string => `${briefId}::${runId}`;
  const findRunByKey = (key: string): SidecarRunListEntry | null => {
    for (const run of debuggerRuns) {
      if (makeRunKey(run.briefId, run.runId) === key) return run;
    }
    return null;
  };
  const setDebuggerVariantOptions = (indices: number[], preferredIndex?: number): void => {
    debuggerVariantSelect.replaceChildren();
    if (indices.length === 0) {
      const option = document.createElement('option');
      option.value = '0';
      option.textContent = '#0';
      debuggerVariantSelect.append(option);
      debuggerVariantSelect.value = '0';
      return;
    }
    for (const index of indices) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `#${index}`;
      debuggerVariantSelect.append(option);
    }
    const fallback = String(indices[0]);
    const preferred = preferredIndex !== undefined ? String(preferredIndex) : '';
    debuggerVariantSelect.value = indices.some((index) => String(index) === preferred)
      ? preferred
      : fallback;
  };
  const populateDebuggerRunOptions = (): void => {
    debuggerRunSelect.replaceChildren();
    if (debuggerRuns.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No runs available';
      debuggerRunSelect.append(option);
      debuggerRunSelect.value = '';
      return;
    }
    for (const run of debuggerRuns) {
      const option = document.createElement('option');
      option.value = makeRunKey(run.briefId, run.runId);
      const countSuffix = run.candidateCount === null ? '' : ` (${run.candidateCount} variants)`;
      option.textContent = `${run.briefId} / ${run.runId}${countSuffix}`;
      debuggerRunSelect.append(option);
    }
    if (!debuggerRunSelect.value) {
      const firstRun = debuggerRuns[0];
      if (firstRun) {
        debuggerRunSelect.value = makeRunKey(firstRun.briefId, firstRun.runId);
      }
    }
  };
  const loadDebuggerVariantOptions = async (preferredIndex?: number): Promise<void> => {
    const run = findRunByKey(debuggerRunSelect.value);
    if (!run) {
      setDebuggerVariantOptions([0], preferredIndex);
      return;
    }
    const key = makeRunKey(run.briefId, run.runId);
    const cached = debuggerVariantCache.get(key);
    if (cached) {
      setDebuggerVariantOptions(cached, preferredIndex);
      return;
    }
    debuggerPickerStatus.textContent = 'Loading variants…';
    try {
      const summary = await fetchRunSummary(run.briefId, run.runId);
      const indices = extractVariantIndices(summary);
      debuggerVariantCache.set(key, indices);
      setDebuggerVariantOptions(indices, preferredIndex);
      debuggerPickerStatus.textContent = `Available runs: ${debuggerRuns.length}`;
    } catch (error) {
      setDebuggerVariantOptions([0], preferredIndex);
      debuggerPickerStatus.textContent = `Failed to load variants: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const refreshDebuggerRuns = async (options: { background?: boolean } = {}): Promise<void> => {
    const background = options.background === true;
    // A background revalidate with a usable cached list must not disrupt the
    // operator: keep the buttons live and the current options in place.
    const quiet = background && debuggerRuns.length > 0;
    // Preserve the operator's in-progress dropdown pick across the rebuild.
    const previousKey = debuggerRunSelect.value;
    if (!quiet) {
      debuggerPickerStatus.textContent = 'Loading available runs…';
      debuggerRefreshPickerBtn.disabled = true;
      debuggerLoadPickerBtn.disabled = true;
    }
    try {
      const runs = await listSidecarRuns();
      debuggerRuns = runs;
      populateDebuggerRunOptions();
      // Restore priority: the operator's in-progress selection (survives a
      // background refresh) → the loaded debugTarget → the first run (populate's
      // default when this resolves to '').
      const debugTargetKey = debugTarget ? makeRunKey(debugTarget.briefId, debugTarget.runId) : '';
      const restoreKey = resolveRunPickerSelection(
        previousKey,
        debuggerRuns.map((run) => makeRunKey(run.briefId, run.runId)),
        debugTargetKey,
      );
      if (restoreKey) {
        debuggerRunSelect.value = restoreKey;
      }
      await loadDebuggerVariantOptions(debugTarget?.variantIndex);
      debuggerPickerStatus.textContent = `Available runs: ${debuggerRuns.length}`;
      // Persist for instant first paint on the next reload.
      writeCachedRuns('all', runs);
    } catch (error) {
      if (quiet) {
        // Keep the cached options usable; just note the background refresh failed.
        debuggerPickerStatus.textContent = `Refresh failed (showing cached runs): ${error instanceof Error ? error.message : String(error)}`;
      } else {
        debuggerRuns = [];
        populateDebuggerRunOptions();
        setDebuggerVariantOptions([0], 0);
        debuggerPickerStatus.textContent = `Failed to load runs: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      debuggerRefreshPickerBtn.disabled = false;
      debuggerLoadPickerBtn.disabled = false;
    }
  };
  // Instant first paint for the debugger picker: fill the dropdown from the
  // cached run list, restore the loaded debugTarget, and warm the variant cache
  // (one fast blob GET) so Load has real indices. A `null` slot (never cached)
  // bails to the background refresh; a cached empty list (`[]`) paints the "no
  // runs available" state via `populateDebuggerRunOptions` instead of a blank
  // dropdown. The slow list revalidates in the background afterwards.
  const hydrateDebuggerRunsFromCache = (): void => {
    const cached = readCachedRuns('all');
    if (!cached) {
      return;
    }
    debuggerRuns = cached;
    populateDebuggerRunOptions();
    const targetKey = debugTarget ? makeRunKey(debugTarget.briefId, debugTarget.runId) : '';
    if (targetKey && findRunByKey(targetKey)) {
      debuggerRunSelect.value = targetKey;
    }
    void loadDebuggerVariantOptions(debugTarget?.variantIndex);
    debuggerPickerStatus.textContent = `Showing cached runs (${cached.length}) — refreshing…`;
  };

  const setWorkflowStatus = (message: string, color = '#cbd5e1') => {
    workflowStatus.style.color = color;
    workflowStatus.textContent = message;
  };

  const STAGE_BADGES: Readonly<Record<WorkflowStage, { text: string; color: string }>> = {
    draft: { text: 'Draft', color: '#94a3b8' },
    synthesizing: { text: 'Synthesizing…', color: '#38bdf8' },
    candidates: { text: 'Choose candidate', color: '#7dd3fc' },
    generating: { text: 'Generating…', color: '#facc15' },
    sheet: { text: 'Sheet ready · PostProcess', color: '#22d3ee' },
    postprocessing: { text: 'Post-processing…', color: '#22d3ee' },
    postprocessed: { text: 'Post-processed · Judge', color: '#a78bfa' },
    judging: { text: 'Judging…', color: '#a78bfa' },
    variants: { text: 'Pick winner', color: '#fbbf24' },
    approved: { text: 'Approved', color: '#a78bfa' },
    'checked-in': { text: 'Checked in', color: '#34d399' },
    tagging: { text: 'Tagging…', color: '#a78bfa' },
    done: { text: 'Done ✓', color: '#bef264' },
  };

  /** Mirror the active queue item's artifacts onto the legacy projection vars. */
  const projectActiveItem = (): void => {
    const item = getSelectedItem(queueState);
    if (!item) {
      selectedCandidatePath = null;
      promotedBriefPath = null;
      currentRun = null;
      return;
    }
    selectedCandidatePath = item.chosenCandidatePath;
    promotedBriefPath = item.briefPath;
    currentRun = item.run
      ? {
          briefId: item.run.briefId,
          runId: item.run.runId,
          candidates: item.run.candidates.map((candidate) => ({
            index: candidate.index,
            score: candidate.score,
            outOf: candidate.outOf,
            passed: candidate.passed,
            combinedPassed: candidate.combinedPassed,
            judge: candidate.judge
              ? {
                  passed: candidate.judge.passed,
                  minScore: candidate.judge.minScore,
                  designLanguage: candidate.judge.designLanguage ?? candidate.judge.styleMatch,
                  referenceStyleMatch:
                    candidate.judge.referenceStyleMatch ?? candidate.judge.styleMatch,
                  styleMatch: candidate.judge.styleMatch,
                  briefMatch: candidate.judge.briefMatch,
                  readability: candidate.judge.readability,
                  rejectedBy: [...candidate.judge.rejectedBy],
                }
              : null,
            sensors: candidate.sensors.map((sensor) => ({
              sensor: sensor.sensor,
              ok: sensor.ok,
              reason: sensor.reason,
              pixelCount: sensor.pixelCount,
            })),
          })),
        }
      : null;
  };

  const renderQueue = () => {
    queueList.replaceChildren();
    if (queueState.items.length === 0) {
      queueList.append(
        el('span', {
          text: 'Queue is empty — add a brief above.',
          style: { fontSize: '12px', color: '#64748b' },
        }),
      );
      return;
    }
    for (const item of queueState.items) {
      const isSelected = queueState.selectedId === item.id;
      const badge = STAGE_BADGES[item.stage];
      const chip = el('button', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: '2px',
          padding: '6px 10px',
          borderRadius: '10px',
          border: isSelected
            ? '1px solid rgba(125,211,252,0.9)'
            : '1px solid rgba(125,211,252,0.35)',
          background: isSelected ? '#0c4a6e' : '#0b2433',
          color: '#e0f2fe',
          cursor: 'pointer',
          fontSize: '11px',
          textAlign: 'left',
        },
      });
      chip.append(
        el('span', {
          text: item.name,
          style: { fontWeight: '600', fontSize: '12px' },
        }),
        el('span', {
          text: `${item.resolvedType ?? item.requestedType} · ${badge.text}`,
          style: { color: badge.color, fontSize: '10px' },
        }),
      );
      chip.title = item.brief ? `${item.name} — ${item.brief}` : item.name;
      chip.addEventListener('click', () => {
        queueState = queueSelectItem(queueState, item.id);
        writeQueueState();
        renderQueue();
        renderWorkflowSelection();
      });
      queueList.append(chip);
    }
  };

  const renderStepper = (item: QueueItem | null): void => {
    stepperHost.replaceChildren();
    if (!item) return;
    const cells = stepperFor(item.stage);
    cells.forEach((cell, index) => {
      const color =
        cell.status === 'done' ? '#bef264' : cell.status === 'active' ? '#fbbf24' : '#475569';
      const mark = cell.status === 'done' ? '✓' : cell.busy ? '…' : String(index + 1);
      stepperHost.append(
        el('span', {
          text: `${mark} ${cell.label}`,
          style: {
            padding: '4px 8px',
            borderRadius: '999px',
            border: `1px solid ${color}`,
            color: cell.status === 'todo' ? '#64748b' : color,
            background: cell.status === 'active' ? 'rgba(251,191,36,0.12)' : 'transparent',
            fontSize: '11px',
            fontWeight: cell.status === 'active' ? '700' : '500',
          },
        }),
      );
    });
  };

  const renderGenerationProgress = (): void => {
    const item = getSelectedItem(queueState);
    if (!item || item.stage !== 'generating') {
      generationProgress.style.display = 'none';
      generationProgress.textContent = '';
      cancelGenerateBtn.style.display = 'none';
      cancelGenerateBtn.disabled = true;
      return;
    }
    cancelGenerateBtn.style.display = '';
    cancelGenerateBtn.disabled = false;
    const startedAtMs = item.generationStartedAt ? Date.parse(item.generationStartedAt) : NaN;
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
    // The queued path records a server `generationRequestedAt` and polls; the
    // synchronous path has neither, so a null requestedAt means "no poll count".
    const isQueued = item.generationRequestedAt !== null;
    const pollAttempts = isQueued ? (generationPollAttempts.get(item.id) ?? 0) : null;
    generationProgress.style.display = 'block';
    // On the queued path a stall is most often "no worker is consuming the
    // queue". When the in-app "Launch worker" button is the right recovery,
    // surface that and suppress the generic CLI stall hint so the two
    // remediations don't overlap.
    const showWorkerLaunchHint =
      isQueued && sidecarQueueBackend === 'azure-queue' && !sidecarWorker?.running;
    generationProgress.textContent = describeGenerationProgress({
      brief: item.name,
      elapsedMs,
      pollAttempts,
      queueBackend: sidecarQueueBackend,
      suppressQueuedStallHint: showWorkerLaunchHint,
    });
    if (showWorkerLaunchHint) {
      generationProgress.textContent +=
        '\n⚠ No queue worker is running — click "Launch worker" to start processing this job.';
    }
  };

  const renderWorkflowSelection = () => {
    projectActiveItem();
    const item = getSelectedItem(queueState);
    if (!item) {
      activeItemLabel.textContent = 'Active item: none — add a brief above to begin.';
      renderStepper(null);
      synthBtn.disabled = true;
      postprocessBtn.disabled = true;
      judgeBtn.disabled = true;
      forceJudgeBtn.style.display = 'none';
      generateBtn.disabled = true;
      metadataBtn.disabled = true;
      removeItemBtn.disabled = true;
      restartBriefBtn.style.display = 'none';
      restartSheetBtn.style.display = 'none';
      cancelStepBtn.style.display = 'none';
      renderSynthCandidates([]);
      renderRunCandidates();
      renderGenerationProgress();
      return;
    }
    const badge = STAGE_BADGES[item.stage];
    const briefSuffix = item.brief ? ` — ${item.brief}` : '';
    const sizeSuffix =
      item.sizeVariant === DEFAULT_SIZE_VARIANT ? '' : ` · size: ${item.sizeVariant}`;
    activeItemLabel.textContent = `Active: "${item.name}"${briefSuffix} → ${item.kebabName} [${item.resolvedType ?? item.requestedType}]${sizeSuffix} · ${badge.text}`;
    activeItemLabel.style.color = badge.color;
    renderStepper(item);
    const busy = isBusyStage(item.stage);
    synthBtn.disabled = busy || !(item.stage === 'draft' || item.stage === 'candidates');
    // Generate produces a NEW sheet from the chosen brief candidate (or a
    // reloaded item's promoted briefPath). Reachable from `candidates` and from
    // `sheet`: at `sheet` it is the explicit "regenerate / call OpenAI again"
    // path, while PostProcess reuses the existing sheet by default.
    generateBtn.disabled =
      busy ||
      !(item.stage === 'candidates' || item.stage === 'sheet') ||
      (item.chosenCandidatePath === null && item.briefPath === null);
    // PostProcess re-runs over the stored sheet, so it stays available after the
    // first pass (a re-postprocess resets judge verdicts back to `postprocessed`).
    postprocessBtn.disabled =
      busy ||
      item.run === null ||
      !(item.stage === 'sheet' || item.stage === 'postprocessed' || item.stage === 'variants');
    // Judge needs the stored processed/NN.png, so it is gated behind PostProcess
    // (only once variants exist) and is re-runnable from `variants`.
    judgeBtn.disabled =
      busy ||
      item.run === null ||
      item.run.candidates.length === 0 ||
      !(item.stage === 'postprocessed' || item.stage === 'variants');
    // Force-judge override: only surfaced when the run actually has variants the
    // sensor gate would skip, and only while a judge step is reachable — hidden
    // otherwise so it never reads as the default path.
    const showForceJudge =
      item.run !== null &&
      item.run.candidates.length > 0 &&
      (item.stage === 'postprocessed' || item.stage === 'variants') &&
      runHasSensorFailures(item.run);
    forceJudgeBtn.style.display = showForceJudge ? '' : 'none';
    forceJudgeBtn.disabled = busy || !showForceJudge;
    metadataBtn.disabled =
      busy || !(item.stage === 'approved' || item.stage === 'checked-in' || item.stage === 'done');
    removeItemBtn.disabled = false;
    // Restart points: Brief is offered once the item has moved past the initial
    // draft (there is something to rewind); Sheet is offered whenever a
    // generated sheet exists to return to.
    const pastBrief = item.stage !== 'draft' && item.stage !== 'synthesizing';
    restartBriefBtn.style.display = pastBrief ? '' : 'none';
    restartBriefBtn.disabled = busy;
    const canRestartSheet = item.run !== null;
    restartSheetBtn.style.display = canRestartSheet ? '' : 'none';
    restartSheetBtn.disabled = busy || !canRestartSheet;
    // Show the shared Cancel button only while THIS item's PostProcess/Judge step
    // is actually in flight (its trigger button is busy-disabled meanwhile), so
    // a hung step can be aborted and retried instead of wedging the page.
    const stepRunning =
      inFlightSteps.has(item.id) && (item.stage === 'postprocessing' || item.stage === 'judging');
    cancelStepBtn.style.display = stepRunning ? '' : 'none';
    cancelStepBtn.disabled = !stepRunning;
    const nextAction = primaryActionLabel(item.stage);
    if (item.lastError) {
      const failed = lastFailedStep.get(item.id);
      if (failed === 'postprocess') {
        setWorkflowStatus(
          `PostProcess failed: ${item.lastError} — click PostProcess to retry.`,
          '#fca5a5',
        );
      } else if (failed === 'judge') {
        setWorkflowStatus(`Judge failed: ${item.lastError} — click Judge to retry.`, '#fca5a5');
      } else {
        setWorkflowStatus(`Error: ${item.lastError}`, '#fca5a5');
      }
    } else if (lastCanceledStep.has(item.id)) {
      const canceled = lastCanceledStep.get(item.id);
      const label = canceled === 'postprocess' ? 'PostProcess' : 'Judge';
      setWorkflowStatus(
        `Canceled ${label}. Nothing was changed — click ${label} to retry.`,
        '#fcd34d',
      );
    } else if (item.metadataSummary && item.stage === 'done') {
      setWorkflowStatus(
        item.metadataSummary,
        item.queueDurability === 'failed'
          ? '#fca5a5'
          : item.queueDurability === 'ok'
            ? '#bef264'
            : '#fcd34d',
      );
    } else if (item.checkinSummary && item.stage === 'checked-in') {
      setWorkflowStatus(item.checkinSummary, '#86efac');
    } else if (item.approvalSummary && item.stage === 'approved') {
      setWorkflowStatus(
        item.approvalSummary,
        item.queueDurability === 'failed'
          ? '#fca5a5'
          : item.queueDurability === 'ok'
            ? '#bef264'
            : '#fcd34d',
      );
    } else if (nextAction) {
      setWorkflowStatus(`Next: ${nextAction}`, '#cbd5e1');
    }
    renderSynthCandidates(item.candidates);
    renderRunCandidates();
    renderGenerationProgress();
  };

  const renderSynthCandidates = (candidates: WorkflowSynthCandidate[]) => {
    synthResultsHost.replaceChildren();
    if (candidates.length === 0) {
      synthResultsHost.append(
        el('div', {
          text: 'No valid synthesized candidates.',
          style: { fontSize: '12px', color: '#fca5a5' },
        }),
      );
      return;
    }
    for (const candidate of candidates) {
      const card = el('details', {
        style: {
          border: '1px solid rgba(148,163,184,0.2)',
          borderRadius: '8px',
          background: '#111827',
          padding: '6px',
        },
      });
      const summaryNode = el('summary', {
        style: { cursor: 'pointer', color: '#e5e7eb', fontSize: '12px' },
      });
      const chooseBtn = el('button', {
        text: selectedCandidatePath === candidate.yamlPath ? 'Selected' : 'Select',
        style: {
          marginRight: '8px',
          padding: '4px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(125,211,252,0.5)',
          background: selectedCandidatePath === candidate.yamlPath ? '#0c4a6e' : '#082f49',
          color: '#e0f2fe',
          cursor: 'pointer',
          fontSize: '11px',
        },
      });
      chooseBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const active = getSelectedItem(queueState);
        if (active) {
          queueState = queueUpdateItem(queueState, active.id, {
            chosenCandidatePath: candidate.yamlPath,
            stage: 'candidates',
            briefPath: null,
            run: null,
            generationRequestedAt: null,
            approvedAssetPath: null,
            lastError: null,
          });
          writeQueueState();
        }
        selectedCandidatePath = candidate.yamlPath;
        promotedBriefPath = null;
        currentRun = null;
        debugTarget = null;
        runResultsHost.replaceChildren();
        renderPostprocessDebugger();
        renderWorkflowSelection();
        writeWorkflowState();
      });
      const descSpan = el('span', { text: `${candidate.id} — ${candidate.description}` });
      summaryNode.append(chooseBtn, descSpan);
      const editorWrap = el('div', { style: { marginTop: '8px' } });
      const yamlEditor = el('textarea', {
        title: 'Edit the synthesized brief YAML. Save validates it; Generate uses the saved file.',
        style: {
          width: '100%',
          minHeight: '180px',
          maxHeight: '320px',
          boxSizing: 'border-box',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '10px',
          lineHeight: '1.35',
          color: '#cbd5e1',
          background: '#0b1220',
          border: '1px solid rgba(148,163,184,0.25)',
          borderRadius: '6px',
          padding: '6px',
          resize: 'vertical',
          whiteSpace: 'pre',
          overflow: 'auto',
        },
      });
      yamlEditor.value = candidate.yaml;
      yamlEditor.spellcheck = false;
      const saveRow = el('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' },
      });
      const saveBriefBtn = el('button', {
        text: 'Save brief',
        title: 'Validate and save the edited brief YAML. Generate will use the saved file.',
        style: {
          padding: '4px 10px',
          borderRadius: '6px',
          border: '1px solid rgba(125,211,252,0.5)',
          background: '#082f49',
          color: '#e0f2fe',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: '600',
        },
      });
      const saveStatus = el('span', { style: { fontSize: '10px', color: '#94a3b8' } });
      saveBriefBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const yaml = yamlEditor.value;
        if (yaml.trim() === '') {
          saveStatus.textContent = 'Brief cannot be empty.';
          saveStatus.style.color = '#fca5a5';
          return;
        }
        setButtonBusy(saveBriefBtn, true, 'Save brief', 'Saving...');
        saveStatus.textContent = '';
        try {
          const response = await fetch(`${SIDECAR_BASE}/api/workflow/brief`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ yamlPath: candidate.yamlPath, yaml }),
          });
          const payload = (await response.json().catch(() => ({}))) as {
            description?: unknown;
            yaml?: unknown;
            message?: unknown;
          };
          if (!response.ok) {
            const message =
              typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
            saveStatus.textContent = `Save failed: ${message}`;
            saveStatus.style.color = '#fca5a5';
            return;
          }
          const savedYaml = typeof payload.yaml === 'string' ? payload.yaml : yaml;
          const savedDescription =
            typeof payload.description === 'string' ? payload.description : candidate.description;
          candidate.yaml = savedYaml;
          candidate.description = savedDescription;
          yamlEditor.value = savedYaml;
          descSpan.textContent = `${candidate.id} — ${savedDescription}`;
          // Persist onto the active item's candidate so reloads/re-renders keep
          // the edit; Generate reads the saved file from disk.
          const active = getSelectedItem(queueState);
          if (active) {
            queueState = queueUpdateItem(queueState, active.id, {
              candidates: active.candidates.map((entry) =>
                entry.yamlPath === candidate.yamlPath
                  ? { ...entry, yaml: savedYaml, description: savedDescription }
                  : entry,
              ),
            });
            writeQueueState();
          }
          saveStatus.textContent = 'Saved. Generate will use the edited brief.';
          saveStatus.style.color = '#bef264';
        } catch (error) {
          saveStatus.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
          saveStatus.style.color = '#fca5a5';
        } finally {
          setButtonBusy(saveBriefBtn, false, 'Save brief', 'Saving...');
        }
      });
      saveRow.append(saveBriefBtn, saveStatus);
      editorWrap.append(yamlEditor, saveRow);
      card.append(summaryNode, editorWrap);
      synthResultsHost.append(card);
    }
  };

  /** A small colored chip showing one judge axis score (1-5, fail < 3). */
  const judgeAxisChip = (label: string, score: number, axisName: string): HTMLElement => {
    const ok = score >= 3;
    return el('span', {
      text: `${label} ${score || '–'}`,
      title: `${axisName}: ${score || '–'}/5 ${ok ? '(pass)' : '(below 3 — flagged)'}`,
      style: {
        display: 'inline-block',
        padding: '1px 5px',
        borderRadius: '4px',
        fontSize: '9px',
        fontWeight: '600',
        color: ok ? '#bbf7d0' : '#fecaca',
        background: ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.18)',
        border: `1px solid ${ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.45)'}`,
      },
    });
  };

  /** Rank best-first: combined-pass wins, then sensor score, then judge minScore. */
  const rankRunCandidates = (candidates: readonly WorkflowRunCandidate[]): WorkflowRunCandidate[] =>
    [...candidates].sort((a, b) => {
      if (a.combinedPassed !== b.combinedPassed) return a.combinedPassed ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      const am = a.judge?.minScore ?? 0;
      const bm = b.judge?.minScore ?? 0;
      if (bm !== am) return bm - am;
      return a.index - b.index;
    });

  // ── Candidate detail sidebar ────────────────────────────────────────────────
  // Clicking a variant's sprite opens an inline panel with the FULL judge
  // scorecard (axis names + score + the model's per-axis rationale) and the full
  // sensor breakdown — the same detail the sprite-gallery lab shows, embedded in
  // the workflow. Scores + sensors come from persisted queue state (instant, and
  // survive a refresh); the per-axis rationale + judge-skip reason are enriched
  // from the run summary (GET /api/runs/:b/:r) when the sidecar is reachable.
  const STATUS_KIND_COLORS: Readonly<Record<CandidateStatusKind, string>> = {
    pass: '#86efac',
    'sensor-failed': '#fca5a5',
    'judge-rejected': '#fca5a5',
    unjudged: '#94a3b8',
  };
  const JUDGE_AXES = [
    { key: 'designLanguage', label: 'Crawler design language' },
    { key: 'referenceStyleMatch', label: 'Reference style match' },
    { key: 'briefMatch', label: 'Brief match' },
    { key: 'readability', label: 'Readability' },
  ] as const;
  type JudgeAxisKey = (typeof JUDGE_AXES)[number]['key'];
  interface SummaryJudgeDetail {
    readonly passed: boolean;
    readonly minScore: number;
    readonly rejectedBy: readonly string[];
    readonly rationale: Readonly<Record<JudgeAxisKey, string | null>>;
    readonly modelDeployment: string | null;
    readonly judgedAt: string | null;
  }
  interface SummaryCandidateDetail {
    readonly judge: SummaryJudgeDetail | null;
    readonly judgeSkipReason: string | null;
    readonly raw: Record<string, unknown>;
  }
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

  let runDetailSel: { readonly key: string; readonly index: number } | null = null;
  let runDetailSummary: { key: string; byIndex: Map<number, Record<string, unknown>> } | null =
    null;
  let runDetailPendingKey: string | null = null;
  const runDetailHost = el('aside', {
    style: {
      flex: '0 0 320px',
      maxWidth: '340px',
      display: 'none',
      flexDirection: 'column',
      gap: '8px',
      padding: '10px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.4)',
      background: '#0b1220',
    },
  });

  const runKey = (): string | null =>
    currentRun ? `${currentRun.briefId}/${currentRun.runId}` : null;

  const parseSummaryCandidate = (raw: Record<string, unknown>): SummaryCandidateDetail => {
    const scorecard = asRecord(raw.judgeScorecard);
    const axisRationale = (key: string): string | null => {
      const axis = scorecard ? asRecord(scorecard[key]) : null;
      return axis && typeof axis.rationale === 'string' ? axis.rationale : null;
    };
    const judge: SummaryJudgeDetail | null = scorecard
      ? {
          passed: scorecard.passed === true,
          minScore: typeof scorecard.minScore === 'number' ? scorecard.minScore : 0,
          rejectedBy: Array.isArray(scorecard.rejectedBy)
            ? scorecard.rejectedBy.filter((r): r is string => typeof r === 'string')
            : [],
          rationale: {
            designLanguage: axisRationale('designLanguage'),
            referenceStyleMatch:
              axisRationale('referenceStyleMatch') ?? axisRationale('styleMatch'),
            briefMatch: axisRationale('briefMatch'),
            readability: axisRationale('readability'),
          },
          modelDeployment:
            typeof scorecard.modelDeployment === 'string' ? scorecard.modelDeployment : null,
          judgedAt: typeof scorecard.judgedAt === 'string' ? scorecard.judgedAt : null,
        }
      : null;
    return {
      judge,
      judgeSkipReason: typeof raw.judgeSkipReason === 'string' ? raw.judgeSkipReason : null,
      raw,
    };
  };

  const detailSectionTitle = (text: string): HTMLElement =>
    el('div', {
      text,
      style: { fontWeight: '600', fontSize: '12px', color: '#f1f5f9', margin: '4px 0 2px' },
    });

  const paintRunDetail = (
    candidate: WorkflowRunCandidate,
    detail: SummaryCandidateDetail | null,
  ): void => {
    if (!currentRun) return;
    const run = currentRun;
    runDetailHost.replaceChildren();
    runDetailHost.style.display = 'flex';
    const status = candidateStatus(candidate);

    const headerRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    });
    const closeBtn = el('button', {
      text: '✕',
      title: 'Close detail',
      style: {
        border: '1px solid rgba(148,163,184,0.4)',
        background: 'transparent',
        color: '#cbd5e1',
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '11px',
        lineHeight: '1',
        padding: '2px 6px',
      },
    });
    closeBtn.addEventListener('click', () => openRunDetail(null));
    headerRow.append(
      el('div', {
        text: `Variant #${candidate.index}`,
        style: { fontWeight: '700', fontSize: '13px', color: '#e2e8f0' },
      }),
      closeBtn,
    );

    const statusPill = el('div', {
      text: status.label,
      style: {
        alignSelf: 'flex-start',
        fontSize: '10px',
        fontWeight: '700',
        color: STATUS_KIND_COLORS[status.kind],
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      },
    });

    const padded = String(candidate.index).padStart(2, '0');
    const big = document.createElement('img');
    big.src = spriteUrl(run.briefId, run.runId, `${padded}.png`);
    Object.assign(big.style, {
      width: '160px',
      height: '160px',
      imageRendering: 'pixelated' as CSSStyleDeclaration['imageRendering'],
      alignSelf: 'center',
      background: '#1e293b',
      borderRadius: '6px',
    });

    runDetailHost.append(headerRow, statusPill, big);

    // Judge section: axis names + score/5 + per-axis rationale (when enriched).
    const judgeSection = el('div');
    judgeSection.append(detailSectionTitle('Judge (advisory)'));
    if (candidate.judge) {
      const scores: Record<JudgeAxisKey, number> = {
        designLanguage: candidate.judge.designLanguage,
        referenceStyleMatch: candidate.judge.referenceStyleMatch,
        briefMatch: candidate.judge.briefMatch,
        readability: candidate.judge.readability,
      };
      for (const axis of JUDGE_AXES) {
        const score = scores[axis.key];
        const ok = score >= 3;
        const row = el('div', { style: { marginBottom: '4px' } });
        const head = el('div', {
          style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' },
        });
        head.append(
          el('span', { text: axis.label, style: { color: '#e2e8f0', fontWeight: '600' } }),
          el('span', {
            text: `${score || '–'}/5 ${ok ? '✓' : '✗'}`,
            style: { color: ok ? '#86efac' : '#fca5a5', fontWeight: '600' },
          }),
        );
        row.append(head);
        const rationale = detail?.judge?.rationale[axis.key] ?? null;
        if (rationale) {
          row.append(
            el('div', {
              text: rationale,
              style: { fontSize: '10px', color: '#94a3b8', lineHeight: '1.35', marginTop: '1px' },
            }),
          );
        }
        judgeSection.append(row);
      }
      judgeSection.append(
        el('div', {
          text: `Verdict: ${candidate.judge.passed ? 'passed' : 'rejected'} · lowest axis ${
            candidate.judge.minScore
          }/5${
            candidate.judge.rejectedBy.length
              ? ` · rejected on ${candidate.judge.rejectedBy.join(', ')}`
              : ''
          }`,
          style: {
            fontSize: '10px',
            color: candidate.judge.passed ? '#86efac' : '#fca5a5',
            marginTop: '2px',
          },
        }),
      );
      const provenance = [detail?.judge?.modelDeployment, detail?.judge?.judgedAt]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' · ');
      if (provenance) {
        judgeSection.append(
          el('div', {
            text: provenance,
            style: { fontSize: '9px', color: '#64748b', marginTop: '1px' },
          }),
        );
      }
    } else {
      judgeSection.append(
        el('div', {
          text:
            describeJudgeSkipReason(detail ? detail.judgeSkipReason : null, false) ??
            'Not judged yet — run Judge to score this variant.',
          style: { fontSize: '11px', color: '#cbd5e1', lineHeight: '1.4' },
        }),
      );
    }
    runDetailHost.append(judgeSection);

    // Sensor section: every sensor with pass/fail + reason.
    const sensorSection = el('div');
    sensorSection.append(detailSectionTitle('Sensors'));
    if (candidate.sensors.length === 0) {
      sensorSection.append(
        el('div', {
          text: candidate.passed
            ? 'All sensors passed (no per-sensor detail recorded).'
            : 'No per-sensor detail recorded for this run.',
          style: { fontSize: '11px', color: candidate.passed ? '#86efac' : '#fecaca' },
        }),
      );
    } else {
      for (const sensor of candidate.sensors) {
        const row = el('div', { style: { marginBottom: '3px' } });
        const head = el('div', {
          style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' },
        });
        head.append(
          el('span', { text: sensor.sensor, style: { color: '#e2e8f0' } }),
          el('span', {
            text: sensor.ok ? '✓' : '✗',
            style: { color: sensor.ok ? '#86efac' : '#fca5a5', fontWeight: '700' },
          }),
        );
        row.append(head);
        if (!sensor.ok && (sensor.reason || sensor.pixelCount !== null)) {
          row.append(
            el('div', {
              text: `${sensor.reason ?? 'failed'}${
                sensor.pixelCount !== null ? ` (${sensor.pixelCount}px)` : ''
              }`,
              style: { fontSize: '10px', color: '#fecaca', lineHeight: '1.3' },
            }),
          );
        }
        sensorSection.append(row);
      }
    }
    runDetailHost.append(sensorSection);

    // Raw candidate JSON — full parity with the gallery's detail view.
    if (detail) {
      const raw = el('details', { style: { marginTop: '2px' } });
      raw.append(
        el('summary', {
          text: 'Raw candidate JSON',
          style: { fontSize: '10px', color: '#7dd3fc', cursor: 'pointer' },
        }),
        el('pre', {
          text: JSON.stringify(detail.raw, null, 2),
          style: {
            fontSize: '9px',
            color: '#cbd5e1',
            background: '#0f172a',
            borderRadius: '4px',
            padding: '6px',
            overflowX: 'auto',
            maxHeight: '220px',
            marginTop: '4px',
            whiteSpace: 'pre-wrap',
          },
        }),
      );
      runDetailHost.append(raw);
    }
  };

  const renderRunDetail = (): void => {
    const key = runKey();
    if (!runDetailSel || !currentRun || !key || runDetailSel.key !== key) {
      runDetailHost.replaceChildren();
      runDetailHost.style.display = 'none';
      return;
    }
    const sel = runDetailSel;
    const candidate = currentRun.candidates.find((c) => c.index === sel.index);
    if (!candidate) {
      runDetailHost.replaceChildren();
      runDetailHost.style.display = 'none';
      return;
    }
    const cached =
      runDetailSummary && runDetailSummary.key === key
        ? (runDetailSummary.byIndex.get(candidate.index) ?? null)
        : null;
    paintRunDetail(candidate, cached ? parseSummaryCandidate(cached) : null);
    if (cached || runDetailPendingKey === key) return;

    // Enrich with per-axis rationale + skip reason from the run summary. Best
    // effort: if the sidecar is unreachable the persisted-state panel stands.
    runDetailPendingKey = key;
    const briefId = currentRun.briefId;
    const runId = currentRun.runId;
    void (async () => {
      try {
        const summary = await fetchJson<{ candidates?: unknown }>(
          `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}`,
        );
        const byIndex = new Map<number, Record<string, unknown>>();
        if (Array.isArray(summary.candidates)) {
          for (const entry of summary.candidates) {
            const rec = asRecord(entry);
            if (rec && typeof rec.index === 'number') byIndex.set(rec.index, rec);
          }
        }
        runDetailSummary = { key, byIndex };
        const cur = runDetailSel;
        if (cur && cur.key === key && cur.index === candidate.index && runKey() === key) {
          const enriched = byIndex.get(candidate.index) ?? null;
          if (enriched) paintRunDetail(candidate, parseSummaryCandidate(enriched));
        }
      } catch {
        // Sidecar unreachable — base panel from persisted state remains.
      } finally {
        if (runDetailPendingKey === key) runDetailPendingKey = null;
      }
    })();
  };

  function openRunDetail(index: number | null): void {
    const key = runKey();
    runDetailSel = index === null || !key ? null : { key, index };
    renderRunDetail();
  }

  const renderRunCandidates = () => {
    runResultsHost.replaceChildren();
    if (!currentRun) return;
    const run = currentRun;
    // The selected item drives stage-gated affordances (e.g. the per-variant
    // force-judge override is only offered while a judge step is reachable).
    const selectedItem = getSelectedItem(queueState);
    const judgeStageActive =
      selectedItem !== null &&
      !isBusyStage(selectedItem.stage) &&
      (selectedItem.stage === 'postprocessed' || selectedItem.stage === 'variants');
    // Sheet-only stage (PR2b-1): Generate stores a raw sheet with no variants.
    // PostProcess is what slices it into the scored candidates rendered below.
    if (run.candidates.length === 0) {
      runResultsHost.append(
        el('div', {
          text: `Run ${run.briefId}/${run.runId} — raw sheet stored, no variants yet.`,
          style: { fontSize: '12px', color: '#93c5fd', marginBottom: '2px' },
        }),
        el('div', {
          text: 'Below is the raw generated sheet. Click PostProcess to slice, background-fix, and resize it into scored variants.',
          style: { fontSize: '10px', color: '#94a3b8', marginBottom: '6px' },
        }),
      );
      const sheetHost = el('div', {
        style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' },
      });
      runResultsHost.append(sheetHost);
      // Async: list and render the raw sheet PNG(s) the Generate step stored.
      // A render token guards against the selection changing mid-fetch.
      const sheetBriefId = run.briefId;
      const sheetRunId = run.runId;
      const token = ++rawSheetRenderToken;
      void (async () => {
        try {
          const response = await fetch(sheetsUrl(sheetBriefId, sheetRunId), { cache: 'no-store' });
          if (token !== rawSheetRenderToken) return;
          if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
          const data = (await response.json()) as { files?: unknown };
          if (token !== rawSheetRenderToken) return;
          const files = Array.isArray(data.files)
            ? data.files.filter((value): value is string => typeof value === 'string')
            : [];
          if (files.length === 0) {
            sheetHost.append(
              el('div', {
                text: 'No raw sheet image found for this run.',
                style: { fontSize: '11px', color: '#94a3b8' },
              }),
            );
            return;
          }
          for (const file of files) {
            const figure = el('div', {
              style: { display: 'flex', flexDirection: 'column', gap: '4px' },
            });
            const img = el('img', {
              style: {
                maxWidth: '320px',
                imageRendering: 'pixelated',
                border: '1px solid rgba(148,163,184,0.3)',
                borderRadius: '6px',
                background: '#0f172a',
              },
            });
            img.src = sheetUrl(sheetBriefId, sheetRunId, file);
            img.alt = `Raw sheet ${file} for ${sheetBriefId}/${sheetRunId}`;
            figure.append(
              img,
              el('div', {
                text: file,
                style: { fontSize: '10px', color: '#64748b', textAlign: 'center' },
              }),
            );
            sheetHost.append(figure);
          }
        } catch (error) {
          if (token !== rawSheetRenderToken) return;
          sheetHost.append(
            el('div', {
              text: `Could not load raw sheet: ${error instanceof Error ? error.message : String(error)}`,
              style: { fontSize: '11px', color: '#fca5a5' },
            }),
          );
        }
      })();
      return;
    }
    const ranked = rankRunCandidates(run.candidates);
    const judged = ranked.some((c) => c.judge !== null);
    const passingCount = ranked.filter((c) => c.combinedPassed).length;
    const selectedDetailIndex =
      runDetailSel && runDetailSel.key === `${run.briefId}/${run.runId}`
        ? runDetailSel.index
        : null;
    const title = el('div', {
      text: judged
        ? `Run ${run.briefId}/${run.runId} — ${passingCount}/${ranked.length} pass the judge`
        : `Run ${run.briefId}/${run.runId} — ${ranked.length} variant(s) post-processed, not yet judged`,
      style: { fontSize: '12px', color: '#93c5fd', marginBottom: '2px' },
    });
    const hint = el('div', {
      text: judged
        ? passingCount > 0
          ? 'Approve a recommended variant, or override any other with “Approve anyway”.'
          : 'The judge flagged every variant. Pick the best and use “Approve anyway” — the judge is advisory; you have the final say.'
        : 'Click Judge to rank these variants, or Approve one directly — judging is optional.',
      style: { fontSize: '10px', color: '#94a3b8', marginBottom: '6px' },
    });
    const grid = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    ranked.forEach((candidate, rankIndex) => {
      const isTop = rankIndex === 0;
      const card = el('div', {
        style: {
          border: `1px solid ${
            candidate.combinedPassed
              ? 'rgba(34,197,94,0.55)'
              : isTop
                ? 'rgba(250,204,21,0.55)'
                : 'rgba(148,163,184,0.25)'
          }`,
          borderRadius: '8px',
          padding: '6px',
          background: '#111827',
          width: '128px',
        },
      });
      const padded = String(candidate.index).padStart(2, '0');
      const sprite = document.createElement('img');
      sprite.src = spriteUrl(run.briefId, run.runId, `${padded}.png`);
      Object.assign(sprite.style, {
        width: '96px',
        height: '96px',
        imageRendering: 'pixelated' as CSSStyleDeclaration['imageRendering'],
        display: 'block',
        margin: '0 auto 6px',
        background: '#334155',
        cursor: 'pointer',
        borderRadius: '4px',
        outline:
          candidate.index === selectedDetailIndex ? '2px solid #38bdf8' : '2px solid transparent',
      });
      sprite.title = 'Click for the full judge scorecard + sensor detail';
      sprite.addEventListener('click', () => openRunDetail(candidate.index));
      const status = candidateStatus(candidate);
      const statusColor = STATUS_KIND_COLORS[status.kind];
      const header = el('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '4px',
        },
      });
      header.append(
        el('span', {
          text: `#${candidate.index} · ${candidate.score}/${candidate.outOf}`,
          style: { fontSize: '10px', color: '#cbd5e1' },
        }),
        el('span', {
          text: isTop ? `${status.label} · best` : status.label,
          style: {
            fontSize: '9px',
            fontWeight: '600',
            color: statusColor,
          },
        }),
      );
      card.append(sprite, header);
      if (candidate.judge) {
        const chips = el('div', {
          style: { display: 'flex', gap: '3px', flexWrap: 'wrap', marginBottom: '5px' },
        });
        chips.append(
          judgeAxisChip('D', candidate.judge.designLanguage, 'Crawler design language'),
          judgeAxisChip('S', candidate.judge.referenceStyleMatch, 'Reference style match'),
          judgeAxisChip('B', candidate.judge.briefMatch, 'Brief match'),
          judgeAxisChip('R', candidate.judge.readability, 'Readability'),
        );
        card.append(chips);
      }
      // Per-sensor failure detail (PR2c): show WHICH sensors failed and why for
      // this variant — not just the pass/fail tally — so an operator can decide
      // whether to fix the brief, re-postprocess, or force-judge past the gate.
      const sensors = sensorSummary(candidate);
      if (sensors) {
        const sensorBlock = el('div', { style: { marginBottom: '5px' } });
        if (sensors.failed === 0) {
          sensorBlock.append(
            el('div', {
              text: `✓ ${sensors.total} sensor${sensors.total === 1 ? '' : 's'} passed`,
              style: { fontSize: '9px', color: '#86efac' },
            }),
          );
        } else {
          sensorBlock.append(
            el('div', {
              text: `⚠ ${sensors.failed}/${sensors.total} sensor${
                sensors.total === 1 ? '' : 's'
              } failed`,
              style: {
                fontSize: '9px',
                fontWeight: '600',
                color: '#fca5a5',
                marginBottom: '2px',
              },
            }),
          );
          const list = el('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
              maxHeight: '64px',
              overflowY: 'auto',
            },
          });
          for (const label of sensors.failingLabels) {
            list.append(
              el('div', {
                text: label,
                title: label,
                style: {
                  fontSize: '9px',
                  lineHeight: '1.3',
                  color: '#fecaca',
                  wordBreak: 'break-word',
                },
              }),
            );
          }
          sensorBlock.append(list);
        }
        card.append(sensorBlock);
      }
      const overrideNeeded = !candidate.combinedPassed;
      const variantKey = `${run.briefId}-var-${candidate.index}`;
      const isApproved = approvedVariantKeys.has(variantKey);
      const debugBtn = el('button', {
        text: 'Debug',
        style: {
          width: '100%',
          marginTop: '6px',
          padding: '4px 6px',
          borderRadius: '6px',
          border: '1px solid rgba(125,211,252,0.5)',
          background: '#082f49',
          color: '#e0f2fe',
          cursor: 'pointer',
          fontSize: '11px',
        },
      });
      debugBtn.addEventListener('click', () => {
        location.href = postprocessDebuggerHref(run.briefId, run.runId, candidate.index);
      });
      // Shared approve action. Reused by the initial Approve CTA and, once a
      // variant is approved, by the secondary Re-approve control (re-running
      // post-processing can change the image, which this re-approves).
      const doApprove = async (triggerBtn: HTMLButtonElement, busyLabel: string): Promise<void> => {
        const isReapproval = approvedVariantKeys.has(variantKey);
        if (isReapproval) {
          // Re-approving the SAME variant slot is allowed only when the image
          // actually changed (e.g. after re-running post-processing). The server
          // is the source of truth: it compares content hashes and refuses an
          // identical image with 409. Here we just confirm intent — no hard block.
          const ok = window.confirm(
            `Variant ${variantKey} is already approved. Re-approve it with the ` +
              'current image? This overwrites the existing asset if the image ' +
              'changed; an identical image is refused.',
          );
          if (!ok) return;
        } else {
          // Confirm before approving an ADDITIONAL variant for a brief that
          // already has one or more approved variants.
          const siblingVariantCount = [...approvedVariantKeys].filter((key) =>
            key.startsWith(`${run.briefId}-var-`),
          ).length;
          if (siblingVariantCount > 0) {
            const ok = window.confirm(
              `${run.briefId} already has ${siblingVariantCount} approved ` +
                `variant${siblingVariantCount === 1 ? '' : 's'}. Approve variant ` +
                `#${candidate.index} as an ADDITIONAL variant? At runtime the game ` +
                'picks one of a brief\u2019s variants at random.',
            );
            if (!ok) return;
          }
        }
        if (overrideNeeded) {
          const axes = candidate.judge?.rejectedBy?.length
            ? candidate.judge.rejectedBy.join(', ')
            : 'judge';
          const ok = window.confirm(
            `Variant #${candidate.index} was flagged by the judge (${axes}). ` +
              'Approve it anyway and write it to the catalog?',
          );
          if (!ok) return;
        }
        // Capture the queue item being approved BEFORE the await. postApprove
        // now includes a durable queue-commit git push (seconds), during which
        // the operator can reselect a different queue chip (selection is NOT
        // locked). Reading getSelectedItem() after the await would patch the
        // newly-selected item — corrupting its stage and attaching THIS asset's
        // durability warning to the wrong item — so pin the target here.
        const approveTarget = getSelectedItem(queueState);
        setButtonBusy(triggerBtn, true, busyLabel, 'Approving...');
        try {
          const approved = await postApprove(run.briefId, run.runId, candidate.index);
          const queueCommitFailed = approved.queueCommit?.status === 'failed';
          // Mark approved locally so the card flips to "✓ Approved!" immediately,
          // before the async recompute re-reads the manifest to confirm.
          approvedVariantKeys.add(variantKey);
          const patch = approvedItemPatch({
            briefId: run.briefId,
            variantIndex: candidate.index,
            alreadyApproved: approved.alreadyApproved,
            assetPath: approved.assetPath,
            sensorScore: approved.sensorScore,
            judgeScore: approved.judgeScore,
            judgeOverride: overrideNeeded,
            queueCommitFailed,
            queueCommitError:
              approved.queueCommit && approved.queueCommit.status === 'failed'
                ? approved.queueCommit.error
                : undefined,
          });
          if (approveTarget) {
            queueState = queueUpdateItem(queueState, approveTarget.id, patch);
            writeQueueState();
          }
          renderQueue();
          renderWorkflowSelection();
          // A failed durable push isn't an approval failure (the catalog write
          // succeeded), but it IS a durability warning: color it red and rely on
          // the warning baked into approvalSummary so recompute's re-render keeps it.
          setWorkflowStatus(patch.approvalSummary, queueCommitFailed ? '#fca5a5' : '#bef264');
          void recompute();
        } catch (error) {
          // The sidecar returns 409 (already-approved) only when this exact
          // variant key already exists WITH byte-identical content. That is NOT
          // a failure: the asset IS in the catalog, so advance the item to the
          // `approved` stage (unlocking Tag) exactly like a fresh approval —
          // otherwise re-approving an already-approved variant dead-ends on the
          // Approve step and the operator can never reach Tag/Done.
          if (error instanceof ApproveRequestError && error.status === 409) {
            approvedVariantKeys.add(variantKey);
            const patch = approvedItemPatch({
              briefId: run.briefId,
              variantIndex: candidate.index,
              assetPath: `generated/${variantKey}.png`,
              alreadyApproved: true,
            });
            if (approveTarget) {
              queueState = queueUpdateItem(queueState, approveTarget.id, patch);
              writeQueueState();
            }
            renderQueue();
            renderWorkflowSelection();
            setWorkflowStatus(patch.approvalSummary, '#bef264');
            void recompute();
          } else {
            setWorkflowStatus(
              `Approve failed: ${error instanceof Error ? error.message : String(error)}`,
              '#fca5a5',
            );
          }
        } finally {
          setButtonBusy(triggerBtn, false, busyLabel, 'Approving...');
        }
      };
      if (isApproved) {
        const approvedBadge = el('button', {
          text: '\u2713 Approved!',
          title: `Variant #${candidate.index} is approved and written to the catalog.`,
          style: {
            width: '100%',
            padding: '4px 6px',
            borderRadius: '6px',
            border: '1px solid rgba(34,197,94,0.6)',
            background: '#052e16',
            color: '#bbf7d0',
            fontSize: '11px',
            fontWeight: '700',
            cursor: 'default',
          },
        });
        approvedBadge.disabled = true;
        const reapproveBtn = el('button', {
          text: 'Re-approve',
          title:
            'Re-approve with the current image. Use after re-running post-processing changed it; an identical image is refused.',
          style: {
            width: '100%',
            marginTop: '6px',
            padding: '4px 6px',
            borderRadius: '6px',
            border: '1px solid rgba(148,163,184,0.4)',
            background: '#0f172a',
            color: '#cbd5e1',
            cursor: 'pointer',
            fontSize: '11px',
          },
        });
        reapproveBtn.addEventListener('click', () => {
          void doApprove(reapproveBtn, 'Re-approve');
        });
        card.append(approvedBadge, reapproveBtn, debugBtn);
      } else {
        const approveBtn = el('button', {
          text: overrideNeeded ? 'Approve anyway' : 'Approve',
          style: {
            width: '100%',
            padding: '4px 6px',
            borderRadius: '6px',
            border: overrideNeeded
              ? '1px solid rgba(250,204,21,0.6)'
              : '1px solid rgba(34,197,94,0.6)',
            background: overrideNeeded ? '#422006' : '#052e16',
            color: overrideNeeded ? '#fef3c7' : '#bbf7d0',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: '600',
          },
        });
        const busyLabel = overrideNeeded ? 'Approve anyway' : 'Approve';
        approveBtn.addEventListener('click', () => {
          void doApprove(approveBtn, busyLabel);
        });
        card.append(approveBtn, debugBtn);
      }
      // Per-variant override: judge this one sensor-failed variant past the gate
      // (only while a judge step is reachable). Calls the shared runJudge with a
      // variantIndexes subset. The handler references runJudge lazily at click
      // time, after it is initialised — never during this synchronous render.
      if (judgeStageActive && candidateForceEligible(candidate)) {
        const forceVariantBtn = el('button', {
          text: 'Force judge variant',
          title: 'Force the LLM judge on this sensor-failed variant (ignores the sensor gate).',
          style: {
            width: '100%',
            marginTop: '6px',
            padding: '4px 6px',
            borderRadius: '6px',
            border: '1px solid rgba(251,146,60,0.55)',
            background: '#431407',
            color: '#fed7aa',
            cursor: 'pointer',
            fontSize: '11px',
          },
        });
        forceVariantBtn.addEventListener('click', () => {
          void runJudge({ force: true, variantIndexes: [candidate.index] });
        });
        card.append(forceVariantBtn);
      }
      grid.append(card);
    });
    const bodyRow = el('div', {
      style: { display: 'flex', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' },
    });
    Object.assign(grid.style, { flex: '1 1 320px', minWidth: '0' });
    bodyRow.append(grid, runDetailHost);
    runResultsHost.append(title, hint, bodyRow);
    renderRunDetail();
  };

  if (currentRun) {
    renderRunCandidates();
  }

  const renderPostprocessDebugger = (): void => {
    const target = debugTarget;
    const renderToken = ++debuggerRenderToken;
    rerenderPostprocessPipeline = null;
    debuggerTraceHost.replaceChildren();

    if (!target) {
      debuggerTargetLabel.textContent = 'No target selected — use the picker above';
      debuggerTraceHost.append(
        el('p', {
          text: 'Select a run above and click "Load selected" to trace the full postprocess pipeline.',
          style: {
            color: '#475569',
            fontSize: '12px',
            textAlign: 'center',
            padding: '32px 0',
            margin: '0',
          },
        }),
      );
      return;
    }

    const { briefId, runId, variantIndex } = target;
    briefIdInput.value = briefId;
    runIdInput.value = runId;
    variantIndexInput.value = String(variantIndex);
    const pickerKey = makeRunKey(briefId, runId);
    if (findRunByKey(pickerKey)) {
      debuggerRunSelect.value = pickerKey;
      const cached = debuggerVariantCache.get(pickerKey);
      if (cached) {
        setDebuggerVariantOptions(cached, variantIndex);
      } else {
        void loadDebuggerVariantOptions(variantIndex);
      }
    }
    const padded = String(variantIndex).padStart(2, '0');
    const targetKey = `${briefId}/${runId}/${variantIndex}`;
    debuggerTargetLabel.textContent = `${briefId} / ${runId} — variant #${variantIndex}`;

    const checkerBg: Partial<CSSStyleDeclaration> = {
      background:
        'linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%)',
      backgroundSize: '10px 10px',
      backgroundPosition: '0 0, 0 5px, 5px -5px, -5px 0px',
      backgroundColor: '#0f172a',
    };

    const makeSection = (title: string): { section: HTMLElement; body: HTMLElement } => {
      const section = el('div', {
        style: {
          marginBottom: '12px',
          border: '1px solid rgba(148,163,184,0.15)',
          borderRadius: '8px',
          overflow: 'hidden',
        },
      });
      const header = el('div', {
        text: title,
        style: {
          padding: '7px 12px',
          background: 'rgba(15,23,42,0.9)',
          fontSize: '10px',
          fontWeight: '600',
          color: '#94a3b8',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          borderBottom: '1px solid rgba(148,163,184,0.1)',
        },
      });
      const body = el('div', { style: { padding: '12px', background: 'rgba(8,12,24,0.6)' } });
      section.append(header, body);
      return { section, body };
    };

    const makeImgEl = (size: number): HTMLImageElement => {
      const img = document.createElement('img');
      Object.assign(img.style, {
        maxWidth: `${size}px`,
        maxHeight: `${size}px`,
        width: 'auto',
        height: 'auto',
        imageRendering: 'pixelated',
        display: 'block',
        border: '1px solid rgba(148,163,184,0.2)',
        borderRadius: '4px',
        ...checkerBg,
      });
      return img;
    };

    // ── Section 1: Source sprite sheet ─────────────────────────────
    const { section: sheetSection, body: sheetBody } = makeSection('Source sprite sheet');
    const sheetTabRow = el('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' },
    });
    const sheetStatus = el('div', {
      text: 'Loading sheet…',
      style: { fontSize: '11px', color: '#64748b' },
    });
    const sheetCanvas = document.createElement('canvas');
    Object.assign(sheetCanvas.style, {
      display: 'none',
      maxWidth: '100%',
      imageRendering: 'pixelated',
      borderRadius: '4px',
      border: '1px solid rgba(148,163,184,0.2)',
    });
    sheetBody.append(sheetTabRow, sheetStatus, sheetCanvas);
    debuggerTraceHost.append(sheetSection);

    // ── Slicing elements (rendered as first pipeline step) ──────────
    const slicingVariantRow = el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' },
    });
    const slicingVariantLabel = el('span', {
      text: 'Variant:',
      style: { fontSize: '10px', color: '#64748b' },
    });
    Object.assign(debuggerVariantSelect.style, { width: '120px' });
    const sliceModeBadge = el('span', {
      text: 'Canonical (v2)',
      style: {
        fontSize: '10px',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid #7dd3fc',
        background: 'rgba(125,211,252,0.12)',
        color: '#7dd3fc',
        fontWeight: '600',
      },
    });
    slicingVariantRow.append(slicingVariantLabel, debuggerVariantSelect, sliceModeBadge);

    const slicingStatus = el('div', {
      text: 'Waiting for sheet…',
      style: { fontSize: '11px', color: '#64748b', marginBottom: '8px' },
    });
    const slicingCanvas = document.createElement('canvas');
    Object.assign(slicingCanvas.style, {
      display: 'none',
      maxWidth: '100%',
      imageRendering: 'pixelated',
      borderRadius: '4px',
      border: '1px solid rgba(148,163,184,0.2)',
    });

    // ── Section 3: Pipeline steps ───────────────────────────────────
    const { section: pipelineSection, body: pipelineBody } = makeSection(
      'Postprocess pipeline — step by step',
    );
    const pipelineLoading = el('div', {
      text: 'Loading pipeline trace…',
      style: { fontSize: '11px', color: '#64748b' },
    });
    pipelineBody.append(pipelineLoading);
    debuggerTraceHost.append(pipelineSection);

    // ── Shared state for cross-section rendering ────────────────────
    let pendingSheetImgForSlice: HTMLImageElement | null = null;
    let sliceMap: SliceMapResponse | null = null;
    let rerenderPipeline: (() => void) | null = null;
    let hitCells: Array<{
      cell: SliceMapResponse['cells'][number];
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    const getActiveSliceMap = (): SliceMapResponse | null => sliceMap;
    const getActiveSliceVersion = (): 'v2' => 'v2';

    const drawSliceMapOnCanvas = (
      sourceImg: HTMLImageElement,
      sliceMap: SliceMapResponse,
    ): void => {
      const maxW = Math.min(sourceImg.naturalWidth, 640);
      const scale = maxW / sourceImg.naturalWidth;
      const dw = Math.round(sourceImg.naturalWidth * scale);
      const dh = Math.round(sourceImg.naturalHeight * scale);

      // Plain sheet
      sheetCanvas.width = dw;
      sheetCanvas.height = dh;
      const ctx1 = sheetCanvas.getContext('2d');
      if (ctx1) {
        ctx1.imageSmoothingEnabled = false;
        ctx1.drawImage(sourceImg, 0, 0, dw, dh);
      }
      sheetCanvas.style.display = 'block';
      sheetStatus.style.display = 'none';

      // Slicing overlay with actual cell bboxes
      slicingCanvas.width = dw;
      slicingCanvas.height = dh;
      const ctx2 = slicingCanvas.getContext('2d');
      if (!ctx2) return;
      hitCells = [];
      ctx2.imageSmoothingEnabled = false;
      ctx2.drawImage(sourceImg, 0, 0, dw, dh);
      // Dim everything
      ctx2.fillStyle = 'rgba(8,12,24,0.55)';
      ctx2.fillRect(0, 0, dw, dh);

      // Draw each cell with its actual (nudged) bounds
      // In degraded mode (brief unavailable) cell indices are renumbered and
      // unreliable, so we do not resolve or highlight a "selected" cell from them.
      const indicesTrustworthy = sliceMap.emptyCellsApplied !== false;
      const selectedCell = indicesTrustworthy
        ? (sliceMap.cells.find((c) => c.index === variantIndex) ?? null)
        : null;
      for (const cell of sliceMap.cells) {
        const sx = cell.x0;
        const sy = cell.y0;
        const dx = Math.round(sx * scale);
        const dy = Math.round(sy * scale);
        const dCellW = Math.round(cell.w * scale);
        const dCellH = Math.round(cell.h * scale);
        const isSelected = indicesTrustworthy && cell.index === variantIndex;
        hitCells.push({ cell, x: dx, y: dy, w: dCellW, h: dCellH });

        if (cell.empty) {
          // Empty cell: dashed red outline
          ctx2.save();
          ctx2.setLineDash([3, 3]);
          ctx2.strokeStyle = 'rgba(239,68,68,0.5)';
          ctx2.lineWidth = 1;
          ctx2.strokeRect(dx + 0.5, dy + 0.5, dCellW - 1, dCellH - 1);
          ctx2.restore();
        } else if (isSelected) {
          // Selected: redraw undimmed, add highlight
          ctx2.drawImage(sourceImg, sx, sy, cell.w, cell.h, dx, dy, dCellW, dCellH);
          ctx2.fillStyle = 'rgba(125,211,252,0.12)';
          ctx2.fillRect(dx, dy, dCellW, dCellH);
          ctx2.strokeStyle = '#7dd3fc';
          ctx2.lineWidth = 2;
          ctx2.strokeRect(dx + 1, dy + 1, dCellW - 2, dCellH - 2);
        } else {
          // Non-selected cell: show border
          ctx2.strokeStyle = 'rgba(148,163,184,0.4)';
          ctx2.lineWidth = 1;
          ctx2.strokeRect(dx + 0.5, dy + 0.5, dCellW - 1, dCellH - 1);
        }
      }

      // Build status line
      const nudgeRows = sliceMap.rowOffsets.filter((o) => o !== 0);
      const nudgeCols = sliceMap.colOffsets.filter((o) => o !== 0);
      const nudgeNote =
        nudgeRows.length > 0 || nudgeCols.length > 0
          ? ` · autoNudge: rows[${sliceMap.rowOffsets.join(',')}] cols[${sliceMap.colOffsets.join(',')}]`
          : ' · no nudge';
      const cellLabel =
        selectedCell && !selectedCell.empty
          ? ` — variant #${variantIndex} at (${selectedCell.x0},${selectedCell.y0}) ${selectedCell.w}×${selectedCell.h}px`
          : '';
      const degradedNote = indicesTrustworthy
        ? ''
        : ' · ⚠ approximate slicing (brief unavailable) — cell indices not authoritative';
      slicingStatus.textContent =
        `${sliceMap.cols}×${sliceMap.rows} grid · ${sliceMap.cellW}×${sliceMap.cellH}px cells` +
        nudgeNote +
        cellLabel +
        degradedNote;
      slicingCanvas.style.display = 'block';
    };

    slicingCanvas.onclick = (event: MouseEvent): void => {
      if (!debugTarget || hitCells.length === 0) return;
      // Degraded slice map: cell indices are not authoritative, so click-to-
      // reselect would jump to the wrong variant. Ignore clicks in that mode.
      if (getActiveSliceMap()?.emptyCellsApplied === false) return;
      const rect = slicingCanvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) * slicingCanvas.width) / rect.width;
      const y = ((event.clientY - rect.top) * slicingCanvas.height) / rect.height;
      const clicked = hitCells.find(
        (entry) =>
          !entry.cell.empty &&
          x >= entry.x &&
          x <= entry.x + entry.w &&
          y >= entry.y &&
          y <= entry.y + entry.h,
      );
      if (!clicked || clicked.cell.index < 0 || clicked.cell.index === debugTarget.variantIndex)
        return;
      debugTarget = { ...debugTarget, variantIndex: clicked.cell.index };
      renderPostprocessDebugger();
      writeWorkflowState();
    };

    debuggerVariantSelect.onchange = (): void => {
      if (!debugTarget) return;
      const variantIndexRaw = Number.parseInt(debuggerVariantSelect.value, 10);
      const selectedIndex =
        Number.isFinite(variantIndexRaw) && variantIndexRaw >= 0 ? variantIndexRaw : 0;
      if (selectedIndex === debugTarget.variantIndex) return;
      debugTarget = { ...debugTarget, variantIndex: selectedIndex };
      renderPostprocessDebugger();
      writeWorkflowState();
    };

    const tryDrawSliceMap = (sourceImg: HTMLImageElement): void => {
      const active = getActiveSliceMap();
      if (active) {
        drawSliceMapOnCanvas(sourceImg, active);
      } else {
        pendingSheetImgForSlice = sourceImg;
      }
    };

    const onSliceMapKnown = (nextSliceMap: SliceMapResponse): void => {
      sliceMap = nextSliceMap;
      const active = getActiveSliceMap();
      if (!active) return;
      if (pendingSheetImgForSlice) {
        drawSliceMapOnCanvas(pendingSheetImgForSlice, active);
        lastSheetImg = pendingSheetImgForSlice;
        pendingSheetImgForSlice = null;
      } else if (lastSheetImg) {
        drawSliceMapOnCanvas(lastSheetImg, active);
      }
    };

    let lastSheetImg: HTMLImageElement | null = null;

    const normalizeSheetFiles = (response: SidecarSheetsResponse): string[] =>
      Array.isArray(response.files)
        ? response.files.filter(
            (file): file is string => typeof file === 'string' && /^sheet-\d+\.png$/i.test(file),
          )
        : [];

    const loadSheetFile = (filename: string, sheetRunId: string): void => {
      sheetStatus.textContent = `Loading ${filename}…`;
      sheetStatus.style.display = '';
      sheetCanvas.style.display = 'none';
      sliceMap = null;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = async () => {
        if (
          renderToken !== debuggerRenderToken ||
          !debugTarget ||
          `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !== targetKey
        )
          return;
        lastSheetImg = img;
        try {
          const map = await fetchJson<SliceMapResponse>(sliceMapUrl(briefId, sheetRunId, filename));
          if (
            renderToken !== debuggerRenderToken ||
            !debugTarget ||
            `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !== targetKey
          )
            return;
          onSliceMapKnown(map);
        } catch (error) {
          slicingStatus.textContent = `Slice map unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
        tryDrawSliceMap(img);
        rerenderPipeline?.();
      };
      img.onerror = () => {
        sheetStatus.textContent = `Failed to load ${filename}`;
      };
      img.src = sheetUrl(briefId, sheetRunId, filename);
    };

    const makeSelectedRawCellDataUrl = (): string | null => {
      const activeSliceMap = getActiveSliceMap();
      if (!activeSliceMap || !lastSheetImg || !lastSheetImg.complete) return null;
      // Degraded slice map: indices are unreliable, so cropping the sheet at
      // `variantIndex` could return the wrong cell. Return null so the caller
      // falls back to the index-keyed stored raw `NN.png` (always correct).
      if (activeSliceMap.emptyCellsApplied === false) return null;
      const selectedCell = activeSliceMap.cells.find(
        (cell) => cell.index === variantIndex && !cell.empty,
      );
      if (!selectedCell || selectedCell.w <= 0 || selectedCell.h <= 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = selectedCell.w;
      canvas.height = selectedCell.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        lastSheetImg,
        selectedCell.x0,
        selectedCell.y0,
        selectedCell.w,
        selectedCell.h,
        0,
        0,
        selectedCell.w,
        selectedCell.h,
      );
      return canvas.toDataURL('image/png');
    };

    const makeComparisonStepCard = (
      stepLabel: string,
      beforeSrc: string | null,
      afterASrc: string,
      afterBSrc: string | null,
      bLabel: string,
      selectedBranch: 'A' | 'B',
      onBranchSelect: (branch: 'A' | 'B') => void,
      skipped: boolean,
      onSkipToggle: () => void,
      inlineConfig: HTMLElement | null = null,
    ): HTMLElement => {
      const card = el('div', {
        style: {
          marginBottom: '10px',
          padding: '10px',
          background: 'rgba(15,23,42,0.5)',
          border: '1px solid rgba(148,163,184,0.1)',
          borderRadius: '6px',
        },
      });
      const title = el('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '11px',
          color: '#7dd3fc',
          fontWeight: '600',
          marginBottom: '8px',
          letterSpacing: '0.02em',
        },
      });
      const titleText = el('span', { text: stepLabel });
      const branchRow = el('div', { style: { display: 'flex', gap: '4px' } });
      const makeBranchBtn = (
        label: string,
        branch: 'A' | 'B',
        enabled: boolean,
      ): HTMLButtonElement => {
        const active = selectedBranch === branch;
        const btn = el('button', {
          text: label,
          style: {
            fontSize: '10px',
            padding: '2px 8px',
            borderRadius: '4px',
            border: `1px solid ${active ? '#7dd3fc' : '#475569'}`,
            background: active ? 'rgba(125,211,252,0.12)' : '#1e293b',
            color: active ? '#7dd3fc' : '#94a3b8',
            cursor: enabled ? 'pointer' : 'not-allowed',
            opacity: enabled ? '1' : '0.5',
          },
        }) as HTMLButtonElement;
        btn.disabled = !enabled;
        if (enabled) {
          btn.addEventListener('click', () => onBranchSelect(branch));
        }
        return btn;
      };
      const makeSkipBtn = (): HTMLButtonElement => {
        const btn = el('button', {
          text: skipped ? '▶ Enable' : 'Skip',
          style: {
            fontSize: '10px',
            padding: '2px 8px',
            borderRadius: '4px',
            border: `1px solid ${skipped ? '#fbbf24' : '#475569'}`,
            background: skipped ? 'rgba(251,191,36,0.12)' : '#1e293b',
            color: skipped ? '#fbbf24' : '#94a3b8',
            cursor: 'pointer',
          },
        }) as HTMLButtonElement;
        btn.addEventListener('click', onSkipToggle);
        return btn;
      };
      branchRow.append(
        makeBranchBtn('A', 'A', true),
        makeBranchBtn(bLabel, 'B', afterBSrc !== null),
        makeSkipBtn(),
      );
      title.append(titleText, branchRow);
      if (skipped) {
        const badge = el('div', {
          text: '⏭ SKIPPED — passing through',
          style: {
            fontSize: '11px',
            color: '#fbbf24',
            background: 'rgba(251,191,36,0.06)',
            border: '1px dashed rgba(251,191,36,0.25)',
            borderRadius: '4px',
            padding: '6px 10px',
          },
        });
        card.append(title);
        if (inlineConfig) {
          card.append(inlineConfig);
        }
        card.append(badge);
        return card;
      }
      const row = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          alignItems: 'flex-start',
          gap: '10px',
        },
      });
      const makeBox = (label: string, src: string | null, emptyText = '—'): HTMLElement => {
        const box = el('div', {
          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
        });
        const lbl = el('div', { text: label, style: { fontSize: '10px', color: '#64748b' } });
        if (src) {
          const img = makeImgEl(96);
          img.src = src;
          box.append(lbl, img);
        } else {
          const ph = el('div', {
            text: emptyText,
            style: {
              width: '96px',
              height: '96px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px dashed rgba(148,163,184,0.2)',
              borderRadius: '4px',
              color: '#334155',
              fontSize: emptyText === '—' ? '20px' : '11px',
              textAlign: 'center',
              padding: '0 6px',
            },
          });
          box.append(lbl, ph);
        }
        return box;
      };
      row.append(
        makeBox('before', beforeSrc),
        makeBox('after (A)', afterASrc),
        makeBox(`after (${bLabel})`, afterBSrc, 'no experiment'),
      );
      card.append(title);
      if (inlineConfig) {
        card.append(inlineConfig);
      }
      card.append(row);
      return card;
    };

    const makeReprocessStepBridge = (onReprocess: () => void): HTMLElement => {
      const row = el('div', {
        style: {
          display: 'flex',
          justifyContent: 'center',
          margin: '4px 0 10px',
        },
      });
      const button = el('button', {
        text: 'Reprocess',
        style: {
          fontSize: '10px',
          padding: '3px 10px',
          borderRadius: '999px',
          border: '1px solid #475569',
          background: '#1e293b',
          color: '#94a3b8',
          cursor: 'pointer',
        },
      }) as HTMLButtonElement;
      button.addEventListener('click', onReprocess);
      row.append(button);
      return row;
    };

    const makeSlicingStepCard = (collapsed: boolean, onCollapseToggle: () => void): HTMLElement => {
      const card = el('div', {
        style: {
          marginBottom: '10px',
          padding: '10px',
          background: 'rgba(15,23,42,0.5)',
          border: '1px solid rgba(148,163,184,0.1)',
          borderRadius: '6px',
        },
      });
      const headerEl = el('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '11px',
          color: '#7dd3fc',
          fontWeight: '600',
          marginBottom: collapsed ? '0' : '10px',
          letterSpacing: '0.02em',
        },
      });
      const titleText = el('span', { text: 'Slicing — visualization only' });
      const vizNote = el('div', {
        text: 'Canonical slicer drives both this visualization and the traced pipeline.',
        style: {
          fontSize: '10px',
          color: '#64748b',
          marginBottom: collapsed ? '0' : '6px',
          fontWeight: '400',
          letterSpacing: '0',
        },
      });
      const btnRow = el('div', { style: { display: 'flex', gap: '4px' } });
      const collapseBtn = el('button', {
        text: collapsed ? '▶ Show' : 'Skip',
        style: {
          fontSize: '10px',
          padding: '2px 8px',
          borderRadius: '4px',
          border: `1px solid ${collapsed ? '#fbbf24' : '#475569'}`,
          background: collapsed ? 'rgba(251,191,36,0.12)' : '#1e293b',
          color: collapsed ? '#fbbf24' : '#94a3b8',
          cursor: 'pointer',
        },
      }) as HTMLButtonElement;
      collapseBtn.addEventListener('click', onCollapseToggle);
      btnRow.append(collapseBtn);
      headerEl.append(titleText, btnRow);
      card.append(headerEl);
      if (!collapsed) {
        card.append(vizNote, slicingVariantRow, slicingStatus, slicingCanvas);
      }
      return card;
    };

    const makeFinalOutputCard = (src: string): HTMLElement => {
      const card = el('div', {
        style: {
          marginTop: '10px',
          padding: '10px',
          background: 'rgba(15,23,42,0.5)',
          border: '1px solid rgba(148,163,184,0.1)',
          borderRadius: '6px',
        },
      });
      const title = el('div', {
        text: 'Final output',
        style: {
          fontSize: '11px',
          color: '#7dd3fc',
          fontWeight: '600',
          marginBottom: '8px',
          letterSpacing: '0.02em',
        },
      });
      const resolvedAnchor: AnchorMarkerState | null =
        manualAnchorOverride &&
        (manualAnchorOverride.applyToAllVariants === true ||
          manualAnchorOverride.variantIndex === variantIndex)
          ? { x: manualAnchorOverride.x, y: manualAnchorOverride.y, source: 'manual' }
          : derivedAnchorForDebugVariant;
      const img = makeImgEl(128);
      img.src = src;
      img.style.cursor = 'crosshair';
      img.title = 'Click a pixel to set the anchor.';
      const imageWrap = el('div', {
        style: { position: 'relative', display: 'inline-block', width: '128px', height: '128px' },
      });
      const anchorMarker = el('div', {
        text: '+',
        style: {
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#facc15',
          fontWeight: '700',
          fontSize: '22px',
          lineHeight: '1',
          textShadow: '0 0 2px #000, 0 0 6px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
          display: resolvedAnchor ? 'block' : 'none',
        },
      });
      const updateAnchorMarker = (anchor: AnchorMarkerState | null): void => {
        if (!anchor || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
          anchorMarker.style.display = 'none';
          return;
        }
        const leftPct = ((anchor.x + 0.5) / img.naturalWidth) * 100;
        const topPct = ((anchor.y + 0.5) / img.naturalHeight) * 100;
        anchorMarker.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
        anchorMarker.style.top = `${Math.max(0, Math.min(100, topPct))}%`;
        anchorMarker.style.color = anchor.source === 'manual' ? '#facc15' : '#22d3ee';
        anchorMarker.style.display = 'block';
      };
      img.onload = () => {
        updateAnchorMarker(
          manualAnchorOverride &&
            (manualAnchorOverride.applyToAllVariants === true ||
              manualAnchorOverride.variantIndex === variantIndex)
            ? { x: manualAnchorOverride.x, y: manualAnchorOverride.y, source: 'manual' }
            : derivedAnchorForDebugVariant,
        );
      };
      img.onclick = (event) => {
        if (!debugTarget) {
          finalAdjustStatus.textContent = 'Select a debug target first.';
          finalAdjustStatus.style.color = '#fca5a5';
          return;
        }
        const rect = img.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          img.naturalWidth <= 0 ||
          img.naturalHeight <= 0
        ) {
          return;
        }
        const x = Math.max(
          0,
          Math.min(
            img.naturalWidth - 1,
            Math.floor(((event.clientX - rect.left) / rect.width) * img.naturalWidth),
          ),
        );
        const y = Math.max(
          0,
          Math.min(
            img.naturalHeight - 1,
            Math.floor(((event.clientY - rect.top) / rect.height) * img.naturalHeight),
          ),
        );
        manualAnchorOverride = {
          variantIndex: debugTarget.variantIndex,
          x,
          y,
          ...(applyScopeSelection === 'all' ? { applyToAllVariants: true } : {}),
        };
        pendingManualAnchorClear = false;
        syncTweakInputsFromState();
        pendingPostprocessMode = 'replace';
        finalAdjustStatus.textContent = `Anchor picked at (${x}, ${y}). Click Apply changes to persist.`;
        finalAdjustStatus.style.color = '#93c5fd';
        rerenderDebuggerAfterTweaks();
      };
      const controlPanel = el('div', {
        style: {
          marginTop: '10px',
          padding: '10px',
          borderRadius: '6px',
          border: '1px solid rgba(56,189,248,0.25)',
          background: 'rgba(8,47,73,0.35)',
          display: 'grid',
          gap: '8px',
        },
      });
      const topRow = el('div', {
        style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' },
      });
      const facingLabel = el('label', {
        style: {
          display: 'inline-flex',
          gap: '6px',
          alignItems: 'center',
          fontSize: '11px',
          color: '#bae6fd',
        },
      });
      facingLabel.append(el('span', { text: 'Facing' }), facingDirectionSelect);
      topRow.append(
        facingLabel,
        el('span', { text: 'Scope', style: { fontSize: '11px', color: '#bae6fd' } }),
        applyScopeSelect,
      );
      const anchorRow = el('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      });
      anchorRow.append(
        el('span', { text: 'Hold anchor x/y', style: { fontSize: '11px', color: '#bae6fd' } }),
        manualAnchorXInput,
        manualAnchorYInput,
      );
      const weaponAnchorRow = el('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      });
      weaponAnchorRow.append(
        el('span', { text: 'Weapon anchor x/y', style: { fontSize: '11px', color: '#bae6fd' } }),
        manualWeaponAnchorXInput,
        manualWeaponAnchorYInput,
      );
      const actionRow = el('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      });
      actionRow.append(applyChangesBtn, resetAnchorBtn, returnToWorkflowBtn, finalAdjustStatus);
      applyChangesBtn.onclick = async () => {
        if (!debugTarget) {
          finalAdjustStatus.textContent = 'Select a debug target first.';
          finalAdjustStatus.style.color = '#fca5a5';
          return;
        }
        const applyMode: 'replace' | 'reset' =
          pendingPostprocessMode === 'reset' ? 'reset' : 'replace';
        if (applyMode === 'replace') {
          syncManualAnchorFromInputs();
          syncManualWeaponAnchorFromInputs();
        }
        const hasManualAnchor = manualAnchorOverride !== null;
        const currentManualAnchor = manualAnchorOverride;
        const hasManualWeaponAnchor = manualWeaponAnchorOverride !== null;
        const currentManualWeaponAnchor = manualWeaponAnchorOverride;
        const applyToAll = applyScopeSelection === 'all';
        finalAdjustStatus.textContent = 'Applying…';
        finalAdjustStatus.style.color = '#93c5fd';
        applyChangesBtn.disabled = true;
        try {
          const manualAnchorPayload =
            pendingManualAnchorClear || !hasManualAnchor
              ? pendingManualAnchorClear
                ? null
                : undefined
              : {
                  variantIndex: debugTarget.variantIndex,
                  x: currentManualAnchor!.x,
                  y: currentManualAnchor!.y,
                  ...(applyToAll ? { applyToAllVariants: true } : {}),
                };
          const manualWeaponAnchorPayload =
            pendingManualWeaponAnchorClear || !hasManualWeaponAnchor
              ? pendingManualWeaponAnchorClear
                ? null
                : undefined
              : {
                  variantIndex: debugTarget.variantIndex,
                  x: currentManualWeaponAnchor!.x,
                  y: currentManualWeaponAnchor!.y,
                  ...(applyToAll ? { applyToAllVariants: true } : {}),
                };
          await fetchJson(
            `${SIDECAR_BASE}/api/runs/${encodeURIComponent(debugTarget.briefId)}/${encodeURIComponent(debugTarget.runId)}/postprocess`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mode: applyMode,
                ...(applyMode === 'replace'
                  ? {
                      options: {
                        background: {
                          colorToleranceSq: appliedBackgroundTweaks.colorToleranceSq,
                          fringeToleranceSq: appliedBackgroundTweaks.fringeToleranceSq,
                        },
                      },
                      facing: {
                        variantIndex: debugTarget.variantIndex,
                        direction: facingDirection,
                        ...(applyToAll ? { applyToAllVariants: true } : {}),
                      },
                      ...(manualAnchorPayload !== undefined
                        ? { manualAnchor: manualAnchorPayload }
                        : {}),
                      ...(manualWeaponAnchorPayload !== undefined
                        ? { weaponAnchor: manualWeaponAnchorPayload }
                        : {}),
                      ...(!applyToAll ? { variantIndexes: [debugTarget.variantIndex] } : {}),
                    }
                  : {}),
              }),
            },
          );
          if (pendingManualAnchorClear) {
            manualAnchorOverride = null;
          }
          if (pendingManualWeaponAnchorClear) {
            manualWeaponAnchorOverride = null;
          }
          pendingManualAnchorClear = false;
          pendingManualWeaponAnchorClear = false;
          pendingPostprocessMode = 'default';
          finalAdjustStatus.textContent = applyToAll
            ? 'Applied to all variants.'
            : `Applied to variant #${debugTarget.variantIndex}.`;
          finalAdjustStatus.style.color = '#86efac';
          rerenderDebuggerAfterTweaks();
          void refreshDebuggerRuns();
        } catch (error) {
          finalAdjustStatus.textContent =
            error instanceof Error
              ? `Apply failed: ${error.message}`
              : `Apply failed: ${String(error)}`;
          finalAdjustStatus.style.color = '#fca5a5';
        } finally {
          applyChangesBtn.disabled = false;
        }
      };
      const facingArrow = el('div', {
        text: facingDirection === 'left' ? '← facing left' : 'facing right →',
        style: { fontSize: '11px', color: '#bae6fd', marginTop: '6px' },
      });
      controlPanel.append(topRow, anchorRow, weaponAnchorRow, facingArrow, actionRow);
      imageWrap.append(img, anchorMarker);
      card.append(title, imageWrap, controlPanel);
      return card;
    };

    // ── Async: fetch sheets + manifest + run summary in parallel ──────
    void (async () => {
      try {
        const [sheetResult, manifestResult, summaryResult] = await Promise.allSettled([
          fetchJson<SidecarSheetsResponse>(sheetsUrl(briefId, runId)),
          fetchJson<PipelineManifest>(spriteUrl(briefId, runId, `${padded}.pipeline.json`)),
          fetchJson<Record<string, unknown>>(
            `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}`,
          ),
        ]);

        if (
          !debugTarget ||
          `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !== targetKey
        )
          return;

        // Resolve sheet files
        let sheetFiles: string[] = [];
        let sheetRunId = runId;
        if (sheetResult.status === 'fulfilled') {
          sheetFiles = normalizeSheetFiles(sheetResult.value);
        }
        if (sheetFiles.length === 0 && manifestResult.status === 'fulfilled') {
          const src =
            typeof manifestResult.value.sourceRunId === 'string' &&
            manifestResult.value.sourceRunId.length > 0
              ? manifestResult.value.sourceRunId
              : null;
          if (src) {
            sheetRunId = src;
            try {
              const fb = await fetchJson<SidecarSheetsResponse>(sheetsUrl(briefId, src));
              if (
                renderToken !== debuggerRenderToken ||
                !debugTarget ||
                `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !==
                  targetKey
              )
                return;
              sheetFiles = normalizeSheetFiles(fb);
            } catch {
              /* ignore */
            }
          }
        }

        // Sheet tabs
        if (sheetFiles.length > 1) {
          sheetTabRow.replaceChildren();
          for (const file of sheetFiles) {
            const btn = el('button', {
              text: file.replace(/^sheet-/, 'attempt ').replace(/\.png$/i, ''),
              style: {
                fontSize: '10px',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid #475569',
                background: '#1e293b',
                color: '#e2e8f0',
                cursor: 'pointer',
              },
            }) as HTMLButtonElement;
            const capturedFile = file;
            const capturedRunId = sheetRunId;
            btn.addEventListener('click', () => loadSheetFile(capturedFile, capturedRunId));
            sheetTabRow.append(btn);
          }
        }

        // Load most recent (last) sheet
        const activeSheet = sheetFiles[sheetFiles.length - 1];
        if (activeSheet) {
          loadSheetFile(activeSheet, sheetRunId);
        } else {
          sheetStatus.textContent = 'No source sheets found for this run.';
        }

        if (
          renderToken !== debuggerRenderToken ||
          !debugTarget ||
          `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !== targetKey
        )
          return;

        // ── Pipeline trace ─────────────────────────────────────────
        pipelineBody.replaceChildren();
        const finalSrcBase = spriteUrl(briefId, runId, `${padded}.png`);
        const finalSrc = `${finalSrcBase}${finalSrcBase.includes('?') ? '&' : '?'}ts=${Date.now()}`;

        if (manifestResult.status === 'rejected') {
          pipelineBody.append(
            el('div', {
              text: 'No pipeline trace available for this run.',
              style: { fontSize: '11px', color: '#64748b', marginBottom: '10px' },
            }),
            makeFinalOutputCard(finalSrc),
          );
          return;
        }

        const manifest = manifestResult.value;
        const profile =
          typeof manifest.profile === 'string' && manifest.profile.length > 0
            ? manifest.profile
            : null;
        if (profile) {
          pipelineBody.append(
            el('div', {
              text: `Profile: ${profile}`,
              style: { fontSize: '11px', color: '#475569', marginBottom: '10px' },
            }),
          );
        }

        const steps = (manifest.steps ?? []).filter(
          (s): s is Required<PipelineStepManifest> & { file: string } =>
            typeof s.file === 'string' && s.file.length > 0,
        );

        if (steps.length === 0) {
          const collapsedSteps0 = new Set<number>();
          pipelineBody.append(
            makeSlicingStepCard(false, () => {
              if (collapsedSteps0.has(0)) {
                collapsedSteps0.delete(0);
              } else {
                collapsedSteps0.add(0);
              }
            }),
            makeFinalOutputCard(finalSrc),
          );
          return;
        }

        const stepEntries = steps.map((step) => {
          const label = step.label ?? step.id ?? step.file;
          const afterASrc = spriteUrl(briefId, runId, step.file);
          return { label, afterASrc, afterBSrc: null as string | null };
        });
        const selectedBranches: Array<'A' | 'B'> = stepEntries.map(() => 'A');
        // index 0 = slicing step, 1..n = pipeline steps
        const collapsedSteps = new Set<number>();

        // Extract briefPath from summary for live postprocessing
        const briefPath =
          summaryResult.status === 'fulfilled'
            ? (summaryResult.value as Record<string, unknown>).briefPath
            : null;
        const briefPathStr =
          typeof briefPath === 'string' && briefPath.length > 0 ? briefPath : null;
        facingDirection = 'right';
        applyScopeSelection = 'variant';
        manualAnchorOverride = null;
        pendingManualAnchorClear = false;
        derivedAnchorForDebugVariant = null;
        if (summaryResult.status === 'fulfilled') {
          const candidatesRaw = (summaryResult.value as { candidates?: unknown }).candidates;
          if (Array.isArray(candidatesRaw)) {
            const candidate = candidatesRaw.find(
              (entry) =>
                entry &&
                typeof entry === 'object' &&
                (entry as { index?: unknown }).index === variantIndex,
            ) as
              | {
                  derivedAnchor?: unknown;
                  derivedAnchors?: { hold?: unknown };
                }
              | undefined;
            const hold = candidate?.derivedAnchors?.hold;
            const base = hold ?? candidate?.derivedAnchor;
            if (
              base &&
              typeof base === 'object' &&
              typeof (base as { x?: unknown }).x === 'number' &&
              typeof (base as { y?: unknown }).y === 'number'
            ) {
              derivedAnchorForDebugVariant = {
                x: (base as { x: number }).x,
                y: (base as { y: number }).y,
                source: 'derived',
              };
            }
          }
          const post = (summaryResult.value as { postprocessOverrides?: unknown })
            .postprocessOverrides;
          if (post && typeof post === 'object') {
            const options = (post as { options?: unknown }).options;
            const bg =
              options && typeof options === 'object'
                ? (options as { background?: unknown }).background
                : null;
            if (bg && typeof bg === 'object') {
              const color = (bg as { colorToleranceSq?: unknown }).colorToleranceSq;
              const fringe = (bg as { fringeToleranceSq?: unknown }).fringeToleranceSq;
              if (typeof color === 'number' && typeof fringe === 'number') {
                appliedBackgroundTweaks = { colorToleranceSq: color, fringeToleranceSq: fringe };
              }
            }
            const facing = (post as { facing?: unknown }).facing;
            const facingApplyToAll =
              facing &&
              typeof facing === 'object' &&
              (facing as { applyToAllVariants?: unknown }).applyToAllVariants === true;
            if (facing && typeof facing === 'object') {
              const direction = (facing as { direction?: unknown }).direction;
              if (direction === 'left' || direction === 'right') {
                facingDirection = direction;
              }
            }
            const manual = (post as { manualAnchor?: unknown }).manualAnchor;
            let manualApplyToAll = false;
            if (manual && typeof manual === 'object') {
              const variantIndex = (manual as { variantIndex?: unknown }).variantIndex;
              const x = (manual as { x?: unknown }).x;
              const y = (manual as { y?: unknown }).y;
              const applyToAllVariants =
                (manual as { applyToAllVariants?: unknown }).applyToAllVariants === true;
              manualApplyToAll = applyToAllVariants;
              if (
                typeof variantIndex === 'number' &&
                typeof x === 'number' &&
                typeof y === 'number'
              ) {
                manualAnchorOverride = {
                  variantIndex,
                  x,
                  y,
                  ...(applyToAllVariants ? { applyToAllVariants: true } : {}),
                };
              }
            }
            applyScopeSelection = manualApplyToAll || facingApplyToAll ? 'all' : 'variant';
            // Hydrate weapon anchor state from persisted summary.
            const manualWeapon = (post as { manualWeaponAnchor?: unknown }).manualWeaponAnchor;
            if (manualWeapon && typeof manualWeapon === 'object') {
              const variantIndex = (manualWeapon as { variantIndex?: unknown }).variantIndex;
              const x = (manualWeapon as { x?: unknown }).x;
              const y = (manualWeapon as { y?: unknown }).y;
              const applyToAllVariants =
                (manualWeapon as { applyToAllVariants?: unknown }).applyToAllVariants === true;
              if (
                typeof variantIndex === 'number' &&
                typeof x === 'number' &&
                typeof y === 'number'
              ) {
                manualWeaponAnchorOverride = {
                  variantIndex,
                  x,
                  y,
                  ...(applyToAllVariants ? { applyToAllVariants: true } : {}),
                };
              }
            }
            syncTweakInputsFromState();
          }
        }

        // Cache for live-computed pipeline results (by rawCellUrl)
        const liveResultsCache = new Map<string, LivePostprocessResult>();
        // Sticky terminal flag: once live postprocess fails for this target we
        // stop re-hitting /api/postprocess on every rerender and show the
        // pre-baked pipeline instead. Reset on an explicit user reprocess.
        let livePostprocessFailed = false;
        let pipelineRenderVersion = 0;
        rerenderPostprocessPipeline = () => {
          liveResultsCache.clear();
          livePostprocessFailed = false;
          void renderPipelineSteps();
        };

        const renderPipelineSteps = async (): Promise<void> => {
          if (renderToken !== debuggerRenderToken) return;
          const renderVersion = ++pipelineRenderVersion;
          rerenderPipeline = () => {
            void renderPipelineSteps();
          };
          const profileNode = profile
            ? el('div', {
                text: `Profile: ${profile}`,
                style: { fontSize: '11px', color: '#475569', marginBottom: '10px' },
              })
            : null;
          const experimentInfoNode = el('div', {
            text: 'Background removal runs a single promoted algorithm with configurable tolerances.',
            style: { fontSize: '11px', color: '#64748b', marginBottom: '10px' },
          });
          pipelineBody.replaceChildren(...(profileNode ? [profileNode] : []), experimentInfoNode);

          // Slicing step is always first in the pipeline
          pipelineBody.append(
            makeSlicingStepCard(collapsedSteps.has(0), () => {
              if (collapsedSteps.has(0)) {
                collapsedSteps.delete(0);
              } else {
                collapsedSteps.add(0);
              }
              void renderPipelineSteps();
            }),
          );

          // Start from current slicer selection when available; fallback to raw artifact.
          const selectedRawCellDataUrl = makeSelectedRawCellDataUrl();
          const rawCellSource =
            selectedRawCellDataUrl ?? rawSpriteUrl(briefId, runId, `${padded}.png`);
          const cacheKey =
            `${briefId}/${runId}/${variantIndex}|${getActiveSliceVersion()}|` +
            `${selectedRawCellDataUrl ? 'sheet' : 'raw'}|` +
            `c=${appliedBackgroundTweaks.colorToleranceSq}|` +
            `f=${appliedBackgroundTweaks.fringeToleranceSq}|` +
            `d=${facingDirection}`;
          let selectedOutputForNextStep: string | null = rawCellSource;

          // Renders the pre-baked pipeline (per-step PNGs from the run store),
          // seeded from `initialSource` as the step-0 "before" image. Extracted so
          // BOTH the no-briefPath path and the live-failure fallback (catch below)
          // can reuse it; it keeps its OWN `selectedOutput` accumulator so it never
          // mutates the live branch's `selectedOutputForNextStep`.
          const renderPrebakedSteps = (initialSource: string | null): void => {
            let selectedOutput: string | null = initialSource;
            if (stepEntries.length > 0) {
              pipelineBody.append(
                makeReprocessStepBridge(() => {
                  void renderPipelineSteps();
                }),
              );
            }
            for (let i = 0; i < stepEntries.length; i++) {
              const step = stepEntries[i]!;
              const combinedIdx = i + 1; // 0 = slicing
              const beforeSrc: string | null = selectedOutput;
              const selectedBranch = selectedBranches[i]!;
              const isSkipped = collapsedSteps.has(combinedIdx);
              pipelineBody.append(
                makeComparisonStepCard(
                  step.label,
                  beforeSrc,
                  step.afterASrc,
                  step.afterBSrc,
                  'B',
                  selectedBranch,
                  (branch) => {
                    const requested = branch === 'B' && step.afterBSrc === null ? 'A' : branch;
                    if (selectedBranches[i] === requested) return;
                    selectedBranches[i] = requested;
                    void renderPipelineSteps();
                  },
                  isSkipped,
                  () => {
                    if (collapsedSteps.has(combinedIdx)) {
                      collapsedSteps.delete(combinedIdx);
                    } else {
                      collapsedSteps.add(combinedIdx);
                    }
                    void renderPipelineSteps();
                  },
                ),
              );
              if (i < stepEntries.length - 1) {
                pipelineBody.append(
                  makeReprocessStepBridge(() => {
                    void renderPipelineSteps();
                  }),
                );
              }
              if (isSkipped) {
                selectedOutput = beforeSrc;
              } else {
                selectedOutput =
                  selectedBranch === 'B' && step.afterBSrc ? step.afterBSrc : step.afterASrc;
              }
            }
            pipelineBody.append(makeFinalOutputCard(finalSrc));
          };

          // If we have briefPath (and live postprocess hasn't already failed for
          // this target), compute live pipeline steps; otherwise show pre-baked.
          const useLivePostprocess = briefPathStr !== null && !livePostprocessFailed;

          if (useLivePostprocess) {
            // Compute all live steps from the raw cell
            try {
              const liveCacheKey = `${cacheKey}|bg=promoted`;
              let liveResult = liveResultsCache.get(liveCacheKey);
              if (!liveResult) {
                liveResult = await livePostprocess(rawCellSource, briefPathStr, {
                  background: {
                    colorToleranceSq: appliedBackgroundTweaks.colorToleranceSq,
                    fringeToleranceSq: appliedBackgroundTweaks.fringeToleranceSq,
                  },
                });
                liveResultsCache.set(liveCacheKey, liveResult);
              }
              if (renderVersion !== pipelineRenderVersion) {
                return;
              }
              if (renderToken !== debuggerRenderToken) {
                return;
              }
              const stepsA = liveResult.steps;
              const stepCount = stepsA.length;

              if (stepCount > 0) {
                pipelineBody.append(
                  makeReprocessStepBridge(() => {
                    liveResultsCache.delete(liveCacheKey);
                    void renderPipelineSteps();
                  }),
                );
              }

              // Render each step with live-computed images
              for (let i = 0; i < stepCount; i++) {
                const stepA = stepsA[i];
                if (!stepA) continue;
                const stepId = stepA.id ?? `step-${i + 1}`;
                const stepLabel = stepA.label ?? stepId;
                const combinedIdx = i + 1;
                const beforeSrc: string | null = selectedOutputForNextStep;
                const selectedBranch = selectedBranches[i] ?? 'A';
                const isSkipped = collapsedSteps.has(combinedIdx);

                const afterAFromStep: string = `data:image/png;base64,${stepA.png}`;
                const afterASrc: string = afterAFromStep;
                const afterBSrc: string | null = null;
                const bLabel = 'B (n/a)';

                pipelineBody.append(
                  makeComparisonStepCard(
                    stepLabel,
                    beforeSrc,
                    afterASrc,
                    afterBSrc,
                    bLabel,
                    selectedBranch,
                    (branch) => {
                      const requested = branch === 'B' && afterBSrc === null ? 'A' : branch;
                      if (selectedBranches[i] === requested) return;
                      selectedBranches[i] = requested;
                      void renderPipelineSteps();
                    },
                    isSkipped,
                    () => {
                      if (collapsedSteps.has(combinedIdx)) {
                        collapsedSteps.delete(combinedIdx);
                      } else {
                        collapsedSteps.add(combinedIdx);
                      }
                      void renderPipelineSteps();
                    },
                    stepId === 'background-removal' ? tweakPanel : null,
                  ),
                );
                if (i < stepCount - 1) {
                  pipelineBody.append(
                    makeReprocessStepBridge(() => {
                      liveResultsCache.delete(liveCacheKey);
                      void renderPipelineSteps();
                    }),
                  );
                }

                if (!isSkipped) {
                  selectedOutputForNextStep = afterASrc;
                }
              }

              // Final output from live postprocessing
              const finalOutputSrc = `data:image/png;base64,${liveResult.finalPng}`;
              pipelineBody.append(makeFinalOutputCard(finalOutputSrc));
            } catch (err) {
              // A newer render (rerender or target switch) may have superseded
              // this one while we awaited; that newer render already reset
              // pipelineBody via replaceChildren, so appending now would orphan
              // stale nodes into it. Bail if superseded.
              if (renderVersion !== pipelineRenderVersion || renderToken !== debuggerRenderToken) {
                return;
              }
              // Terminal for this target: stop re-hitting /api/postprocess on
              // subsequent rerenders and fall back to the pre-baked pipeline.
              livePostprocessFailed = true;
              pipelineBody.append(
                el('div', {
                  text: `Live re-processing unavailable (${err instanceof Error ? err.message : String(err)}). Showing pre-baked pipeline output.`,
                  style: {
                    fontSize: '11px',
                    color: '#fbbf24',
                    marginTop: '10px',
                    marginBottom: '6px',
                  },
                }),
              );
              renderPrebakedSteps(rawCellSource);
            }
          } else {
            // No briefPath, or live postprocess already failed for this target:
            // render the pre-baked pipeline images.
            if (livePostprocessFailed && briefPathStr !== null) {
              pipelineBody.append(
                el('div', {
                  text: 'Live re-processing unavailable. Showing pre-baked pipeline output.',
                  style: {
                    fontSize: '11px',
                    color: '#fbbf24',
                    marginTop: '10px',
                    marginBottom: '6px',
                  },
                }),
              );
            }
            renderPrebakedSteps(selectedOutputForNextStep);
          }
        };

        void renderPipelineSteps();
      } catch (error) {
        if (
          renderToken !== debuggerRenderToken ||
          !debugTarget ||
          `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !== targetKey
        )
          return;
        sheetStatus.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
        pipelineBody.replaceChildren(
          el('div', {
            text: `Failed to load trace: ${error instanceof Error ? error.message : String(error)}`,
            style: { fontSize: '11px', color: '#fca5a5' },
          }),
        );
      }
    })();
  };

  loadTargetBtn.addEventListener('click', () => {
    const briefId = briefIdInput.value.trim();
    const runId = runIdInput.value.trim();
    const variantIndexRaw = Number.parseInt(variantIndexInput.value, 10);
    const variantIndex =
      Number.isFinite(variantIndexRaw) && variantIndexRaw >= 0 ? variantIndexRaw : 0;
    if (!briefId || !runId) {
      return;
    }
    debugTarget = { briefId, runId, variantIndex };
    renderPostprocessDebugger();
    writeWorkflowState();
  });

  debuggerRunSelect.addEventListener('change', () => {
    void loadDebuggerVariantOptions();
  });
  debuggerRefreshPickerBtn.addEventListener('click', () => {
    void refreshDebuggerRuns();
  });
  debuggerLoadPickerBtn.addEventListener('click', () => {
    void (async () => {
      const run = findRunByKey(debuggerRunSelect.value);
      if (!run) {
        debuggerPickerStatus.textContent = 'Select a run first.';
        return;
      }
      const runKey = makeRunKey(run.briefId, run.runId);
      // Resolve the real variant indices before pinning one: a cached/background
      // paint can leave `debuggerVariantCache` unpopulated for this run, and
      // defaulting to index 0 would load the wrong variant.
      if (!debuggerVariantCache.has(runKey)) {
        await loadDebuggerVariantOptions();
      }
      const cachedVariants = debuggerVariantCache.get(runKey) ?? [0];
      const variantIndex = cachedVariants[0] ?? 0;
      debugTarget = { briefId: run.briefId, runId: run.runId, variantIndex };
      renderPostprocessDebugger();
      writeWorkflowState();
    })();
  });

  const addBriefToQueue = (): void => {
    const name = nameInput.value;
    const brief = briefInput.value;
    const requested = typeSelect.value as RequestedType;
    const next = queueAddItem(queueState, name, brief, requested, 'manual');
    if (next === queueState) {
      setWorkflowStatus('Enter a name (letters or numbers) before adding to the queue.', '#fca5a5');
      return;
    }
    queueState = next;
    const addedId = next.selectedId;
    if (addedId) {
      queueState = queueUpdateItem(queueState, addedId, {
        sizeVariant: isSizeVariant(sizeSelect.value) ? sizeSelect.value : DEFAULT_SIZE_VARIANT,
      });
    }
    nameInput.value = '';
    briefInput.value = '';
    writeQueueState();
    renderQueue();
    renderWorkflowSelection();
    const active = getSelectedItem(queueState);
    setWorkflowStatus(
      active
        ? `Added "${active.name}" to the queue. Click Synthesize to start.`
        : 'Added to queue.',
      '#bef264',
    );
  };

  addToQueueBtn.addEventListener('click', () => {
    addBriefToQueue();
  });
  const addOnEnter = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addBriefToQueue();
    }
  };
  nameInput.addEventListener('keydown', addOnEnter);
  briefInput.addEventListener('keydown', addOnEnter);

  clearQueueBtn.addEventListener('click', () => {
    queueState = queueClear(queueState);
    writeQueueState();
    renderQueue();
    renderWorkflowSelection();
    setWorkflowStatus('Queue cleared.', '#cbd5e1');
  });

  removeItemBtn.addEventListener('click', () => {
    const active = getSelectedItem(queueState);
    if (!active) {
      return;
    }
    queueState = queueRemoveItem(queueState, active.id);
    writeQueueState();
    renderQueue();
    renderWorkflowSelection();
    setWorkflowStatus(`Removed "${active.name}" from the queue.`, '#cbd5e1');
  });

  const recompute = async (): Promise<void> => {
    manifestError = null;
    const existingAssets = new Set<string>();
    let manifest: unknown = null;
    try {
      const response = await fetch('/assets/generated/manifest.json', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      manifest = (await response.json()) as unknown;
      const entries = ((manifest as { entries?: Record<string, { assetPath?: string }> }).entries ??
        {}) as Record<string, { assetPath?: string }>;
      approvedVariantKeys = new Set(Object.keys(entries));
      await Promise.all(
        Object.values(entries)
          .filter((entry): entry is { assetPath: string } => typeof entry.assetPath === 'string')
          .map(async (entry) => {
            try {
              const head = await fetch(`/assets/${entry.assetPath}`, {
                method: 'HEAD',
                cache: 'no-store',
              });
              if (head.ok) {
                existingAssets.add(entry.assetPath);
              }
            } catch {
              // Ignore per-asset lookup failures; status will surface as missing file.
            }
          }),
      );
    } catch (error) {
      manifestError = error instanceof Error ? error.message : String(error);
    }

    const approvedSprites = parseApprovedSprites(manifest, { existingAssets });
    reports = plans.map((plan) =>
      buildFloorArtPlanReport(plan, {
        briefKeys,
        draftBriefKeys,
        approvedSprites,
        spriteRegistryIds,
        itemCatalogIds,
      }),
    );
    renderActivePlan();
  };

  const renderActivePlan = (): void => {
    // No manifest chosen (default): keep the table empty and show a prompt,
    // but never swallow a real manifest-load failure surfaced by recompute().
    if (planSelect.value === '') {
      summary.replaceChildren();
      tbody.replaceChildren();
      emptyState.style.display = 'none';
      manifestState.textContent = manifestError
        ? `Manifest state: unavailable (${manifestError})`
        : 'Select a manifest to view its assets.';
      manifestState.style.color = manifestError ? '#fca5a5' : '#93c5fd';
      renderQueue();
      renderWorkflowSelection();
      return;
    }
    const plan = reports.find((candidate) => candidate.planId === planSelect.value) ?? reports[0];
    if (!plan) {
      return;
    }
    if (planSelect.value !== plan.planId) {
      planSelect.value = plan.planId;
    }

    summary.replaceChildren();
    const cards: Array<[string, string]> = [
      ['Assets', String(plan.assets.length)],
      ['Unresolved placeholders', String(plan.unresolvedPlaceholders)],
      ['Ready', String(plan.counts.ready)],
      ['Reviewed not integrated', String(plan.counts['approved-not-integrated'])],
      ['Drafts ready', String(plan.counts['draft-ready'] + plan.counts['draft-ready-placeholder'])],
      ['Needs art', String(plan.counts['needs-art-placeholder'])],
    ];
    for (const [label, value] of cards) {
      const card = el('div', {
        style: {
          border: '1px solid rgba(229,231,235,0.2)',
          borderRadius: '10px',
          padding: '10px',
          background: '#111827',
        },
      });
      card.append(
        el('div', {
          text: label,
          style: { color: '#93c5fd', fontSize: '12px', marginBottom: '4px' },
        }),
        el('div', { text: value, style: { fontSize: '20px', fontWeight: '700' } }),
      );
      summary.append(card);
    }

    manifestState.textContent = manifestError
      ? `Manifest state: unavailable (${manifestError})`
      : 'Manifest state: loaded';
    manifestState.style.color = manifestError ? '#fca5a5' : '#93c5fd';

    tbody.replaceChildren();
    const query = searchInput.value.trim().toLowerCase();
    const selectedStatus = statusFilter.value;
    const filtered = plan.assets.filter((asset) => {
      const statusMatch = selectedStatus === 'all' || asset.status === selectedStatus;
      if (!statusMatch) return false;
      if (!query) return true;
      const integrationText = asset.integration
        ? `${asset.integration.kind}:${asset.integration.id}`
        : '';
      return [asset.id, asset.label, asset.briefId, asset.status, integrationText]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });

    for (const asset of filtered) {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      if (selectedAssetId === asset.id) {
        row.style.background = 'rgba(30,64,175,0.2)';
      }
      const reviewHref = reviewHrefForApprovedAsset(asset);
      const statusPill = el('span', {
        text: formatReviewStatus(asset.status),
        style: {
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: '999px',
          background: STATUS_COLORS[asset.status],
          color: '#ffffff',
          fontSize: '11px',
          whiteSpace: 'nowrap',
        },
      });
      const integrationText = asset.integration
        ? `${asset.integration.kind}:${asset.integration.id}`
        : 'n/a';

      const statusCell = document.createElement('td');
      statusCell.append(statusPill);
      const actionsCell = document.createElement('td');
      const alreadyQueued = queueState.items.some(
        (queueItem) =>
          queueItem.source === 'asset-plan' && queueItem.kebabName === slugify(asset.label),
      );
      const requestedType: RequestedType = (SPRITE_TYPES as readonly string[]).includes(asset.type)
        ? (asset.type as RequestedType)
        : 'auto';
      const queueBtn = el('button', {
        text: alreadyQueued ? 'Queued' : 'Queue',
        style: {
          padding: '4px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(125,211,252,0.5)',
          background: alreadyQueued ? '#0c4a6e' : '#082f49',
          color: '#e0f2fe',
          cursor: alreadyQueued ? 'not-allowed' : 'pointer',
          opacity: alreadyQueued ? '0.7' : '1',
          fontSize: '11px',
        },
      }) as HTMLButtonElement;
      queueBtn.disabled = alreadyQueued;
      queueBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const alreadyQueuedNow = queueState.items.some(
          (queueItem) =>
            queueItem.source === 'asset-plan' && queueItem.kebabName === slugify(asset.label),
        );
        if (alreadyQueuedNow) {
          return; // Prevent duplicate queue items
        }
        queueBtn.disabled = true;
        selectedAssetId = asset.id;
        queueState = queueAddItem(queueState, asset.label, '', requestedType, 'asset-plan');
        writeQueueState();
        renderQueue();
        renderWorkflowSelection();
        renderActivePlan();
        writeWorkflowState();
      });
      actionsCell.append(queueBtn);
      if (reviewHref) {
        const reviewBtn = el('a', {
          text: 'Review',
          style: {
            marginLeft: '8px',
            padding: '4px 8px',
            borderRadius: '6px',
            border: '1px solid rgba(167,139,250,0.5)',
            background: '#312e81',
            color: '#ede9fe',
            cursor: 'pointer',
            fontSize: '11px',
            textDecoration: 'none',
            display: 'inline-block',
          },
        });
        reviewBtn.setAttribute('href', reviewHref);
        reviewBtn.addEventListener('click', (event) => {
          event.stopPropagation();
        });
        actionsCell.append(reviewBtn);
      }
      row.addEventListener('click', () => {
        selectedAssetId = asset.id;
        renderActivePlan();
        writeWorkflowState();
      });

      row.append(
        el('td', { text: `${asset.id} — ${asset.label}` }),
        el('td', { text: asset.type }),
        statusCell,
        el('td', { text: asset.briefId }),
        el('td', { text: asset.placeholderInUse ? 'yes' : 'no' }),
        el('td', { text: asset.briefAuthored ? 'yes' : 'no' }),
        el('td', { text: asset.draftAuthored ? 'yes' : 'no' }),
        el('td', {
          text: asset.approvedAssetExists
            ? reviewHref
              ? 'Reviewed'
              : 'yes'
            : asset.approved
              ? 'manifest-only'
              : 'no',
        }),
        el('td', { text: `${integrationText} (${asset.integrationState})` }),
        actionsCell,
      );
      tbody.append(row);
    }

    emptyState.style.display = filtered.length === 0 ? 'block' : 'none';
    renderQueue();
    renderWorkflowSelection();
  };

  // Show the "Launch worker" button only when the sidecar uses the azure-queue
  // backend (the noop path runs generate inline, so it needs no worker) and no
  // worker is currently running. This is the click target the queued-stall hint
  // points at. Hidden when the worker is running or the backend is inline/unknown.
  const updateWorkerControls = (): void => {
    const needsWorker = sidecarQueueBackend === 'azure-queue' && !sidecarWorker?.running;
    launchWorkerBtn.style.display = needsWorker ? '' : 'none';
  };

  const checkWorkflowHealth = async (): Promise<void> => {
    try {
      const health = await fetchJson<{
        status: string;
        runsDir: string;
        queueBackend?: string;
        worker?: {
          running?: boolean;
          processed?: number;
          failed?: number;
          lastError?: string | null;
        };
      }>(`${SIDECAR_BASE}/api/health`);
      sidecarQueueBackend = typeof health.queueBackend === 'string' ? health.queueBackend : null;
      sidecarWorker =
        health.worker && typeof health.worker.running === 'boolean'
          ? {
              running: health.worker.running,
              processed: health.worker.processed ?? 0,
              failed: health.worker.failed ?? 0,
              lastError: health.worker.lastError ?? null,
            }
          : null;
      updateWorkerControls();
      const queueLine = sidecarQueueBackend ? `\nQueue: ${sidecarQueueBackend}` : '';
      let workerLine = '';
      if (sidecarQueueBackend === 'azure-queue') {
        if (!sidecarWorker) {
          workerLine = '\nWorker: unknown';
        } else if (sidecarWorker.running) {
          workerLine = `\nWorker: running (processed ${sidecarWorker.processed}, failed ${sidecarWorker.failed})`;
        } else {
          workerLine = '\nWorker: stopped — click "Launch worker" to process queued runs';
        }
      }
      setWorkflowStatus(
        `Sidecar: ${health.status}\nRuns: ${health.runsDir}${queueLine}${workerLine}`,
        '#93c5fd',
      );
    } catch (error) {
      sidecarWorker = null;
      updateWorkerControls();
      setWorkflowStatus(
        `Sidecar unreachable. Start it with: npm run sprites:gallery\n${error instanceof Error ? error.message : String(error)}`,
        '#fca5a5',
      );
    }
  };

  synthBtn.addEventListener('click', async () => {
    const item = getSelectedItem(queueState);
    if (!item) {
      setWorkflowStatus('Add a brief to the queue first.', '#fca5a5');
      return;
    }
    const subject = item.name.trim() || item.kebabName;
    if (item.kebabName === '') {
      setWorkflowStatus('This item has no name.', '#fca5a5');
      return;
    }
    const briefHint = item.brief.trim();
    const requestedType = item.requestedType === 'auto' ? undefined : item.requestedType;
    queueState = queueUpdateItem(queueState, item.id, { stage: 'synthesizing', lastError: null });
    writeQueueState();
    renderQueue();
    setButtonBusy(synthBtn, true, 'Synthesize', 'Synthesizing...');
    setWorkflowStatus(`Synthesizing brief candidates for "${subject}"...`);
    try {
      const result = await fetchJson<{
        type: SpriteType;
        written: WorkflowSynthCandidate[];
        rejected: Array<{ index: number; reason: string }>;
      }>(`${SIDECAR_BASE}/api/workflow/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.kebabName,
          ...(briefHint ? { brief: briefHint } : {}),
          type: requestedType,
          sizeVariant: item.sizeVariant,
          candidates: 3,
        }),
      });
      const firstPath = result.written[0]?.yamlPath ?? null;
      queueState = queueUpdateItem(queueState, item.id, {
        stage: 'candidates',
        resolvedType: result.type,
        candidates: result.written.map((candidate) => ({
          id: candidate.id,
          yamlPath: candidate.yamlPath,
          description: candidate.description,
          yaml: candidate.yaml,
        })),
        chosenCandidatePath: firstPath,
        briefPath: null,
        run: null,
        generationRequestedAt: null,
        approvedAssetPath: null,
        approvalSummary: null,
        checkinBranch: null,
        checkinIssueUrl: null,
        checkinIssueTitle: null,
        checkinIssueBody: null,
        checkinSummary: null,
        metadataSummary: null,
        lastError: null,
      });
      writeQueueState();
      debugTarget = null;
      runResultsHost.replaceChildren();
      renderPostprocessDebugger();
      renderQueue();
      renderWorkflowSelection();
      writeWorkflowState();
      const rejected =
        result.rejected.length > 0
          ? `\nRejected:\n${result.rejected.map((entry) => `  - #${entry.index}: ${entry.reason}`).join('\n')}`
          : '';
      setWorkflowStatus(
        `Synthesis completed: ${result.written.length} candidate(s) [type: ${result.type}]. Choose one, then Generate.${rejected}`,
        '#bef264',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queueState = queueUpdateItem(queueState, item.id, { stage: 'draft', lastError: message });
      writeQueueState();
      renderQueue();
      renderWorkflowSelection();
      setWorkflowStatus(`Synthesis failed: ${message}`, '#fca5a5');
    } finally {
      setButtonBusy(synthBtn, false, 'Synthesize', 'Synthesizing...');
    }
  });

  // Sprite review page — read-only viewer for approved sprite sheets
  if (isSpriteReviewPage) {
    const params = new URLSearchParams(window.location.search);
    const queryBriefId = params.get('briefId');
    const queryRunId = params.get('runId');

    const viewerContainer = el('div', {
      style: {
        display: 'grid',
        gap: '16px',
      },
    });
    shell.append(viewerContainer);

    const runPickerHost = el('div', {
      style: {
        display: 'grid',
        gap: '8px',
      },
    });
    const renderHost = el('div', {
      style: {
        display: 'grid',
        gap: '12px',
      },
    });
    const loadingMsg = el('p', {
      text: 'Loading sprite sheet...',
      style: { color: '#93c5fd', fontSize: '14px' },
    });
    viewerContainer.append(runPickerHost, loadingMsg, renderHost);

    // Fetch and render the sprite sheet
    (async () => {
      try {
        let briefId = queryBriefId;
        let runId = queryRunId;
        const runs = await listSidecarRuns();
        let autoSelectedLatest = false;
        if (
          !briefId ||
          !runId ||
          !runs.some((run) => run.briefId === briefId && run.runId === runId)
        ) {
          loadingMsg.textContent = 'Selecting latest run...';
          const latestRun = runs[0];
          if (!latestRun) {
            renderHost.replaceChildren(
              el('div', {
                style: {
                  padding: '16px',
                  borderRadius: '8px',
                  background: '#78350f',
                  color: '#fef3c7',
                  border: '1px solid rgba(255,255,255,0.18)',
                },
                text: 'No sprite runs found yet. Generate a run from Sprite Generation Workflow first, then open Sprite Review.',
              }),
            );
            return;
          }
          briefId = latestRun.briefId;
          runId = latestRun.runId;
          autoSelectedLatest = true;
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set('page', DEVTOOLS_PAGE_SPRITE_REVIEW);
          nextUrl.searchParams.set('briefId', briefId);
          nextUrl.searchParams.set('runId', runId);
          window.history.replaceState(null, '', nextUrl.toString());
        }

        const runPickerLabel = el('p', {
          text: 'Select generated run:',
          style: { margin: '0', fontSize: '12px', color: '#93c5fd' },
        });
        const runPickerRow = el('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
        });
        const runPicker = document.createElement('select');
        Object.assign(runPicker.style, {
          background: '#0f172a',
          color: '#e2e8f0',
          border: '1px solid rgba(148,163,184,0.35)',
          borderRadius: '6px',
          padding: '6px 10px',
          fontSize: '13px',
        });
        const makeRunKey = (b: string, r: string): string => `${b}::${r}`;
        for (const run of runs) {
          const option = document.createElement('option');
          option.value = makeRunKey(run.briefId, run.runId);
          const countSuffix =
            typeof run.candidateCount === 'number' && run.candidateCount >= 0
              ? ` (${run.candidateCount} variants)`
              : '';
          option.textContent = `${run.briefId} / ${run.runId}${countSuffix}`;
          if (run.briefId === briefId && run.runId === runId) option.selected = true;
          runPicker.append(option);
        }

        const openRunBtn = document.createElement('button');
        openRunBtn.type = 'button';
        openRunBtn.textContent = 'Open run';
        Object.assign(openRunBtn.style, {
          background: '#1d4ed8',
          color: '#f8fafc',
          border: '1px solid rgba(148,163,184,0.35)',
          borderRadius: '6px',
          padding: '6px 12px',
          cursor: 'pointer',
          fontSize: '13px',
        });

        const navigateToSelectedRun = (): void => {
          const [nextBriefId, nextRunId] = runPicker.value.split('::');
          if (!nextBriefId || !nextRunId) return;
          if (nextBriefId === briefId && nextRunId === runId) return;
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set('page', DEVTOOLS_PAGE_SPRITE_REVIEW);
          nextUrl.searchParams.set('briefId', nextBriefId);
          nextUrl.searchParams.set('runId', nextRunId);
          window.location.assign(nextUrl.toString());
        };
        openRunBtn.addEventListener('click', navigateToSelectedRun);
        runPicker.addEventListener('change', navigateToSelectedRun);
        runPickerRow.append(runPicker, openRunBtn);
        runPickerHost.replaceChildren(runPickerLabel, runPickerRow);

        // Get the list of available sheets for this run
        const sheetsResp = await fetchJson<{ files: string[] }>(sheetsUrl(briefId, runId));
        const sheets = sheetsResp.files || [];

        if (sheets.length === 0) {
          loadingMsg.textContent = '';
          renderHost.replaceChildren(
            el('div', {
              style: {
                padding: '16px',
                borderRadius: '8px',
                background: '#78350f',
                color: '#fef3c7',
              },
              text: 'No sprite sheets available for this run.',
            }),
          );
          return;
        }

        // For now, just show the first sheet. In a more complete implementation,
        // we would allow selection between multiple sheets.
        const selectedSheet = sheets[0];
        if (!selectedSheet) {
          loadingMsg.textContent = '';
          renderHost.replaceChildren(
            el('div', {
              style: { color: '#fca5a5' },
              text: 'Unable to determine which sheet to display.',
            }),
          );
          return;
        }

        loadingMsg.textContent = `Fetching ${selectedSheet}...`;

        const sheetImg = document.createElement('img');
        sheetImg.src = sheetUrl(briefId, runId, selectedSheet);
        sheetImg.style.maxWidth = '100%';
        sheetImg.style.border = '1px solid rgba(148,163,184,0.2)';
        sheetImg.style.borderRadius = '8px';
        sheetImg.style.imageRendering = 'pixelated';

        sheetImg.addEventListener('load', () => {
          const detailsDiv = el('div', {
            style: { marginBottom: '12px' },
          });
          if (autoSelectedLatest) {
            detailsDiv.append(
              el('p', {
                text: 'Auto-selected latest run because briefId/runId were missing from the URL.',
                style: {
                  margin: '0 0 8px 0',
                  fontSize: '12px',
                  color: '#fde68a',
                },
              }),
            );
          }
          const sheetNameEl = el('p', {
            text: `Sheet: ${selectedSheet}`,
            style: {
              margin: '0 0 8px 0',
              fontSize: '14px',
              color: '#e5e7eb',
            },
          });
          const briefRunEl = el('p', {
            text: `${briefId} / ${runId}`,
            style: {
              margin: '0',
              fontSize: '12px',
              color: '#93c5fd',
            },
          });
          detailsDiv.append(sheetNameEl, briefRunEl);

          const viewerDiv = el('div', {
            style: {
              border: '1px solid rgba(148,163,184,0.2)',
              borderRadius: '8px',
              overflow: 'auto',
              background: '#0f172a',
              padding: '12px',
            },
          });
          viewerDiv.append(sheetImg);

          loadingMsg.textContent = '';
          renderHost.replaceChildren(detailsDiv, viewerDiv);
        });

        sheetImg.addEventListener('error', () => {
          loadingMsg.textContent = '';
          renderHost.replaceChildren(
            el('div', {
              style: { color: '#fca5a5' },
              text: `Failed to load sprite sheet: ${selectedSheet}`,
            }),
          );
        });
      } catch (error) {
        loadingMsg.textContent = '';
        renderHost.replaceChildren(
          el('div', {
            style: {
              padding: '16px',
              borderRadius: '8px',
              background: '#7f1d1d',
              color: '#fef3c7',
            },
            text: `Error loading sprite review: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
      }
    })();
  }

  const toWorkflowRunState = (
    briefId: string,
    runId: string,
    candidates: RawGenerateCandidate[],
  ): WorkflowRunState => ({
    briefId,
    runId,
    candidates: candidates.map((candidate) => ({
      index: candidate.index,
      score: candidate.score,
      outOf: candidate.outOf,
      passed: candidate.passed,
      combinedPassed: candidate.combinedPassed,
      judge: toJudgeSummary(candidate.judgeScorecard),
      sensors: toSensorResults(candidate.breakdown),
    })),
  });

  const applyRunToQueue = (
    itemId: string,
    briefId: string,
    runId: string,
    candidates: RawGenerateCandidate[],
    opts: {
      readonly stage: WorkflowStage;
      readonly status: string;
      readonly statusColor?: string;
      readonly resetApproval?: boolean;
    },
  ): void => {
    generationPollAttempts.delete(itemId);
    pendingGenerateAborts.delete(itemId);
    const patch: Partial<QueueItem> = {
      stage: opts.stage,
      run: toWorkflowRunState(briefId, runId, candidates),
      generationRequestedAt: null,
      generationStartedAt: null,
      lastError: null,
    };
    if (opts.resetApproval) {
      patch.approvedAssetPath = null;
      patch.approvalSummary = null;
      patch.checkinBranch = null;
      patch.checkinIssueUrl = null;
      patch.checkinIssueTitle = null;
      patch.checkinIssueBody = null;
      patch.checkinSummary = null;
      patch.metadataSummary = null;
    }
    lastCanceledStep.delete(itemId);
    queueState = queueUpdateItem(queueState, itemId, patch);
    writeQueueState();
    debugTarget = candidates[0]
      ? {
          briefId,
          runId,
          variantIndex: candidates[0].index,
        }
      : null;
    renderPostprocessDebugger();
    void refreshDebuggerRuns();
    renderQueue();
    renderWorkflowSelection();
    writeWorkflowState();
    setWorkflowStatus(opts.status, opts.statusColor ?? '#bef264');
  };

  /**
   * PostProcess the stored raw sheet: slice → background-fix → resize → store
   * the final variants via PR2a's re-runnable endpoint. Idempotent and
   * re-runnable on the SAME sheet without regenerating; a re-postprocess resets
   * judge verdicts, so the item lands back on `postprocessed`.
   */
  postprocessBtn.addEventListener('click', async () => {
    const item = getSelectedItem(queueState);
    if (!item || !item.run) {
      setWorkflowStatus('Generate a sheet before post-processing.', '#fca5a5');
      return;
    }
    const { briefId, runId } = item.run;
    const priorStage = item.stage;
    const abort = new AbortController();
    inFlightSteps.set(item.id, { kind: 'postprocess', abort, priorStage });
    queueState = queueUpdateItem(queueState, item.id, { stage: 'postprocessing', lastError: null });
    lastFailedStep.delete(item.id);
    lastCanceledStep.delete(item.id);
    writeQueueState();
    renderQueue();
    renderWorkflowSelection();
    setButtonBusy(postprocessBtn, true, 'PostProcess', 'Post-processing...');
    try {
      const result = await fetchJson<{ summary?: { candidates?: RawGenerateCandidate[] } }>(
        `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/postprocess`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: pendingPostprocessMode,
            ...(pendingPostprocessMode === 'replace'
              ? {
                  options: {
                    background: {
                      colorToleranceSq: appliedBackgroundTweaks.colorToleranceSq,
                      fringeToleranceSq: appliedBackgroundTweaks.fringeToleranceSq,
                    },
                  },
                }
              : {}),
            ...(manualAnchorOverride ? { manualAnchor: manualAnchorOverride } : {}),
          }),
          signal: abort.signal,
        },
      );
      const candidates = result.summary?.candidates ?? [];
      applyRunToQueue(item.id, briefId, runId, candidates, {
        stage: 'postprocessed',
        status: `Post-processed ${candidates.length} variant(s) for ${briefId}. Click Judge to rank, or Approve a variant directly.`,
        resetApproval: true,
      });
      pendingPostprocessMode = 'default';
    } catch (error) {
      // A user-initiated Cancel aborts the fetch; the Cancel handler has already
      // restored this item's prior stage, so don't clobber it with an error.
      if ((error as { name?: string }).name === 'AbortError') {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      lastFailedStep.set(item.id, 'postprocess');
      queueState = queueUpdateItem(queueState, item.id, { stage: priorStage, lastError: message });
      writeQueueState();
      renderQueue();
      renderWorkflowSelection();
      setWorkflowStatus(`PostProcess failed: ${message} — click PostProcess to retry.`, '#fca5a5');
    } finally {
      if (inFlightSteps.get(item.id)?.abort === abort) inFlightSteps.delete(item.id);
      setButtonBusy(postprocessBtn, false, 'PostProcess', 'Post-processing...');
    }
  });

  /**
   * Run the LLM judge over the post-processed variants via PR2a's re-runnable
   * endpoint. Needs the stored `processed/NN.png`, so it is only reachable once
   * PostProcess has populated variants; re-runnable from `variants`. Refused in
   * CI (403) and 400 with no vision provider — both surface via the standard
   * error path.
   *
   * `force` lifts the sensor gate so variants that failed a sensor are judged
   * anyway (the override path); `variantIndexes` restricts the pass to a subset
   * (the per-variant override). Shared by the Judge button, the run-level
   * Force-judge override, and the per-card Force-judge-variant affordance.
   */
  const runJudge = async (
    opts: { readonly force?: boolean; readonly variantIndexes?: readonly number[] } = {},
  ): Promise<void> => {
    const item = getSelectedItem(queueState);
    if (!item || !item.run || item.run.candidates.length === 0) {
      setWorkflowStatus('Post-process the sheet before judging.', '#fca5a5');
      return;
    }
    const { briefId, runId } = item.run;
    const priorStage = item.stage;
    const forced = opts.force === true;
    const subset =
      opts.variantIndexes && opts.variantIndexes.length > 0 ? [...opts.variantIndexes] : undefined;
    const body: { force?: boolean; variantIndexes?: number[] } = {};
    if (forced) body.force = true;
    if (subset) body.variantIndexes = subset;
    const abort = new AbortController();
    inFlightSteps.set(item.id, { kind: 'judge', abort, priorStage });
    queueState = queueUpdateItem(queueState, item.id, { stage: 'judging', lastError: null });
    lastFailedStep.delete(item.id);
    lastCanceledStep.delete(item.id);
    writeQueueState();
    renderQueue();
    renderWorkflowSelection();
    const triggerBtn = forced ? forceJudgeBtn : judgeBtn;
    const triggerLabel = forced ? 'Force judge' : 'Judge';
    setButtonBusy(triggerBtn, true, triggerLabel, 'Judging...');
    try {
      const result = await fetchJson<{ summary?: { candidates?: RawGenerateCandidate[] } }>(
        `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/judge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: abort.signal,
        },
      );
      const candidates = result.summary?.candidates ?? [];
      const passing = candidates.filter((candidate) => candidate.combinedPassed).length;
      const scope = subset ? ` variant${subset.length === 1 ? '' : 's'} ${subset.join(', ')}` : '';
      const forcedNote = forced ? ' (forced past sensor gate)' : '';
      applyRunToQueue(item.id, briefId, runId, candidates, {
        stage: 'variants',
        status: `Judged ${briefId}${scope}${forcedNote}: ${passing}/${candidates.length} pass. Pick the best variant and Approve.`,
      });
    } catch (error) {
      // A user-initiated Cancel aborts the fetch; the Cancel handler has already
      // restored this item's prior stage, so don't clobber it with an error.
      if ((error as { name?: string }).name === 'AbortError') {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      lastFailedStep.set(item.id, 'judge');
      queueState = queueUpdateItem(queueState, item.id, { stage: priorStage, lastError: message });
      writeQueueState();
      renderQueue();
      renderWorkflowSelection();
      setWorkflowStatus(`Judge failed: ${message} — click Judge to retry.`, '#fca5a5');
    } finally {
      if (inFlightSteps.get(item.id)?.abort === abort) inFlightSteps.delete(item.id);
      setButtonBusy(triggerBtn, false, triggerLabel, 'Judging...');
    }
  };

  judgeBtn.addEventListener('click', () => {
    void runJudge();
  });

  // Run-level override: judge every sensor-failed variant past the gate. Gated
  // by a confirm so it never fires by accident, and only shown (in
  // renderWorkflowSelection) when the run actually has sensor-failed variants.
  forceJudgeBtn.addEventListener('click', () => {
    const item = getSelectedItem(queueState);
    if (!item || !item.run || item.run.candidates.length === 0) {
      setWorkflowStatus('Post-process the sheet before judging.', '#fca5a5');
      return;
    }
    const ok = window.confirm(
      'Force the LLM judge to run on variants that FAILED a sensor check? ' +
        'This ignores the sensor gate — the judge stays advisory and you still ' +
        'decide whether to approve.',
    );
    if (!ok) return;
    void runJudge({ force: true });
  });

  const beginQueuedRunPolling = (itemId: string): void => {
    if (pendingGenerationPolls.has(itemId)) {
      return;
    }
    pendingGenerationPolls.add(itemId);
    void (async () => {
      try {
        while (true) {
          const item = queueState.items.find((candidate) => candidate.id === itemId) ?? null;
          if (!item || item.stage !== 'generating' || !item.generationRequestedAt) {
            return;
          }
          if (!Number.isFinite(Date.parse(item.generationRequestedAt))) {
            throw new Error(
              `Queued run polling stopped: invalid generationRequestedAt "${item.generationRequestedAt}".`,
            );
          }
          const attempt = (generationPollAttempts.get(itemId) ?? 0) + 1;
          generationPollAttempts.set(itemId, attempt);
          renderGenerationProgress();
          // Refresh worker health on the first poll and periodically after, so
          // a queued stall reflects the *current* worker state (and reveals the
          // "Launch worker" button) instead of the init-time snapshot.
          if (attempt === 1 || attempt % 5 === 0) {
            void checkWorkflowHealth();
          }
          try {
            const chosenCandidate = item.candidates.find(
              (c) => c.yamlPath === item.chosenCandidatePath,
            );
            // Match against the chosen candidate's id (the brief `name:`), not only
            // kebabName. The promote step copies YAML without rewriting `name:`.
            const expectedBriefIds = chosenCandidate
              ? [chosenCandidate.id, item.kebabName]
              : [item.kebabName, ...item.candidates.map((candidate) => candidate.id)];
            if (!chosenCandidate) {
              console.warn(
                `Queue item ${itemId}: chosen candidate path does not match any candidate. ` +
                  `Chosen path: ${item.chosenCandidatePath ?? 'null'}, ` +
                  `available: [${item.candidates.map((c) => c.yamlPath).join(', ')}]. ` +
                  `Falling back to known brief ids (${expectedBriefIds.join(', ')}) for run matching.`,
              );
            }
            let match: { briefId: string; runId: string } | null = null;
            for (const briefId of expectedBriefIds) {
              if (match) break;
              try {
                const latest = await fetchLatestRunForBriefSince(
                  briefId,
                  item.generationRequestedAt,
                );
                if (latest) {
                  match = { briefId: latest.briefId, runId: latest.runId };
                }
              } catch (lookupError) {
                const lookupMessage =
                  lookupError instanceof Error ? lookupError.message : String(lookupError);
                console.warn(
                  `Queued-run latest lookup failed for brief ${briefId} (will retry): ${lookupMessage}`,
                );
              }
            }
            if (match) {
              const summary = (await fetchRunSummary(match.briefId, match.runId)) as {
                candidates?: RawGenerateCandidate[];
              };
              applyRunToQueue(itemId, match.briefId, match.runId, summary.candidates ?? [], {
                stage: 'sheet',
                status: `Sheet generated for ${match.briefId}. Click PostProcess to slice, background-fix, and store variants.`,
                resetApproval: true,
              });
              return;
            }
          } catch (pollError) {
            const pollMessage = pollError instanceof Error ? pollError.message : String(pollError);
            console.warn(`Queued-run poll failed (will retry): ${pollMessage}`);
          }
          await new Promise((resolve) => window.setTimeout(resolve, QUEUED_RUN_POLL_MS));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        queueState = queueUpdateItem(queueState, itemId, {
          stage: 'candidates',
          generationRequestedAt: null,
          generationStartedAt: null,
          lastError: message,
        });
        writeQueueState();
        renderQueue();
        renderWorkflowSelection();
        setWorkflowStatus(`Queued generate failed: ${message}`, '#fca5a5');
      } finally {
        pendingGenerationPolls.delete(itemId);
        generationPollAttempts.delete(itemId);
        renderGenerationProgress();
      }
    })();
  };

  generateBtn.addEventListener('click', async () => {
    const item = getSelectedItem(queueState);
    if (!item) {
      setWorkflowStatus('Select a queue item to generate.', '#fca5a5');
      return;
    }
    if (!item.briefPath && !item.chosenCandidatePath) {
      setWorkflowStatus('Choose a candidate brief first.', '#fca5a5');
      return;
    }
    generationPollAttempts.delete(item.id);
    const abortController = new AbortController();
    pendingGenerateAborts.set(item.id, abortController);
    queueState = queueUpdateItem(queueState, item.id, {
      stage: 'generating',
      generationRequestedAt: null,
      generationStartedAt: new Date().toISOString(),
      lastError: null,
    });
    writeQueueState();
    renderQueue();
    setButtonBusy(generateBtn, true, 'Generate run', 'Generating...');
    renderGenerationProgress();
    try {
      // Fold the former standalone Promote step into Generate: when this item
      // has no promoted draft brief yet, promote the chosen candidate first,
      // then generate the raw sheet from it. Re-Choosing clears `briefPath`, so
      // a re-roll re-promotes from the freshly chosen candidate.
      let briefPath = item.briefPath;
      if (!briefPath) {
        const type =
          item.resolvedType ?? (item.requestedType === 'auto' ? null : item.requestedType);
        if (!type) {
          throw new Error('Cannot generate: sprite type is unknown. Re-run Synthesize.');
        }
        const promoted = await fetchJson<{ briefPath: string }>(
          `${SIDECAR_BASE}/api/workflow/promote-brief`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceYamlPath: item.chosenCandidatePath,
              type,
              name: item.kebabName,
              target: 'draft',
            }),
            signal: abortController.signal,
          },
        );
        briefPath = promoted.briefPath;
        draftBriefKeys.add(briefKey(type, item.kebabName));
        queueState = queueUpdateItem(queueState, item.id, { briefPath });
        writeQueueState();
        void recompute();
      }
      const result = await fetchJson<
        WorkflowGenerateCompletedResponse | WorkflowGenerateQueuedResponse
      >(`${SIDECAR_BASE}/api/workflow/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefPath }),
        signal: abortController.signal,
      });
      if (result.status === 'queued') {
        queueState = queueUpdateItem(queueState, item.id, {
          stage: 'generating',
          generationRequestedAt: result.requestedAt,
          run: null,
          approvedAssetPath: null,
          approvalSummary: null,
          checkinBranch: null,
          checkinIssueUrl: null,
          checkinIssueTitle: null,
          checkinIssueBody: null,
          checkinSummary: null,
          metadataSummary: null,
          lastError: null,
        });
        writeQueueState();
        renderQueue();
        renderWorkflowSelection();
        setWorkflowStatus(
          `Generation queued on ${result.queueBackend} for ${result.briefId}. Waiting for worker output…`,
          '#bef264',
        );
        beginQueuedRunPolling(item.id);
      } else {
        applyRunToQueue(item.id, result.briefId, result.runId, result.summary.candidates, {
          stage: 'sheet',
          status: `Sheet generated for ${result.briefId}. Click PostProcess to slice, background-fix, and store variants.`,
          resetApproval: true,
        });
      }
    } catch (error) {
      // A user-initiated Cancel aborts the fetch; the Cancel handler has
      // already reset this item's state, so don't clobber it with an error.
      if ((error as { name?: string }).name === 'AbortError') {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      queueState = queueUpdateItem(queueState, item.id, {
        stage: 'candidates',
        generationRequestedAt: null,
        generationStartedAt: null,
        lastError: message,
      });
      writeQueueState();
      renderQueue();
      renderWorkflowSelection();
      setWorkflowStatus(`Generate failed: ${message}`, '#fca5a5');
    } finally {
      pendingGenerateAborts.delete(item.id);
      const selectedAfterGenerate = getSelectedItem(queueState);
      if (selectedAfterGenerate?.stage === 'generating') {
        setButtonBusy(generateBtn, true, 'Generate run', 'Generating...');
      } else {
        setButtonBusy(generateBtn, false, 'Generate run', 'Generating...');
      }
      renderGenerationProgress();
    }
  });

  cancelGenerateBtn.addEventListener('click', () => {
    const item = getSelectedItem(queueState);
    if (!item || item.stage !== 'generating') {
      return;
    }
    // Abort the in-flight synchronous request if one is pending. For the
    // queued path there is no live request to abort; resetting the stage below
    // makes the poll loop exit on its next iteration.
    const abortController = pendingGenerateAborts.get(item.id);
    if (abortController) {
      abortController.abort();
      pendingGenerateAborts.delete(item.id);
    }
    generationPollAttempts.delete(item.id);
    // Generate is reachable only from `candidates` (promotion folds into it), so
    // a cancel always returns there — the chosen candidate/brief is unchanged
    // and re-running PostProcess/Judge is the iteration path for an existing run.
    queueState = queueUpdateItem(queueState, item.id, {
      stage: 'candidates',
      generationRequestedAt: null,
      generationStartedAt: null,
      lastError: null,
    });
    writeQueueState();
    renderQueue();
    renderWorkflowSelection();
    setButtonBusy(generateBtn, false, 'Generate run', 'Generating...');
    setWorkflowStatus(
      `Canceled generation for "${item.name}". The brief is unchanged — click Generate run to retry.`,
      '#fcd34d',
    );
  });

  // Abort the in-flight PostProcess / Judge step. The aborted fetch's own
  // finally re-enables its trigger button; here we just restore the prior stage
  // (so the step can be retried) and report the cancellation.
  cancelStepBtn.addEventListener('click', () => {
    const item = getSelectedItem(queueState);
    const step = item ? inFlightSteps.get(item.id) : null;
    if (!item || !step) return;
    step.abort.abort();
    inFlightSteps.delete(item.id);
    lastFailedStep.delete(item.id);
    lastCanceledStep.set(item.id, step.kind);
    queueState = queueUpdateItem(queueState, item.id, {
      stage: step.priorStage,
      lastError: null,
    });
    writeQueueState();
    renderQueue();
    // renderWorkflowSelection surfaces the sticky lastCanceledStep note, so the
    // "Canceled X" status survives any later re-render (e.g. a slow boot task).
    renderWorkflowSelection();
  });

  // Publish every locally-approved asset that differs from origin/main: push an
  // assets/<slug> branch and file the asset-checkin tracking issue (no PR). This
  // is the step that actually reaches GitHub — approve alone is local-only.
  checkinBtn.addEventListener('click', async () => {
    const ok = window.confirm(
      'Check in all locally-approved sprites? This pushes an assets/<slug> branch ' +
        'and files an asset-checkin issue on GitHub (no PR is opened).',
    );
    if (!ok) return;

    setButtonBusy(checkinBtn, true, 'Check in to GitHub', 'Preparing...');
    // Clear any prior result so a stale success banner can't linger if this
    // attempt fails.
    checkinResult.style.display = 'none';
    checkinResult.replaceChildren();

    try {
      // Step 1: Fast pre-flight check — detect what will be checked in
      let prepareData: CheckinPrepareResponse | null = null;
      let preflightSkippedStale = false;
      try {
        setWorkflowStatus('Checking approved assets...', '#60a5fa');
        prepareData = await prepareCheckin();
        setWorkflowStatus(
          `Ready to check in ${prepareData.assetCount} asset${prepareData.assetCount === 1 ? '' : 's'} ` +
            `on branch ${prepareData.branch}. Estimated time: ${prepareData.estimatedDuration}`,
          '#60a5fa',
        );
      } catch (prepareErr) {
        if (
          prepareErr instanceof CheckinRequestError &&
          prepareErr.errorCode === 'nothing-to-checkin'
        ) {
          setWorkflowStatus(
            'Nothing to check in — approve a sprite first. Only assets that differ from ' +
              'origin/main are published.',
            '#fcd34d',
          );
          return;
        } else if (
          prepareErr instanceof CheckinRequestError &&
          prepareErr.errorCode === 'ci-refused'
        ) {
          setWorkflowStatus(
            'Check-in is disabled in CI (it runs only from a local sidecar).',
            '#fca5a5',
          );
          return;
        } else if (isSidecarRouteMissing(prepareErr)) {
          // Stale sidecar: it lacks the newer pre-flight route but still serves
          // the older /api/checkin route. Skip pre-flight and continue — the
          // sidecar computes its own slug/branch, exactly as it did pre-#635.
          preflightSkippedStale = true;
          prepareData = null;
          setWorkflowStatus(
            `Pre-flight unavailable — ${STALE_SIDECAR_HINT} Continuing check-in without it...`,
            '#fcd34d',
          );
        } else {
          const message = prepareErr instanceof Error ? prepareErr.message : String(prepareErr);
          setWorkflowStatus(`Pre-flight check failed: ${message}`, '#fca5a5');
          return;
        }
      }

      // Step 2: Execute the actual check-in (push + issue filing happen in one request).
      setButtonBusy(checkinBtn, true, 'Check in to GitHub', 'Checking in...');
      if (prepareData) {
        setWorkflowStatus(
          `Pushing ${prepareData.assetCount} asset${prepareData.assetCount === 1 ? '' : 's'} to ${prepareData.branch} ` +
            'and filing the asset-checkin issue on GitHub...',
          '#60a5fa',
        );
      } else {
        setWorkflowStatus('Checking in approved assets (pre-flight unavailable)...', '#60a5fa');
      }

      const result = await postCheckin(prepareData?.slug);
      const count = result.assets.length;

      const normalizeCheckedAssetPath = (assetPath: string): string =>
        assetPath.startsWith('public/assets/')
          ? assetPath.slice('public/assets/'.length)
          : assetPath;
      const checkedAssetPaths = new Set(
        result.assets.map((asset) => normalizeCheckedAssetPath(asset.assetPath)),
      );
      const updatedItems = queueState.items.map((item) => {
        if (item.approvedAssetPath === null) {
          return item;
        }
        const normalizedApprovedPath = normalizeCheckedAssetPath(item.approvedAssetPath);
        if (!checkedAssetPaths.has(normalizedApprovedPath)) {
          return item;
        }
        const summary =
          `Checked in ${normalizedApprovedPath} on ${result.branch}. ` +
          `Filed issue: ${result.issueUrl}.`;
        return {
          ...item,
          stage: item.stage === 'approved' ? ('checked-in' as const) : item.stage,
          checkinBranch: result.branch,
          checkinIssueUrl: result.issueUrl,
          checkinIssueTitle: result.issueTitle,
          checkinIssueBody: result.issueBody,
          checkinSummary: summary,
          lastError: null,
        };
      });
      if (updatedItems.some((item, index) => item !== queueState.items[index])) {
        queueState = { ...queueState, items: updatedItems };
        writeQueueState();
        renderQueue();
        renderWorkflowSelection();
      }

      // Success message with link to the issue
      const link = el('a', {
        text: 'View asset-checkin issue ↗',
        style: { color: '#93c5fd', textDecoration: 'underline' },
      });
      link.href = result.issueUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      // Render into the dedicated element (not `workflowStatus`) so the 1s
      // renderWorkflowSelection poll cannot clobber the filed-issue link.
      checkinResult.style.display = 'block';
      checkinResult.replaceChildren(
        document.createTextNode(
          `✅ Successfully checked in ${count} asset${count === 1 ? '' : 's'} on ${result.branch}. `,
        ),
        link,
      );
      if (preflightSkippedStale) {
        // Persist the actionable hint next to the success banner so the 1s
        // renderWorkflowSelection poll can't wipe it from the status line.
        checkinResult.appendChild(
          el('div', {
            text: `Note: pre-flight was skipped — ${STALE_SIDECAR_HINT}`,
            style: { color: '#fcd34d', marginTop: '6px' },
          }),
        );
      }

      setWorkflowStatus(
        `✅ Checked in ${count} asset${count === 1 ? '' : 's'}. Branch: ${result.branch}`,
        '#86efac',
      );
    } catch (error) {
      if (error instanceof CheckinRequestError && error.errorCode === 'nothing-to-checkin') {
        setWorkflowStatus(
          'Nothing to check in — approve a sprite first. Only assets that differ from ' +
            'origin/main are published.',
          '#fcd34d',
        );
      } else if (error instanceof CheckinRequestError && error.errorCode === 'ci-refused') {
        setWorkflowStatus(
          'Check-in is disabled in CI (it runs only from a local sidecar).',
          '#fca5a5',
        );
      } else if (isSidecarRouteMissing(error)) {
        // Render into the persistent result element (not the transient status
        // line) so the operator retains the "restart the sidecar" instruction.
        checkinResult.style.display = 'block';
        checkinResult.replaceChildren(
          el('div', { text: STALE_SIDECAR_HINT, style: { color: '#fca5a5' } }),
        );
        setWorkflowStatus('Check-in failed — the sidecar is out of date.', '#fca5a5');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setWorkflowStatus(`Check-in failed: ${message}`, '#fca5a5');
      }
    } finally {
      setButtonBusy(checkinBtn, false, 'Check in to GitHub', 'Checking in...');
    }
  });

  launchWorkerBtn.addEventListener('click', async () => {
    setButtonBusy(launchWorkerBtn, true, 'Launch worker', 'Launching...');
    try {
      const result = await fetchJson<{
        started: boolean;
        reason: string;
        status: { running: boolean; lastError?: string | null };
      }>(`${SIDECAR_BASE}/api/workflow/worker/start`, { method: 'POST' });
      if (result.started || result.status.running) {
        setWorkflowStatus(
          'Worker launched. Queued generations will now be picked up and processed.',
          '#bef264',
        );
      } else {
        const detail = result.status.lastError ? ` — ${result.status.lastError}` : '';
        setWorkflowStatus(`Could not launch worker (${result.reason})${detail}`, '#fca5a5');
      }
    } catch (error) {
      setWorkflowStatus(
        `Launch worker failed: ${error instanceof Error ? error.message : String(error)}`,
        '#fca5a5',
      );
    } finally {
      setButtonBusy(launchWorkerBtn, false, 'Launch worker', 'Launching...');
      void checkWorkflowHealth();
    }
  });

  metadataBtn.addEventListener('click', async () => {
    const item = getSelectedItem(queueState);
    if (!item) {
      setWorkflowStatus('Add and approve an item first.', '#fca5a5');
      return;
    }
    const priorStage = item.stage;
    queueState = queueUpdateItem(queueState, item.id, { stage: 'tagging', lastError: null });
    writeQueueState();
    renderQueue();
    setButtonBusy(metadataBtn, true, 'Tag (metadata)', 'Tagging...');
    try {
      const result = await fetchJson<{
        provider: string;
        changedCount: number;
        processedCount: number;
        rejectedCount: number;
        skippedCount?: number;
        queueCommit?:
          | { status: 'committed' | 'noop'; branch: string; commit?: string; attempts: number }
          | { status: 'failed'; error: string }
          | { status: 'skipped'; reason: string }
          | null;
      }>(`${SIDECAR_BASE}/api/workflow/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [item.kebabName],
          provider: 'auto',
          minScore: 70,
        }),
      });
      // The Tag step runs its OWN durable queue-commit (#1); it — not the earlier
      // approve push — decides whether this item is safe across worktrees. A
      // failed push bakes a warning into metadataSummary (so it survives
      // recompute's re-render) and keeps queueDurability red; a null/skipped
      // result preserves the item's prior durability instead of fabricating a
      // green "ready to use" the tag never earned (#1c/#7). See applyMetadataTagResult.
      const { patch, banner } = applyMetadataTagResult({
        provider: result.provider,
        processedCount: result.processedCount,
        changedCount: result.changedCount,
        rejectedCount: result.rejectedCount,
        queueStatus: result.queueCommit?.status ?? null,
        queueCommitError:
          result.queueCommit?.status === 'failed' ? result.queueCommit.error : undefined,
        previousDurability: item.queueDurability ?? null,
      });
      queueState = queueUpdateItem(queueState, item.id, patch);
      writeQueueState();
      renderQueue();
      renderWorkflowSelection();
      // Thin passthrough: applyMetadataTagResult bundled the patch + banner into one
      // tested transition. The banner color/text is gated on the HONEST post-merge
      // durability (patch.queueDurability), so a null/skipped re-queue that INHERITS
      // a prior 'failed' stays red instead of flashing green "ready to use" (#1c/#7).
      setWorkflowStatus(banner.message, banner.color);
      void recompute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queueState = queueUpdateItem(queueState, item.id, { stage: priorStage, lastError: message });
      writeQueueState();
      renderQueue();
      renderWorkflowSelection();
      setWorkflowStatus(`Metadata failed: ${message}`, '#fca5a5');
    } finally {
      setButtonBusy(metadataBtn, false, 'Tag (metadata)', 'Tagging...');
    }
  });

  planSelect.addEventListener('change', () => {
    renderActivePlan();
    writeWorkflowState();
  });
  statusFilter.addEventListener('change', () => {
    renderActivePlan();
    writeWorkflowState();
  });
  searchInput.addEventListener('input', () => {
    renderActivePlan();
    writeWorkflowState();
  });
  refreshBtn.addEventListener('click', () => {
    void recompute();
  });

  const resumeGeneratingPolls = (): void => {
    for (const item of queueState.items) {
      if (item.stage === 'generating' && item.generationRequestedAt) {
        beginQueuedRunPolling(item.id);
      }
    }
  };

  // The sidecar store is the source of truth: on load, adopt its state (so a
  // checkpoint-wiped localStorage cache is repaired from Azure) and only fall
  // back to the cache when the sidecar is unreachable. Auto-resume polling
  // runs against the final, hydrated state.
  const hydrateQueueFromSidecar = async (): Promise<void> => {
    try {
      const res = await fetch(WORKFLOW_STATE_URL, { method: 'GET' });
      if (res.ok) {
        const body = (await res.json()) as { state?: unknown; etag?: unknown };
        workflowStateEtag = typeof body.etag === 'string' ? body.etag : null;
        if (body.state && typeof body.state === 'object') {
          queueState = deserializeQueue(JSON.stringify(body.state));
          try {
            window.localStorage.setItem(QUEUE_STORAGE_KEY, serializeQueue(queueState));
          } catch {
            // Ignore cache write failures; in-memory state is authoritative.
          }
          renderQueue();
          renderWorkflowSelection();
        } else if (queueState.items.length > 0) {
          // Sidecar reachable but has no state yet (first run): seed it from
          // the local cache so this backlog becomes durable immediately.
          scheduleWorkflowStateSync();
        }
      }
    } catch {
      // Sidecar unreachable; keep the localStorage-cached queue as-is.
    } finally {
      resumeGeneratingPolls();
    }
  };

  // Keep the generating item's elapsed clock live even when nothing else
  // triggers a re-render. The renderer is a no-op (hides the panel) whenever the
  // selected item isn't generating, so this is cheap.
  window.setInterval(renderGenerationProgress, 1000);

  renderPostprocessDebugger();
  renderQueue();
  renderWorkflowSelection();
  // Instant first paint from cache, then revalidate in the background so the
  // slow run list never blanks the debugger picker on reload.
  hydrateDebuggerRunsFromCache();
  void refreshDebuggerRuns({ background: true });
  void checkWorkflowHealth();
  // Gate the Azure runs UI on queue hydration: a run loaded before hydration
  // finishes would be clobbered by the blind queue replace, so keep the controls
  // disabled ("Syncing queue…") until hydration resolves, then enable, do the
  // initial (non-silent) list, and start the periodic refresh.
  if (showSpriteWorkflow) {
    // Paint the reload dropdown from cache now so the cached runs are visible
    // during the (short) queue-sync gate and the picker is ready the instant the
    // gate lifts. The controls are disabled just below, so it is not interactive
    // until then — this only avoids a blank dropdown while the slow list loads.
    hydrateAzureRunsFromCache();
    setAzureControlsEnabled(false);
    reloadStatus.textContent = 'Syncing queue…';
  }
  void (async () => {
    await hydrateQueueFromSidecar();
    if (showSpriteWorkflow) {
      setAzureControlsEnabled(true);
      await refreshAzureRuns();
      startAzureAutoRefresh();
    }
  })();
  void recompute();
}

render();
