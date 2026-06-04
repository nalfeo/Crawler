import { registerLab } from '../registry.js';
import { SHEETS, SPRITES, getSheet } from '../../engine/sprites/index.js';

interface SheetCacheEntry {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
}

function loadSheet(path: string): SheetCacheEntry {
  const entry: SheetCacheEntry = {
    image: new Image(),
    loaded: false,
    error: false,
  };
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
    'Every sprite registered in src/engine/sprites/registry.ts, rendered at 4x for inspection.';
  subtitle.style.color = '#c9d4ff';
  subtitle.style.lineHeight = '1.6';
  subtitle.style.marginBottom = '24px';

  root.append(heading, subtitle);

  const sheetEntries = new Map<string, SheetCacheEntry>();
  for (const sheet of SHEETS) {
    sheetEntries.set(sheet.key, loadSheet(sheet.path));
  }

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(160px, 1fr))';
  grid.style.gap = '16px';

  const PREVIEW_SCALE = 4;

  const tiles: Array<{ canvas: HTMLCanvasElement; spriteId: string }> = [];

  for (const sprite of SPRITES) {
    const sheet = getSheet(sprite.sheetKey);
    if (!sheet) continue;

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
    canvas.width = sheet.frameWidth * PREVIEW_SCALE;
    canvas.height = sheet.frameHeight * PREVIEW_SCALE;
    canvas.style.imageRendering = 'pixelated';
    canvas.style.background =
      'repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 50% / 16px 16px';

    const idLabel = document.createElement('code');
    idLabel.textContent = sprite.id;
    idLabel.style.color = '#7ee0ff';
    idLabel.style.fontSize = '13px';

    const frameLabel = document.createElement('span');
    frameLabel.textContent = `frame ${sprite.frame} (${sprite.frame % sheet.cols}, ${Math.floor(
      sprite.frame / sheet.cols,
    )})`;
    frameLabel.style.fontSize = '11px';
    frameLabel.style.color = '#94a3b8';

    tile.append(canvas, idLabel, frameLabel);
    if (sprite.note) {
      const note = document.createElement('span');
      note.textContent = sprite.note;
      note.style.fontSize = '11px';
      note.style.color = '#cbd5f5';
      note.style.textAlign = 'center';
      tile.append(note);
    }

    grid.append(tile);
    tiles.push({ canvas, spriteId: sprite.id });
  }

  root.append(grid);
  canvasHost.append(root);

  const note = document.createElement('p');
  note.textContent =
    'Sprites are pulled directly from the asset PNGs served by Vite. If a tile is empty, the sheet is still loading or the file is missing — check public/assets/kenney/.';
  note.style.color = '#c9d4ff';
  note.style.lineHeight = '1.6';
  controls.append(note);

  const sheetList = document.createElement('ul');
  sheetList.style.marginTop = '12px';
  sheetList.style.paddingLeft = '20px';
  sheetList.style.color = '#cbd5f5';
  for (const sheet of SHEETS) {
    const li = document.createElement('li');
    li.style.marginBottom = '4px';
    li.textContent = `${sheet.key} — ${sheet.path}`;
    sheetList.append(li);
  }
  controls.append(sheetList);

  let animationFrame = 0;
  let disposed = false;

  function paint(): void {
    if (disposed) return;
    for (const { canvas, spriteId } of tiles) {
      const sprite = SPRITES.find((s) => s.id === spriteId);
      if (!sprite) continue;
      const sheet = getSheet(sprite.sheetKey);
      const entry = sheetEntries.get(sprite.sheetKey);
      if (!sheet || !entry) continue;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (entry.error) {
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
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
        canvas.width,
        canvas.height,
      );
    }
    animationFrame = window.requestAnimationFrame(paint);
  }

  animationFrame = window.requestAnimationFrame(paint);

  return () => {
    disposed = true;
    window.cancelAnimationFrame(animationFrame);
    note.remove();
    sheetList.remove();
    root.remove();
  };
}

registerLab('sprite-preview', {
  name: 'Sprite Preview',
  description: 'Visual catalog of every sprite registered in the engine sprite registry.',
  create: createSpritePreviewLab,
});
