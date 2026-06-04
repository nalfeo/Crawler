import type GUI from 'lil-gui';
import { SeededRandom } from '../../shared/random.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type ProjectileState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  culled: boolean;
  cullFrame: number;
};

type Viewport = {
  scale: number;
  outerLeft: number;
  outerTop: number;
  outerWidth: number;
  outerHeight: number;
  gameLeft: number;
  gameTop: number;
  gameWidth: number;
  gameHeight: number;
};

interface ProjectileCleanupSettings {
  projectileSpeed: number;
  autoFire: boolean;
  autoFireRate: number;
  cullMargin: number;
  showBounds: boolean;
}

const GAME_WIDTH = 1024;
const GAME_HEIGHT = 768;
const LOGICAL_WIDTH = 640;
const LOGICAL_HEIGHT = 480;
const FRAME_MS = 1000 / 60;
const PROJECTILE_RADIUS = 4;
const FLASH_FRAMES = 10;
const FIRE_ORIGIN = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
const BACKGROUND = '#0d0d14';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createProjectileCleanupLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.boxSizing = 'border-box';
  root.style.background = BACKGROUND;

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${LOGICAL_WIDTH}px`;
  canvas.style.aspectRatio = `${LOGICAL_WIDTH} / ${LOGICAL_HEIGHT}`;
  canvas.style.background = BACKGROUND;
  canvas.style.cursor = 'crosshair';
  root.append(canvas);
  canvasHost.append(root);

  const hint = document.createElement('p');
  hint.textContent =
    'Click inside the white game bounds to fire from center. Red rings show projectiles culled beyond the dashed boundary.';
  hint.style.cssText = 'margin-top:16px;color:#9fe7ff;line-height:1.6;font-family:monospace;';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for projectile cleanup lab.');
  }

  const random = new SeededRandom(0x20c1_2026);
  const settings: ProjectileCleanupSettings = {
    projectileSpeed: 6,
    autoFire: true,
    autoFireRate: 5,
    cullMargin: 100,
    showBounds: true,
  };

  const projectiles: ProjectileState[] = [];
  let totalCulled = 0;
  let autoFireBudget = 0;
  let frameHandle = 0;
  let lastFrameTimeMs = performance.now();

  const syncCanvasSize = () => {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.floor(LOGICAL_WIDTH * dpr);
    const pixelHeight = Math.floor(LOGICAL_HEIGHT * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };

  const getViewport = (): Viewport => {
    const fullWidth = GAME_WIDTH + settings.cullMargin * 2;
    const fullHeight = GAME_HEIGHT + settings.cullMargin * 2;
    const scale = Math.min(LOGICAL_WIDTH / fullWidth, LOGICAL_HEIGHT / fullHeight);
    const outerWidth = fullWidth * scale;
    const outerHeight = fullHeight * scale;
    const outerLeft = (LOGICAL_WIDTH - outerWidth) / 2;
    const outerTop = (LOGICAL_HEIGHT - outerHeight) / 2;

    return {
      scale,
      outerLeft,
      outerTop,
      outerWidth,
      outerHeight,
      gameLeft: outerLeft + settings.cullMargin * scale,
      gameTop: outerTop + settings.cullMargin * scale,
      gameWidth: GAME_WIDTH * scale,
      gameHeight: GAME_HEIGHT * scale,
    };
  };

  const getCullBounds = () => ({
    minX: -settings.cullMargin,
    maxX: GAME_WIDTH + settings.cullMargin,
    minY: -settings.cullMargin,
    maxY: GAME_HEIGHT + settings.cullMargin,
  });

  const worldToScreen = (x: number, y: number, viewport: Viewport) => ({
    x: viewport.outerLeft + (x + settings.cullMargin) * viewport.scale,
    y: viewport.outerTop + (y + settings.cullMargin) * viewport.scale,
  });

  const activeProjectileCount = () => projectiles.filter((projectile) => !projectile.culled).length;

  const clearProjectiles = () => {
    projectiles.length = 0;
    totalCulled = 0;
    autoFireBudget = 0;
  };

  const spawnProjectile = (dx: number, dy: number) => {
    const length = Math.hypot(dx, dy);
    if (length <= 0.0001) {
      return;
    }

    const speed = settings.projectileSpeed;
    projectiles.push({
      x: FIRE_ORIGIN.x,
      y: FIRE_ORIGIN.y,
      vx: (dx / length) * speed,
      vy: (dy / length) * speed,
      culled: false,
      cullFrame: 0,
    });
  };

  const spawnToward = (targetX: number, targetY: number) => {
    spawnProjectile(targetX - FIRE_ORIGIN.x, targetY - FIRE_ORIGIN.y);
  };

  const spawnRandomProjectile = () => {
    const angle = random.next() * Math.PI * 2;
    spawnProjectile(Math.cos(angle), Math.sin(angle));
  };

  const updateSimulation = (deltaMs: number) => {
    const deltaFrames = Math.min(deltaMs / FRAME_MS, 3);

    if (settings.autoFire) {
      autoFireBudget += (deltaMs / 1000) * settings.autoFireRate;
      while (autoFireBudget >= 1) {
        spawnRandomProjectile();
        autoFireBudget -= 1;
      }
    } else {
      autoFireBudget = 0;
    }

    const bounds = getCullBounds();
    for (const projectile of projectiles) {
      if (projectile.culled) {
        projectile.cullFrame += deltaFrames;
        continue;
      }

      projectile.x += projectile.vx * deltaFrames;
      projectile.y += projectile.vy * deltaFrames;

      if (
        projectile.x < bounds.minX ||
        projectile.x > bounds.maxX ||
        projectile.y < bounds.minY ||
        projectile.y > bounds.maxY
      ) {
        projectile.culled = true;
        projectile.cullFrame = 0;
        totalCulled += 1;
      }
    }

    for (let index = projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = projectiles[index];
      if (projectile && projectile.culled && projectile.cullFrame >= FLASH_FRAMES) {
        projectiles.splice(index, 1);
      }
    }
  };

  const drawBounds = (viewport: Viewport) => {
    if (!settings.showBounds) {
      return;
    }

    context.save();
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1;
    context.setLineDash([]);
    context.strokeRect(
      viewport.gameLeft,
      viewport.gameTop,
      viewport.gameWidth,
      viewport.gameHeight,
    );

    context.strokeStyle = '#ff4d4d';
    context.setLineDash([7, 5]);
    context.strokeRect(
      viewport.outerLeft,
      viewport.outerTop,
      viewport.outerWidth,
      viewport.outerHeight,
    );
    context.restore();
  };

  const drawProjectiles = (viewport: Viewport) => {
    for (const projectile of projectiles) {
      const screen = worldToScreen(projectile.x, projectile.y, viewport);

      if (projectile.culled) {
        const progress = clamp(projectile.cullFrame / FLASH_FRAMES, 0, 1);
        const radius = PROJECTILE_RADIUS + 2 + progress * 14;

        context.save();
        context.globalAlpha = 1 - progress;
        context.strokeStyle = '#ff4d4d';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        context.stroke();
        context.restore();
        continue;
      }

      context.save();
      context.fillStyle = '#22d3ee';
      context.shadowColor = 'rgba(34, 211, 238, 0.6)';
      context.shadowBlur = 8;
      context.beginPath();
      context.arc(screen.x, screen.y, PROJECTILE_RADIUS, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  };

  const drawCounter = () => {
    context.fillStyle = '#f4f4f5';
    context.font = '16px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText(`Active: ${activeProjectileCount()} | Culled: ${totalCulled}`, 16, 16);
  };

  const render = () => {
    const viewport = getViewport();

    context.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    drawBounds(viewport);
    drawProjectiles(viewport);
    drawCounter();
  };

  const tick = (now: number) => {
    syncCanvasSize();
    const deltaMs = Math.min(now - lastFrameTimeMs, 50);
    lastFrameTimeMs = now;

    updateSimulation(deltaMs);
    render();
    frameHandle = window.requestAnimationFrame(tick);
  };

  const handleCanvasClick = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const logicalX = ((event.clientX - rect.left) / rect.width) * LOGICAL_WIDTH;
    const logicalY = ((event.clientY - rect.top) / rect.height) * LOGICAL_HEIGHT;
    const viewport = getViewport();
    const insideGameBounds =
      logicalX >= viewport.gameLeft &&
      logicalX <= viewport.gameLeft + viewport.gameWidth &&
      logicalY >= viewport.gameTop &&
      logicalY <= viewport.gameTop + viewport.gameHeight;

    if (!insideGameBounds) {
      return;
    }

    const targetX = (logicalX - viewport.gameLeft) / viewport.scale;
    const targetY = (logicalY - viewport.gameTop) / viewport.scale;
    spawnToward(targetX, targetY);
  };

  const actions = {
    clear: clearProjectiles,
  };

  gui.add(settings, 'projectileSpeed', 2, 20, 1).name('projectileSpeed');
  gui.add(settings, 'autoFire').name('autoFire');
  gui.add(settings, 'autoFireRate', 1, 30, 1).name('autoFireRate');
  gui.add(settings, 'cullMargin', 0, 300, 1).name('cullMargin');
  gui.add(settings, 'showBounds').name('showBounds');
  gui.add(actions, 'clear').name('Clear');

  canvas.addEventListener('click', handleCanvasClick);
  window.addEventListener('resize', syncCanvasSize);

  syncCanvasSize();
  render();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    window.removeEventListener('resize', syncCanvasSize);
    canvas.removeEventListener('click', handleCanvasClick);
    hint.remove();
    root.remove();
  };
}

registerLab('projectilecleanup-lab', {
  category: 'Entities' as LabCategory,
  name: 'Projectile Cleanup Lab',
  description: 'Visualize projectile culling against the game-area cleanup bounds.',
  create: createProjectileCleanupLab,
});
