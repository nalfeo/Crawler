import type GUI from 'lil-gui';
import { SeededRandom } from '../../shared/random.js';
import { GAME } from '../../shared/constants.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface DeathTimerEntity {
  id: number;
  x: number;
  y: number;
  remainingMs: number;
  totalMs: number;
}

interface DeathTimerLabSettings {
  deathTimerMs: number;
  spawnCount: number;
  paused: boolean;
}

const BACKGROUND = '#0d0d14';
const ENTITY_RADIUS = 14;
const LAB_SEED = 0xdead_7174;

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
    'Spawn dying entities and watch them count down to removal. Visualizes the deathTimerSystem delay mechanic.';
  hint.style.marginTop = '16px';
  hint.style.color = '#9fe7ff';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for death timer lab.');
  }

  const random = new SeededRandom(LAB_SEED);
  const settings: DeathTimerLabSettings = {
    deathTimerMs: GAME.DELTA_MS * 60,
    spawnCount: 5,
    paused: false,
  };

  const entities: DeathTimerEntity[] = [];
  let nextId = 1;
  let removedCount = 0;
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
    for (let i = 0; i < settings.spawnCount; i++) {
      entities.push({
        id: nextId++,
        x: 40 + random.next() * (width - 80),
        y: 60 + random.next() * (height - 120),
        remainingMs: settings.deathTimerMs,
        totalMs: settings.deathTimerMs,
      });
    }
  };

  const clearAll = () => {
    entities.length = 0;
    removedCount = 0;
    nextId = 1;
  };

  const tick = (now: number) => {
    syncCanvasSize();
    const deltaMs = Math.min(now - lastFrameTimeMs, 50);
    lastFrameTimeMs = now;

    if (!settings.paused) {
      for (let i = entities.length - 1; i >= 0; i--) {
        const entity = entities[i]!;
        entity.remainingMs -= deltaMs;
        if (entity.remainingMs <= 0) {
          entities.splice(i, 1);
          removedCount++;
        }
      }
    }

    // Render
    context.clearRect(0, 0, width, height);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    // HUD
    context.fillStyle = '#22d3ee';
    context.font = '16px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText(`Dying: ${entities.length} | Removed: ${removedCount}`, 20, 20);

    if (settings.paused) {
      context.fillStyle = 'rgba(255, 230, 140, 0.95)';
      context.fillText('PAUSED', 20, 42);
    }

    // Draw entities
    for (const entity of entities) {
      const ratio = clamp(entity.remainingMs / entity.totalMs, 0, 1);
      const alpha = 0.3 + ratio * 0.7;

      // Skull/death circle
      context.globalAlpha = alpha;
      context.beginPath();
      context.fillStyle = '#ff4444';
      context.arc(entity.x, entity.y, ENTITY_RADIUS * ratio, 0, Math.PI * 2);
      context.fill();

      // Ring showing countdown
      context.strokeStyle = `rgba(255, 80, 80, ${alpha})`;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(
        entity.x,
        entity.y,
        ENTITY_RADIUS + 4,
        -Math.PI / 2,
        -Math.PI / 2 + ratio * Math.PI * 2,
      );
      context.stroke();

      context.globalAlpha = 1;

      // Timer text
      context.fillStyle = '#ffffff';
      context.font = '10px monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(`${Math.ceil(entity.remainingMs)}`, entity.x, entity.y);
    }

    frameHandle = window.requestAnimationFrame(tick);
  };

  const actions = {
    spawnDying: spawnBatch,
    clearAll,
  };

  gui.add(settings, 'deathTimerMs', 100, 5000, 50).name('Timer (ms)');
  gui.add(settings, 'spawnCount', 1, 20, 1).name('Spawn count');
  gui.add(settings, 'paused').name('Paused');
  gui.add(actions, 'spawnDying').name('Spawn Dying');
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
  description: 'Visualize the death-timer countdown that delays entity removal after death.',
  create: createDeathTimerLab,
});
