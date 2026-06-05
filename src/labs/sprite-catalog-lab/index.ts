import type GUI from 'lil-gui';
import catalogJson from '../../shared/data/sprite-catalog.json';
import { parseSpriteCatalog, type SpriteCatalogRecord } from '../../shared/sprite-catalog.js';
import { getRepoWriteCapability, saveTuning } from '../lab-tuning.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type AiProviderMode = 'auto' | 'heuristic' | 'openai';

const LAB_ID = 'sprite-catalog';
const CATALOG_FILE = 'sprite-catalog.json';

interface AiRunResult {
  ok: boolean;
  provider?: string;
  changedCount?: number;
  rejectedCount?: number;
  entry?: unknown;
  error?: string;
}

function createBadge(text: string): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.textContent = text;
  badge.style.padding = '2px 8px';
  badge.style.borderRadius = '999px';
  badge.style.fontSize = '11px';
  badge.style.background = 'rgba(126, 224, 255, 0.15)';
  badge.style.color = '#7ee0ff';
  badge.style.border = '1px solid rgba(126, 224, 255, 0.25)';
  return badge;
}

function splitCommaValue(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function createSpriteCatalogLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const entries = parseSpriteCatalog(catalogJson).map((entry) => ({ ...entry }));
  let selectedId = entries[0]?.id;
  let aiProvider: AiProviderMode = 'auto';

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.gridTemplateColumns = '360px 1fr';
  root.style.gap = '16px';
  root.style.height = '100%';
  root.style.padding = '16px';
  root.style.boxSizing = 'border-box';
  root.style.background = 'radial-gradient(circle at top, #243b55 0%, #141e30 60%, #0f172a 100%)';
  root.style.color = '#f8fafc';

  const listPanel = document.createElement('section');
  listPanel.style.border = '1px solid rgba(255,255,255,0.12)';
  listPanel.style.borderRadius = '12px';
  listPanel.style.background = 'rgba(8, 12, 24, 0.6)';
  listPanel.style.overflow = 'hidden';
  listPanel.style.display = 'grid';
  listPanel.style.gridTemplateRows = 'auto auto 1fr';

  const listTitle = document.createElement('h2');
  listTitle.textContent = 'Sprite Catalog';
  listTitle.style.padding = '12px 14px';
  listTitle.style.margin = '0';
  listTitle.style.fontSize = '18px';
  listTitle.style.borderBottom = '1px solid rgba(255,255,255,0.08)';

  const filterInput = document.createElement('input');
  filterInput.placeholder = 'Filter by id, sheet, or tag';
  filterInput.style.margin = '12px 14px';
  filterInput.style.padding = '10px';
  filterInput.style.borderRadius = '8px';
  filterInput.style.border = '1px solid rgba(255,255,255,0.18)';
  filterInput.style.background = 'rgba(15, 23, 42, 0.9)';
  filterInput.style.color = '#e2e8f0';

  const listBody = document.createElement('div');
  listBody.style.overflow = 'auto';
  listBody.style.padding = '0 8px 8px';

  listPanel.append(listTitle, filterInput, listBody);

  const detailPanel = document.createElement('section');
  detailPanel.style.border = '1px solid rgba(255,255,255,0.12)';
  detailPanel.style.borderRadius = '12px';
  detailPanel.style.background = 'rgba(8, 12, 24, 0.6)';
  detailPanel.style.padding = '16px';
  detailPanel.style.overflow = 'auto';

  const status = document.createElement('p');
  status.style.minHeight = '20px';
  status.style.fontSize = '13px';
  status.style.color = '#7ee0ff';

  detailPanel.append(status);

  root.append(listPanel, detailPanel);
  canvasHost.append(root);

  const writeCapability = getRepoWriteCapability();
  const writeFolder = gui.addFolder('Write Back');
  writeFolder
    .add({ mode: writeCapability.enabled ? 'enabled (local)' : `disabled (${writeCapability.reason})` }, 'mode')
    .name('Repo writes')
    .disable();
  writeFolder
    .add({ provider: aiProvider }, 'provider', {
      Auto: 'auto',
      Heuristic: 'heuristic',
      OpenAI: 'openai',
    })
    .name('AI provider')
    .onChange((value: AiProviderMode) => {
      aiProvider = value;
      renderDetails();
    });

  function getSelected(): SpriteCatalogRecord | undefined {
    return entries.find((entry) => entry.id === selectedId);
  }

  function renderList(): void {
    listBody.replaceChildren();
    const filter = filterInput.value.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (filter === '') return true;
      const tagMatch = entry.tags.some((tag) => tag.toLowerCase().includes(filter));
      const fieldMatch =
        entry.id.toLowerCase().includes(filter) ||
        entry.label.toLowerCase().includes(filter) ||
        entry.description.toLowerCase().includes(filter);
      const sheetMatch = entry.sheetKey.toLowerCase().includes(filter);
      return tagMatch || fieldMatch || sheetMatch;
    });

    for (const entry of filtered) {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.width = '100%';
      button.style.textAlign = 'left';
      button.style.padding = '10px';
      button.style.margin = '4px 0';
      button.style.borderRadius = '8px';
      button.style.border = '1px solid rgba(255,255,255,0.12)';
      button.style.background =
        entry.id === selectedId ? 'rgba(126, 224, 255, 0.2)' : 'rgba(15, 23, 42, 0.7)';
      button.style.color = '#e2e8f0';
      button.style.cursor = 'pointer';

      const top = document.createElement('div');
      top.style.display = 'flex';
      top.style.alignItems = 'center';
      top.style.gap = '8px';
      top.style.marginBottom = '4px';

      const id = document.createElement('code');
      id.textContent = entry.id;
      id.style.fontSize = '12px';
      id.style.color = '#7ee0ff';

      top.append(id, createBadge(entry.kind));

      const subtitle = document.createElement('div');
      subtitle.textContent = entry.description;
      subtitle.style.fontSize = '12px';
      subtitle.style.color = '#cbd5e1';
      subtitle.style.lineHeight = '1.4';

      button.append(top, subtitle);
      button.addEventListener('click', () => {
        selectedId = entry.id;
        renderList();
        renderDetails();
      });
      listBody.append(button);
    }
  }

  function labeledInput(labelText: string, input: HTMLElement): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '6px';
    wrap.style.marginBottom = '12px';

    const label = document.createElement('label');
    label.textContent = labelText;
    label.style.fontSize = '12px';
    label.style.color = '#cbd5f5';
    label.style.fontWeight = '600';

    wrap.append(label, input);
    return wrap;
  }

  function readOnlyField(label: string, value: string): HTMLDivElement {
    const pre = document.createElement('code');
    pre.textContent = value;
    pre.style.display = 'block';
    pre.style.padding = '10px';
    pre.style.borderRadius = '8px';
    pre.style.background = 'rgba(15, 23, 42, 0.8)';
    pre.style.border = '1px solid rgba(255,255,255,0.1)';
    pre.style.fontSize = '12px';
    pre.style.wordBreak = 'break-all';
    return labeledInput(label, pre);
  }

  async function saveEntry(
    entry: SpriteCatalogRecord,
    description: string,
    tagsInput: string,
    connectsToInput: string,
    clipsInput: string,
  ): Promise<void> {
    status.textContent = '';
    if (!writeCapability.enabled) {
      status.textContent = `Read-only: ${writeCapability.reason}`;
      return;
    }

    const tags = splitCommaValue(tagsInput);
    const saveDescription = await saveTuning(CATALOG_FILE, 'description', description.trim(), entry.id);
    if (!saveDescription.ok) {
      status.textContent = `Save failed: ${saveDescription.error ?? 'unknown error'}`;
      return;
    }

    const saveTags = await saveTuning(CATALOG_FILE, 'tags', tags, entry.id);
    if (!saveTags.ok) {
      status.textContent = `Save failed: ${saveTags.error ?? 'unknown error'}`;
      return;
    }

    if (entry.kind === 'sprite') {
      const connectsTo = splitCommaValue(connectsToInput);
      const clips = splitCommaValue(clipsInput);

      const saveTile = await saveTuning(CATALOG_FILE, 'tile.connectsTo', connectsTo, entry.id);
      if (!saveTile.ok) {
        status.textContent = `Save failed: ${saveTile.error ?? 'unknown error'}`;
        return;
      }

      const saveClips = await saveTuning(CATALOG_FILE, 'animation.clips', clips, entry.id);
      if (!saveClips.ok) {
        status.textContent = `Save failed: ${saveClips.error ?? 'unknown error'}`;
        return;
      }
    }

    entry.description = description.trim();
    entry.tags = tags;
    if (entry.kind === 'sprite') {
      entry.tile = { connectsTo: splitCommaValue(connectsToInput) };
      entry.animation = { clips: splitCommaValue(clipsInput) };
    }
    status.textContent = `Saved ${entry.id} to ${CATALOG_FILE}.`;
    renderList();
  }

  async function runAiForEntry(entry: SpriteCatalogRecord): Promise<void> {
    if (!writeCapability.enabled) {
      status.textContent = `Read-only: ${writeCapability.reason}`;
      return;
    }

    status.textContent = `Running AI metadata pipeline for ${entry.id} (${aiProvider})...`;
    const response = await fetch('/__sprite-metadata-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: entry.id,
        provider: aiProvider,
        force: true,
      }),
    });
    const payload = (await response.json()) as AiRunResult;
    if (!response.ok || !payload.ok) {
      status.textContent = `AI run failed: ${payload.error ?? `HTTP ${response.status}`}`;
      return;
    }

    if (payload.entry) {
      const parsed = parseSpriteCatalog([payload.entry])[0];
      if (parsed) {
        const index = entries.findIndex((candidate) => candidate.id === parsed.id);
        if (index >= 0) {
          entries[index] = parsed;
          selectedId = parsed.id;
        }
      }
    }

    status.textContent = `AI run (${payload.provider ?? aiProvider}) complete: changed ${payload.changedCount ?? 0}, rejected ${payload.rejectedCount ?? 0}.`;
    renderList();
    renderDetails();
  }

  function createActionButton(
    label: string,
    enabled: boolean,
    borderColor: string,
    background: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = enabled ? label : `Read-only (${writeCapability.reason})`;
    button.disabled = !enabled;
    button.style.padding = '10px 14px';
    button.style.borderRadius = '8px';
    button.style.border = `1px solid ${borderColor}`;
    button.style.background = enabled ? background : 'rgba(148,163,184,0.18)';
    button.style.color = '#e2e8f0';
    button.style.cursor = enabled ? 'pointer' : 'not-allowed';
    return button;
  }

  function renderDetails(): void {
    const selected = getSelected();
    detailPanel.replaceChildren(status);
    if (!selected) {
      const empty = document.createElement('p');
      empty.textContent = 'Select a catalog entry to inspect and edit metadata.';
      empty.style.color = '#cbd5f5';
      detailPanel.append(empty);
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = selected.id;
    heading.style.marginTop = '0';
    heading.style.marginBottom = '10px';
    detailPanel.append(heading);

    const kindLine = document.createElement('div');
    kindLine.style.display = 'flex';
    kindLine.style.gap = '8px';
    kindLine.style.marginBottom = '12px';
    kindLine.append(createBadge(selected.kind), createBadge(selected.sheetKey));
    detailPanel.append(kindLine);

    const descriptionInput = document.createElement('input');
    descriptionInput.value = selected.description;
    descriptionInput.style.padding = '10px';
    descriptionInput.style.borderRadius = '8px';
    descriptionInput.style.border = '1px solid rgba(255,255,255,0.18)';
    descriptionInput.style.background = 'rgba(15, 23, 42, 0.9)';
    descriptionInput.style.color = '#e2e8f0';
    detailPanel.append(labeledInput('One sentence description', descriptionInput));

    const tagsInput = document.createElement('input');
    tagsInput.value = selected.tags.join(', ');
    tagsInput.style.padding = '10px';
    tagsInput.style.borderRadius = '8px';
    tagsInput.style.border = '1px solid rgba(255,255,255,0.18)';
    tagsInput.style.background = 'rgba(15, 23, 42, 0.9)';
    tagsInput.style.color = '#e2e8f0';
    detailPanel.append(labeledInput('Tags (comma separated)', tagsInput));

    const aiInfo = document.createElement('p');
    aiInfo.textContent = `On-demand AI provider: ${aiProvider}`;
    aiInfo.style.marginTop = '0';
    aiInfo.style.marginBottom = '12px';
    aiInfo.style.fontSize = '12px';
    aiInfo.style.color = '#86efac';
    detailPanel.append(aiInfo);

    let connectsToInput = '';
    let clipsInput = '';
    if (selected.kind === 'sprite') {
      const connectsInput = document.createElement('input');
      connectsToInput = selected.tile?.connectsTo.join(', ') ?? '';
      connectsInput.value = connectsToInput;
      connectsInput.style.padding = '10px';
      connectsInput.style.borderRadius = '8px';
      connectsInput.style.border = '1px solid rgba(255,255,255,0.18)';
      connectsInput.style.background = 'rgba(15, 23, 42, 0.9)';
      connectsInput.style.color = '#e2e8f0';
      detailPanel.append(labeledInput('Tile connectsTo IDs (comma separated)', connectsInput));

      const clips = document.createElement('input');
      clipsInput = selected.animation?.clips.join(', ') ?? '';
      clips.value = clipsInput;
      clips.style.padding = '10px';
      clips.style.borderRadius = '8px';
      clips.style.border = '1px solid rgba(255,255,255,0.18)';
      clips.style.background = 'rgba(15, 23, 42, 0.9)';
      clips.style.color = '#e2e8f0';
      detailPanel.append(labeledInput('Animation clip refs (comma separated)', clips));

      detailPanel.append(
        readOnlyField(
          'Generated frame data',
          JSON.stringify(
            {
              sheetKey: selected.sheetKey,
              frame: selected.frame,
              col: selected.col,
              row: selected.row,
              note: selected.note ?? null,
            },
            null,
            2,
          ),
        ),
      );

      const saveButton = createActionButton(
        'Save metadata',
        writeCapability.enabled,
        'rgba(126,224,255,0.45)',
        'rgba(126,224,255,0.2)',
      );
      saveButton.addEventListener('click', async () => {
        await saveEntry(selected, descriptionInput.value, tagsInput.value, connectsInput.value, clips.value);
      });
      detailPanel.append(saveButton);

      const aiButton = createActionButton(
        `AI generate + judge (${aiProvider})`,
        writeCapability.enabled,
        'rgba(52,211,153,0.45)',
        'rgba(52,211,153,0.15)',
      );
      aiButton.style.marginTop = '8px';
      aiButton.addEventListener('click', async () => {
        await runAiForEntry(selected);
      });
      detailPanel.append(aiButton);
      return;
    }

    detailPanel.append(
      readOnlyField(
        'Generated sheet data',
        JSON.stringify(
          {
            sheetKey: selected.sheetKey,
            path: selected.path,
            frameWidth: selected.frameWidth,
            frameHeight: selected.frameHeight,
            margin: selected.margin,
            spacing: selected.spacing,
            cols: selected.cols,
          },
          null,
          2,
        ),
      ),
    );

    const saveButton = createActionButton(
      'Save metadata',
      writeCapability.enabled,
      'rgba(126,224,255,0.45)',
      'rgba(126,224,255,0.2)',
    );
    saveButton.addEventListener('click', async () => {
      await saveEntry(selected, descriptionInput.value, tagsInput.value, connectsToInput, clipsInput);
    });
    detailPanel.append(saveButton);

    const aiButton = createActionButton(
      `AI generate + judge (${aiProvider})`,
      writeCapability.enabled,
      'rgba(52,211,153,0.45)',
      'rgba(52,211,153,0.15)',
    );
    aiButton.style.marginTop = '8px';
    aiButton.addEventListener('click', async () => {
      await runAiForEntry(selected);
    });
    detailPanel.append(aiButton);
  }

  filterInput.addEventListener('input', () => {
    renderList();
  });

  renderList();
  renderDetails();

  return () => {
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta',
  name: 'Sprite Catalog',
  description:
    'Edit one-sentence sprite/sheet metadata, tile connectivity, and animation clip references with local-only repo write-back.',
  create: createSpriteCatalogLab,
});
