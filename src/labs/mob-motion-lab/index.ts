import type GUI from 'lil-gui';
import { DEFAULT_MANIFEST_URL, resolvePublicAssetUrl } from '../../engine/generatedAssets/index.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import {
  sampleMobMotion,
  selectMobSprites,
  type MobMotionState,
  type MobMotionTransform,
  type MobSpriteOption,
} from './model.js';

const LAB_ID = 'mob-motion-lab';
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 360;
const PANEL_WIDTH = 296;
const PANEL_GAP = 16;

interface MobMotionSettings {
  spriteKey: string;
  speed: number;
  intensity: number;
  scale: number;
  paused: boolean;
  previewTimeMs: number;
}

interface MobMotionProbe {
  ready(): boolean;
  selectedSprite(): string;
  panelStates(): readonly MobMotionState[];
  selectSprite(textureKey: string): void;
  setTime(elapsedMs: number): void;
}

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type ProbeWindow = Window &
  typeof globalThis & {
    __mobMotionProbe?: MobMotionProbe;
    __uiProbe?: { ready(): boolean };
  };

const PANELS: readonly {
  state: MobMotionState;
  title: string;
  subtitle: string;
  accent: string;
}[] = [
  {
    state: 'movement',
    title: 'MOVEMENT',
    subtitle: 'step bob · squash · lean',
    accent: '#38bdf8',
  },
  {
    state: 'attack',
    title: 'ATTACK',
    subtitle: 'wind-up · lunge · recovery',
    accent: '#f59e0b',
  },
  {
    state: 'hit',
    title: 'HIT REACTION',
    subtitle: 'recoil · shake · flash',
    accent: '#ef4444',
  },
];

function imageUrl(assetPath: string): string {
  const normalized = assetPath.replace(/^\/+/, '');
  return resolvePublicAssetUrl(
    normalized.startsWith('assets/') ? normalized : `assets/${normalized}`,
  );
}

function resolveAnchor(
  point: { readonly x: number; readonly y: number } | null,
  image: HTMLImageElement,
  fallback: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  if (!point || point.x < 0 || point.y < 0 || point.x > image.width || point.y > image.height) {
    return fallback;
  }
  return point;
}

function drawAnchoredSprite(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sprite: MobSpriteOption,
  transform: MobMotionTransform,
  holdX: number,
  holdY: number,
  displayScale: number,
): void {
  const hold = resolveAnchor(sprite.anchor, image, {
    x: image.width / 2,
    y: image.height - 2,
  });
  const center = resolveAnchor(sprite.centerOfGravity, image, {
    x: image.width / 2,
    y: image.height / 2,
  });
  const scaleX = displayScale * transform.scaleX;
  const scaleY = displayScale * transform.scaleY;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  const anchorVectorX = hold.x - center.x;
  const anchorVectorY = hold.y - center.y;
  const transformedAnchorX = anchorVectorX * scaleX * cos - anchorVectorY * scaleY * sin;
  const transformedAnchorY = anchorVectorX * scaleX * sin + anchorVectorY * scaleY * cos;
  const pivotX = holdX + transform.offsetX * displayScale - transformedAnchorX;
  const pivotY = holdY + transform.offsetY * displayScale - transformedAnchorY;

  const draw = (): void => {
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(transform.rotation);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(image, -center.x, -center.y);
    ctx.restore();
  };

  ctx.globalAlpha = transform.alpha;
  draw();
  if (transform.flash > 0) {
    ctx.globalAlpha = transform.flash * 0.8;
    ctx.filter = 'brightness(3) saturate(0)';
    draw();
    ctx.filter = 'none';
  }
  ctx.globalAlpha = 1;
}

function createMobMotionLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const saved = loadLabState<Partial<MobMotionSettings>>(LAB_ID) ?? {};
  const settings: MobMotionSettings = {
    spriteKey: '',
    speed: 1,
    intensity: 1,
    scale: 1.6,
    paused: false,
    previewTimeMs: 385,
    ...saved,
  };

  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;';
  canvasHost.appendChild(root);

  const status = document.createElement('div');
  status.style.cssText =
    'width:min(960px,100%);box-sizing:border-box;padding:8px 12px;border-radius:6px;' +
    'background:#0f172a;color:#94a3b8;font:12px monospace;';
  status.textContent = 'Loading approved mob sprites…';
  root.appendChild(status);

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  canvas.style.cssText =
    'display:block;width:min(960px,100%);height:auto;image-rendering:pixelated;' +
    'border:1px solid #334155;border-radius:8px;background:#080b12;';
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable.');
  ctx.imageSmoothingEnabled = false;

  let sprites: readonly MobSpriteOption[] = [];
  let selected: MobSpriteOption | undefined;
  let image: HTMLImageElement | undefined;
  let imageReady = false;
  let manifestReady = false;
  let animationFrame = 0;

  const render = (rafTimeMs: number): void => {
    ctx.fillStyle = '#080b12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const elapsedMs = settings.paused ? settings.previewTimeMs : rafTimeMs * settings.speed;

    for (let index = 0; index < PANELS.length; index++) {
      const panel = PANELS[index]!;
      const x = 20 + index * (PANEL_WIDTH + PANEL_GAP);
      const y = 18;
      const baselineY = 280;
      ctx.fillStyle = '#111827';
      ctx.fillRect(x, y, PANEL_WIDTH, 314);
      ctx.strokeStyle = panel.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, PANEL_WIDTH - 2, 312);

      ctx.fillStyle = panel.accent;
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(panel.title, x + PANEL_WIDTH / 2, y + 28);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px monospace';
      ctx.fillText(panel.subtitle, x + PANEL_WIDTH / 2, y + 47);

      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      ctx.beginPath();
      ctx.ellipse(x + PANEL_WIDTH / 2, baselineY + 3, 45, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 24, baselineY + 5);
      ctx.lineTo(x + PANEL_WIDTH - 24, baselineY + 5);
      ctx.stroke();

      if (imageReady && image && selected) {
        const transform = sampleMobMotion(panel.state, elapsedMs, settings.intensity);
        drawAnchoredSprite(
          ctx,
          image,
          selected,
          transform,
          x + PANEL_WIDTH / 2,
          baselineY,
          settings.scale,
        );
      } else {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px monospace';
        ctx.fillText('loading sprite…', x + PANEL_WIDTH / 2, 170);
      }
    }

    ctx.textAlign = 'left';
    animationFrame = requestAnimationFrame(render);
  };

  const loadSelectedSprite = (): void => {
    selected = sprites.find((sprite) => sprite.textureKey === settings.spriteKey);
    if (!selected) return;
    imageReady = false;
    image = new Image();
    image.addEventListener('load', () => {
      imageReady = true;
      status.textContent =
        `${selected!.label} · ${image!.width}×${image!.height}px · ` +
        `${selected!.anchor ? 'manifest anchor' : 'bottom-center fallback'}`;
    });
    image.addEventListener('error', () => {
      status.textContent = `Could not load ${selected!.assetPath}`;
    });
    image.src = imageUrl(selected.assetPath);
    saveLabState(LAB_ID, settings);
  };

  const playbackFolder = gui.addFolder('Motion');
  playbackFolder.add(settings, 'speed', 0.25, 2.5, 0.05).name('Speed');
  playbackFolder.add(settings, 'intensity', 0, 2, 0.05).name('Intensity');
  playbackFolder.add(settings, 'scale', 0.5, 3, 0.1).name('Preview scale');
  playbackFolder
    .add(settings, 'paused')
    .name('Pause / scrub')
    .onChange(() => saveLabState(LAB_ID, settings));
  playbackFolder
    .add(settings, 'previewTimeMs', 0, 2_000, 5)
    .name('Scrub time (ms)')
    .onChange(() => saveLabState(LAB_ID, settings));
  playbackFolder.open();

  const probeWindow = window as ProbeWindow;
  const readyAlias = { ready: () => manifestReady && imageReady };
  const probe: MobMotionProbe = {
    ready: readyAlias.ready,
    selectedSprite: () => settings.spriteKey,
    panelStates: () => PANELS.map((panel) => panel.state),
    selectSprite: (textureKey) => {
      if (!sprites.some((sprite) => sprite.textureKey === textureKey)) return;
      settings.spriteKey = textureKey;
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
      loadSelectedSprite();
    },
    setTime: (elapsedMs) => {
      settings.paused = true;
      settings.previewTimeMs = Math.max(0, elapsedMs);
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
    },
  };
  probeWindow.__mobMotionProbe = probe;
  probeWindow.__uiProbe = readyAlias;

  void fetch(DEFAULT_MANIFEST_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Manifest request returned ${response.status}`);
      sprites = selectMobSprites(await response.json());
      if (sprites.length === 0) throw new Error('No approved mob sprites found.');
      manifestReady = true;
      if (!sprites.some((sprite) => sprite.textureKey === settings.spriteKey)) {
        settings.spriteKey = sprites[0]!.textureKey;
      }
      const choices = Object.fromEntries(
        sprites.map((sprite) => [sprite.label, sprite.textureKey]),
      );
      gui
        .add(settings, 'spriteKey', choices)
        .name('Mob sprite')
        .onChange(() => loadSelectedSprite());
      loadSelectedSprite();
    })
    .catch((error: unknown) => {
      status.textContent =
        error instanceof Error ? `Mob manifest error: ${error.message}` : String(error);
    });

  animationFrame = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(animationFrame);
    if (probeWindow.__mobMotionProbe === probe) delete probeWindow.__mobMotionProbe;
    if (probeWindow.__uiProbe === readyAlias) delete probeWindow.__uiProbe;
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta',
  name: 'Mob Motion Lab',
  description:
    'Preview simulated movement, attack, and hit animation on approved generated mob sprites.',
  create: createMobMotionLab,
});
