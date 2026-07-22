/**
 * Sprite Tint Lab — investigates how to reuse one sprite sheet frame for
 * multiple visual variants via tinting and colour manipulation.
 *
 * Problem: custom pixel-art sprites are expensive to author. Tinting lets us
 * derive dozens of variants (enemy colours, status effects, rarity tiers) from
 * a single approved frame — keeping the art pipeline lean.
 *
 * This lab renders the same sprite six times in a row, each with a different
 * Canvas 2D technique applied, and lets you tune the tint colour and parameters
 * interactively so you can compare them side by side.
 *
 * Techniques demonstrated:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Original          — no modification, reference frame.
 * 2. CSS hue-rotate    — `ctx.filter = "hue-rotate(Xdeg)"` shifts the hue of
 *                        every pixel while preserving luminance. Fast, cheap,
 *                        no extra canvas needed.  Ideal for enemy colour variants
 *                        (green slime → purple slime).
 * 3. Multiply blend    — draw sprite, then overlay a solid colour rect with
 *                        `globalCompositeOperation = "multiply"`.  Darkens towards
 *                        the tint colour.  Good for "cursed" / "shadow" variants.
 * 4. Screen blend      — same but with `"screen"`.  Lightens towards the tint.
 *                        Good for "blessed" / "fire" glow effects.
 * 5. CSS colorize      — `hue-rotate` + `saturate` filter combo.  Pushes the
 *                        sprite toward a dominant hue while keeping detail.
 * 6. Palette swap      — per-pixel ImageData loop replaces each unique source
 *                        colour with a mapped target colour.  Pixel-accurate,
 *                        zero visual artefacts, but costs one ImageData round-
 *                        trip per render.  Best for deterministic recolouring
 *                        (rarity tiers, faction colours).
 *
 * Phaser 4 mapping notes:
 * ─────────────────────────────────────────────────────────────────────────────
 * • `GameObject.setTint(color)` applies a multiply-style per-vertex tint that
 *   Phaser composites on the GPU.  It is free at runtime.
 * • For hue-rotate: render the sprite to a RenderTexture with a Phaser Pipeline
 *   that applies a hue-rotation uniform.  The custom pipeline approach from
 *   Phaser 3 is largely identical in Phaser 4 — attach a PostFX pipeline.
 * • For palette swap: bake the recoloured frame to an offscreen Canvas / RT at
 *   load time and register it as a new texture key.  Runtime cost is zero.
 *
 * Controls:
 *   Sprite        — choose which registered sprite to display.
 *   Tint colour   — hex colour fed to techniques 3-6.
 *   Hue shift     — degrees fed to techniques 2 and 5.
 *   Saturation    — CSS saturation multiplier for technique 5.
 *   Scale         — render scale (zoom).
 *   Swap target   — second palette colour for the palette-swap preview.
 */

import GUI from 'lil-gui';
import { SHEETS, SPRITES } from '../../engine/sprites/index.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'sprite-tint-lab';

type TintTechnique =
  | 'original'
  | 'hue-rotate'
  | 'multiply'
  | 'screen'
  | 'colorize'
  | 'palette-swap';

interface SpriteTintSettings {
  spriteId: string;
  tintColor: string;
  hueShift: number;
  saturation: number;
  scale: number;
  swapTarget: string;
}

interface SheetImage {
  img: HTMLImageElement;
  loaded: boolean;
  error: boolean;
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
  cols: number;
}

function loadSheetImages(): Map<string, SheetImage> {
  const map = new Map<string, SheetImage>();
  for (const sheet of SHEETS) {
    const entry: SheetImage = {
      img: new Image(),
      loaded: false,
      error: false,
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
      margin: sheet.margin,
      spacing: sheet.spacing,
      cols: sheet.cols,
    };
    entry.img.addEventListener('load', () => {
      entry.loaded = true;
    });
    entry.img.addEventListener('error', () => {
      entry.error = true;
    });
    entry.img.src = sheet.path;
    map.set(sheet.key, entry);
  }
  return map;
}

