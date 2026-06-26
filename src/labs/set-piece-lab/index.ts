import type GUI from 'lil-gui';
import catalogJson from '../../shared/data/sprite-catalog.json';
import { parseSpriteCatalog } from '../../shared/sprite-catalog.js';
import {
  SET_PIECE_TILE_SIZE,
  collectCustomArtRequests,
  flattenSetPieceLayers,
  getAllSetPieceDefs,
  getSetPieceDef,
  getSetPieceFootprint,
  isCustomSpriteRef,
  type SetPieceDef,
  type SpriteRef,
} from '../../shared/set-piece-types.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface SheetMeta {
  path: string;
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
}

/** A concrete sheet frame resolved from any sprite reference (or null for a pure placeholder). */
interface ResolvedFrame {
  sheetKey: string;
  col: number;
  row: number;
}

interface SheetImageCache {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
}

const PLACEHOLDER_COLOR = '#ff4fd8';

function buildSheetIndex(): {
  sheets: Map<string, SheetMeta>;
  sprites: Map<string, ResolvedFrame>;
} {
  const sheets = new Map<string, SheetMeta>();
  const sprites = new Map<string, ResolvedFrame>();
  for (const entry of parseSpriteCatalog(catalogJson)) {
    if (entry.kind === 'sheet') {
      sheets.set(entry.sheetKey, {
        path: entry.path,
        frameWidth: entry.frameWidth,
        frameHeight: entry.frameHeight,
        margin: entry.margin,
        spacing: entry.spacing,
      });
    } else {
      sprites.set(entry.id, { sheetKey: entry.sheetKey, col: entry.col, row: entry.row });
    }
  }
  return { sheets, sprites };
}

/** Resolve a sprite reference to a drawable sheet frame, or null when only a placeholder exists. */
function resolveFrame(ref: SpriteRef, sprites: Map<string, ResolvedFrame>): ResolvedFrame | null {
  if (ref.source === 'sheet') {
    return { sheetKey: ref.sheetKey, col: ref.col, row: ref.row };
  }
  if (ref.source === 'catalog') {
    return sprites.get(ref.spriteId) ?? null;
  }
  // custom: fall back to its placeholder, if any.
  if (ref.placeholder) {
    return resolveFrame(ref.placeholder, sprites);
  }
  return null;
}

function createSetPieceLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const { sheets, sprites } = buildSheetIndex();
  const sheetImages = new Map<string, SheetImageCache>();
  const defs = getAllSetPieceDefs();

  const layout = document.createElement('div');
  layout.style.cssText =
    'display:flex;gap:16px;align-items:flex-start;padding:16px;flex-wrap:wrap;background:#0d0d14;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'background:repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 50% / 32px 32px;border:1px solid rgba(255,255,255,0.15);border-radius:8px;image-rendering:pixelated;';

  const panel = document.createElement('div');
  panel.style.cssText =
    'min-width:280px;max-width:360px;color:#e2e8f0;font-family:monospace;font-size:12px;line-height:1.5;';

  layout.append(canvas, panel);
  canvasHost.append(layout);

  const state = {
    setPieceId: defs[0]?.id ?? '',
    zoom: 3,
    showGrid: true,
    showLabels: true,
    highlightCustom: true,
  };

  function getSheetImage(path: string): SheetImageCache {
    let cached = sheetImages.get(path);
    if (!cached) {
      const image = new Image();
      const next: SheetImageCache = { image, loaded: false, error: false };
      image.addEventListener('load', () => {
        next.loaded = true;
        render();
      });
      image.addEventListener('error', () => {
        next.error = true;
      });
      image.src = path;
      sheetImages.set(path, next);
      cached = next;
    }
    return cached;
  }

  function drawPlaceholder(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    w: number,
    h: number,
    label: string,
  ): void {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 79, 216, 0.18)';
    ctx.fillRect(px, py, w, h);
    ctx.strokeStyle = PLACEHOLDER_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
    ctx.fillStyle = PLACEHOLDER_COLOR;
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(label, px + 2, py + 2, w - 4);
    ctx.restore();
  }

  function render(): void {
    const def = getSetPieceDef(state.setPieceId);
    if (!def) return;

    const tile = SET_PIECE_TILE_SIZE * state.zoom;
    const footprint = getSetPieceFootprint(def);
    canvas.width = footprint.width * tile;
    canvas.height = footprint.height * tile;
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const draw of flattenSetPieceLayers(def)) {
      const { prop, layer } = draw;
      const baseX = prop.x * tile + (layer.offsetX ?? 0) * state.zoom;
      const baseY = prop.y * tile + (layer.offsetY ?? 0) * state.zoom;
      const scale = layer.scale ?? 1;
      const frame = resolveFrame(layer.sprite, sprites);
      const isCustom = isCustomSpriteRef(layer.sprite);

      if (frame) {
        const sheet = sheets.get(frame.sheetKey);
        if (sheet) {
          const img = getSheetImage(sheet.path);
          const drawW = sheet.frameWidth * state.zoom * scale;
          const drawH = sheet.frameHeight * state.zoom * scale;
          if (img.loaded) {
            const sx = sheet.margin + frame.col * (sheet.frameWidth + sheet.spacing);
            const sy = sheet.margin + frame.row * (sheet.frameHeight + sheet.spacing);
            ctx.drawImage(
              img.image,
              sx,
              sy,
              sheet.frameWidth,
              sheet.frameHeight,
              baseX,
              baseY,
              drawW,
              drawH,
            );
          }
          if (isCustom && state.highlightCustom) {
            drawPlaceholder(ctx, baseX, baseY, drawW, drawH, '◴');
          }
          continue;
        }
      }

      // No drawable frame — render a labeled placeholder sized to the request.
      const custom = layer.sprite.source === 'custom' ? layer.sprite : undefined;
      const w = (custom?.widthTiles ?? prop.width) * tile * scale;
      const h = (custom?.heightTiles ?? prop.height) * tile * scale;
      drawPlaceholder(ctx, baseX, baseY, w, h, custom?.label ?? prop.id);
    }

    if (state.showGrid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= footprint.width; gx++) {
        ctx.beginPath();
        ctx.moveTo(gx * tile + 0.5, 0);
        ctx.lineTo(gx * tile + 0.5, canvas.height);
        ctx.stroke();
      }
      for (let gy = 0; gy <= footprint.height; gy++) {
        ctx.beginPath();
        ctx.moveTo(0, gy * tile + 0.5);
        ctx.lineTo(canvas.width, gy * tile + 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (state.showLabels) {
      ctx.save();
      ctx.font = '10px monospace';
      ctx.textBaseline = 'top';
      for (const prop of def.props) {
        const lx = prop.x * tile + 2;
        const ly = prop.y * tile + 2;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(lx - 1, ly - 1, ctx.measureText(prop.id).width + 4, 12);
        ctx.fillStyle = '#cbd5f5';
        ctx.fillText(prop.id, lx + 1, ly);
      }
      ctx.restore();
    }

    renderPanel(def);
  }

  function renderPanel(def: SetPieceDef): void {
    const footprint = getSetPieceFootprint(def);
    const requests = collectCustomArtRequests(def);
    const lines: string[] = [];
    lines.push(`<b style="font-size:14px;color:#fff">${def.name}</b>`);
    lines.push(`<span style="color:#7ee0ff">${def.theme} · ${def.sizing}</span>`);
    lines.push('');
    lines.push(def.description);
    lines.push('');
    lines.push(`<b>Footprint:</b> ${footprint.width}×${footprint.height} tiles`);
    if (def.sizing === 'themed') {
      lines.push(
        `<span style="color:#94a3b8">themed kit: ${def.width}×${def.height} → ${footprint.width}×${footprint.height}</span>`,
      );
    }
    lines.push(`<b>Props:</b> ${def.props.length}`);
    lines.push(`<b>Tags:</b> ${def.tags.join(', ') || '—'}`);
    lines.push('');
    lines.push(`<b>Custom art requests (${requests.length}):</b>`);
    if (requests.length === 0) {
      lines.push('<span style="color:#94a3b8">none — all reused/recorded sprites</span>');
    }
    for (const req of requests) {
      const ph = req.placeholder ? ' <span style="color:#22c55e">[placeholder]</span>' : '';
      lines.push(
        `<span style="color:${PLACEHOLDER_COLOR}">◴</span> <b>${req.label}</b> <code>${req.requestId}</code>${ph}`,
      );
    }
    lines.push('');
    lines.push('<span style="color:#64748b">◴ = custom art pending generation</span>');
    panel.innerHTML = lines.join('<br/>');
  }

  const setPieceOptions: Record<string, string> = {};
  for (const def of defs) {
    setPieceOptions[`${def.name} (${def.theme})`] = def.id;
  }

  gui.add(state, 'setPieceId', setPieceOptions).name('Set piece').onChange(render);
  gui.add(state, 'zoom', 1, 6, 1).name('Zoom').onChange(render);
  gui.add(state, 'showGrid').name('Show grid').onChange(render);
  gui.add(state, 'showLabels').name('Prop labels').onChange(render);
  gui.add(state, 'highlightCustom').name('Mark custom art').onChange(render);

  const summary = {
    totalSetPieces: defs.length,
    totalCustomRequests: collectCustomArtRequests(defs).length,
  };
  const meta = gui.addFolder('Pack summary');
  meta.add(summary, 'totalSetPieces').name('Set pieces').disable();
  meta.add(summary, 'totalCustomRequests').name('Custom art requests').disable();

  render();

  return () => {
    layout.remove();
  };
}

registerLab('set-piece-lab', {
  category: 'Meta' as LabCategory,
  name: 'Set Piece Viewer',
  description:
    'Inspect Earth-themed set-piece rooms: layered sprites, reused/recorded art, and pending custom-art placeholders.',
  create: createSetPieceLab,
});
