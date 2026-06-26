import type GUI from 'lil-gui';
import { SeededRandom } from '../../shared/random.js';
import { GAME } from '../../shared/constants.js';
import {
  MINI_SLIME_SPAWN_ANIM_MS,
  SPAWN_ANIM_WIGGLE_AMPLITUDE,
  SPAWN_ANIM_WIGGLE_CYCLES,
  computeSpawnPopScale,
  spawnAnimProgress,
} from '../../shared/spawn-anim.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface BabySlime {
  x: number;
  y: number;
  remainingMs: number;
  totalMs: number;
  sizeScale: number;
}

interface SpawnAnimLabSettings {
  animMs: number;
  wiggleAmplitude: number;
  wiggleCycles: number;
  miniSizeScale: number;
  autoLoopMs: number;
  paused: boolean;
}

const BACKGROUND = '#0d0d14';
const FULL_SLIME_RADIUS = 34;
const SLIME_BODY = '#54d66a';
const SLIME_GLOSS = '#b9f5c4';
const INVULN_RING = '#6cf2ff';
const LAB_SEED = 0x5_1_1_3;

function createSpawnAnimLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
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
    'Baby slimes pop out smaller than a full slime, wiggle into existence, and stay ' +
    'invulnerable (cyan ring) until the animation settles. Mirrors spawnAnimSystem + the ' +
    'shared spawn-anim math used by the real renderer.';
  hint.style.marginTop = '16px';
  hint.style.color = '#9fe7ff';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for spawn-anim lab.');
  }

  const random = new SeededRandom(LAB_SEED);
  const settings: SpawnAnimLabSettings = {
    animMs: MINI_SLIME_SPAWN_ANIM_MS,
    wiggleAmplitude: SPAWN_ANIM_WIGGLE_AMPLITUDE,
    wiggleCycles: SPAWN_ANIM_WIGGLE_CYCLES,
    miniSizeScale: 0.65,
    autoLoopMs: 1200,
    paused: false,
  };

  const babies: BabySlime[] = [];
  let frameHandle = 0;
  let lastFrameTimeMs = performance.now();
  let autoTimerMs = 0;
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

  /** Spawn two babies near the centre, like a slime split. */
  const split = () => {
    const cx = width / 2;
    const cy = height / 2;
    for (let i = 0; i < 2; i += 1) {
      const angle = random.next() * Math.PI * 2;
      const distance = 30 + random.next() * 50;
      babies.push({
        x: cx + Math.cos(angle) * distance,
        y: cy + Math.sin(angle) * distance,
        remainingMs: settings.animMs,
        totalMs: settings.animMs,
        sizeScale: settings.miniSizeScale,
      });
    }
    // Keep the sandbox tidy.
    while (babies.length > 12) {
      babies.shift();
    }
  };

  const clearAll = () => {
    babies.length = 0;
    autoTimerMs = 0;
  };

  const drawSlime = (
    cx: number,
    cy: number,
    radiusX: number,
    radiusY: number,
    bodyAlpha: number,
  ) => {
    context.globalAlpha = bodyAlpha;
    context.fillStyle = SLIME_BODY;
    context.beginPath();
    context.ellipse(cx, cy, Math.max(0.1, radiusX), Math.max(0.1, radiusY), 0, 0, Math.PI * 2);
    context.fill();
    // Glossy highlight.
    context.globalAlpha = bodyAlpha * 0.8;
    context.fillStyle = SLIME_GLOSS;
    context.beginPath();
    context.ellipse(
      cx - radiusX * 0.3,
      cy - radiusY * 0.35,
      Math.max(0.1, radiusX * 0.32),
      Math.max(0.1, radiusY * 0.24),
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.globalAlpha = 1;
  };

  const tick = (now: number) => {
    syncCanvasSize();
    const deltaMs = Math.min(now - lastFrameTimeMs, 50);
    lastFrameTimeMs = now;

    if (!settings.paused) {
      // Mirror spawnAnimSystem's fixed-step countdown.
      for (let i = babies.length - 1; i >= 0; i -= 1) {
        const baby = babies[i]!;
        baby.remainingMs -= GAME.DELTA_MS;
        if (baby.remainingMs < -2000) {
          babies.splice(i, 1);
        }
      }
      autoTimerMs += deltaMs;
      if (settings.autoLoopMs > 0 && autoTimerMs >= settings.autoLoopMs) {
        autoTimerMs = 0;
        split();
      }
    }

    context.clearRect(0, 0, width, height);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    // Reference full-size slime outline (centre).
    context.strokeStyle = 'rgba(120, 220, 150, 0.35)';
    context.lineWidth = 2;
    context.setLineDash([6, 6]);
    context.beginPath();
    context.ellipse(width / 2, height / 2, FULL_SLIME_RADIUS, FULL_SLIME_RADIUS, 0, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = '#22d3ee';
    context.font = '15px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    const invulnCount = babies.filter((b) => b.remainingMs > 0).length;
    context.fillText(
      `Babies: ${babies.length} | Invulnerable: ${invulnCount}` +
        (settings.paused ? '  [PAUSED]' : ''),
      18,
      16,
    );
    context.fillStyle = 'rgba(140, 230, 160, 0.6)';
    context.fillText('dashed ring = full slime size', 18, 38);

    for (const baby of babies) {
      const progress = spawnAnimProgress(baby.remainingMs, baby.totalMs);
      const pop = computeSpawnPopScale(progress, {
        wiggleAmplitude: settings.wiggleAmplitude,
        wiggleCycles: settings.wiggleCycles,
      });
      const baseRadius = FULL_SLIME_RADIUS * baby.sizeScale;
      const radiusX = baseRadius * pop.x;
      const radiusY = baseRadius * pop.y;
      const invulnerable = baby.remainingMs > 0;

      drawSlime(baby.x, baby.y, radiusX, radiusY, 1);

      if (invulnerable) {
        // Pulsing invulnerability ring that fades as the animation settles.
        const ringAlpha = 0.85 * (1 - progress) + 0.15;
        context.globalAlpha = ringAlpha;
        context.strokeStyle = INVULN_RING;
        context.lineWidth = 2.5;
        context.beginPath();
        context.ellipse(
          baby.x,
          baby.y,
          Math.max(0.1, radiusX + 6),
          Math.max(0.1, radiusY + 6),
          0,
          0,
          Math.PI * 2,
        );
        context.stroke();
        context.globalAlpha = 1;
      }
    }

    frameHandle = window.requestAnimationFrame(tick);
  };

  const actions = {
    split,
    clearAll,
  };

  gui.add(settings, 'animMs', 100, 1500, 10).name('Anim / invuln (ms)');
  gui.add(settings, 'wiggleAmplitude', 0, 0.6, 0.01).name('Wiggle amplitude');
  gui.add(settings, 'wiggleCycles', 0, 8, 1).name('Wiggle cycles');
  gui.add(settings, 'miniSizeScale', 0.2, 1, 0.05).name('Baby size scale');
  gui.add(settings, 'autoLoopMs', 0, 4000, 100).name('Auto split (ms, 0=off)');
  gui.add(settings, 'paused').name('Paused');
  gui.add(actions, 'split').name('Split now');
  gui.add(actions, 'clearAll').name('Clear');

  const handleResize = () => syncCanvasSize();
  window.addEventListener('resize', handleResize);

  syncCanvasSize();
  split();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    window.removeEventListener('resize', handleResize);
    hint.remove();
    root.remove();
  };
}

registerLab('spawnanim-lab', {
  category: 'Entities' as LabCategory,
  name: 'Spawn Animation',
  description:
    'Visualize the baby-slime spawn-in pop/wiggle and the invulnerability window driven by spawnAnimSystem.',
  create: createSpawnAnimLab,
});