/** Parse a CSS hex colour string (#rrggbb) to [r, g, b]. */
function cssToRGB(css: string): [number, number, number] {
  const hex = css.replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Extract a single frame from a sheet image into an offscreen canvas. */
function extractSpriteFrame(entry: SheetImage, frame: number): HTMLCanvasElement {
  const fw = entry.frameWidth;
  const fh = entry.frameHeight;
  const col = frame % entry.cols;
  const row = Math.floor(frame / entry.cols);
  const srcX = entry.margin + col * (fw + entry.spacing);
  const srcY = entry.margin + row * (fh + entry.spacing);

  const off = document.createElement('canvas');
  off.width = fw;
  off.height = fh;
  const octx = off.getContext('2d')!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(entry.img, srcX, srcY, fw, fh, 0, 0, fw, fh);
  return off;
}

/**
 * Apply palette-swap: for each pixel whose RGB exactly matches one of the
 * most-frequent source colours, replace it with a proportionally shifted colour
 * towards the target.
 */
function applyPaletteSwap(
  src: HTMLCanvasElement,
  swapMap: Map<string, [number, number, number]>,
): HTMLCanvasElement {
  const fw = src.width;
  const fh = src.height;
  const off = document.createElement('canvas');
  off.width = fw;
  off.height = fh;
  const octx = off.getContext('2d')!;
  octx.drawImage(src, 0, 0);
  const id = octx.getImageData(0, 0, fw, fh);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 10) continue; // skip transparent
    const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
    const mapped = swapMap.get(key);
    if (mapped) {
      d[i + 0] = mapped[0];
      d[i + 1] = mapped[1];
      d[i + 2] = mapped[2];
    }
  }
  octx.putImageData(id, 0, 0);
  return off;
}

/**
 * Build a simple palette-swap map: find all unique opaque colours in the
 * sprite and remap them by blending each source colour 65% toward targetRGB.
 */
function buildPaletteSwapMap(
  src: HTMLCanvasElement,
  targetRGB: [number, number, number],
): Map<string, [number, number, number]> {
  const octx = src.getContext('2d')!;
  const id = octx.getImageData(0, 0, src.width, src.height);
  const d = id.data;
  const swapMap = new Map<string, [number, number, number]>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 10) continue;
    const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
    if (swapMap.has(key)) continue;
    const [sr, sg, sb] = [d[i]!, d[i + 1]!, d[i + 2]!];
    // Blend 65% toward target to preserve some luminance variation
    const blend = 0.65;
    swapMap.set(key, [
      Math.round(sr * (1 - blend) + targetRGB[0] * blend),
      Math.round(sg * (1 - blend) + targetRGB[1] * blend),
      Math.round(sb * (1 - blend) + targetRGB[2] * blend),
    ]);
  }
  return swapMap;
}

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

// ── Panel definitions ─────────────────────────────────────────────────────────

interface TintPanel {
  technique: TintTechnique;
  label: string;
  description: string;
  badge: string;
}

const PANELS: TintPanel[] = [
  {
    technique: 'original',
    label: 'Original',
    description: 'No modification — reference frame.',
    badge: '#64748b',
  },
  {
    technique: 'hue-rotate',
    label: 'Hue Rotate',
    description: 'ctx.filter hue-rotate — cheap, GPU-friendly, great for enemy colour variants.',
    badge: '#a78bfa',
  },
  {
    technique: 'multiply',
    label: 'Multiply',
    description: 'Tint × pixel colour — darkens toward tint. Cursed / shadow variants.',
    badge: '#f97316',
  },
  {
    technique: 'screen',
    label: 'Screen',
    description: '1−(1−tint)(1−pixel) — lightens toward tint. Blessed / fire glow.',
    badge: '#34d399',
  },
  {
    technique: 'colorize',
    label: 'Colorize',
    description: 'CSS hue-rotate + saturate combo — pushes dominant hue, keeps detail.',
    badge: '#60a5fa',
  },
  {
    technique: 'palette-swap',
    label: 'Palette Swap',
    description: 'ImageData per-pixel remap — pixel-accurate, zero artefacts, rarity tiers.',
    badge: '#f472b6',
  },
];

// ── Lab ───────────────────────────────────────────────────────────────────────

function createSpriteTintLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const spriteIds = SPRITES.map((s) => s.id);

  const settings: SpriteTintSettings = {
    spriteId: 'enemy.slime',
    tintColor: '#22c55e',
    hueShift: 150,
    saturation: 3,
    scale: 8,
    swapTarget: '#d946ef',
    ...(loadLabState<Partial<SpriteTintSettings>>(LAB_ID) ?? {}),
  };

  const sheets = loadSheetImages();

  // ── Main canvas ───────────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'overflow-x:auto;';
  canvasHost.appendChild(wrapper);

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.imageRendering = 'pixelated';
  wrapper.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;

  // ── Info bar ──────────────────────────────────────────────────────────────
  const infoEl = document.createElement('div');
  infoEl.style.cssText =
    'font-size:11px;font-family:monospace;color:#94a3b8;margin-top:8px;padding:4px 8px;' +
    'background:#0f172a;border-radius:4px;';
  canvasHost.appendChild(infoEl);

  // ── Technique notes ───────────────────────────────────────────────────────
  const notesEl = document.createElement('div');
  notesEl.style.cssText =
    'margin-top:12px;font-size:11px;font-family:monospace;color:#94a3b8;line-height:1.8;' +
    'background:#0f172a;border-radius:4px;padding:8px 12px;';
  notesEl.innerHTML =
    '<b style="color:#e2e8f0">Phaser 4 equivalents:</b><br>' +
    '<b style="color:#a78bfa">Hue Rotate</b> → PostFX pipeline with hue-rotation uniform.<br>' +
    '<b style="color:#f97316">Multiply</b> → <code>sprite.setTint(color)</code> (Phaser uses multiply tint natively).<br>' +
    '<b style="color:#34d399">Screen</b> → custom blendMode on a Container or PipelinePlugin.<br>' +
    '<b style="color:#60a5fa">Colorize</b> → PostFX pipeline with hue+saturation uniforms.<br>' +
    '<b style="color:#f472b6">Palette Swap</b> → generate a new texture key at floor-load via <code>textures.createCanvas()</code>.<br>' +
    '<br><b style="color:#e2e8f0">Cheapest options at runtime:</b> Multiply tint (GPU vertex attr) and Hue Rotate (single uniform).';
  controls.appendChild(notesEl);

  // ── Render ────────────────────────────────────────────────────────────────

  function render(): void {
    saveLabState(LAB_ID, settings);

    const spriteDef = SPRITES.find((s) => s.id === settings.spriteId);
    if (!spriteDef) return;

    const sheet = sheets.get(spriteDef.sheetKey);
    if (!sheet?.loaded) {
      infoEl.textContent = `Loading sheet: ${spriteDef.sheetKey}…`;
      return;
    }

    const fw = sheet.frameWidth;
    const fh = sheet.frameHeight;
    const sc = settings.scale;
    const GAP = Math.max(4, Math.round(sc * 1.5)); // gap between panels
    const LABEL_H = 14; // px for label below sprite
    const INFO_H = 0; // we'll paint labels on the canvas

    const numPanels = PANELS.length;
    const panelW = fw * sc;
    const panelH = fh * sc + LABEL_H + 4;
    const totalW = numPanels * panelW + (numPanels - 1) * GAP;
    const totalH = panelH + INFO_H;

    canvas.width = totalW;
    canvas.height = totalH;
    ctx.imageSmoothingEnabled = false;

    // Extract base frame
    const baseFrame = extractSpriteFrame(sheet, spriteDef.frame);

    // Palette-swap map (built once per render)
    const swapTarget = cssToRGB(settings.swapTarget);
    const swapMap = buildPaletteSwapMap(baseFrame, swapTarget);
    const swappedFrame = applyPaletteSwap(baseFrame, swapMap);

    for (let pi = 0; pi < PANELS.length; pi++) {
      const panel = PANELS[pi]!;
      const px = pi * (panelW + GAP);
      const py = 0;

      // Dark background per panel
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px, py, panelW, panelH);

      const imgY = py + 2;
      const imgH = fh * sc;

      switch (panel.technique) {
        case 'original': {
          ctx.drawImage(baseFrame, px, imgY, panelW, imgH);
          break;
        }

        case 'hue-rotate': {
          ctx.filter = `hue-rotate(${settings.hueShift}deg)`;
          ctx.drawImage(baseFrame, px, imgY, panelW, imgH);
          ctx.filter = 'none';
          break;
        }

        case 'multiply': {
          // Draw sprite to an offscreen, apply tint colour via multiply compositing.
          const off = document.createElement('canvas');
          off.width = fw;
          off.height = fh;
          const octx = off.getContext('2d')!;
          octx.imageSmoothingEnabled = false;
          octx.drawImage(baseFrame, 0, 0);
          octx.globalCompositeOperation = 'multiply';
          octx.fillStyle = settings.tintColor;
          octx.fillRect(0, 0, fw, fh);
          // Re-clip the tinted fill back to the sprite silhouette so the
          // transparent background stays transparent (matches sprite.setTint()).
          octx.globalCompositeOperation = 'destination-in';
          octx.drawImage(baseFrame, 0, 0);
          octx.globalCompositeOperation = 'source-over';
          ctx.drawImage(off, px, imgY, panelW, imgH);
          break;
        }

        case 'screen': {
          const off = document.createElement('canvas');
          off.width = fw;
          off.height = fh;
          const octx = off.getContext('2d')!;
          octx.imageSmoothingEnabled = false;
          octx.drawImage(baseFrame, 0, 0);
          octx.globalCompositeOperation = 'screen';
          octx.fillStyle = settings.tintColor;
          octx.fillRect(0, 0, fw, fh);
          // Re-clip to the sprite silhouette so the transparent background is
          // not filled with an opaque tint block.
          octx.globalCompositeOperation = 'destination-in';
          octx.drawImage(baseFrame, 0, 0);
          octx.globalCompositeOperation = 'source-over';
          ctx.drawImage(off, px, imgY, panelW, imgH);
          break;
        }

        case 'colorize': {
          ctx.filter = `hue-rotate(${settings.hueShift}deg) saturate(${settings.saturation})`;
          ctx.drawImage(baseFrame, px, imgY, panelW, imgH);
          ctx.filter = 'none';
          break;
        }

        case 'palette-swap': {
          ctx.drawImage(swappedFrame, px, imgY, panelW, imgH);
          break;
        }
      }

      // Label below sprite
      const labelY = imgY + imgH + 2;
      ctx.fillStyle = panel.badge;
      ctx.fillRect(px, labelY, panelW, 2);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = `bold ${Math.max(8, Math.round(panelW / 9))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(panel.label, px + panelW / 2, labelY + 11);
    }

    ctx.textAlign = 'left';

    infoEl.textContent =
      `Sprite: ${settings.spriteId} · Scale: ${sc}× · ` +
      `Hue: ${settings.hueShift}° · Tint: ${settings.tintColor} · ` +
      `Swap→: ${settings.swapTarget}`;
  }

  // Reload on sheets ready
  for (const entry of sheets.values()) {
    entry.img.addEventListener('load', () => render());
    entry.img.addEventListener('error', () => render());
  }

  // ── lil-gui controls ──────────────────────────────────────────────────────

  const spriteFolder = gui.addFolder('Sprite');
  spriteFolder
    .add(settings, 'spriteId', spriteIds)
    .name('Sprite')
    .onChange(() => render());
  spriteFolder
    .add(settings, 'scale', 2, 16, 1)
    .name('Scale (×)')
    .onChange(() => render());

  const tintFolder = gui.addFolder('Tint & Colour');
  tintFolder
    .addColor(settings, 'tintColor')
    .name('Tint Colour')
    .onChange(() => render());
  tintFolder
    .add(settings, 'hueShift', 0, 360, 1)
    .name('Hue Shift (°)')
    .onChange(() => render());
  tintFolder
    .add(settings, 'saturation', 0.1, 10, 0.1)
    .name('Saturation ×')
    .onChange(() => render());
  tintFolder
    .addColor(settings, 'swapTarget')
    .name('Palette Swap Target')
    .onChange(() => render());

  // Buttons: quick preset tints
  const presets = {
    'Preset: Poison': () => {
      settings.tintColor = '#22c55e';
      settings.swapTarget = '#16a34a';
      settings.hueShift = 120;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      render();
    },
    'Preset: Fire': () => {
      settings.tintColor = '#f97316';
      settings.swapTarget = '#ef4444';
      settings.hueShift = 30;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      render();
    },
    'Preset: Ice': () => {
      settings.tintColor = '#7dd3fc';
      settings.swapTarget = '#38bdf8';
      settings.hueShift = 200;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      render();
    },
    'Preset: Cursed': () => {
      settings.tintColor = '#7c3aed';
      settings.swapTarget = '#a855f7';
      settings.hueShift = 270;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      render();
    },
    'Preset: Gold': () => {
      settings.tintColor = '#fbbf24';
      settings.swapTarget = '#f59e0b';
      settings.hueShift = 45;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      render();
    },
  };
  const presetsFolder = gui.addFolder('Quick Presets');
  for (const [name, fn] of Object.entries(presets)) {
    presetsFolder.add({ fn }, 'fn').name(name);
  }
  presetsFolder.open();

  render();

  return () => {
    wrapper.remove();
    infoEl.remove();
    notesEl.remove();
  };
}

registerLab('sprite-tint-lab', {
  category: 'Meta',
  name: 'Sprite Tint Lab',
  description:
    'Investigates how to reuse one sprite frame for multiple visual variants via tinting ' +
    'and colour manipulation. Demonstrates hue-rotate, multiply, screen, colorize, and palette-swap.',
  create: createSpriteTintLab,
});
