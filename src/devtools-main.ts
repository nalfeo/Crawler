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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
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

function render(): void {
  const root = document.getElementById('devtools-root');
  if (!(root instanceof HTMLElement)) {
    throw new Error('Missing #devtools-root host element');
  }
  root.replaceChildren();

  const shell = el('section', { className: 'panel devtools-shell' });
  const title = el('h1', { text: 'Crawler DevTools' });
  const navRow = el('div', {
    style: {
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      marginBottom: '10px',
      flexWrap: 'wrap',
    },
  });
  const labsLink = el('a', {
    text: 'Open Labs',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '6px 10px',
      borderRadius: '999px',
      border: '1px solid rgba(147,197,253,0.5)',
      color: '#93c5fd',
      textDecoration: 'none',
      fontSize: '12px',
      background: '#111827',
    },
  });
  labsLink.setAttribute('href', '/lab.html');
  navRow.append(labsLink);
  const subtitle = el('p', {
    text: LOCAL_HOSTS.has(window.location.hostname)
      ? 'Floor art tracker: visibility over placeholders, briefs, approvals, and integration.'
      : 'DevTools is disabled outside localhost.',
    style: { marginBottom: '16px' },
  });
  shell.append(title, navRow, subtitle);
  root.append(shell);

  if (!LOCAL_HOSTS.has(window.location.hostname)) {
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

  let reports: FloorArtPlanReport[] = [];
  let manifestError: string | null = null;

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
      );
      tbody.append(row);
    }

    emptyState.style.display = filtered.length === 0 ? 'block' : 'none';
  };

  planSelect.addEventListener('change', renderActivePlan);
  statusFilter.addEventListener('change', renderActivePlan);
  searchInput.addEventListener('input', renderActivePlan);
  refreshBtn.addEventListener('click', () => {
    void recompute();
  });

  void recompute();
}

render();
