import { ITEM_CATALOG } from './shared/items.js';
import { SPRITES } from './engine/sprites/index.js';
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
import {
  extractVariantIndices,
  fetchRunSummary,
  listSidecarRuns,
  postApprove,
  type SidecarRunListEntry,
} from './devtools/sprite-approval-api.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SIDECAR_BASE = 'http://127.0.0.1:3010';
const DEVTOOLS_PAGE_HOME = 'home';
const DEVTOOLS_PAGE_FLOOR_ART = 'floor-art';
const DEVTOOLS_PAGE_POSTPROCESS = 'postprocess';
type DevtoolsPage =
  | typeof DEVTOOLS_PAGE_HOME
  | typeof DEVTOOLS_PAGE_FLOOR_ART
  | typeof DEVTOOLS_PAGE_POSTPROCESS;
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

// @ts-expect-error Vite provides import.meta.glob at runtime.
const planSources = import.meta.glob('../plans/floor-art/*.art.yaml', {
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

interface WorkflowRunCandidate {
  index: number;
  score: number;
  outOf: number;
  passed: boolean;
  combinedPassed: boolean;
  judgeScorecard: { passed: boolean; minScore: number } | null;
}

interface WorkflowRunState {
  briefId: string;
  runId: string;
  candidates: WorkflowRunCandidate[];
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
}

interface ReprocessResponse {
  sourceRunDir: string;
  briefPath: string;
  runs: Array<{
    profile: string;
    briefId: string;
    runId: string;
    runDir: string;
    summaryPath: string;
  }>;
}

interface PostprocessDebugTarget {
  briefId: string;
  runId: string;
  variantIndex: number;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    readonly text?: string;
    readonly className?: string;
    readonly style?: Partial<CSSStyleDeclaration>;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
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

function sliceMapUrl(briefId: string, runId: string, version: 'v1' | 'v2' = 'v1'): string {
  const v = version === 'v2' ? '?v=2' : '';
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/slice-map${v}`;
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

async function livePostprocess(
  rawPngUrl: string,
  briefPath: string,
): Promise<LivePostprocessResult> {
  // Fetch raw PNG as blob
  const pngRes = await fetch(rawPngUrl);
  if (!pngRes.ok) {
    throw new Error(`Failed to fetch raw PNG: ${pngRes.status} ${pngRes.statusText}`);
  }
  const pngBlob = await pngRes.arrayBuffer();
  const pngBase64 = btoa(String.fromCharCode(...new Uint8Array(pngBlob)));

  // Call /api/postprocess
  const result = await fetchJson<LivePostprocessResult>(`${SIDECAR_BASE}/api/postprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      briefPath,
      rawPng: pngBase64,
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
  if (value === DEVTOOLS_PAGE_FLOOR_ART) return DEVTOOLS_PAGE_FLOOR_ART;
  return value === DEVTOOLS_PAGE_POSTPROCESS ? DEVTOOLS_PAGE_POSTPROCESS : DEVTOOLS_PAGE_HOME;
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
  const isPostprocessPage = currentPage === DEVTOOLS_PAGE_POSTPROCESS;
  const title = el('h1', { text: 'Crawler DevTools' });
  const subtitle = el('p', {
    text: LOCAL_HOSTS.has(window.location.hostname)
      ? isHomePage
        ? 'Pick a DevTool from the searchable index below.'
        : isPostprocessPage
          ? 'Postprocess debugger: inspect pipeline steps, slicing, and A/B reprocess runs.'
          : 'Floor art tracker: visibility over placeholders, briefs, approvals, and integration.'
      : 'DevTools is disabled outside localhost.',
    style: { marginBottom: '16px' },
  });
  shell.append(title, subtitle);
  root.append(shell);

  if (!LOCAL_HOSTS.has(window.location.hostname)) {
    return;
  }

  if (isHomePage) {
    const tools = [
      {
        id: DEVTOOLS_PAGE_FLOOR_ART,
        name: 'Floor art + workflow',
        description:
          'Track floor-art status, run synth/generate/approve/metadata workflow, and inspect generated candidates.',
      },
      {
        id: DEVTOOLS_PAGE_POSTPROCESS,
        name: 'Postprocess debugger',
        description:
          'Inspect pipeline steps, validate sheet slicing, and run A/B postprocess reprocessing with profiles.',
      },
    ] as const;
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
            display: 'block',
            padding: compact ? '12px 14px' : '16px 20px',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '12px',
            background: 'rgba(22, 33, 62, 0.9)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
            color: '#e0e0e0',
            textDecoration: 'none',
            transition: 'border-color 0.15s, transform 0.15s',
          },
        });
        card.setAttribute('href', `/devtools.html?page=${encodeURIComponent(tool.id)}`);
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

  const plans = parseFloorArtPlans(planSources);
  if (plans.length === 0) {
    shell.append(
      el('p', {
        text: 'No floor art plans found under plans/floor-art/*.art.yaml.',
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
    option.textContent = value === 'all' ? 'All statuses' : value;
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
    'Approved',
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
    text: 'Sprite workflow (asset-plan integrated)',
    style: { margin: '0 0 8px 0', fontSize: '16px', color: '#e5e7eb' },
  });
  const workflowHint = el('p', {
    text: 'Queue assets from this plan and drive one-liner → brief → generation → winner approval → metadata from DevTools.',
    style: { margin: '0 0 10px 0', fontSize: '12px', color: '#93c5fd' },
  });
  const queueBar = el('div', {
    style: {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      marginBottom: '10px',
      alignItems: 'center',
    },
  });
  const clearQueueBtn = el('button', {
    text: 'Clear queue',
    style: {
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#1f2937',
      color: '#e5e7eb',
      cursor: 'pointer',
      fontSize: '12px',
    },
  });
  const queueList = el('div', {
    style: { display: 'flex', gap: '6px', flexWrap: 'wrap', flex: '1 1 auto' },
  });
  queueBar.append(clearQueueBtn, queueList);

  const selectedAssetLabel = el('p', {
    text: 'Selected asset: none',
    style: { margin: '0 0 8px 0', fontSize: '12px', color: '#cbd5e1' },
  });

  const oneLinerInput = el('input', {
    style: {
      width: '100%',
      marginBottom: '8px',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(229,231,235,0.3)',
      background: '#111827',
      color: '#e5e7eb',
    },
  });
  oneLinerInput.placeholder = 'One-liner subject for synthesis (e.g. "baby dragon")';

  const workflowButtons = el('div', {
    style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' },
  });
  const synthBtn = el('button', {
    text: '1) Synthesize brief candidates',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(56,189,248,0.5)',
      background: '#082f49',
      color: '#e0f2fe',
      cursor: 'pointer',
    },
  });
  const promoteBtn = el('button', {
    text: '2) Promote selected brief',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(52,211,153,0.5)',
      background: '#052e2b',
      color: '#d1fae5',
      cursor: 'pointer',
    },
  });
  const generateBtn = el('button', {
    text: '3) Generate run',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(250,204,21,0.5)',
      background: '#422006',
      color: '#fef3c7',
      cursor: 'pointer',
    },
  });
  const metadataBtn = el('button', {
    text: '4) Generate metadata',
    style: {
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(167,139,250,0.5)',
      background: '#312e81',
      color: '#ede9fe',
      cursor: 'pointer',
    },
  });
  workflowButtons.append(synthBtn, promoteBtn, generateBtn, metadataBtn);

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

  const synthResultsHost = el('div', {
    style: { marginBottom: '10px', display: 'grid', gap: '6px' },
  });
  const runResultsHost = el('div', {
    style: { display: 'grid', gap: '6px' },
  });
  workflowPanel.append(
    workflowTitle,
    workflowHint,
    queueBar,
    selectedAssetLabel,
    oneLinerInput,
    workflowButtons,
    workflowStatus,
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
    text: 'Focused tool for pipeline steps, source-sheet slicing, and postprocess A/B reprocess runs.',
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
  const debuggerTraceHost = el('div', { style: { marginTop: '8px' } });
  const debuggerReprocessSection = el('div', {
    style: {
      margin: '8px 0 0',
      padding: '8px',
      border: '1px solid rgba(148,163,184,0.2)',
      borderRadius: '6px',
      background: 'rgba(15,23,42,0.7)',
    },
  });
  const debuggerReprocessStatus = el('div', {
    text: 'Reprocess status: waiting for debug target.',
    style: { fontSize: '11px', color: '#94a3b8', marginTop: '6px', whiteSpace: 'pre-wrap' },
  });
  const reprocessModes: ReadonlyArray<'edge-drop' | 'preserve-orphans' | 'disabled'> = [
    'edge-drop',
    'preserve-orphans',
    'disabled',
  ];
  const reprocessARow = el('div', {
    style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' },
  });
  const reprocessALabel = document.createElement('input');
  reprocessALabel.placeholder = 'A label';
  reprocessALabel.value = 'A';
  Object.assign(reprocessALabel.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  const reprocessAMode = document.createElement('select');
  for (const mode of reprocessModes) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode;
    reprocessAMode.append(option);
  }
  Object.assign(reprocessAMode.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  reprocessARow.append(reprocessALabel, reprocessAMode);
  const reprocessBEnableLabel = el('label', {
    style: {
      display: 'flex',
      alignItems: 'center',
      fontSize: '11px',
      color: '#cbd5e1',
      marginBottom: '6px',
    },
  });
  const reprocessBEnable = document.createElement('input');
  reprocessBEnable.type = 'checkbox';
  reprocessBEnable.style.margin = '0 6px 0 0';
  reprocessBEnableLabel.append(reprocessBEnable, document.createTextNode('Enable B profile'));
  const reprocessBRow = el('div', {
    style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' },
  });
  const reprocessBLabel = document.createElement('input');
  reprocessBLabel.placeholder = 'B label';
  reprocessBLabel.value = 'B';
  Object.assign(reprocessBLabel.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  const reprocessBMode = document.createElement('select');
  for (const mode of reprocessModes) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode;
    reprocessBMode.append(option);
  }
  Object.assign(reprocessBMode.style, {
    width: '100%',
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
  });
  reprocessBRow.append(reprocessBLabel, reprocessBMode);
  const runReprocessBtn = el('button', {
    text: 'Run reprocess',
    style: {
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: '#1e293b',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '11px',
    },
  });
  debuggerReprocessSection.append(
    el('div', {
      text: 'Postprocess A/B',
      style: { fontSize: '12px', fontWeight: '600', marginBottom: '4px' },
    }),
    reprocessARow,
    reprocessBEnableLabel,
    reprocessBRow,
    runReprocessBtn,
    debuggerReprocessStatus,
  );
  debuggerPanel.append(
    debuggerTitle,
    debuggerHint,
    debuggerTargetLabel,
    debuggerPickerRow,
    debuggerPickerStatus,
    debuggerTargetForm,
    debuggerTraceHost,
    debuggerReprocessSection,
  );
  shell.append(debuggerPanel);
  const showFloorArtWorkflow = !isPostprocessPage;
  controls.style.display = showFloorArtWorkflow ? 'flex' : 'none';
  summary.style.display = showFloorArtWorkflow ? 'grid' : 'none';
  manifestState.style.display = showFloorArtWorkflow ? 'block' : 'none';
  tableWrap.style.display = showFloorArtWorkflow ? 'block' : 'none';
  emptyState.style.display = showFloorArtWorkflow ? emptyState.style.display : 'none';
  workflowPanel.style.display = showFloorArtWorkflow ? 'block' : 'none';
  debuggerPanel.style.display = isPostprocessPage ? 'block' : 'none';

  let reports: FloorArtPlanReport[] = [];
  let manifestError: string | null = null;
  let currentPlan: FloorArtPlanReport | null = null;
  let selectedAssetId: string | null = null;
  let selectedCandidatePath: string | null = null;
  let promotedBriefPath: string | null = null;
  let currentRun: WorkflowRunState | null = null;
  let debugTarget: PostprocessDebugTarget | null = null;
  let preferredSliceVersion: 'v1' | 'v2' = 'v1';
  const queuedAssetIds = new Set<string>();
  const initialParams = new URLSearchParams(window.location.search);
  const initialBriefId = initialParams.get('briefId');
  const initialRunId = initialParams.get('runId');
  const initialVariantIndex = Number.parseInt(initialParams.get('variantIndex') ?? '0', 10);
  if (initialBriefId) {
    briefIdInput.value = initialBriefId;
  }
  if (initialRunId) {
    runIdInput.value = initialRunId;
  }
  if (Number.isFinite(initialVariantIndex) && initialVariantIndex >= 0) {
    variantIndexInput.value = String(initialVariantIndex);
  }
  if (initialBriefId && initialRunId) {
    debugTarget = {
      briefId: initialBriefId,
      runId: initialRunId,
      variantIndex:
        Number.isFinite(initialVariantIndex) && initialVariantIndex >= 0 ? initialVariantIndex : 0,
    };
  }
  let debuggerRuns: SidecarRunListEntry[] = [];
  const debuggerVariantCache = new Map<string, number[]>();
  const experimentPartnerByRun = new Map<
    string,
    { briefId: string; runId: string; label: string }
  >();
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
  const refreshDebuggerRuns = async (): Promise<void> => {
    debuggerPickerStatus.textContent = 'Loading available runs…';
    debuggerRefreshPickerBtn.disabled = true;
    debuggerLoadPickerBtn.disabled = true;
    try {
      debuggerRuns = await listSidecarRuns();
      populateDebuggerRunOptions();
      const targetKey = debugTarget ? makeRunKey(debugTarget.briefId, debugTarget.runId) : '';
      if (targetKey && findRunByKey(targetKey)) {
        debuggerRunSelect.value = targetKey;
      }
      await loadDebuggerVariantOptions(debugTarget?.variantIndex);
      debuggerPickerStatus.textContent = `Available runs: ${debuggerRuns.length}`;
    } catch (error) {
      debuggerRuns = [];
      populateDebuggerRunOptions();
      setDebuggerVariantOptions([0], 0);
      debuggerPickerStatus.textContent = `Failed to load runs: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      debuggerRefreshPickerBtn.disabled = false;
      debuggerLoadPickerBtn.disabled = false;
    }
  };

  const getSelectedAsset = () =>
    currentPlan?.assets.find((asset) => asset.id === selectedAssetId) ?? null;

  const setWorkflowStatus = (message: string, color = '#cbd5e1') => {
    workflowStatus.style.color = color;
    workflowStatus.textContent = message;
  };

  const renderQueue = () => {
    queueList.replaceChildren();
    const plan = currentPlan;
    if (!plan || queuedAssetIds.size === 0) {
      queueList.append(
        el('span', { text: 'Queue is empty', style: { fontSize: '12px', color: '#64748b' } }),
      );
      return;
    }
    for (const assetId of queuedAssetIds) {
      const asset = plan.assets.find((candidate) => candidate.id === assetId);
      const chip = el('button', {
        text: asset ? `${asset.id} (${asset.type})` : assetId,
        style: {
          padding: '4px 8px',
          borderRadius: '999px',
          border: '1px solid rgba(125,211,252,0.5)',
          background: selectedAssetId === assetId ? '#0c4a6e' : '#082f49',
          color: '#e0f2fe',
          cursor: 'pointer',
          fontSize: '11px',
        },
      });
      chip.addEventListener('click', () => {
        selectedAssetId = assetId;
        renderQueue();
        renderWorkflowSelection();
      });
      queueList.append(chip);
    }
  };

  const renderWorkflowSelection = () => {
    const selected = getSelectedAsset();
    if (!selected) {
      selectedAssetLabel.textContent = 'Selected asset: none';
      promoteBtn.disabled = true;
      generateBtn.disabled = true;
      metadataBtn.disabled = true;
      return;
    }
    selectedAssetLabel.textContent = `Selected asset: ${selected.id} — ${selected.label} [${selected.type}]`;
    if (oneLinerInput.value.trim() === '' || oneLinerInput.dataset.assetId !== selected.id) {
      oneLinerInput.value = selected.label;
      oneLinerInput.dataset.assetId = selected.id;
    }
    promoteBtn.disabled = selectedCandidatePath === null;
    generateBtn.disabled = promotedBriefPath === null;
    metadataBtn.disabled = currentRun === null;
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
        selectedCandidatePath = candidate.yamlPath;
        promotedBriefPath = null;
        currentRun = null;
        debugTarget = null;
        renderSynthCandidates(candidates);
        runResultsHost.replaceChildren();
        renderPostprocessDebugger();
        renderWorkflowSelection();
      });
      summaryNode.append(
        chooseBtn,
        el('span', { text: `${candidate.id} — ${candidate.description}` }),
      );
      card.append(
        summaryNode,
        el('pre', {
          text: candidate.yaml,
          style: {
            marginTop: '8px',
            fontSize: '10px',
            lineHeight: '1.35',
            color: '#cbd5e1',
            whiteSpace: 'pre-wrap',
            maxHeight: '220px',
            overflow: 'auto',
          },
        }),
      );
      synthResultsHost.append(card);
    }
  };

  const renderRunCandidates = () => {
    runResultsHost.replaceChildren();
    if (!currentRun) return;
    const run = currentRun;
    const title = el('div', {
      text: `Run ${run.briefId}/${run.runId}`,
      style: { fontSize: '12px', color: '#93c5fd', marginBottom: '4px' },
    });
    const grid = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    for (const candidate of run.candidates) {
      const card = el('div', {
        style: {
          border: '1px solid rgba(148,163,184,0.25)',
          borderRadius: '8px',
          padding: '6px',
          background: '#111827',
          width: '120px',
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
      });
      card.append(
        sprite,
        el('div', {
          text: `#${candidate.index} ${candidate.score}/${candidate.outOf} ${candidate.combinedPassed ? 'PASS' : 'fail'}`,
          style: { fontSize: '10px', color: '#cbd5e1', marginBottom: '4px' },
        }),
      );
      const approveBtn = el('button', {
        text: 'Approve',
        style: {
          width: '100%',
          padding: '4px 6px',
          borderRadius: '6px',
          border: '1px solid rgba(250,204,21,0.5)',
          background: '#422006',
          color: '#fef3c7',
          cursor: 'pointer',
          fontSize: '11px',
        },
      });
      approveBtn.disabled = !candidate.combinedPassed;
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
        debugTarget = { briefId: run.briefId, runId: run.runId, variantIndex: candidate.index };
        renderPostprocessDebugger();
      });
      approveBtn.addEventListener('click', async () => {
        setButtonBusy(approveBtn, true, 'Approve', 'Approving...');
        try {
          const approved = await postApprove(run.briefId, run.runId, candidate.index);
          setWorkflowStatus(
            `Approved ${run.briefId} variant ${candidate.index} -> ${approved.assetPath} (${approved.sensorScore}${approved.judgeScore ? ` · judge ${approved.judgeScore}` : ''})`,
            '#bef264',
          );
          void recompute();
        } catch (error) {
          setWorkflowStatus(
            `Approve failed: ${error instanceof Error ? error.message : String(error)}`,
            '#fca5a5',
          );
        } finally {
          setButtonBusy(approveBtn, false, 'Approve', 'Approving...');
        }
      });
      card.append(approveBtn, debugBtn);
      grid.append(card);
    }
    runResultsHost.append(title, grid);
  };

  const syncReprocessBControls = (): void => {
    const enabled = reprocessBEnable.checked;
    reprocessBLabel.disabled = !enabled;
    reprocessBMode.disabled = !enabled;
    reprocessBLabel.style.opacity = enabled ? '1' : '0.55';
    reprocessBMode.style.opacity = enabled ? '1' : '0.55';
  };
  syncReprocessBControls();
  reprocessBEnable.addEventListener('change', syncReprocessBControls);

  const renderPostprocessDebugger = (): void => {
    const target = debugTarget;
    debuggerTraceHost.replaceChildren();
    runReprocessBtn.disabled = target === null;

    if (!target) {
      debuggerTargetLabel.textContent = 'No target selected — use the picker above';
      debuggerReprocessStatus.textContent = 'Waiting for debug target.';
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
        width: `${size}px`,
        height: `${size}px`,
        objectFit: 'contain',
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
    slicingVariantRow.append(slicingVariantLabel, debuggerVariantSelect);

    const makeAbBtn = (label: string, active: boolean): HTMLButtonElement => {
      const btn = el('button', {
        text: label,
        style: {
          fontSize: '10px',
          padding: '2px 8px',
          borderRadius: '4px',
          border: `1px solid ${active ? '#7dd3fc' : '#475569'}`,
          background: active ? 'rgba(125,211,252,0.12)' : '#1e293b',
          color: active ? '#7dd3fc' : '#94a3b8',
          cursor: 'pointer',
          fontWeight: active ? '600' : '400',
        },
      }) as HTMLButtonElement;
      return btn;
    };
    let sliceVersion: 'v1' | 'v2' = preferredSliceVersion;
    const btnV1 = makeAbBtn('A — v1 (nudge)', preferredSliceVersion === 'v1');
    const btnV2 = makeAbBtn('B — v2 (bands)', preferredSliceVersion === 'v2');

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
    let sliceMapV1: SliceMapResponse | null = null;
    let sliceMapV2: SliceMapResponse | null = null;
    let hitCells: Array<{
      cell: SliceMapResponse['cells'][number];
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    // currentSliceMap is a derived getter, not separate state
    const getActiveSliceMap = (): SliceMapResponse | null =>
      sliceVersion === 'v2' ? sliceMapV2 : sliceMapV1;

    const setAbActive = (v: 'v1' | 'v2'): void => {
      sliceVersion = v;
      preferredSliceVersion = v;
      const activeStyle = {
        border: '1px solid #7dd3fc',
        background: 'rgba(125,211,252,0.12)',
        color: '#7dd3fc',
        fontWeight: '600',
      };
      const idleStyle = {
        border: '1px solid #475569',
        background: '#1e293b',
        color: '#94a3b8',
        fontWeight: '400',
      };
      Object.assign(btnV1.style, v === 'v1' ? activeStyle : idleStyle);
      Object.assign(btnV2.style, v === 'v2' ? activeStyle : idleStyle);
    };

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
      const selectedCell = sliceMap.cells.find((c) => c.index === variantIndex) ?? null;
      for (const cell of sliceMap.cells) {
        const sx = cell.x0;
        const sy = cell.y0;
        const dx = Math.round(sx * scale);
        const dy = Math.round(sy * scale);
        const dCellW = Math.round(cell.w * scale);
        const dCellH = Math.round(cell.h * scale);
        const isSelected = cell.index === variantIndex;
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
      slicingStatus.textContent =
        `${sliceMap.cols}×${sliceMap.rows} grid · ${sliceMap.cellW}×${sliceMap.cellH}px cells` +
        nudgeNote +
        cellLabel;
      slicingCanvas.style.display = 'block';
    };

    slicingCanvas.onclick = (event: MouseEvent): void => {
      if (!debugTarget || hitCells.length === 0) return;
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
    };

    debuggerVariantSelect.onchange = (): void => {
      if (!debugTarget) return;
      const variantIndexRaw = Number.parseInt(debuggerVariantSelect.value, 10);
      const selectedIndex =
        Number.isFinite(variantIndexRaw) && variantIndexRaw >= 0 ? variantIndexRaw : 0;
      if (selectedIndex === debugTarget.variantIndex) return;
      debugTarget = { ...debugTarget, variantIndex: selectedIndex };
      renderPostprocessDebugger();
    };

    const tryDrawSliceMap = (sourceImg: HTMLImageElement): void => {
      const active = getActiveSliceMap();
      if (active) {
        drawSliceMapOnCanvas(sourceImg, active);
      } else {
        pendingSheetImgForSlice = sourceImg;
      }
    };

    const onSliceMapKnown = (sliceMap: SliceMapResponse, v: 'v1' | 'v2'): void => {
      if (v === 'v1') sliceMapV1 = sliceMap;
      else sliceMapV2 = sliceMap;
      if (v !== sliceVersion) return; // Not the active version, nothing to draw yet
      if (pendingSheetImgForSlice) {
        drawSliceMapOnCanvas(pendingSheetImgForSlice, sliceMap);
        lastSheetImg = pendingSheetImgForSlice;
        pendingSheetImgForSlice = null;
      } else if (lastSheetImg) {
        drawSliceMapOnCanvas(lastSheetImg, sliceMap);
      }
    };

    // Wire A/B buttons — redraw immediately from cached maps if sheet is available
    let lastSheetImg: HTMLImageElement | null = null;
    // Button listeners are wired after renderPipelineSteps is defined (see line ~2258)

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
      const img = new Image();
      img.onload = () => {
        if (
          !debugTarget ||
          `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !== targetKey
        )
          return;
        lastSheetImg = img;
        tryDrawSliceMap(img);
      };
      img.onerror = () => {
        sheetStatus.textContent = `Failed to load ${filename}`;
      };
      img.src = sheetUrl(briefId, sheetRunId, filename);
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
        if (enabled) btn.addEventListener('click', () => onBranchSelect(branch));
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
        card.append(title, badge);
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
      card.append(title, row);
      return card;
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
        text: 'v1/v2 choice affects this visualization only. Cell selection controls which variant is traced below.',
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
      btnRow.append(btnV1, btnV2, collapseBtn);
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
      const img = makeImgEl(128);
      img.src = src;
      card.append(title, img);
      return card;
    };

    // ── Async: fetch sheets + manifest + slice-map + run summary in parallel ──────
    void (async () => {
      try {
        const [sheetResult, manifestResult, sliceMapResult, sliceMapV2Result, summaryResult] =
          await Promise.allSettled([
            fetchJson<SidecarSheetsResponse>(sheetsUrl(briefId, runId)),
            fetchJson<PipelineManifest>(spriteUrl(briefId, runId, `${padded}.pipeline.json`)),
            fetchJson<SliceMapResponse>(sliceMapUrl(briefId, runId, 'v1')),
            fetchJson<SliceMapResponse>(sliceMapUrl(briefId, runId, 'v2')),
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

        // Wire up slice-maps (drives the slicing canvas A/B)
        if (sliceMapResult.status === 'fulfilled') {
          onSliceMapKnown(sliceMapResult.value, 'v1');
        } else {
          slicingStatus.textContent = 'Slice map unavailable — run may pre-date this feature.';
        }
        if (sliceMapV2Result.status === 'fulfilled') {
          onSliceMapKnown(sliceMapV2Result.value, 'v2');
        }

        // Load most recent (last) sheet
        const activeSheet = sheetFiles[sheetFiles.length - 1];
        if (activeSheet) {
          loadSheetFile(activeSheet, sheetRunId);
        } else {
          sheetStatus.textContent = 'No source sheets found for this run.';
        }

        if (
          !debugTarget ||
          `${debugTarget.briefId}/${debugTarget.runId}/${debugTarget.variantIndex}` !== targetKey
        )
          return;

        // ── Pipeline trace ─────────────────────────────────────────
        pipelineBody.replaceChildren();
        const finalSrc = spriteUrl(briefId, runId, `${padded}.png`);
        const experimentPartner = experimentPartnerByRun.get(makeRunKey(briefId, runId)) ?? null;
        let partnerManifest: PipelineManifest | null = null;
        if (experimentPartner) {
          try {
            partnerManifest = await fetchJson<PipelineManifest>(
              spriteUrl(
                experimentPartner.briefId,
                experimentPartner.runId,
                `${padded}.pipeline.json`,
              ),
            );
          } catch {
            partnerManifest = null;
          }
        }

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
        pipelineBody.append(
          el('div', {
            text:
              experimentPartner && partnerManifest
                ? `A/B: A=${briefId}/${runId} · B=${experimentPartner.label} (${experimentPartner.briefId}/${experimentPartner.runId})`
                : 'A/B: no experiment',
            style: { fontSize: '11px', color: '#64748b', marginBottom: '10px' },
          }),
        );

        const steps = (manifest.steps ?? []).filter(
          (s): s is Required<PipelineStepManifest> & { file: string } =>
            typeof s.file === 'string' && s.file.length > 0,
        );
        const partnerSteps = ((partnerManifest?.steps ?? []).filter(
          (s): s is Required<PipelineStepManifest> & { file: string } =>
            typeof s.file === 'string' && s.file.length > 0,
        ) ?? []) as Array<Required<PipelineStepManifest> & { file: string }>;
        const partnerById = new Map(
          partnerSteps
            .filter((step) => typeof step.id === 'string' && step.id.length > 0)
            .map((step) => [step.id as string, step] as const),
        );
        const bLabel = experimentPartner?.label ?? 'B';

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

        const stepEntries = steps.map((step, i) => {
          const label = step.label ?? step.id ?? step.file;
          const afterASrc = spriteUrl(briefId, runId, step.file);
          const partnerStep =
            (step.id ? partnerById.get(step.id) : undefined) ?? partnerSteps[i] ?? null;
          const afterBSrc =
            partnerStep && experimentPartner
              ? spriteUrl(experimentPartner.briefId, experimentPartner.runId, partnerStep.file)
              : null;
          return { label, afterASrc, afterBSrc };
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

        // Cache for live-computed pipeline results (by rawCellUrl)
        const liveResultsCache = new Map<string, LivePostprocessResult>();

        // Define button wiring function before renderPipelineSteps so it can be called
        const wireSlicingButtons = (): void => {
          btnV1.onclick = () => {
            setAbActive('v1');
            if (sliceMapV1 && lastSheetImg) drawSliceMapOnCanvas(lastSheetImg, sliceMapV1);
            else if (!sliceMapV1) slicingStatus.textContent = 'v1 slice map not yet loaded…';
            void renderPipelineSteps();
          };
          btnV2.onclick = () => {
            setAbActive('v2');
            if (sliceMapV2 && lastSheetImg) drawSliceMapOnCanvas(lastSheetImg, sliceMapV2);
            else if (!sliceMapV2) slicingStatus.textContent = 'v2 slice map not yet loaded…';
            void renderPipelineSteps();
          };
        };

        const renderPipelineSteps = async (): Promise<void> => {
          const profileNode = profile
            ? el('div', {
                text: `Profile: ${profile}`,
                style: { fontSize: '11px', color: '#475569', marginBottom: '10px' },
              })
            : null;
          const abNode = el('div', {
            text:
              experimentPartner && partnerManifest
                ? `A/B: A=${briefId}/${runId} · B=${experimentPartner.label} (${experimentPartner.briefId}/${experimentPartner.runId})`
                : 'A/B: no experiment',
            style: { fontSize: '11px', color: '#64748b', marginBottom: '10px' },
          });
          pipelineBody.replaceChildren(...(profileNode ? [profileNode] : []), abNode);

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

          // Wire button listeners every time pipeline is re-rendered
          wireSlicingButtons();

          // Start with raw cell URL and include slice version in cache key
          const rawCellUrl = rawSpriteUrl(briefId, runId, `${padded}.png`);
          const cacheKey = `${rawCellUrl}|${sliceVersion}`;
          let selectedOutputForNextStep: string | null = rawCellUrl;
          let lastActiveBranch: 'A' | 'B' = 'A';

          // If we have briefPath, compute live pipeline steps; otherwise show pre-baked
          const useLivePostprocess = briefPathStr !== null;

          if (useLivePostprocess) {
            // Compute all live steps from the raw cell
            try {
              let liveResult = liveResultsCache.get(cacheKey);
              if (!liveResult) {
                liveResult = await livePostprocess(rawCellUrl, briefPathStr);
                liveResultsCache.set(cacheKey, liveResult);
              }
              const steps = liveResult.steps;

              // Render each step with live-computed images
              for (let i = 0; i < steps.length; i++) {
                const step = steps[i]!;
                const combinedIdx = i + 1;
                const beforeSrc: string | null = selectedOutputForNextStep;
                const selectedBranch = selectedBranches[i] ?? 'A';
                const isSkipped = collapsedSteps.has(combinedIdx);

                // Convert base64 to data URL
                const afterASrc = `data:image/png;base64,${step.png}`;

                pipelineBody.append(
                  makeComparisonStepCard(
                    step.label,
                    beforeSrc,
                    afterASrc,
                    null, // No B variant for live processing
                    'B',
                    selectedBranch,
                    () => {
                      // Live postprocessing doesn't have variants yet
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

                if (!isSkipped) {
                  lastActiveBranch = 'A';
                  selectedOutputForNextStep = afterASrc;
                }
              }

              // Final output from live postprocessing
              const finalOutputSrc = `data:image/png;base64,${liveResult.finalPng}`;
              pipelineBody.append(makeFinalOutputCard(finalOutputSrc));
            } catch (err) {
              pipelineBody.append(
                el('div', {
                  text: `Live postprocessing failed: ${err instanceof Error ? err.message : String(err)}`,
                  style: { fontSize: '11px', color: '#fca5a5', marginTop: '10px' },
                }),
              );
            }
          } else {
            // Fall back to pre-baked images if no briefPath
            for (let i = 0; i < stepEntries.length; i++) {
              const step = stepEntries[i]!;
              const combinedIdx = i + 1; // 0 = slicing
              const beforeSrc: string | null = selectedOutputForNextStep;
              const selectedBranch = selectedBranches[i]!;
              const isSkipped = collapsedSteps.has(combinedIdx);
              pipelineBody.append(
                makeComparisonStepCard(
                  step.label,
                  beforeSrc,
                  step.afterASrc,
                  step.afterBSrc,
                  bLabel,
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
              if (isSkipped) {
                selectedOutputForNextStep = beforeSrc;
              } else {
                lastActiveBranch = selectedBranch;
                selectedOutputForNextStep =
                  selectedBranch === 'B' && step.afterBSrc ? step.afterBSrc : step.afterASrc;
              }
            }

            const finalOutputSrc =
              lastActiveBranch === 'B' && experimentPartner
                ? spriteUrl(experimentPartner.briefId, experimentPartner.runId, `${padded}.png`)
                : finalSrc;
            pipelineBody.append(makeFinalOutputCard(finalOutputSrc));
          }
        };

        void renderPipelineSteps();
      } catch (error) {
        if (
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
      debuggerReprocessStatus.textContent = 'Reprocess status: provide brief id and run id.';
      return;
    }
    debugTarget = { briefId, runId, variantIndex };
    renderPostprocessDebugger();
  });

  debuggerRunSelect.addEventListener('change', () => {
    void loadDebuggerVariantOptions();
  });
  debuggerRefreshPickerBtn.addEventListener('click', () => {
    void refreshDebuggerRuns();
  });
  debuggerLoadPickerBtn.addEventListener('click', () => {
    const run = findRunByKey(debuggerRunSelect.value);
    if (!run) {
      debuggerPickerStatus.textContent = 'Select a run first.';
      return;
    }
    const runKey = makeRunKey(run.briefId, run.runId);
    const cachedVariants = debuggerVariantCache.get(runKey) ?? [0];
    const variantIndex = cachedVariants[0] ?? 0;
    debugTarget = { briefId: run.briefId, runId: run.runId, variantIndex };
    renderPostprocessDebugger();
  });

  runReprocessBtn.addEventListener('click', async () => {
    if (!debugTarget) {
      debuggerReprocessStatus.textContent = 'Select a debug target first.';
      debuggerReprocessStatus.style.color = '#fecaca';
      return;
    }
    setButtonBusy(runReprocessBtn as HTMLButtonElement, true, 'Run reprocess', 'Reprocessing...');
    debuggerReprocessStatus.style.color = '#93c5fd';
    debuggerReprocessStatus.textContent = 'Reprocessing…';
    try {
      const profileAName = reprocessALabel.value.trim() || 'A';
      const profileBName = reprocessBLabel.value.trim() || 'B';
      const result = await fetchJson<ReprocessResponse>(`${SIDECAR_BASE}/api/workflow/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceBriefId: debugTarget.briefId,
          sourceRunId: debugTarget.runId,
          profileA: {
            name: profileAName,
            modules: {
              speckleMode: reprocessAMode.value as 'edge-drop' | 'preserve-orphans' | 'disabled',
            },
          },
          ...(reprocessBEnable.checked
            ? {
                profileB: {
                  name: profileBName,
                  modules: {
                    speckleMode: reprocessBMode.value as
                      | 'edge-drop'
                      | 'preserve-orphans'
                      | 'disabled',
                  },
                },
              }
            : {}),
        }),
      });
      debuggerReprocessStatus.style.color = '#86efac';
      debuggerReprocessStatus.textContent = `Created runs:\n${result.runs
        .map((r) => `${r.profile}: ${r.briefId}/${r.runId}`)
        .join('\n')}`;
      if (result.runs[0] && result.runs[1]) {
        const runA = result.runs[0];
        const runB = result.runs[1];
        experimentPartnerByRun.set(makeRunKey(runA.briefId, runA.runId), {
          briefId: runB.briefId,
          runId: runB.runId,
          label: runB.profile,
        });
      }
      if (result.runs[0]) {
        debugTarget = {
          briefId: result.runs[0].briefId,
          runId: result.runs[0].runId,
          variantIndex: debugTarget.variantIndex,
        };
        renderPostprocessDebugger();
      }
    } catch (error) {
      debuggerReprocessStatus.style.color = '#fecaca';
      debuggerReprocessStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setButtonBusy(
        runReprocessBtn as HTMLButtonElement,
        false,
        'Run reprocess',
        'Reprocessing...',
      );
    }
  });

  clearQueueBtn.addEventListener('click', () => {
    queuedAssetIds.clear();
    renderQueue();
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
    const plan = reports.find((candidate) => candidate.planId === planSelect.value) ?? reports[0];
    if (!plan) {
      return;
    }
    currentPlan = plan;
    if (planSelect.value !== plan.planId) {
      planSelect.value = plan.planId;
    }

    summary.replaceChildren();
    const cards: Array<[string, string]> = [
      ['Assets', String(plan.assets.length)],
      ['Unresolved placeholders', String(plan.unresolvedPlaceholders)],
      ['Ready', String(plan.counts.ready)],
      ['Approved not integrated', String(plan.counts['approved-not-integrated'])],
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
      const statusPill = el('span', {
        text: asset.status,
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
      const queueBtn = el('button', {
        text: queuedAssetIds.has(asset.id) ? 'Queued' : 'Queue',
        style: {
          padding: '4px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(125,211,252,0.5)',
          background: queuedAssetIds.has(asset.id) ? '#0c4a6e' : '#082f49',
          color: '#e0f2fe',
          cursor: 'pointer',
          fontSize: '11px',
        },
      });
      queueBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        queuedAssetIds.add(asset.id);
        selectedAssetId = asset.id;
        renderQueue();
        renderWorkflowSelection();
        renderActivePlan();
      });
      actionsCell.append(queueBtn);
      row.addEventListener('click', () => {
        selectedAssetId = asset.id;
        renderQueue();
        renderWorkflowSelection();
        renderActivePlan();
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
          text: asset.approvedAssetExists ? 'yes' : asset.approved ? 'manifest-only' : 'no',
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

  const checkWorkflowHealth = async (): Promise<void> => {
    try {
      const health = await fetchJson<{ status: string; runsDir: string }>(
        `${SIDECAR_BASE}/api/health`,
      );
      setWorkflowStatus(`Sidecar: ${health.status}\nRuns: ${health.runsDir}`, '#93c5fd');
    } catch (error) {
      setWorkflowStatus(
        `Sidecar unreachable. Start it with: npm run sprites:gallery\n${error instanceof Error ? error.message : String(error)}`,
        '#fca5a5',
      );
    }
  };

  synthBtn.addEventListener('click', async () => {
    const selected = getSelectedAsset();
    if (!selected) {
      setWorkflowStatus('Select an asset from the table first.', '#fca5a5');
      return;
    }
    const subject = oneLinerInput.value.trim();
    if (subject === '') {
      setWorkflowStatus('Enter a one-liner subject before synthesizing.', '#fca5a5');
      return;
    }
    setButtonBusy(synthBtn, true, '1) Synthesize brief candidates', 'Synthesizing...');
    setWorkflowStatus(`Synthesizing ${selected.type} brief candidates for "${subject}"...`);
    try {
      const result = await fetchJson<{
        written: WorkflowSynthCandidate[];
        rejected: Array<{ index: number; reason: string }>;
      }>(`${SIDECAR_BASE}/api/workflow/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: subject, type: selected.type, candidates: 3 }),
      });
      selectedCandidatePath = result.written[0]?.yamlPath ?? null;
      promotedBriefPath = null;
      currentRun = null;
      debugTarget = null;
      renderSynthCandidates(result.written);
      runResultsHost.replaceChildren();
      renderPostprocessDebugger();
      renderWorkflowSelection();
      const rejected =
        result.rejected.length > 0
          ? `\nRejected:\n${result.rejected.map((item) => `  - #${item.index}: ${item.reason}`).join('\n')}`
          : '';
      setWorkflowStatus(
        `Synthesis completed: ${result.written.length} candidate(s).${rejected}`,
        '#bef264',
      );
    } catch (error) {
      setWorkflowStatus(
        `Synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
        '#fca5a5',
      );
    } finally {
      setButtonBusy(synthBtn, false, '1) Synthesize brief candidates', 'Synthesizing...');
    }
  });

  promoteBtn.addEventListener('click', async () => {
    const selected = getSelectedAsset();
    if (!selected || !selectedCandidatePath) {
      setWorkflowStatus('Select an asset and a synthesized candidate first.', '#fca5a5');
      return;
    }
    setButtonBusy(promoteBtn, true, '2) Promote selected brief', 'Promoting...');
    try {
      const result = await fetchJson<{ briefPath: string }>(
        `${SIDECAR_BASE}/api/workflow/promote-brief`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceYamlPath: selectedCandidatePath,
            type: selected.type,
            name: selected.briefId,
            target: 'draft',
          }),
        },
      );
      promotedBriefPath = result.briefPath;
      renderWorkflowSelection();
      setWorkflowStatus(`Promoted brief to ${result.briefPath}`, '#bef264');
      void recompute();
    } catch (error) {
      setWorkflowStatus(
        `Promote failed: ${error instanceof Error ? error.message : String(error)}`,
        '#fca5a5',
      );
    } finally {
      setButtonBusy(promoteBtn, false, '2) Promote selected brief', 'Promoting...');
    }
  });

  generateBtn.addEventListener('click', async () => {
    if (!promotedBriefPath) {
      setWorkflowStatus('Promote a brief first.', '#fca5a5');
      return;
    }
    setButtonBusy(generateBtn, true, '3) Generate run', 'Generating...');
    try {
      const result = await fetchJson<{
        briefId: string;
        runId: string;
        summary: { candidates: WorkflowRunCandidate[] };
      }>(`${SIDECAR_BASE}/api/workflow/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefPath: promotedBriefPath }),
      });
      currentRun = {
        briefId: result.briefId,
        runId: result.runId,
        candidates: result.summary.candidates,
      };
      debugTarget = result.summary.candidates[0]
        ? {
            briefId: result.briefId,
            runId: result.runId,
            variantIndex: result.summary.candidates[0].index,
          }
        : null;
      renderRunCandidates();
      renderPostprocessDebugger();
      void refreshDebuggerRuns();
      renderWorkflowSelection();
      setWorkflowStatus(
        `Generation completed for ${result.briefId} (${result.summary.candidates.length} candidates). Select a winner to approve.`,
        '#bef264',
      );
    } catch (error) {
      setWorkflowStatus(
        `Generate failed: ${error instanceof Error ? error.message : String(error)}`,
        '#fca5a5',
      );
    } finally {
      setButtonBusy(generateBtn, false, '3) Generate run', 'Generating...');
    }
  });

  metadataBtn.addEventListener('click', async () => {
    const selected = getSelectedAsset();
    if (!selected) {
      setWorkflowStatus('Select an asset first.', '#fca5a5');
      return;
    }
    setButtonBusy(metadataBtn, true, '4) Generate metadata', 'Generating metadata...');
    try {
      const result = await fetchJson<{
        provider: string;
        changedCount: number;
        processedCount: number;
        rejectedCount: number;
      }>(`${SIDECAR_BASE}/api/workflow/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [selected.briefId],
          provider: 'auto',
          minScore: 70,
        }),
      });
      setWorkflowStatus(
        `Metadata done via ${result.provider}: processed=${result.processedCount}, changed=${result.changedCount}, rejected=${result.rejectedCount}`,
        '#bef264',
      );
    } catch (error) {
      setWorkflowStatus(
        `Metadata failed: ${error instanceof Error ? error.message : String(error)}`,
        '#fca5a5',
      );
    } finally {
      setButtonBusy(metadataBtn, false, '4) Generate metadata', 'Generating metadata...');
    }
  });

  planSelect.addEventListener('change', renderActivePlan);
  statusFilter.addEventListener('change', renderActivePlan);
  searchInput.addEventListener('input', renderActivePlan);
  refreshBtn.addEventListener('click', () => {
    void recompute();
  });

  renderPostprocessDebugger();
  void refreshDebuggerRuns();
  void checkWorkflowHealth();
  void recompute();
}

render();
