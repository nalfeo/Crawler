import {
  archiveStorageRuns,
  deleteStorageRunsBatch,
  listStorageRuns,
  type SidecarStorageRunEntry,
} from './devtools/sprite-approval-api.js';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { text?: string; style?: Partial<CSSStyleDeclaration> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.text) node.textContent = options.text;
  if (options.style) Object.assign(node.style, options.style);
  return node;
}

function keyForRun(scope: 'active' | 'archive', run: SidecarStorageRunEntry): string {
  return `${scope === 'archive' ? 'archive/' : ''}${run.briefId}/${run.runId}`;
}

async function render(): Promise<void> {
  const root = document.querySelector('#storage-root');
  if (!(root instanceof HTMLElement)) return;
  const title = el('h1', { text: 'Azure storage lifecycle manager' });
  const status = el('div', { text: 'Loading…', style: { marginBottom: '10px', color: '#93c5fd' } });
  const controls = el('div', {
    style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' },
  });
  const scopeSelect = document.createElement('select');
  scopeSelect.innerHTML =
    '<option value="active">Active runs</option><option value="archive">Archive</option>';
  const searchInput = document.createElement('input');
  searchInput.placeholder = 'Search brief or run id';
  const refreshBtn = el('button', { text: 'Refresh' }) as HTMLButtonElement;
  const archiveBtn = el('button', { text: 'Archive selected' }) as HTMLButtonElement;
  const deleteBtn = el('button', { text: 'Delete selected' }) as HTMLButtonElement;
  controls.append(scopeSelect, searchInput, refreshBtn, archiveBtn, deleteBtn);
  const listHost = el('div');
  root.replaceChildren(title, status, controls, listHost);

  let selected = new Set<string>();
  let currentRuns: SidecarStorageRunEntry[] = [];

  const renderRows = (scope: 'active' | 'archive') => {
    const table = el('table', { style: { width: '100%', borderCollapse: 'collapse' } });
    const head = document.createElement('thead');
    head.innerHTML =
      '<tr><th></th><th>Brief</th><th>Run</th><th>Timestamp</th><th>Summary key</th></tr>';
    table.append(head);
    const body = document.createElement('tbody');
    for (const run of currentRuns) {
      const row = document.createElement('tr');
      const key = keyForRun(scope, run);
      const checked = selected.has(key) ? 'checked' : '';
      row.innerHTML = `<td><input type="checkbox" data-key="${key}" ${checked} /></td><td>${run.briefId}</td><td>${run.runId}</td><td>${run.timestamp ?? '—'}</td><td>${run.summaryKey}</td>`;
      body.append(row);
    }
    table.append(body);
    listHost.replaceChildren(table);
    for (const input of body.querySelectorAll('input[type="checkbox"]')) {
      input.addEventListener('change', () => {
        const key = (input as HTMLInputElement).dataset.key ?? '';
        if ((input as HTMLInputElement).checked) selected.add(key);
        else selected.delete(key);
      });
    }
  };

  const reload = async () => {
    const scope = scopeSelect.value === 'archive' ? 'archive' : 'active';
    status.textContent = 'Loading runs…';
    const payload = await listStorageRuns(scope, searchInput.value);
    currentRuns = payload.runs;
    renderRows(scope);
    status.textContent = `Loaded ${currentRuns.length} ${scope} run(s).`;
  };

  refreshBtn.addEventListener('click', () => void reload());
  scopeSelect.addEventListener('change', () => {
    selected = new Set<string>();
    void reload();
  });
  searchInput.addEventListener('change', () => void reload());

  archiveBtn.addEventListener('click', async () => {
    const keys = [...selected].filter((key) => !key.startsWith('archive/'));
    if (keys.length === 0) {
      status.textContent = 'Select at least one active run to archive.';
      return;
    }
    if (!window.confirm(`Archive ${keys.length} run(s)?`)) return;
    const result = await archiveStorageRuns(keys);
    status.textContent = `Archived ${result.archived.length}; skipped ${result.skipped.length}.`;
    selected = new Set<string>();
    await reload();
  });

  deleteBtn.addEventListener('click', async () => {
    const keys = [...selected];
    if (keys.length === 0) {
      status.textContent = 'Select at least one run to delete.';
      return;
    }
    if (!window.confirm(`Permanently delete ${keys.length} run(s)? This cannot be undone.`)) return;
    const result = await deleteStorageRunsBatch(keys);
    status.textContent = `Deleted ${result.deleted.length} run(s).`;
    selected = new Set<string>();
    await reload();
  });

  await reload();
}

void render();
