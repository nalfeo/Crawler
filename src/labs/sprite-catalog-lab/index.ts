import type GUI from 'lil-gui';
import { DEFAULT_MANIFEST_URL } from '../../engine/generatedAssets/index.js';
import catalogJson from '../../shared/data/sprite-catalog.json';
import {
  ensureSentence,
  parseSpriteCatalog,
  type SpriteCatalogEntry,
  type SpriteCatalogRecord,
  type SpriteSheetCatalogEntry,
} from '../../shared/sprite-catalog.js';
import { getRepoWriteCapability, saveTuning } from '../lab-tuning.js';
import { registerLab } from '../registry.js';
import { deriveGeneratedCatalogRows } from '../../shared/generated-catalog.js';
import type { GeneratedManifest } from '../../shared/generated-assets.js';
import { generatedSpritePreviewUrl, sheetImageUrl } from './asset-urls.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type AiProviderMode = 'auto' | 'heuristic' | 'openai';

const LAB_ID = 'sprite-catalog';
const CATALOG_FILE = 'sprite-catalog.json';
const PREVIEW_SCALE = 6;

interface AiRunResult {
  ok: boolean;
  provider?: string;
  changedCount?: number;
  rejectedCount?: number;
  entry?: unknown;
  error?: string;
}

interface SheetImageCache {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
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

function loadSheetImage(path: string): SheetImageCache {
  const entry: SheetImageCache = { image: new Image(), loaded: false, error: false };
  entry.image.addEventListener('load', () => {
    entry.loaded = true;
  });
  entry.image.addEventListener('error', () => {
    entry.error = true;
  });
  entry.image.src = sheetImageUrl(path);
  return entry;
}

/**
 * Draw a single sprite frame onto a canvas, clipping from the sheet image.
 */
function drawSpriteFrame(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  col: number,
  row: number,
  frameWidth: number,
  frameHeight: number,
  margin: number,
  spacing: number,
  scale: number,
): void {
  canvas.width = frameWidth * scale;
  canvas.height = frameHeight * scale;
  canvas.style.width = `${frameWidth * scale}px`;
  canvas.style.height = `${frameHeight * scale}px`;
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = margin + col * (frameWidth + spacing);
  const sy = margin + row * (frameHeight + spacing);
  ctx.drawImage(image, sx, sy, frameWidth, frameHeight, 0, 0, canvas.width, canvas.height);
}

function createSpriteCatalogLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const entries = parseSpriteCatalog(catalogJson).map((entry) => ({ ...entry }));

  let selectedId = entries[0]?.id;
  let aiProvider: AiProviderMode = 'auto';
  let filterMode: 'all' | 'sheets' | 'sprites' = 'all';

  // Sheet image cache
  const sheetImages = new Map<string, SheetImageCache>();
  function getSheetImage(path: string): SheetImageCache {
    let cached = sheetImages.get(path);
    if (!cached) {
      cached = loadSheetImage(path);
      sheetImages.set(path, cached);
    }
    return cached;
  }

  // Helper to find the sheet entry for a sprite
  function getSheetForSprite(sprite: SpriteCatalogEntry): SpriteSheetCatalogEntry | undefined {
    return entries.find((e) => e.kind === 'sheet' && e.sheetKey === sprite.sheetKey) as
      | SpriteSheetCatalogEntry
      | undefined;
  }

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
  listPanel.style.gridTemplateRows = 'auto auto auto 1fr';

  const listTitle = document.createElement('h2');
  listTitle.textContent = 'Sprite Catalog';
  listTitle.style.padding = '12px 14px';
  listTitle.style.margin = '0';
  listTitle.style.fontSize = '18px';
  listTitle.style.borderBottom = '1px solid rgba(255,255,255,0.08)';

  // Filter toggle buttons
  const filterButtonsContainer = document.createElement('div');
  filterButtonsContainer.style.display = 'flex';
  filterButtonsContainer.style.gap = '6px';
  filterButtonsContainer.style.padding = '12px 14px';
  filterButtonsContainer.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
  filterButtonsContainer.style.flexWrap = 'wrap';

  const filterModes = [
    { mode: 'all', label: 'All' },
    { mode: 'sheets', label: 'Sheets' },
    { mode: 'sprites', label: 'Sprites' },
  ];

