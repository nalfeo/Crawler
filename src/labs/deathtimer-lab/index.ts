import type GUI from 'lil-gui';
import { SeededRandom } from '../../shared/random.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface DeathTimerEntity {
  id: number;
  x: number;
  y: number;
  totalMs: number;
  remainingMs: number;
}

interface DeathTimerLabSettings {
  timerMs: number;
  spawnRate: number;
  maxEntities: number;
  paused: boolean;
}

const BACKGROUND = '#0d0d14';
const ENTITY_RADIUS = 14;
const FADE_COLOR_START = 'rgba(255, 80, 80, 0.9)';
const FADE_COLOR_END = 'rgba(60, 60, 60, 0.3)';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

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
    'Entities fade and shrink as their death timer counts down. When the timer expires, they are removed with a burst effect.';
  hint.style.marginTop = '16px';
  hint.style.color = '#ff9e9e';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D context for deathtimer lab.');
  }

  const random = new SeededRandom(0xdead_7171);
  const settings: DeathTimerLabSettings = {
    timerMs: 2000,
    spawnRate: 2,
    maxEntities: 20,
    paused: false,
  };

  const entities: DeathTimerEntity[] = [];
  let nextId = 1;
  let spawnBudget = 0;
  let removedCount = 0;
  let lastFrameTime = performance.now();
  let frameHandle = 0;
  let width = 1;
  let height = 1;

  const syncSize = () => {
    const w = Math.max(1, Math.floor(root.clientWidth));
    const h = Math.max(1, Math.floor(root.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pw = Math.max(1, Math.floor(w * dpr));
    const ph = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    width = w;
    height = h;
  };

  const spawnEntity = () => {
    if (entities.length >= settings.maxEntities) return;
    const margin = ENTITY_RADIUS + 30;
    entities.push({
      id: nextId++,
      x: lerp(margin, Math.max(margin, width - margin), random.next()),
      y: lerp(margin + 40, Math.max(margin + 40, height - margin), random.next()),
      totalMs: settings.timerMs,
      remainingMs: settings.timerMs,
    });
  };

  const update = (deltaMs: number) => {
    if (settings.paused) return;

    spawnBudget += (deltaMs / 1000) * settings.spawnRate;
    while (spawnBudget >= 1 && entities.length < settings.maxEntities) {
      spawnEntity();
      spawnBudget -= 1;
    }

    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i];
      if (!e) continue;
      e.remainingMs -= deltaMs;
      if (e.remainingMs <= 0) {
        entities.splice(i, 1);
        removedCount++;
      }
    }
  };

  const render = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    for (const e of entities) {
      const progress = clamp(1 - e.remainingMs / Math.max(1, e.totalMs), 0, 1);
      const scale = lerp(1, 0.3, progress);
      const alpha = lerp(1, 0.2, progress);
      const radius = ENTITY_RADIUS * scale;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Outer glow fades from red to grey
      ctx.beginPath();
      ctx.fillStyle = progress < 0.5 ? FADE_COLOR_START : FADE_COLOR_END;
      ctx.arc(e.x, e.y, radius + 4, 0, Math.PI * 2);
      ctx.fill();

      // Inner body
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, ${Math.round(lerp(200, 60, progress))}, ${Math.round(lerp(200, 60, progress))}, 1)`;
      ctx.arc(e.x, e.y, radius, 0, Math.PI * 2);
      ctx.fill();

      // Timer text
      ctx.fillStyle = '#fff';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.max(0, Math.ceil(e.remainingMs))}`, e.x, e.y);

      ctx.restore();
    }

    // HUD
    ctx.fillStyle = '#ff9e9e';
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Active: ${entities.length} | Removed: ${removedCount}`, 16, 16);

    if (settings.paused) {
      ctx.fillStyle = 'rgba(255, 230, 140, 0.95)';
      ctx.fillText('PAUSED', 16, 36);
    }
  };

  const tick = (now: number) => {
    syncSize();
    const deltaMs = Math.min(now - lastFrameTime, 50);
    lastFrameTime = now;
    update(deltaMs);
    render();
    frameHandle = window.requestAnimationFrame(tick);
  };

  const actions = {
    spawnOne: () => spawnEntity(),
    clearAll: () => {
      entities.length = 0;
      removedCount = 0;
      spawnBudget = 0;
    },
  };

  gui.add(settings, 'timerMs', 200, 5000, 100).name('Timer (ms)');
  gui.add(settings, 'spawnRate', 0.5, 10, 0.5).name('Spawn Rate');
  gui.add(settings, 'maxEntities', 5, 50, 1).name('Max Entities');
  gui.add(settings, 'paused').name('Paused');
  gui.add(actions, 'spawnOne').name('Spawn One');
  gui.add(actions, 'clearAll').name('Clear All');

  const handleResize = () => syncSize();
  window.addEventListener('resize', handleResize);

  syncSize();
  render();
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
  description: 'Visualize delayed entity removal with countdown fade and shrink effects.',
  create: createDeathTimerLab,
});
