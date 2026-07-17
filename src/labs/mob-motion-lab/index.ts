import type GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import { DEFAULT_MANIFEST_URL, resolvePublicAssetUrl } from '../../engine/generatedAssets/index.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import {
  sampleAttackPreview,
  sampleDeathPreview,
  sampleMobMotion,
  sampleStatusTreatment,
  selectMobSprites,
  type MobLocomotionStyle,
  type MobMotionState,
  type MobMotionTransform,
  type MobSpriteOption,
  type MobStatusTreatment,
} from './model.js';
import {
  availableMobPreviewSpecs,
  resolveEnemyProjectileFrame,
  type MobPreviewSpec,
  type ProjectileFrameSpec,
} from './preview-spec.js';

const LAB_ID = 'mob-motion-lab';
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 660;
const PANEL_COLUMNS = 3;
const PANEL_WIDTH = 296;
const PANEL_HEIGHT = 304;
const PANEL_COLUMN_GAP = 16;
const PANEL_ROW_GAP = 20;
const OUTER_X = 20;
const OUTER_Y = 18;

interface MobMotionSettings {
  archetypeId: string;
  spriteKey: string;
  speed: number;
  intensity: number;
  scale: number;
  paused: boolean;
  previewTimeMs: number;
}

interface MobMotionProbe {
  ready(): boolean;
  selectedEnemy(): string;
  selectedSprite(): string;
  panelStates(): readonly MobMotionState[];
  movementStyle(): MobLocomotionStyle;
  hasProjectile(): boolean;
  projectileOrigin(): { readonly x: number; readonly y: number } | null;
  projectilePosition(): { readonly x: number; readonly y: number } | null;
  activeStatusTreatment(): MobStatusTreatment;
  selectEnemy(archetypeId: string): void;
  selectSprite(textureKey: string): void;
  setTime(elapsedMs: number): void;
}

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type ProbeWindow = {
  __mobMotionProbe?: MobMotionProbe;
};
type ReadyProbeWindow = {
  __uiProbe?: { ready(): boolean };
};

