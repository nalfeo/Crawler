import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { SHEETS, SPRITES, getSheet } from '../../engine/sprites/index.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface SheetCacheEntry {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
}

interface Settings {
  scale: number;
  background: 'checker' | 'dark' | 'magenta';
  showFrameInfo: boolean;
  showNotes: boolean;
  filter: string;
}

const LAB_ID = 'sprite-preview';

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

function createSpritePreviewLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: Settings = {
    scale: 4,
    background: 'checker',
    showFrameInfo: true,
    showNotes: true,
    filter: '',
    ...(loadLabState<Partial<Settings>>(LAB_ID) ?? {}),
  };

  const root = document.createElement('div');
  root.style.padding = '24px';
  root.style.overflow = 'auto';
  root.style.height = '100%';
  root.style.background = 'radial-gradient(circle at top, #243b55 0%, #141e30 60%, #0f172a 100%)';
  root.style.color = '#f8fafc';

  const heading = document.createElement('h1');
  heading.textContent = 'Sprite Preview';
  heading.style.fontSize = '28px';
  heading.style.marginBottom = '8px';

  const subtitle = document.createElement('p');
  subtitle.textContent =
    'Every sprite registered in src/engine/sprites/registry.ts. Use the controls panel to tweak the preview.';
  subtitle.style.color = '#c9d4ff';
  subtitle.style.lineHeight = '1.6';
  subtitle.style.marginBottom = '24px';

  const status = document.createElement('p');
  status.style.color = '#7ee0ff';
  status.style.fontSize = '13px';
  status.style.marginBottom = '16px';

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(200px, 1fr))';
  grid.style.gap = '16px';

  root.append(heading, subtitle, status, grid);
  canvasHost.append(root);

  const sheetEntries = new Map<string, SheetCacheEntry>();
  for (const sheet of SHEETS) {
    sheetEntries.set(sheet.key, loadSheet(sheet.path));
  }

  interface Tile {
    el: HTMLDivElement;
    canvas: HTMLCanvasElement;
    frameLabel: HTMLSpanElement;
    noteLabel: HTMLSpanElement | null;
    spriteId: string;
  }

  const tiles: Tile[] = [];

  function buildTile(spriteId: string): Tile | null {
    const sprite = SPRITES.find((s) => s.id === spriteId);
    if (!sprite) return null;
    const sheet = getSheet(sprite.sheetKey);
    if (!sheet) return null;

    const tile = document.createElement('div');
    tile.style.padding = '12px';
    tile.style.border = '1px solid rgba(255, 255, 255, 0.12)';
    tile.style.borderRadius = '12px';
    tile.style.background = 'rgba(8, 12, 24, 0.6)';
    tile.style.display = 'flex';
    tile.style.flexDirection = 'column';
    tile.style.alignItems = 'center';
    tile.style.gap = '8px';

    const canvas = document.createElement('canvas');
    canvas.style.imageRendering = 'pixelated';

    const idLabel = document.createElement('code');
    idLabel.textContent = sprite.id;
    idLabel.style.color = '#7ee0ff';
    idLabel.style.fontSize = '13px';

    const frameLabel = document.createElement('span');
    frameLabel.style.fontSize = '11px';
    frameLabel.style.color = '#94a3b8';

    tile.append(canvas, idLabel, frameLabel);

    let noteLabel: HTMLSpanElement | null = null;
    if (sprite.note) {
      noteLabel = document.createElement('span');
      noteLabel.textContent = sprite.note;
      noteLabel.style.fontSize = '11px';
      noteLabel.style.color = '#cbd5f5';
      noteLabel.style.textAlign = 'center';
      tile.append(noteLabel);
    }

    return { el: tile, canvas, frameLabel, noteLabel, spriteId };
  }

  for (const sprite of SPRITES) {
    const tile = buildTile(sprite.id);
    if (tile) {
      tiles.push(tile);
      grid.append(tile.el);
    }
  }

  function applySettings(): void {
    saveLabState(LAB_ID, settings);
    let visibleCount = 0;
    const filter = settings.filter.trim().toLowerCase();
    for (const tile of tiles) {
      const sprite = SPRITES.find((s) => s.id === tile.spriteId);
      if (!sprite) continue;
      const sheet = getSheet(sprite.sheetKey);
      if (!sheet) continue;

      const matches = filter === '' || tile.spriteId.toLowerCase().includes(filter);
      tile.el.style.display = matches ? 'flex' : 'none';
      if (matches) visibleCount += 1;

      tile.canvas.width = sheet.frameWidth * settings.scale;
      tile.canvas.height = sheet.frameHeight * settings.scale;
      tile.canvas.style.background = BACKGROUNDS[settings.background];

      tile.frameLabel.style.display = settings.showFrameInfo ? '' : 'none';
      tile.frameLabel.textContent = `frame ${sprite.frame} (${
        sprite.frame % sheet.cols
      }, ${Math.floor(sprite.frame / sheet.cols)})`;

      if (tile.noteLabel) {
        tile.noteLabel.style.display = settings.showNotes ? '' : 'none';
      }
    }
    status.textContent = `Showing ${visibleCount} / ${tiles.length} sprite${
      tiles.length === 1 ? '' : 's'
    } across ${SHEETS.length} sheet${SHEETS.length === 1 ? '' : 's'}.`;
  }

  // Controls
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
  previewFolder.add(settings, 'showFrameInfo').name('Show frame info');
  previewFolder.add(settings, 'showNotes').name('Show notes');
  previewFolder.add(settings, 'filter').name('Filter (id)');

  gui.onChange(() => {
    applySettings();
  });

  const sheetsFolder = gui.addFolder('Sheets');
  for (const sheet of SHEETS) {
    const sheetSettings = {
      reload: () => {
        sheetEntries.set(sheet.key, loadSheet(sheet.path));
      },
    };
    sheetsFolder.add(sheetSettings, 'reload').name(`Reload ${sheet.key}`);
  }
  sheetsFolder.close();

  applySettings();

  let animationFrame = 0;
  let disposed = false;

  function paint(): void {
    if (disposed) return;
    for (const tile of tiles) {
      if (tile.el.style.display === 'none') continue;
      const sprite = SPRITES.find((s) => s.id === tile.spriteId);
      if (!sprite) continue;
      const sheet = getSheet(sprite.sheetKey);
      const entry = sheetEntries.get(sprite.sheetKey);
      if (!sheet || !entry) continue;
      const ctx = tile.canvas.getContext('2d');
      if (!ctx) continue;

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height);

      if (entry.error) {
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(0, 0, tile.canvas.width, tile.canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.fillText('load error', 8, 16);
        continue;
      }

      if (!entry.loaded) continue;

      const col = sprite.frame % sheet.cols;
      const row = Math.floor(sprite.frame / sheet.cols);
      const sx = sheet.margin + col * (sheet.frameWidth + sheet.spacing);
      const sy = sheet.margin + row * (sheet.frameHeight + sheet.spacing);
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
  name: 'Sprite Preview',
  description: 'Visual catalog of every sprite registered in the engine sprite registry.',
  create: createSpritePreviewLab,
});
