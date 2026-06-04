import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { SHEETS } from '../../engine/sprites/index.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface SheetCacheEntry {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
}

interface Settings {
  sheet: string;
  scale: number;
  background: 'checker' | 'dark' | 'magenta';
  showFrameNumbers: boolean;
  showGrid: boolean;
  filter: string;
}

const LAB_ID = 'tile-explorer';

const BACKGROUNDS: Record<Settings['background'], string> = {
  checker: 'repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 50% / 16px 16px',
  dark: '#0f172a',
  magenta: '#ff00ff',
};

function loadSheet(path: string): SheetCacheEntry {
  const entry: SheetCacheEntry = { image: new Image(), loaded: false, error: false };
  entry.image.addEventListener('load', () => {
    entry.loaded = true;
  });
  entry.image.addEventListener('error', () => {
    entry.error = true;
  });
  entry.image.src = path;
  return entry;
}

interface TileEntry {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  frameLabel: HTMLSpanElement;
  frame: number;
  col: number;
  row: number;
}

function createTileExplorerLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const defaultSheet = SHEETS[0]?.key ?? '';
  const settings: Settings = {
    sheet: defaultSheet,
    scale: 4,
    background: 'checker',
    showFrameNumbers: true,
    showGrid: false,
    filter: '',
    ...(loadLabState<Partial<Settings>>(LAB_ID) ?? {}),
  };

  if (!SHEETS.find((s) => s.key === settings.sheet)) {
    settings.sheet = defaultSheet;
  }

  const root = document.createElement('div');
  root.style.padding = '24px';
  root.style.overflowY = 'auto';
  root.style.overflowX = 'hidden';
  root.style.height = '100%';
  root.style.width = '100%';
  root.style.boxSizing = 'border-box';
  root.style.background = 'radial-gradient(circle at top, #1e293b 0%, #0f172a 60%, #020617 100%)';
  root.style.color = '#f8fafc';
  root.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

  const heading = document.createElement('h1');
  heading.textContent = 'Tile Explorer';
  heading.style.fontSize = '28px';
  heading.style.marginBottom = '8px';

  const subtitle = document.createElement('p');
  subtitle.innerHTML =
    'Browse <strong>every tile</strong> in a registered spritesheet. Click a tile to copy its frame index to the clipboard. ' +
    'Use this to identify which frames to map to weapons, projectiles, and effects in <code>src/engine/sprites/registry.ts</code>.';
  subtitle.style.color = '#cbd5f5';
  subtitle.style.lineHeight = '1.6';
  subtitle.style.marginBottom = '16px';
  subtitle.style.maxWidth = '720px';

  const sheetMeta = document.createElement('p');
  sheetMeta.style.color = '#94a3b8';
  sheetMeta.style.fontSize = '13px';
  sheetMeta.style.marginBottom = '16px';

  const status = document.createElement('p');
  status.style.color = '#7ee0ff';
  status.style.fontSize = '13px';
  status.style.marginBottom = '16px';
  status.style.minHeight = '18px';

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gap = '6px';

  root.append(heading, subtitle, sheetMeta, status, grid);
  canvasHost.append(root);

  const sheetEntries = new Map<string, SheetCacheEntry>();
  for (const sheet of SHEETS) {
    sheetEntries.set(sheet.key, loadSheet(sheet.path));
  }

  let tiles: TileEntry[] = [];

  function rebuildTiles(): void {
    grid.innerHTML = '';
    tiles = [];
    const sheet = SHEETS.find((s) => s.key === settings.sheet);
    if (!sheet) return;

    // Wrap based on container width so the lab scrolls vertically,
    // not horizontally. Cell min-width adapts to current scale.
    const cellWidth = sheet.frameWidth * settings.scale + 8;
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${cellWidth}px, max-content))`;

    const entry = sheetEntries.get(sheet.key);
    if (!entry) return;

    const buildAll = (): void => {
      const img = entry.image;
      const totalCols = sheet.cols;
      const totalRows = Math.floor(
        (img.naturalHeight + sheet.spacing) / (sheet.frameHeight + sheet.spacing),
      );
      const totalFrames = totalCols * totalRows;

      for (let frame = 0; frame < totalFrames; frame += 1) {
        const col = frame % totalCols;
        const row = Math.floor(frame / totalCols);

        const tile = document.createElement('div');
        tile.style.display = 'flex';
        tile.style.flexDirection = 'column';
        tile.style.alignItems = 'center';
        tile.style.gap = '2px';
        tile.style.cursor = 'pointer';
        tile.style.padding = '2px';
        tile.style.borderRadius = '4px';
        tile.title = `Frame ${frame}  (col ${col}, row ${row}) — click to copy`;

        const canvas = document.createElement('canvas');
        canvas.style.imageRendering = 'pixelated';
        canvas.style.display = 'block';

        const frameLabel = document.createElement('span');
        frameLabel.textContent = String(frame);
        frameLabel.style.fontSize = '10px';
        frameLabel.style.fontFamily = 'ui-monospace, "SF Mono", Consolas, monospace';
        frameLabel.style.color = '#64748b';

        tile.append(canvas, frameLabel);

        tile.addEventListener('click', () => {
          const text = String(frame);
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(text);
          }
          status.textContent = `Copied frame ${frame} (col ${col}, row ${row}) to clipboard.`;
          tile.style.background = 'rgba(126, 224, 255, 0.25)';
          setTimeout(() => {
            tile.style.background = '';
          }, 400);
        });

        tile.addEventListener('mouseenter', () => {
          tile.style.outline = '1px solid #7ee0ff';
        });
        tile.addEventListener('mouseleave', () => {
          tile.style.outline = '';
        });

        tiles.push({ el: tile, canvas, frameLabel, frame, col, row });
        grid.append(tile);
      }
      applySettings();
    };

    if (entry.loaded) {
      buildAll();
    } else {
      entry.image.addEventListener('load', buildAll, { once: true });
    }
  }

  function applySettings(): void {
    saveLabState(LAB_ID, settings);
    const sheet = SHEETS.find((s) => s.key === settings.sheet);
    if (!sheet) return;
    sheetMeta.textContent = `${sheet.key} — ${sheet.description}`;

    // Re-flow on every settings change (scale affects cell size).
    const cellWidth = sheet.frameWidth * settings.scale + 8;
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${cellWidth}px, max-content))`;

    const filter = settings.filter.trim();
    const filterFrame =
      filter !== '' && /^\d+$/u.test(filter) ? Number.parseInt(filter, 10) : null;

    let visible = 0;
    for (const tile of tiles) {
      const matches =
        filter === '' ||
        (filterFrame !== null && tile.frame === filterFrame) ||
        String(tile.frame).startsWith(filter) ||
        `${tile.col},${tile.row}` === filter;

      tile.el.style.display = matches ? 'flex' : 'none';
      if (matches) visible += 1;

      tile.canvas.width = sheet.frameWidth * settings.scale;
      tile.canvas.height = sheet.frameHeight * settings.scale;
      tile.canvas.style.background = BACKGROUNDS[settings.background];
      tile.canvas.style.outline = settings.showGrid ? '1px solid rgba(126,224,255,0.25)' : '';

      tile.frameLabel.style.display = settings.showFrameNumbers ? '' : 'none';
    }
    if (filter === '') {
      status.textContent = `${tiles.length} tile${tiles.length === 1 ? '' : 's'}. Click any tile to copy its frame index.`;
    } else {
      status.textContent = `Filter "${filter}": ${visible} / ${tiles.length} tile${tiles.length === 1 ? '' : 's'}.`;
    }
  }

  const sheetFolder = gui.addFolder('Sheet');
  const sheetChoices: Record<string, string> = {};
  for (const sheet of SHEETS) {
    sheetChoices[sheet.key] = sheet.key;
  }
  sheetFolder
    .add(settings, 'sheet', sheetChoices)
    .name('Sheet')
    .onChange(() => {
      rebuildTiles();
    });

  const previewFolder = gui.addFolder('Preview');
  previewFolder
    .add(settings, 'scale', { '1x': 1, '2x': 2, '4x': 4, '8x': 8, '16x': 16 })
    .name('Scale');
  previewFolder
    .add(settings, 'background', {
      Checkerboard: 'checker',
      Dark: 'dark',
      'Magenta (debug)': 'magenta',
    })
    .name('Background');
  previewFolder.add(settings, 'showFrameNumbers').name('Show frame numbers');
  previewFolder.add(settings, 'showGrid').name('Show tile borders');
  previewFolder.add(settings, 'filter').name('Filter (frame # or col,row)');

  gui.onChange(() => {
    applySettings();
  });

  rebuildTiles();
  applySettings();

  let animationFrame = 0;
  let disposed = false;

  function paint(): void {
    if (disposed) return;
    const sheet = SHEETS.find((s) => s.key === settings.sheet);
    if (sheet) {
      const entry = sheetEntries.get(sheet.key);
      if (entry && entry.loaded && !entry.error) {
        for (const tile of tiles) {
          if (tile.el.style.display === 'none') continue;
          const ctx = tile.canvas.getContext('2d');
          if (!ctx) continue;
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height);
          const sx = sheet.margin + tile.col * (sheet.frameWidth + sheet.spacing);
          const sy = sheet.margin + tile.row * (sheet.frameHeight + sheet.spacing);
          ctx.drawImage(
            entry.image,
            sx,
            sy,
            sheet.frameWidth,
            sheet.frameHeight,
            0,
            0,
            tile.canvas.width,
            tile.canvas.height,
          );
        }
      }
    }
    animationFrame = window.requestAnimationFrame(paint);
  }

  animationFrame = window.requestAnimationFrame(paint);

  return () => {
    disposed = true;
    window.cancelAnimationFrame(animationFrame);
    root.remove();
  };
}

registerLab(LAB_ID, {
  name: 'Tile Explorer',
  description:
    'Browse every tile of any registered spritesheet. Click a tile to copy its frame index — use this to pick weapon/projectile/effect frames.',
  create: createTileExplorerLab,
});
