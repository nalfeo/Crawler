import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';
import { SPRITES, getSheet, type SpriteDef } from '../../engine/sprites/index.js';
import {
  DEFAULT_HANDHELD_SPRITE_ANCHOR,
  isValidAnchor,
  resolveHandheldAnchor,
  type SpriteAnchor,
} from '../../shared/sprite-anchor.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type RotationMode = 'static' | 'spin' | 'swing';

interface AnchorSettings {
  spriteId: string;
  anchorX: number;
  anchorY: number;
  scale: number;
  rotationMode: RotationMode;
  spinSpeedDegPerSec: number;
  swingDegrees: number;
  swingPeriodMs: number;
  staticAngleDeg: number;
  showGrid: boolean;
  showAnchorTrail: boolean;
  showHand: boolean;
}

interface SheetImage {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
}

const SHEET_CACHE = new Map<string, SheetImage>();

function loadSheetImage(path: string): SheetImage {
  const cached = SHEET_CACHE.get(path);
  if (cached) return cached;

  const entry: SheetImage = { image: new Image(), loaded: false, error: false };
  entry.image.addEventListener('load', () => {
    entry.loaded = true;
  });
  entry.image.addEventListener('error', () => {
    entry.error = true;
  });
  entry.image.src = path;
  SHEET_CACHE.set(path, entry);
  return entry;
}

function defaultAnchorFor(sprite: SpriteDef): SpriteAnchor {
  return resolveHandheldAnchor(sprite.anchor);
}

function createAnchorLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  if (SPRITES.length === 0) {
    throw new Error('No sprites registered in src/engine/sprites/registry.ts');
  }

  const firstSprite = SPRITES[0]!;
  const firstAnchor = defaultAnchorFor(firstSprite);

  const settings: AnchorSettings = {
    spriteId: firstSprite.id,
    anchorX: firstAnchor.x,
    anchorY: firstAnchor.y,
    scale: 16,
    rotationMode: 'spin',
    spinSpeedDegPerSec: 90,
    swingDegrees: 60,
    swingPeriodMs: 800,
    staticAngleDeg: 0,
    showGrid: true,
    showAnchorTrail: false,
    showHand: true,
  };

  // ── Layout ─────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.style.cssText =
    'display:grid; grid-template-rows:auto 1fr auto; gap:12px; padding:16px; height:100%; color:#f8fafc; font-family:monospace; box-sizing:border-box;';

  const header = document.createElement('div');
  header.innerHTML =
    '<h2 style="margin:0 0 4px;">🎯 Anchor Lab</h2>' +
    '<p style="margin:0; color:#c9d4ff; font-size:13px; line-height:1.4;">' +
    'Verify a sprite rotates around the correct grip pixel. Click anywhere on the canvas to set the anchor, or use the sliders. ' +
    'Spin / swing modes simulate equip rotation and an attack swing.' +
    '</p>';

  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText =
    'display:flex; align-items:center; justify-content:center; background:repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 50% / 32px 32px; border-radius:12px; overflow:hidden; min-height:0;';

  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 400;
  canvas.style.cssText =
    'cursor:crosshair; image-rendering:pixelated; max-width:100%; max-height:100%;';
  canvasWrap.append(canvas);

  const footer = document.createElement('div');
  footer.style.cssText =
    'display:flex; flex-wrap:wrap; gap:16px; align-items:center; padding:10px 14px; background:rgba(8,12,24,0.6); border-radius:10px; font-size:13px;';

  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'flex:1; min-width:200px;';

  const jsonEl = document.createElement('code');
  jsonEl.style.cssText =
    'background:rgba(0,0,0,0.4); padding:6px 10px; border-radius:6px; color:#7ee0ff; user-select:all;';

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.style.cssText =
    'background:rgba(126,224,255,0.15); border:1px solid rgba(126,224,255,0.4); color:#7ee0ff; padding:6px 14px; border-radius:6px; cursor:pointer; font-family:inherit; font-size:13px;';

  footer.append(statusEl, jsonEl, copyBtn);

  root.append(header, canvasWrap, footer);
  canvasHost.append(root);

  const rawCtx = canvas.getContext('2d');
  if (!rawCtx) throw new Error('Could not get 2D canvas context');
  const ctx: CanvasRenderingContext2D = rawCtx;

  // ── Render loop ────────────────────────────────────────────────────────────
  const start = performance.now();

  function currentSprite(): SpriteDef {
    return SPRITES.find((s) => s.id === settings.spriteId) ?? firstSprite;
  }

  function currentSheet(): ReturnType<typeof getSheet> {
    return getSheet(currentSprite().sheetKey);
  }

  function clampAnchorToSheet(): void {
    const sheet = currentSheet();
    if (!sheet) return;
    settings.anchorX = Math.max(0, Math.min(sheet.frameWidth - 1, Math.round(settings.anchorX)));
    settings.anchorY = Math.max(0, Math.min(sheet.frameHeight - 1, Math.round(settings.anchorY)));
  }

  function computeAngleRadians(elapsedMs: number): number {
    switch (settings.rotationMode) {
      case 'static':
        return (settings.staticAngleDeg * Math.PI) / 180;
      case 'spin': {
        const deg = (elapsedMs / 1000) * settings.spinSpeedDegPerSec;
        return (deg * Math.PI) / 180;
      }
      case 'swing': {
        const period = Math.max(50, settings.swingPeriodMs);
        const t = ((elapsedMs % period) / period) * Math.PI * 2;
        const deg = Math.sin(t) * settings.swingDegrees;
        return (deg * Math.PI) / 180;
      }
    }
  }

  function render(nowMs: number): void {
    const sprite = currentSprite();
    const sheet = currentSheet();

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!sheet) {
      drawError(`Unknown sheet for sprite '${sprite.id}'`);
      return;
    }

    const sheetImg = loadSheetImage(sheet.path);
    if (sheetImg.error) {
      drawError(`Failed to load sheet: ${sheet.path}`);
      return;
    }
    if (!sheetImg.loaded) {
      drawError(`Loading ${sheet.path}…`);
      return;
    }

    const col = sprite.frame % sheet.cols;
    const row = Math.floor(sprite.frame / sheet.cols);
    const sx = sheet.margin + col * (sheet.frameWidth + sheet.spacing);
    const sy = sheet.margin + row * (sheet.frameHeight + sheet.spacing);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const scale = settings.scale;

    const angle = computeAngleRadians(nowMs - start);

    // 1) Draw a "hand" / wielder dot at the canvas center to make the anchor's
    //    pinning behavior visually obvious during rotation.
    if (settings.showHand) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,200,120,0.85)';
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 2) Draw the sprite rotated so that the *anchor pixel* lands at (cx, cy).
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sheetImg.image,
      sx,
      sy,
      sheet.frameWidth,
      sheet.frameHeight,
      -settings.anchorX * scale,
      -settings.anchorY * scale,
      sheet.frameWidth * scale,
      sheet.frameHeight * scale,
    );

    if (settings.showGrid) {
      ctx.strokeStyle = 'rgba(126,224,255,0.18)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= sheet.frameWidth; i++) {
        const x = -settings.anchorX * scale + i * scale;
        ctx.beginPath();
        ctx.moveTo(x, -settings.anchorY * scale);
        ctx.lineTo(x, -settings.anchorY * scale + sheet.frameHeight * scale);
        ctx.stroke();
      }
      for (let j = 0; j <= sheet.frameHeight; j++) {
        const y = -settings.anchorY * scale + j * scale;
        ctx.beginPath();
        ctx.moveTo(-settings.anchorX * scale, y);
        ctx.lineTo(-settings.anchorX * scale + sheet.frameWidth * scale, y);
        ctx.stroke();
      }
    }

    // Anchor crosshair (in sprite-local space so it rotates with the sprite).
    ctx.strokeStyle = '#ff3b6f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(10, 0);
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3b6f';
    ctx.fill();

    ctx.restore();

    // 3) HUD: a small label that does NOT rotate, anchored at hand position.
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${sprite.id}  frame=${sprite.frame}  (${sheet.frameWidth}×${sheet.frameHeight})`,
      8,
      16,
    );
    ctx.fillText(`anchor=(${settings.anchorX}, ${settings.anchorY})  scale=${scale}x`, 8, 30);
    ctx.fillText(
      `mode=${settings.rotationMode}  angle=${((angle * 180) / Math.PI).toFixed(1)}°`,
      8,
      44,
    );

    const valid = isValidAnchor(
      { x: settings.anchorX, y: settings.anchorY },
      sheet.frameWidth,
      sheet.frameHeight,
    );
    if (!valid) {
      ctx.fillStyle = '#ff3b6f';
      ctx.fillText('⚠ anchor invalid for this frame', 8, 58);
    }
  }

  function drawError(msg: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
    ctx.textAlign = 'left';
  }

  function updateStatusAndJson(): void {
    const sprite = currentSprite();
    const sheet = currentSheet();
    const declared = sprite.anchor;
    const declaredStr = declared ? `declared (${declared.x}, ${declared.y})` : 'no declared anchor';
    const defaultStr = `default ${DEFAULT_HANDHELD_SPRITE_ANCHOR.x},${DEFAULT_HANDHELD_SPRITE_ANCHOR.y}`;
    const frameStr = sheet ? `${sheet.frameWidth}×${sheet.frameHeight}` : '?';
    statusEl.innerHTML =
      `<div><b>${sprite.id}</b> · frame ${sprite.frame} · ${frameStr}</div>` +
      `<div style="color:#c9d4ff;font-size:12px;">${declaredStr} · ${defaultStr}</div>`;
    jsonEl.textContent = `anchor: { x: ${settings.anchorX}, y: ${settings.anchorY} }`;
  }

  // ── Canvas interaction ────────────────────────────────────────────────────
  canvas.addEventListener('click', (ev) => {
    const sheet = currentSheet();
    if (!sheet) return;
    const rect = canvas.getBoundingClientRect();
    // Convert click to canvas pixel space.
    const px = ((ev.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((ev.clientY - rect.top) / rect.height) * canvas.height;

    // For unambiguous click-anchor mapping, only allow click-to-set in static
    // mode (otherwise the sprite is mid-rotation and a click in canvas space
    // doesn't map cleanly to sprite-local pixels).
    if (settings.rotationMode !== 'static') {
      flashMessage('Switch to static mode to click-set the anchor.');
      return;
    }

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const angle = (settings.staticAngleDeg * Math.PI) / 180;
    // Inverse-rotate the click around the canvas center, then convert from
    // sprite-local canvas pixels back to sprite frame pixels.
    const dx = px - cx;
    const dy = py - cy;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const ax = Math.round(localX / settings.scale + settings.anchorX);
    const ay = Math.round(localY / settings.scale + settings.anchorY);
    settings.anchorX = ax;
    settings.anchorY = ay;
    clampAnchorToSheet();
    refreshGui();
    updateStatusAndJson();
  });

  let flashTimer: number | undefined;
  function flashMessage(msg: string): void {
    statusEl.innerHTML = `<div style="color:#fbbf24;">${msg}</div>`;
    if (flashTimer !== undefined) {
      window.clearTimeout(flashTimer);
    }
    flashTimer = window.setTimeout(() => {
      updateStatusAndJson();
      flashTimer = undefined;
    }, 1500);
  }

  copyBtn.addEventListener('click', () => {
    const text = jsonEl.textContent ?? '';
    void navigator.clipboard?.writeText(text);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    window.setTimeout(() => {
      copyBtn.textContent = original ?? 'Copy';
    }, 1000);
  });

  // ── GUI ──────────────────────────────────────────────────────────────────
  const spriteFolder = gui.addFolder('Sprite');
  const spriteCtrl = spriteFolder
    .add(
      settings,
      'spriteId',
      Object.fromEntries(SPRITES.map((s) => [`${s.id} (sheet ${s.sheetKey})`, s.id])),
    )
    .name('Sprite');
  spriteCtrl.onChange(() => {
    const s = currentSprite();
    const a = defaultAnchorFor(s);
    settings.anchorX = a.x;
    settings.anchorY = a.y;
    clampAnchorToSheet();
    refreshGui();
    updateStatusAndJson();
  });

  // Resolve max anchor range from first sheet; sprites here are all 16x16
  // but we recompute on sprite change just in case.
  const initialSheet = getSheet(firstSprite.sheetKey);
  const maxX = (initialSheet?.frameWidth ?? 16) - 1;
  const maxY = (initialSheet?.frameHeight ?? 16) - 1;

  const anchorFolder = gui.addFolder('Anchor');
  const xCtrl = anchorFolder.add(settings, 'anchorX', 0, maxX, 1).name('x');
  const yCtrl = anchorFolder.add(settings, 'anchorY', 0, maxY, 1).name('y');
  xCtrl.onChange(() => updateStatusAndJson());
  yCtrl.onChange(() => updateStatusAndJson());
  anchorFolder
    .add(
      {
        defaultHandheld: () => {
          settings.anchorX = DEFAULT_HANDHELD_SPRITE_ANCHOR.x;
          settings.anchorY = DEFAULT_HANDHELD_SPRITE_ANCHOR.y;
          refreshGui();
          updateStatusAndJson();
        },
      },
      'defaultHandheld',
    )
    .name(
      `Reset to default (${DEFAULT_HANDHELD_SPRITE_ANCHOR.x}, ${DEFAULT_HANDHELD_SPRITE_ANCHOR.y})`,
    );
  anchorFolder
    .add(
      {
        resetDeclared: () => {
          const s = currentSprite();
          const a = defaultAnchorFor(s);
          settings.anchorX = a.x;
          settings.anchorY = a.y;
          refreshGui();
          updateStatusAndJson();
        },
      },
      'resetDeclared',
    )
    .name('Reset to declared / default');

  const rotFolder = gui.addFolder('Rotation');
  rotFolder.add(settings, 'rotationMode', ['static', 'spin', 'swing']).name('Mode');
  rotFolder.add(settings, 'spinSpeedDegPerSec', -360, 360, 5).name('Spin speed (°/s)');
  rotFolder.add(settings, 'swingDegrees', 5, 180, 5).name('Swing arc (°)');
  rotFolder.add(settings, 'swingPeriodMs', 100, 3000, 50).name('Swing period (ms)');
  rotFolder.add(settings, 'staticAngleDeg', -180, 180, 1).name('Static angle (°)');

  const viewFolder = gui.addFolder('View');
  viewFolder.add(settings, 'scale', 4, 32, 1).name('Scale');
  viewFolder.add(settings, 'showGrid').name('Show pixel grid');
  viewFolder.add(settings, 'showHand').name('Show hand marker');

  function refreshGui(): void {
    xCtrl.updateDisplay();
    yCtrl.updateDisplay();
  }

  updateStatusAndJson();

  let rafId = 0;
  function loop(now: number): void {
    render(now);
    rafId = window.requestAnimationFrame(loop);
  }
  rafId = window.requestAnimationFrame(loop);

  return () => {
    window.cancelAnimationFrame(rafId);
    if (flashTimer !== undefined) window.clearTimeout(flashTimer);
    root.remove();
  };
}

registerLab('anchor-lab', {
  category: 'Items & Equipment' as LabCategory,
  name: 'Anchor Lab',
  description:
    'Visually verify the 2D anchor on an item sprite. Pick a sprite, see it rotate (spin or swing) around the anchor pixel, and click or use sliders to dial in the correct grip. Copy the anchor JSON back into the sprite registry.',
  create: createAnchorLab,
});