  for (const { mode, label } of filterModes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.padding = '6px 12px';
    btn.style.borderRadius = '6px';
    btn.style.fontSize = '12px';
    btn.style.border = '1px solid rgba(255,255,255,0.18)';
    btn.style.cursor = 'pointer';
    btn.style.background =
      filterMode === mode ? 'rgba(126, 224, 255, 0.25)' : 'rgba(15, 23, 42, 0.5)';
    btn.style.color = filterMode === mode ? '#7ee0ff' : '#cbd5e1';
    btn.addEventListener('click', () => {
      filterMode = mode as typeof filterMode;
      // Update all filter buttons
      filterButtonsContainer.querySelectorAll('button').forEach((b, i) => {
        const isActive = i === filterModes.findIndex((fm) => fm.mode === mode);
        b.style.background = isActive ? 'rgba(126, 224, 255, 0.25)' : 'rgba(15, 23, 42, 0.5)';
        b.style.color = isActive ? '#7ee0ff' : '#cbd5e1';
      });
      renderList();
    });
    filterButtonsContainer.append(btn);
  }

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

  listPanel.append(listTitle, filterButtonsContainer, filterInput, listBody);

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
    .add(
      {
        mode: writeCapability.enabled ? 'enabled (local)' : `disabled (${writeCapability.reason})`,
      },
      'mode',
    )
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
    // Preserve scroll position
    const scrollTop = listBody.scrollTop;

    listBody.replaceChildren();
    const filter = filterInput.value.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      // Apply kind filter
      if (filterMode === 'sheets' && entry.kind !== 'sheet') return false;
      if (filterMode === 'sprites' && entry.kind !== 'sprite') return false;

      // For sheets, filter out those with no cataloged sprites
      if (filterMode === 'sheets' && entry.kind === 'sheet') {
        const hasSprites = entries.some(
          (e) => e.kind === 'sprite' && e.sheetKey === entry.sheetKey,
        );
        if (!hasSprites) return false;
      }

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

    // Restore scroll position
    listBody.scrollTop = scrollTop;
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

  /**
   * Create a sprite preview for generated (individual PNG) sprites.
   */
  function createGeneratedSpritePreview(
    sprite: SpriteCatalogEntry & { assetPath?: string },
  ): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '16px';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'flex-start';
    wrap.style.gap = '8px';

    const previewLabel = document.createElement('label');
    previewLabel.textContent = 'Sprite Preview';
    previewLabel.style.fontSize = '12px';
    previewLabel.style.color = '#cbd5f5';
    previewLabel.style.fontWeight = '600';

    const img = document.createElement('img');
    img.style.background = 'repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 50% / 16px 16px';
    img.style.borderRadius = '8px';
    img.style.border = '1px solid rgba(255,255,255,0.15)';
    img.style.imageRendering = 'pixelated';
    img.style.maxWidth = '256px';
    img.style.maxHeight = '256px';
    img.src = generatedSpritePreviewUrl(sprite);
    img.alt = sprite.spriteId;