const PANELS: readonly {
  state: MobMotionState;
  title: string;
  subtitle: string;
  accent: string;
}[] = [
  {
    state: 'spawn',
    title: 'SPAWN',
    subtitle: 'pop · wiggle · settle',
    accent: '#a78bfa',
  },
  {
    state: 'movement',
    title: 'MOVEMENT',
    subtitle: 'family locomotion',
    accent: '#38bdf8',
  },
  {
    state: 'attack',
    title: 'ATTACK',
    subtitle: 'anticipation · release',
    accent: '#f59e0b',
  },
  {
    state: 'hit',
    title: 'HIT REACTION',
    subtitle: 'recoil · shake · flash',
    accent: '#ef4444',
  },
  {
    state: 'death',
    title: 'DEATH / CORPSE',
    subtitle: 'impact · skull · 3s decay',
    accent: '#94a3b8',
  },
  {
    state: 'status',
    title: 'STATUS',
    subtitle: 'freeze · burn · stun',
    accent: '#34d399',
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

function treatmentFilter(treatment: MobStatusTreatment | null): string {
  if (treatment === 'freeze') return 'brightness(1.35) saturate(0.55) hue-rotate(150deg)';
  if (treatment === 'burn') return 'brightness(1.45) sepia(1) saturate(3.2) hue-rotate(330deg)';
  if (treatment === 'stun') return 'brightness(1.35) sepia(0.8) saturate(2)';
  return 'none';
}

function spriteFilter(treatment: MobStatusTreatment | null, corpseDesaturation: number): string {
  if (corpseDesaturation > 0) {
    const amount = Math.max(0, Math.min(1, corpseDesaturation));
    return `grayscale(${amount}) brightness(${1 - amount * 0.28})`;
  }
  return treatmentFilter(treatment);
}

function anchoredSpritePivot(
  image: HTMLImageElement,
  sprite: MobSpriteOption,
  transform: MobMotionTransform,
  holdX: number,
  holdY: number,
  displayScale: number,
): { readonly x: number; readonly y: number } {
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
  return {
    x: holdX + transform.offsetX * displayScale - transformedAnchorX,
    y: holdY + transform.offsetY * displayScale - transformedAnchorY,
  };
}

function drawAnchoredSprite(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sprite: MobSpriteOption,
  transform: MobMotionTransform,
  holdX: number,
  holdY: number,
  displayScale: number,
  treatment: MobStatusTreatment | null,
  corpseDesaturation = 0,
): void {
  const center = resolveAnchor(sprite.centerOfGravity, image, {
    x: image.width / 2,
    y: image.height / 2,
  });
  const scaleX = displayScale * transform.scaleX;
  const scaleY = displayScale * transform.scaleY;
  const pivot = anchoredSpritePivot(image, sprite, transform, holdX, holdY, displayScale);

  const draw = (): void => {
    ctx.save();
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(transform.rotation);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(image, -center.x, -center.y);
    ctx.restore();
  };

  ctx.globalAlpha = transform.alpha;
  ctx.filter = spriteFilter(treatment, corpseDesaturation);
  draw();
  ctx.filter = 'none';
  if (transform.flash > 0) {
    ctx.globalAlpha = transform.flash * 0.8;
    ctx.filter = 'brightness(3) saturate(0)';
    draw();
    ctx.filter = 'none';
  }
  ctx.globalAlpha = 1;
}

function drawBloodPool(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  progress: number,
): void {
  const scale = 0.25 + progress * 0.75;
  ctx.save();
  ctx.translate(x, y + 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = 'rgba(92, 8, 19, 0.72)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 42, 9, 0, 0, Math.PI * 2);
  ctx.ellipse(-25, -1, 18, 6, -0.15, 0, Math.PI * 2);
  ctx.ellipse(24, 1, 15, 5, 0.2, 0, Math.PI * 2);
  ctx.ellipse(7, -5, 19, 6, -0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDeathPop(ctx: CanvasRenderingContext2D, x: number, y: number, progress: number): void {
  if (progress >= 1) return;
  const life = 1 - progress;
  ctx.save();
  ctx.globalAlpha = life;
  ctx.strokeStyle = '#b91c1c';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 9 + progress * 28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 5 + progress * 17, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#dc2626';
  for (let index = 0; index < 8; index++) {
    const angle = (index / 8) * Math.PI * 2;
    const distance = 8 + progress * (22 + (index % 3) * 4);
    const size = 2 + (index % 2);
    ctx.fillRect(
      x + Math.cos(angle) * distance - size / 2,
      y + Math.sin(angle) * distance - size / 2,
      size,
      size,
    );
  }
  ctx.restore();
}

function drawDeathSkull(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number): void {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.translate(Math.round(x) - 8, Math.round(y) - 8);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.arc(8, 7, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(4, 9, 8, 5);
  ctx.fillRect(6, 14, 1, 2);
  ctx.fillRect(8, 14, 1, 2);
  ctx.fillRect(10, 14, 1, 2);
  ctx.fillStyle = '#0b1020';
  ctx.beginPath();
  ctx.arc(6, 6, 1, 0, Math.PI * 2);
  ctx.arc(10, 6, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(7, 9, 2, 1);
  ctx.restore();
}

function drawProjectileFrame(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  frame: ProjectileFrameSpec,
  x: number,
  y: number,
): void {
  const width = frame.frameWidth * frame.displayScale;
  const height = frame.frameHeight * frame.displayScale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 2);
  ctx.shadowColor = '#fb923c';
  ctx.shadowBlur = 9;
  ctx.drawImage(
    image,
    frame.sourceX,
    frame.sourceY,
    frame.frameWidth,
    frame.frameHeight,
    -width / 2,
    -height / 2,
    width,
    height,
  );
  ctx.restore();
}

function drawAttackTelegraph(
  ctx: CanvasRenderingContext2D,
  startX: number,
  endX: number,
  y: number,
  pulse: number,
): void {
  ctx.save();
  ctx.strokeStyle = `rgba(251, 146, 60, ${pulse})`;
  ctx.fillStyle = `rgba(251, 146, 60, ${Math.min(1, pulse + 0.15)})`;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(startX, y);
  ctx.lineTo(endX, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(startX, y, 4 + pulse * 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function panelSubtitle(
  state: MobMotionState,
  fallback: string,
  spec: MobPreviewSpec | undefined,
): string {
  if (!spec) return fallback;
  if (state === 'movement') return `${spec.movementStyle} locomotion`;
  if (state === 'attack') {
    return spec.hasProjectile ? `${spec.telegraphMs}ms aim lock` : 'anticipate · lunge';
  }
  return fallback;
}

function panelFooter(
  state: MobMotionState,
  spec: MobPreviewSpec | undefined,
  elapsedMs: number,
): string {
  if (!spec) return '';
  if (state === 'movement') return `${spec.movementStyle.toUpperCase()} FAMILY`;
  if (state === 'attack') {
    return spec.hasProjectile ? 'RANGED · PROJECTILE' : 'MELEE · CONTACT';
  }
  if (state === 'status') return `${sampleStatusTreatment(elapsedMs).toUpperCase()} CONCEPT`;
  if (state === 'death') return 'RUNTIME DEATH LINGER';
  return '';
}

function createMobMotionLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const saved = loadLabState<Partial<MobMotionSettings>>(LAB_ID) ?? {};
  const settings: MobMotionSettings = {
    archetypeId: '',
    spriteKey: '',
    speed: 1,
    intensity: 1,
    scale: 1.9,
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
  status.textContent = 'Loading enemy previews…';
  root.appendChild(status);

  const canvasScroller = document.createElement('div');
  canvasScroller.style.cssText =
    'display:flex;justify-content:center;width:100%;overflow:hidden;padding-bottom:4px;';
  root.appendChild(canvasScroller);

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  canvas.style.cssText =
    'display:block;box-sizing:content-box;width:min(960px,calc(100% - 2px));' +
    'height:auto;image-rendering:pixelated;' +
    'border:1px solid #334155;border-radius:8px;background:#080b12;';
  canvasScroller.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable.');
  ctx.imageSmoothingEnabled = false;

  const projectileFrame = resolveEnemyProjectileFrame();
  const projectileImage = new Image();
  let projectileReady = false;
  let projectileError: string | null = null;
  let manifestError: string | null = null;
  let mobImageError: string | null = null;
  let sprites: readonly MobSpriteOption[] = [];
  let previewSpecs: readonly MobPreviewSpec[] = [];
  let selectedSpec: MobPreviewSpec | undefined;
  let selected: MobSpriteOption | undefined;
  let image: HTMLImageElement | undefined;
  let imageReady = false;
  let manifestReady = false;
  let animationFrame = 0;
  let renderedElapsedMs = settings.previewTimeMs;
  let renderedProjectileOrigin: { readonly x: number; readonly y: number } | null = null;
  let renderedProjectilePosition: { readonly x: number; readonly y: number } | null = null;
  let variantController: Controller | undefined;

  const isReady = (): boolean =>
    manifestReady && imageReady && projectileReady && !manifestError && !mobImageError;

  const refreshStatus = (): void => {
    if (manifestError) {
      status.textContent = `Mob manifest error: ${manifestError}`;
      return;
    }
    if (projectileError) {
      status.textContent = `Projectile asset error: ${projectileError}`;
      return;
    }
    if (!manifestReady || !selectedSpec || !selected) {
      status.textContent = 'Loading enemy previews…';
      return;
    }
    if (mobImageError) {
      status.textContent = `Mob asset error: ${mobImageError}`;
      return;
    }
    if (!imageReady || !image) {
      status.textContent = `Loading ${selected.assetPath}…`;
      return;
    }
    if (!projectileReady) {
      status.textContent = `Loading runtime projectile ${projectileFrame.spriteId}…`;
      return;
    }

    const attackLabel = selectedSpec.hasProjectile
      ? `ranged · ${projectileFrame.spriteId}`
      : `${selectedSpec.aiType} · no projectile`;
    status.textContent =
      `${selectedSpec.label} · ${selected.label} · ${image.width}×${image.height}px · ` +
      `${selectedSpec.movementStyle} · ${attackLabel} · ` +
      `${selected.anchor ? 'manifest anchor' : 'bottom-center fallback'}`;
  };

  projectileImage.addEventListener('load', () => {
    projectileReady = true;
    projectileError = null;
    refreshStatus();
  });
  projectileImage.addEventListener('error', () => {
    projectileReady = false;
    projectileError = `Could not load ${projectileFrame.sheetPath}`;
    refreshStatus();
  });
  projectileImage.src = projectileFrame.sheetPath;

  const render = (rafTimeMs: number): void => {
    ctx.fillStyle = '#080b12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    renderedElapsedMs = settings.paused ? settings.previewTimeMs : rafTimeMs * settings.speed;
    const attackPreview = selectedSpec
      ? sampleAttackPreview(renderedElapsedMs, selectedSpec.hasProjectile, selectedSpec.telegraphMs)
      : null;
    const deathPreview = sampleDeathPreview(renderedElapsedMs);
    renderedProjectileOrigin = null;
    renderedProjectilePosition = null;

    for (let index = 0; index < PANELS.length; index++) {
      const panel = PANELS[index]!;
      const column = index % PANEL_COLUMNS;
      const row = Math.floor(index / PANEL_COLUMNS);
      const x = OUTER_X + column * (PANEL_WIDTH + PANEL_COLUMN_GAP);
      const y = OUTER_Y + row * (PANEL_HEIGHT + PANEL_ROW_GAP);
      const baselineY = y + 228;
      const centerX = x + PANEL_WIDTH / 2;
      ctx.fillStyle = '#111827';
      ctx.fillRect(x, y, PANEL_WIDTH, PANEL_HEIGHT);
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#64748b';
      for (let stripeY = y + 108; stripeY < y + PANEL_HEIGHT - 8; stripeY += 18) {
        ctx.fillRect(x + 6, stripeY, PANEL_WIDTH - 12, 1);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0c1322';
      ctx.fillRect(x + 2, y + 2, PANEL_WIDTH - 4, 114);
      ctx.strokeStyle = panel.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, PANEL_WIDTH - 2, PANEL_HEIGHT - 2);
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 5, y + 5, PANEL_WIDTH - 10, PANEL_HEIGHT - 10);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x + 14, y + 116);
      ctx.lineTo(x + PANEL_WIDTH - 14, y + 116);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = panel.accent;
      ctx.font = '12px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(panel.title, centerX, y + 32);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '10px "Press Start 2P", monospace';
      ctx.fillText(panelSubtitle(panel.state, panel.subtitle, selectedSpec), centerX, y + 62);

      const footer = panelFooter(panel.state, selectedSpec, renderedElapsedMs);
      if (footer) {
        ctx.fillStyle = panel.accent;
        ctx.globalAlpha = 0.92;
        ctx.font = '10px "Press Start 2P", monospace';
        ctx.fillText(footer, centerX, y + 92);
        ctx.globalAlpha = 1;
      }

      if (panel.state === 'death') {
        drawBloodPool(ctx, centerX, baselineY, deathPreview.bloodPoolProgress);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.beginPath();
        ctx.ellipse(centerX, baselineY + 3, 45, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (imageReady && image && selected && selectedSpec) {
        const motionOptions = {
          intensity: settings.intensity,
          movementStyle: selectedSpec.movementStyle,
          attack: {
            hasProjectile: selectedSpec.hasProjectile,
            telegraphMs: selectedSpec.telegraphMs,
          },
        } as const;
        const transform = sampleMobMotion(panel.state, renderedElapsedMs, motionOptions);
        const attackOrigin =
          panel.state === 'attack' && attackPreview && selectedSpec.hasProjectile
            ? anchoredSpritePivot(
                image,
                selected,
                sampleMobMotion('attack', renderedElapsedMs - attackPreview.phaseMs, motionOptions),
                centerX,
                baselineY,
                settings.scale,
              )
            : null;
        if (attackOrigin) {
          renderedProjectileOrigin = attackOrigin;
        }
        if (attackOrigin && attackPreview?.telegraphActive) {
          drawAttackTelegraph(
            ctx,
            attackOrigin.x,
            x + PANEL_WIDTH - 26,
            attackOrigin.y,
            attackPreview.telegraphPulse,
          );
        }
        const treatment =
          panel.state === 'status' ? sampleStatusTreatment(renderedElapsedMs) : null;
        const corpseDesaturation = panel.state === 'death' ? deathPreview.corpse.desaturation : 0;
        drawAnchoredSprite(
          ctx,
          image,
          selected,
          transform,
          centerX,
          baselineY,
          settings.scale,
          treatment,
          corpseDesaturation,
        );

        if (panel.state === 'death') {
          const pivot = anchoredSpritePivot(
            image,
            selected,
            transform,
            centerX,
            baselineY,
            settings.scale,
          );
          drawDeathPop(ctx, pivot.x, pivot.y, deathPreview.deathPopProgress);
          drawDeathSkull(
            ctx,
            pivot.x,
            pivot.y - 18 - deathPreview.corpse.skullRisePx,
            deathPreview.corpse.skullAlpha,
          );
        }

        if (
          panel.state === 'attack' &&
          attackOrigin &&
          attackPreview?.projectileVisible &&
          projectileReady
        ) {
          const endX = x + PANEL_WIDTH - 28;
          const projectileX =
            attackOrigin.x + (endX - attackOrigin.x) * attackPreview.projectileProgress;
          renderedProjectilePosition = { x: projectileX, y: attackOrigin.y };
          drawProjectileFrame(ctx, projectileImage, projectileFrame, projectileX, attackOrigin.y);
        }
      } else {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px monospace';
        ctx.fillText('loading sprite…', centerX, y + 160);
      }
    }

    ctx.textAlign = 'left';
    animationFrame = requestAnimationFrame(render);
  };

  const identityFolder = gui.addFolder('Enemy');

  const variantsForSelectedEnemy = (): readonly MobSpriteOption[] =>
    selectedSpec ? sprites.filter((sprite) => sprite.briefId === selectedSpec!.briefId) : [];

  const loadSelectedSprite = (): void => {
    if (!selectedSpec) {
      mobImageError = 'No enemy archetype is selected.';
      imageReady = false;
      refreshStatus();
      return;
    }
    const variants = variantsForSelectedEnemy();
    selected = variants.find((sprite) => sprite.textureKey === settings.spriteKey);
    if (!selected) {
      mobImageError = `No ${selectedSpec.briefId} variant matches ${settings.spriteKey}.`;
      imageReady = false;
      refreshStatus();
      return;
    }

    const requestedSpec = selectedSpec;
    const requestedSprite = selected;
    const requestedImage = new Image();
    imageReady = false;
    mobImageError = null;
    image = requestedImage;
    refreshStatus();
    requestedImage.addEventListener('load', () => {
      if (
        image !== requestedImage ||
        selected !== requestedSprite ||
        selectedSpec !== requestedSpec
      ) {
        return;
      }
      imageReady = true;
      mobImageError = null;
      refreshStatus();
    });
    requestedImage.addEventListener('error', () => {
      if (
        image !== requestedImage ||
        selected !== requestedSprite ||
        selectedSpec !== requestedSpec
      ) {
        return;
      }
      imageReady = false;
      mobImageError = `Could not load ${requestedSprite.assetPath}`;
      refreshStatus();
    });
    requestedImage.src = imageUrl(requestedSprite.assetPath);
    saveLabState(LAB_ID, settings);
  };

  const rebuildVariantController = (): void => {
    const variants = variantsForSelectedEnemy();
    if (variants.length === 0) {
      mobImageError = `No approved art variants exist for ${selectedSpec?.briefId ?? 'selection'}.`;
      imageReady = false;
      refreshStatus();
      return;
    }
    if (!variants.some((sprite) => sprite.textureKey === settings.spriteKey)) {
      settings.spriteKey = variants[0]!.textureKey;
    }

    variantController?.destroy();
    const choices = Object.fromEntries(
      variants.map((sprite) => [`Variant ${sprite.variantIndex}`, sprite.textureKey]),
    );
    variantController = identityFolder
      .add(settings, 'spriteKey', choices)
      .name('Art variant')
      .onChange(() => loadSelectedSprite());
  };

  const selectArchetype = (archetypeId: string): void => {
    const nextSpec = previewSpecs.find((spec) => spec.archetypeId === archetypeId);
    if (!nextSpec) {
      manifestError = `Unknown enemy archetype: ${archetypeId}`;
      imageReady = false;
      refreshStatus();
      return;
    }

    selectedSpec = nextSpec;
    settings.archetypeId = nextSpec.archetypeId;
    manifestError = null;
    rebuildVariantController();
    loadSelectedSprite();
    gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
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
    .add(settings, 'previewTimeMs', 0, 3_600, 5)
    .name('Scrub time (ms)')
    .onChange(() => saveLabState(LAB_ID, settings));
  identityFolder.open();
  playbackFolder.open();

  const probeWindow = window as unknown as ProbeWindow;
  const readyProbeWindow = window as unknown as ReadyProbeWindow;
  const readyAlias = { ready: isReady };
  const probe: MobMotionProbe = {
    ready: isReady,
    selectedEnemy: () => settings.archetypeId,
    selectedSprite: () => settings.spriteKey,
    panelStates: () => PANELS.map((panel) => panel.state),
    movementStyle: () => selectedSpec?.movementStyle ?? 'stride',
    hasProjectile: () => selectedSpec?.hasProjectile ?? false,
    projectileOrigin: () => (renderedProjectileOrigin ? { ...renderedProjectileOrigin } : null),
    projectilePosition: () =>
      renderedProjectilePosition ? { ...renderedProjectilePosition } : null,
    activeStatusTreatment: () => sampleStatusTreatment(renderedElapsedMs),
    selectEnemy: (archetypeId) => {
      if (!previewSpecs.some((spec) => spec.archetypeId === archetypeId)) {
        throw new Error(`Unknown enemy archetype: ${archetypeId}`);
      }
      selectArchetype(archetypeId);
    },
    selectSprite: (textureKey) => {
      if (!variantsForSelectedEnemy().some((sprite) => sprite.textureKey === textureKey)) {
        throw new Error(`Sprite ${textureKey} is not available for ${settings.archetypeId}.`);
      }
      settings.spriteKey = textureKey;
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
      loadSelectedSprite();
    },
    setTime: (elapsedMs) => {
      settings.paused = true;
      settings.previewTimeMs = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
      renderedElapsedMs = settings.previewTimeMs;
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
    },
  };
  probeWindow.__mobMotionProbe = probe;
  readyProbeWindow.__uiProbe = readyAlias;

  void fetch(DEFAULT_MANIFEST_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Manifest request returned ${response.status}`);
      sprites = selectMobSprites(await response.json());
      if (sprites.length === 0) throw new Error('No approved mob sprites found.');

      previewSpecs = availableMobPreviewSpecs(sprites);
      if (previewSpecs.length === 0) {
        throw new Error('No runtime enemy archetypes have approved mob sprites.');
      }
      manifestReady = true;
      manifestError = null;
      if (!previewSpecs.some((spec) => spec.archetypeId === settings.archetypeId)) {
        settings.archetypeId = previewSpecs[0]!.archetypeId;
      }

      const enemyChoices = Object.fromEntries(
        previewSpecs.map((spec) => [spec.label, spec.archetypeId]),
      );
      identityFolder
        .add(settings, 'archetypeId', enemyChoices)
        .name('Enemy archetype')
        .onChange(() => selectArchetype(settings.archetypeId));
      selectArchetype(settings.archetypeId);
    })
    .catch((error: unknown) => {
      manifestReady = false;
      manifestError = error instanceof Error ? error.message : String(error);
      refreshStatus();
    });

  animationFrame = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(animationFrame);
    if (probeWindow.__mobMotionProbe === probe) delete probeWindow.__mobMotionProbe;
    if (readyProbeWindow.__uiProbe === readyAlias) delete readyProbeWindow.__uiProbe;
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta',
  name: 'Mob Motion Lab',
  description:
    'Compare six deterministic motion treatments on runtime enemy archetypes and approved art.',
  create: createMobMotionLab,
});
