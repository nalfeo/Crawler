import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';
import { GAME } from '../../shared/constants.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface DeathTimerEntity {
  id: number;
  x: number;
  y: number;
  remainingMs: number;
  totalMs: number;
}

interface DeathTimerLabSettings {
  timerMs: number;
  spawnCount: number;
}

const BACKGROUND = '#0d0d14';
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
    'Simulates the death timer countdown. Entities fade out and are removed when their timer expires.';
  hint.style.marginTop = '16px';
  hint.style.color = '#9fe7ff';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for deathtimer lab.');
  }

  const settings: DeathTimerLabSettings = {
    timerMs: 1000,
    spawnCount: 5,
  };

  const entities: DeathTimerEntity[] = [];
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

  const spawnEntities = () => {
    const padding = ENTITY_RADIUS + 40;
    const usableWidth = Math.max(1, width - padding * 2);
    const usableHeight = Math.max(1, height - padding * 2);

    for (let i = 0; i < settings.spawnCount; i++) {
      const cols = Math.ceil(Math.sqrt(settings.spawnCount));
      const row = Math.floor(i / cols);
      const col = i % cols;
      const rows = Math.ceil(settings.spawnCount / cols);

      entities.push({
        id: nextId++,
        x: padding + (col / Math.max(1, cols - 1)) * usableWidth,
        y: padding + (row / Math.max(1, rows - 1)) * usableHeight,
        remainingMs: settings.timerMs,
        totalMs: settings.timerMs,
      });
    }
  };

  const update = (deltaMs: number) => {
    for (let i = entities.length - 1; i >= 0; i--) {
      const entity = entities[i];
      if (!entity) continue;

      entity.remainingMs -= deltaMs;
      if (entity.remainingMs <= 0) {
        entities.splice(i, 1);
      }
    }
  };

  const render = () => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    context.fillStyle = '#22d3ee';
    context.font = '14px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText(
      `Dying entities: ${entities.length} | Timer: ${settings.timerMs}ms | Δt: ${GAME.DELTA_MS}ms`,
      16,
      16,
    );

    for (const entity of entities) {
      const progress = clamp(entity.remainingMs / entity.totalMs, 0, 1);
      const alpha = progress;

      // Skull-like marker for dying entity
      context.globalAlpha = alpha;
      context.beginPath();
      context.fillStyle = '#ff4444';
      context.arc(entity.x, entity.y, ENTITY_RADIUS, 0, Math.PI * 2);
      context.fill();

      // Countdown ring
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + progress * Math.PI * 2;
      context.beginPath();
      context.strokeStyle = '#ffffff';
      context.lineWidth = 3;
      context.arc(entity.x, entity.y, ENTITY_RADIUS + 4, startAngle, endAngle);
      context.stroke();

      // Timer text
      context.fillStyle = '#ffffff';
      context.font = '10px monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(`${Math.max(0, Math.ceil(entity.remainingMs))}`, entity.x, entity.y);

      context.globalAlpha = 1;
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
    spawnWave: () => spawnEntities(),
    clearAll: () => {
      entities.length = 0;
    },
  };

  gui.add(settings, 'timerMs', 100, 5000, 50).name('Timer (ms)');
  gui.add(settings, 'spawnCount', 1, 20, 1).name('Spawn count');
  gui.add(actions, 'spawnWave').name('Spawn Wave');
  gui.add(actions, 'clearAll').name('Clear All');

  const handleResize = () => syncCanvasSize();
  window.addEventListener('resize', handleResize);

  syncCanvasSize();
  spawnEntities();
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
  description: 'Visualize the death timer countdown — entities fade and are removed on expiry.',
  create: createDeathTimerLab,
});