    wrap.append(previewLabel, img);
    return wrap;
  }

  /**
   * Create a sprite preview canvas for the detail panel.
   * Shows the actual sprite image from the sheet.
   */
  function createSpritePreview(
    sprite: SpriteCatalogEntry,
    sheet: SpriteSheetCatalogEntry,
  ): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '16px';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'flex-start';
    wrap.style.gap = '8px';

    const previewLabel = document.createElement('label');
    previewLabel.textContent = 'Sprite Preview';
    previewLabel.style.fontSize = '12px';
    previewLabel.style.color = '#cbd5f5';
    previewLabel.style.fontWeight = '600';

    const canvas = document.createElement('canvas');
    canvas.style.background =
      'repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 50% / 16px 16px';
    canvas.style.borderRadius = '8px';
    canvas.style.border = '1px solid rgba(255,255,255,0.15)';

    const sheetImg = getSheetImage(sheet.path);

    const drawPreview = (): void => {
      drawSpriteFrame(
        canvas,
        sheetImg.image,
        sprite.col,
        sprite.row,
        sheet.frameWidth,
        sheet.frameHeight,
        sheet.margin,
        sheet.spacing,
        PREVIEW_SCALE,
      );
    };

    if (sheetImg.loaded) {
      drawPreview();
    } else if (!sheetImg.error) {
      sheetImg.image.addEventListener('load', drawPreview, { once: true });
    }

    wrap.append(previewLabel, canvas);
    return wrap;
  }

  /**
   * Create a sheet overview preview — renders a small version of the full sheet.
   */
  function createSheetOverview(sheet: SpriteSheetCatalogEntry): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '16px';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'flex-start';
    wrap.style.gap = '8px';

    const previewLabel = document.createElement('label');
    previewLabel.textContent = 'Sheet Preview';
    previewLabel.style.fontSize = '12px';
    previewLabel.style.color = '#cbd5f5';
    previewLabel.style.fontWeight = '600';

    const img = document.createElement('img');
    img.src = sheetImageUrl(sheet.path);
    img.style.maxWidth = '100%';
    img.style.maxHeight = '200px';
    img.style.imageRendering = 'pixelated';
    img.style.borderRadius = '8px';
    img.style.border = '1px solid rgba(255,255,255,0.15)';
    img.style.background = 'repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 50% / 16px 16px';

    wrap.append(previewLabel, img);
    return wrap;
  }

  /**
   * Create the sheet parser grid — shows all frames and lets users select and
   * add them to the catalog.
   */
  function createSheetParser(sheet: SpriteSheetCatalogEntry): HTMLDivElement {
    const container = document.createElement('div');
    container.style.marginTop = '16px';
    container.style.borderTop = '1px solid rgba(255,255,255,0.1)';
    container.style.paddingTop = '16px';

    const heading = document.createElement('h3');
    heading.textContent = 'Parse Sheet → Catalog';
    heading.style.margin = '0 0 8px 0';
    heading.style.fontSize = '15px';

    const desc = document.createElement('p');
    desc.textContent =
      'Click frames to select them, then add to catalog. Already-cataloged frames are highlighted.';
    desc.style.fontSize = '12px';
    desc.style.color = '#94a3b8';
    desc.style.marginBottom = '12px';

    const parserStatus = document.createElement('p');
    parserStatus.style.fontSize = '12px';
    parserStatus.style.color = '#7ee0ff';
    parserStatus.style.minHeight = '18px';

    const selectedFrames = new Set<number>();

    // Find which frames are already in the catalog for this sheet
    const catalogedFrames = new Set(
      entries
        .filter((e) => e.kind === 'sprite' && e.sheetKey === sheet.sheetKey)
        .map((e) => (e as SpriteCatalogEntry).frame),
    );

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gap = '4px';
    grid.style.maxHeight = '400px';
    grid.style.overflow = 'auto';
    grid.style.padding = '8px';
    grid.style.borderRadius = '8px';
    grid.style.background = 'rgba(15, 23, 42, 0.6)';
    grid.style.border = '1px solid rgba(255,255,255,0.08)';

    const sheetImg = getSheetImage(sheet.path);

    const cellSize = 3;
    const cellPx = sheet.frameWidth * cellSize;
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${cellPx + 8}px, max-content))`;

    const buildGrid = (): void => {
      const totalRows = Math.floor(
        (sheetImg.image.naturalHeight - sheet.margin * 2 + sheet.spacing) /
          (sheet.frameHeight + sheet.spacing),
      );
      const totalFrames = sheet.cols * totalRows;

      for (let frame = 0; frame < totalFrames; frame++) {
        const col = frame % sheet.cols;
        const row = Math.floor(frame / sheet.cols);
        const isCataloged = catalogedFrames.has(frame);

        const cell = document.createElement('div');
        cell.style.display = 'flex';
        cell.style.flexDirection = 'column';
        cell.style.alignItems = 'center';
        cell.style.gap = '2px';
        cell.style.cursor = 'pointer';
        cell.style.padding = '3px';
        cell.style.borderRadius = '4px';
        cell.style.border = isCataloged
          ? '2px solid rgba(52, 211, 153, 0.6)'
          : '1px solid rgba(255,255,255,0.08)';
        cell.title = isCataloged
          ? `Frame ${frame} (already in catalog)`
          : `Frame ${frame} (col ${col}, row ${row}) — click to select`;

        const canvas = document.createElement('canvas');
        drawSpriteFrame(
          canvas,
          sheetImg.image,
          col,
          row,
          sheet.frameWidth,
          sheet.frameHeight,
          sheet.margin,
          sheet.spacing,
          cellSize,
        );

        const label = document.createElement('span');
        label.textContent = String(frame);
        label.style.fontSize = '9px';
        label.style.color = isCataloged ? '#34d399' : '#64748b';

        cell.append(canvas, label);

        cell.addEventListener('click', () => {
          if (isCataloged) return;
          if (selectedFrames.has(frame)) {
            selectedFrames.delete(frame);
            cell.style.background = '';
            cell.style.border = '1px solid rgba(255,255,255,0.08)';
          } else {
            selectedFrames.add(frame);
            cell.style.background = 'rgba(126, 224, 255, 0.2)';
            cell.style.border = '2px solid rgba(126, 224, 255, 0.6)';
          }
          parserStatus.textContent = `${selectedFrames.size} frame${selectedFrames.size === 1 ? '' : 's'} selected.`;
        });

        grid.append(cell);
      }
    };

    if (sheetImg.loaded) {
      buildGrid();
    } else if (!sheetImg.error) {
      sheetImg.image.addEventListener('load', buildGrid, { once: true });
    }

    // Add to catalog button
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = writeCapability.enabled
      ? 'Add selected to catalog'
      : `Read-only (${writeCapability.reason})`;
    addButton.disabled = !writeCapability.enabled;
    addButton.style.marginTop = '12px';
    addButton.style.padding = '10px 16px';
    addButton.style.borderRadius = '8px';
    addButton.style.border = '1px solid rgba(126,224,255,0.45)';
    addButton.style.background = writeCapability.enabled
      ? 'rgba(126, 224, 255, 0.2)'
      : 'rgba(148,163,184,0.18)';
    addButton.style.color = '#e2e8f0';
    addButton.style.cursor = writeCapability.enabled ? 'pointer' : 'not-allowed';

    addButton.addEventListener('click', async () => {
      if (!writeCapability.enabled || selectedFrames.size === 0) {
        parserStatus.textContent = 'No frames selected.';
        return;
      }

      const newEntries: SpriteCatalogEntry[] = [];
      for (const frame of selectedFrames) {
        const col = frame % sheet.cols;
        const row = Math.floor(frame / sheet.cols);
        const spriteId = `${sheet.sheetKey}.frame.${frame}`;
        newEntries.push({
          id: `sprite:${spriteId}`,
          kind: 'sprite',
          label: spriteId,
          description: ensureSentence(
            `Sprite from ${sheet.sheetKey} at frame ${frame} (col ${col}, row ${row})`,
          ),
          tags: ['generated', sheet.sheetKey],
          spriteId,
          sheetKey: sheet.sheetKey,
          frame,
          col,
          row,
        });
      }

      parserStatus.textContent = `Adding ${newEntries.length} sprites to catalog...`;
      try {
        const response = await fetch('/__sprite-catalog-add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries: newEntries }),
        });
        const result = (await response.json()) as {
          ok?: boolean;
          added?: number;
          skipped?: number;
          addedIds?: string[];
          error?: string;
        };
        if (!response.ok || !result.ok) {
          parserStatus.textContent = `Failed: ${result.error ?? `HTTP ${response.status}`}`;
          return;
        }
        parserStatus.textContent = `Added ${result.added} sprite${result.added === 1 ? '' : 's'}, skipped ${result.skipped}.`;

        // Only update local state with entries the server actually persisted
        const addedSet = new Set(result.addedIds ?? []);
        for (const entry of newEntries) {
          if (addedSet.has(entry.id) && !entries.find((e) => e.id === entry.id)) {
            entries.push(entry);
          }
        }
        entries.sort((a, b) => {
          const kindCmp = (a.kind === 'sheet' ? 0 : 1) - (b.kind === 'sheet' ? 0 : 1);
          if (kindCmp !== 0) return kindCmp;
          return a.id.localeCompare(b.id);
        });
        renderList();
      } catch (err) {
        parserStatus.textContent = `Error: ${err instanceof Error ? err.message : 'unknown'}`;
      }
    });

    container.append(heading, desc, parserStatus, grid, addButton);
    return container;
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
    const saveDescription = await saveTuning(
      CATALOG_FILE,
      'description',
      description.trim(),
      entry.id,
    );
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

    // Sprite preview image
    if (selected.kind === 'sprite') {
      if (selected.tags?.includes('pipeline-approved')) {
        detailPanel.append(createGeneratedSpritePreview(selected));
      } else {
        const sheet = getSheetForSprite(selected);
        if (sheet) {
          detailPanel.append(createSpritePreview(selected, sheet));
        }
      }
    } else {
      detailPanel.append(createSheetOverview(selected));
    }

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
        await saveEntry(
          selected,
          descriptionInput.value,
          tagsInput.value,
          connectsInput.value,
          clips.value,
        );
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

    // Sheet entry
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
      await saveEntry(
        selected,
        descriptionInput.value,
        tagsInput.value,
        connectsToInput,
        clipsInput,
      );
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

    // Sheet parser section
    detailPanel.append(createSheetParser(selected));
  }

  filterInput.addEventListener('input', () => {
    renderList();
  });

  renderList();
  renderDetails();

  // Fetch and merge approved generated sprites from the manifest (async, fire and forget).
  // Derivation goes through the SINGLE shared composer (src/shared/generated-catalog.ts)
  // so the lab, the engine, the Vite plugin, and CI all produce byte-identical
  // generated rows — correct tag order (semantic type first), override support,
  // and placeholder exclusion. Never re-derive rows inline here.
  fetch(DEFAULT_MANIFEST_URL)
    .then((res) => res.json())
    .then((manifest: GeneratedManifest) => {
      if (manifest?.entries) {
        for (const row of deriveGeneratedCatalogRows(manifest)) {
          entries.push(row as unknown as SpriteCatalogEntry);
        }
        // Trigger UI refresh if we've loaded generated sprites
        renderList();
      }
    })
    .catch(() => {
      // Silently ignore manifest load errors
    });

  return () => {
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta',
  name: 'Sprite Catalog',
  description:
    'Browse sprites with live image preview, parse sheets into individual catalog entries, and edit metadata with local write-back.',
  create: createSpriteCatalogLab,
});
