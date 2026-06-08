import type GUI from 'lil-gui';
import { SeededRandom } from '../../shared/random.js';
import { registerLab, type LabCategory } from '../registry.js';
import { GAME } from '../../shared/constants.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type DeathTimerEntity = {
  id: number;
  x: number;
  y: number;
  remainingMs: number;
  totalMs: number;
};

interface DeathTimerLabSettings {
  deathTimerMs: number;
  spawnCount: number;
  paused: boolean;
}

const BACKGROUND = '#0d0d14';
const HUD_PADDING = 20;
const ENTITY_RADIUS = 14;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createDeathTimerLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = BACKGROUND;

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  root.append(canvas);
  canvasHost.append(root);

  const hint = document.createElement('p');
  hint.textContent =
    'Simulates DeathTimer countdown. Entities fade and shrink as their timer expires, then get removed.';
  hint.style.marginTop = '16px';
  hint.style.color = '#ff9e9e';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for death-timer lab.');
  }

  const random = new SeededRandom(0xdead_2026);
  const settings: DeathTimerLabSettings = {
    deathTimerMs: GAME.DELTA_MS * 30,
    spawnCount: 5,
    paused: false,
  };

  const entities: DeathTimerEntity[] = [];
  let removedCount = 0;
  let nextId = 1;
  let frameHandle = 0;
  let lastFrameTimeMs = performance.now();
  let width = 1;
  let height = 1;

  const syncCanvasSize = () => {
    const nextWidth = Math.max(1, Math.floor(root.clientWidth));
    const nextHeight = Math.max(1, Math.floor(root.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.floor(nextWidth * dpr));
    const pixelHeight = Math.max(1, Math.floor(nextHeight * dpr));

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    width = nextWidth;
    height = nextHeight;
  };

  const spawnBatch = () => {
    const margin = ENTITY_RADIUS + 40;
    for (let i = 0; i < settings.spawnCount; i += 1) {
      entities.push({
        id: nextId,
        x: margin + random.next() * Math.max(1, width - margin * 2),
        y: margin + random.next() * Math.max(1, height - margin * 2),
        remainingMs: settings.deathTimerMs,
        totalMs: settings.deathTimerMs,
      });
      nextId += 1;
    }
  };

  const clearAll = () => {
    entities.length = 0;
    removedCount = 0;
    nextId = 1;
  };

  const update = (deltaMs: number) => {
    if (settings.paused) return;

    for (let i = entities.length - 1; i >= 0; i -= 1) {
      const entity = entities[i];
      if (!entity) continue;

      entity.remainingMs -= deltaMs;
      if (entity.remainingMs <= 0) {
        entities.splice(i, 1);
        removedCount += 1;
      }
    }
  };

  const render = () => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    for (const entity of entities) {
      const progress = clamp(1 - entity.remainingMs / entity.totalMs, 0, 1);
      const alpha = 1 - progress;
      const scale = 1 - progress * 0.6;
      const radius = ENTITY_RADIUS * scale;

      // Fade to red as timer expires
      const r = Math.round(255);
      const g = Math.round(255 * (1 - progress));
      const b = Math.round(255 * (1 - progress));

      context.globalAlpha = alpha;
      context.beginPath();
      context.fillStyle = `rgb(${r}, ${g}, ${b})`;
      context.arc(entity.x, entity.y, radius, 0, Math.PI * 2);
      context.fill();

      // Timer ring
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + (1 - progress) * Math.PI * 2;
      context.strokeStyle = `rgba(255, 100, 100, ${alpha})`;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(entity.x, entity.y, radius + 5, startAngle, endAngle);
      context.stroke();

      context.globalAlpha = 1;
    }

    // HUD
    context.fillStyle = '#ff6b6b';
    context.font = '16px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText(
      `Dying: ${entities.length} | Removed: ${removedCount}`,
      HUD_PADDING,
      HUD_PADDING,
    );

    if (settings.paused) {
      context.fillStyle = 'rgba(255, 230, 140, 0.95)';
      context.fillText('PAUSED', HUD_PADDING, HUD_PADDING + 22);
    }
  };

  const tick = (now: number) => {
    syncCanvasSize();
    const deltaMs = Math.min(now - lastFrameTimeMs, 50);
    lastFrameTimeMs = now;

    update(deltaMs);
    render();

    frameHandle = window.requestAnimationFrame(tick);
  };

  const actions = {
    spawnBatch,
    clearAll,
  };

  gui.add(settings, 'deathTimerMs', 100, 3000, 50).name('Timer (ms)');
  gui.add(settings, 'spawnCount', 1, 20, 1).name('Spawn count');
  gui.add(settings, 'paused').name('Paused');
  gui.add(actions, 'spawnBatch').name('Kill Batch');
  gui.add(actions, 'clearAll').name('Clear All');

  const handleResize = () => syncCanvasSize();
  window.addEventListener('resize', handleResize);

  syncCanvasSize();
  spawnBatch();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    window.removeEventListener('resize', handleResize);
    hint.remove();
    root.remove();
  };
}

registerLab('deathtimer-lab', {
  category: 'Entities' as LabCategory,
  name: 'Death Timer',
  description: 'Visualize post-death countdown before entity removal (fade + shrink animation).',
  create: createDeathTimerLab,
});
