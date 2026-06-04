import type GUI from 'lil-gui';
import { SeededRandom } from '../../shared/random.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type LifetimeEntity = {
  id: number;
  x: number;
  y: number;
  spawnedAt: number;
  expiresAt: number;
  radius: number;
};

type PopEffect = {
  x: number;
  y: number;
  radius: number;
  startedAt: number;
  durationMs: number;
};

interface LifetimeLabSettings {
  minLifetimeMs: number;
  maxLifetimeMs: number;
  spawnRate: number;
  maxEntities: number;
  paused: boolean;
}

const BACKGROUND = '#0d0d14';
const COUNTER_COLOR = '#22d3ee';
const ENTITY_RADIUS = 12;
const POP_DURATION_MS = 200;
const TIMELINE_HEIGHT = 44;
const HUD_PADDING = 20;
const SPAWN_TOP_MARGIN = 60;
const SPAWN_BOTTOM_MARGIN = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function createLifetimeLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
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
    'Auto-spawned entities expire on a shared timeline. Tune TTL and spawn pressure, pause the clock, or spawn one manually.';
  hint.style.marginTop = '16px';
  hint.style.color = '#9fe7ff';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for lifetime lab.');
  }

  const random = new SeededRandom(0x1f71_2026);
  const settings: LifetimeLabSettings = {
    minLifetimeMs: 500,
    maxLifetimeMs: 3000,
    spawnRate: 3,
    maxEntities: 30,
    paused: false,
  };

  const entities: LifetimeEntity[] = [];
  const popEffects: PopEffect[] = [];
  let activeExpiredCount = 0;
  let totalSpawnedCount = 0;
  let nextEntityId = 1;
  let simulationTimeMs = 0;
  let spawnBudget = 0;
  let frameHandle = 0;
  let lastFrameTimeMs = performance.now();
  let width = 1;
  let height = 1;

  const getLifetimeRange = () => {
    const minLifetime = Math.min(settings.minLifetimeMs, settings.maxLifetimeMs);
    const maxLifetime = Math.max(settings.minLifetimeMs, settings.maxLifetimeMs);
    return { minLifetime, maxLifetime };
  };

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

  const getSpawnBounds = () => {
    const left = ENTITY_RADIUS + 20;
    const right = Math.max(left, width - ENTITY_RADIUS - 20);
    const top = ENTITY_RADIUS + SPAWN_TOP_MARGIN;
    const bottom = Math.max(top, height - ENTITY_RADIUS - SPAWN_BOTTOM_MARGIN);
    return { left, right, top, bottom };
  };

  const randomBetween = (min: number, max: number) => lerp(min, max, random.next());

  const spawnEntity = () => {
    if (entities.length >= settings.maxEntities) {
      return false;
    }

    const { minLifetime, maxLifetime } = getLifetimeRange();
    const bounds = getSpawnBounds();
    const lifetimeMs = randomBetween(minLifetime, maxLifetime);
    const entity: LifetimeEntity = {
      id: nextEntityId,
      x: randomBetween(bounds.left, bounds.right),
      y: randomBetween(bounds.top, bounds.bottom),
      spawnedAt: simulationTimeMs,
      expiresAt: simulationTimeMs + lifetimeMs,
      radius: ENTITY_RADIUS,
    };

    nextEntityId += 1;
    totalSpawnedCount += 1;
    entities.push(entity);
    return true;
  };

  const clearAll = () => {
    entities.length = 0;
    popEffects.length = 0;
    activeExpiredCount = 0;
    totalSpawnedCount = 0;
    nextEntityId = 1;
    simulationTimeMs = 0;
    spawnBudget = 0;
    lastFrameTimeMs = performance.now();
  };

  const toRingColor = (remainingRatio: number) => {
    const hue = clamp(remainingRatio, 0, 1) * 120;
    return `hsl(${hue}, 90%, 58%)`;
  };

  const drawEntity = (entity: LifetimeEntity) => {
    const totalLifetime = Math.max(1, entity.expiresAt - entity.spawnedAt);
    const remainingLifetime = Math.max(0, entity.expiresAt - simulationTimeMs);
    const remainingRatio = clamp(remainingLifetime / totalLifetime, 0, 1);
    const ringRadius = entity.radius + 6;
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + remainingRatio * Math.PI * 2;

    context.beginPath();
    context.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    context.lineWidth = 3;
    context.arc(entity.x, entity.y, ringRadius, 0, Math.PI * 2);
    context.stroke();

    context.beginPath();
    context.strokeStyle = toRingColor(remainingRatio);
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.arc(entity.x, entity.y, ringRadius, startAngle, endAngle);
    context.stroke();

    context.shadowColor = 'rgba(255, 255, 255, 0.35)';
    context.shadowBlur = 18;
    context.beginPath();
    context.fillStyle = '#ffffff';
    context.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  };

  const drawPopEffect = (effect: PopEffect) => {
    const progress = clamp((simulationTimeMs - effect.startedAt) / effect.durationMs, 0, 1);
    const scale = lerp(1, 2, progress);
    const alpha = 1 - progress;

    context.save();
    context.globalAlpha = alpha;

    context.beginPath();
    context.fillStyle = 'rgba(255, 255, 255, 0.22)';
    context.arc(effect.x, effect.y, effect.radius * scale, 0, Math.PI * 2);
    context.fill();

    context.beginPath();
    context.strokeStyle = `rgba(255, 255, 255, ${0.9 * alpha})`;
    context.lineWidth = 3;
    context.arc(effect.x, effect.y, effect.radius * scale * 1.15, 0, Math.PI * 2);
    context.stroke();

    context.restore();
  };

  const drawCounter = () => {
    context.fillStyle = COUNTER_COLOR;
    context.font = '16px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText(
      `Active: ${entities.length} | Expired: ${activeExpiredCount} | Total spawned: ${totalSpawnedCount}`,
      HUD_PADDING,
      HUD_PADDING,
    );

    if (settings.paused) {
      context.fillStyle = 'rgba(255, 230, 140, 0.95)';
      context.fillText('PAUSED', HUD_PADDING, HUD_PADDING + 22);
    }
  };

  const drawTimeline = () => {
    const { maxLifetime } = getLifetimeRange();
    const barX = 24;
    const barY = height - TIMELINE_HEIGHT;
    const barWidth = Math.max(40, width - 48);
    const baselineY = barY + 18;

    context.fillStyle = 'rgba(10, 18, 28, 0.88)';
    context.fillRect(barX, barY, barWidth, 26);

    context.strokeStyle = 'rgba(34, 211, 238, 0.3)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(barX, baselineY);
    context.lineTo(barX + barWidth, baselineY);
    context.stroke();

    context.fillStyle = 'rgba(160, 240, 255, 0.9)';
    context.font = '12px monospace';
    context.textBaseline = 'alphabetic';
    context.fillText('now', barX, barY + 40);
    context.textAlign = 'right';
    context.fillText(`${Math.round(maxLifetime)}ms`, barX + barWidth, barY + 40);
    context.textAlign = 'left';

    const sortedEntities = [...entities].sort((left, right) => left.expiresAt - right.expiresAt);
    for (const entity of sortedEntities) {
      const totalLifetime = Math.max(1, entity.expiresAt - entity.spawnedAt);
      const remainingLifetime = entity.expiresAt - simulationTimeMs;
      if (remainingLifetime < 0 || remainingLifetime > maxLifetime) {
        continue;
      }

      const remainingRatio = clamp(remainingLifetime / totalLifetime, 0, 1);
      const tickX = barX + (remainingLifetime / maxLifetime) * barWidth;
      const tickHeight = 10 + (1 - remainingRatio) * 10;

      context.strokeStyle = toRingColor(remainingRatio);
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(tickX, baselineY - tickHeight);
      context.lineTo(tickX, baselineY + 2);
      context.stroke();
    }
  };

  const updateSimulation = (deltaMs: number) => {
    if (settings.paused) {
      return;
    }

    simulationTimeMs += deltaMs;
    spawnBudget += (deltaMs / 1000) * settings.spawnRate;

    while (spawnBudget >= 1 && entities.length < settings.maxEntities) {
      spawnEntity();
      spawnBudget -= 1;
    }

    for (let index = entities.length - 1; index >= 0; index -= 1) {
      const entity = entities[index];
      if (!entity || simulationTimeMs < entity.expiresAt) {
        continue;
      }

      entities.splice(index, 1);
      activeExpiredCount += 1;
      popEffects.push({
        x: entity.x,
        y: entity.y,
        radius: entity.radius,
        startedAt: simulationTimeMs,
        durationMs: POP_DURATION_MS,
      });
    }

    for (let index = popEffects.length - 1; index >= 0; index -= 1) {
      const effect = popEffects[index];
      if (!effect || simulationTimeMs - effect.startedAt <= effect.durationMs) {
        continue;
      }

      popEffects.splice(index, 1);
    }
  };

  const render = () => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    context.fillStyle = 'rgba(0, 255, 255, 0.03)';
    context.fillRect(0, 0, width, 56);

    for (const entity of entities) {
      drawEntity(entity);
    }

    for (const effect of popEffects) {
      drawPopEffect(effect);
    }

    drawCounter();
    drawTimeline();
  };

  const tick = (now: number) => {
    syncCanvasSize();
    const deltaMs = Math.min(now - lastFrameTimeMs, 50);
    lastFrameTimeMs = now;

    updateSimulation(deltaMs);
    render();

    frameHandle = window.requestAnimationFrame(tick);
  };

  const actions = {
    spawnOne: () => {
      spawnEntity();
    },
    clearAll,
  };

  gui.add(settings, 'minLifetimeMs', 100, 5000, 50).name('minLifetimeMs');
  gui.add(settings, 'maxLifetimeMs', 500, 10000, 50).name('maxLifetimeMs');
  gui.add(settings, 'spawnRate', 0.5, 20, 0.1).name('spawnRate');
  gui.add(settings, 'maxEntities', 5, 100, 1).name('maxEntities');
  gui.add(settings, 'paused').name('paused');
  gui.add(actions, 'spawnOne').name('Spawn One');
  gui.add(actions, 'clearAll').name('Clear All');

  const handleResize = () => syncCanvasSize();
  window.addEventListener('resize', handleResize);

  syncCanvasSize();
  render();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    window.removeEventListener('resize', handleResize);
    hint.remove();
    root.remove();
  };
}

registerLab('lifetime-lab', {
  category: 'Entities' as LabCategory,
  name: 'Lifetime',
  description: 'Visualize timed entity expiration with countdown rings and pop effects.',
  create: createLifetimeLab,
});
