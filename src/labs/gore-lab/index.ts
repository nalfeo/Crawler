import { registerLab, type LabCategory } from '../registry.js';
import { SeededRandom } from '../../shared/random.js';

interface GoreLabSettings {
  hitGoreEnabled: boolean;
  intensity: number;
  overkillAmount: number;
  hitDamage: number;
  goreFactor: number;
}

const DEFAULT_SETTINGS: GoreLabSettings = {
  hitGoreEnabled: true,
  intensity: 1.0,
  overkillAmount: 10,
  hitDamage: 15,
  goreFactor: 0.8,
};

// Particle physics (mirrors GoreVfx.ts)
const PARTICLE_LIFETIME_MS = 400;
const HIT_BASE_PARTICLES = 3;
const DEATH_BASE_PARTICLES = 12;
const PARTICLE_SPEED = 80;
const PARTICLE_SIZE_MIN = 2;
const PARTICLE_SIZE_MAX = 5;
const BLOOD_COLORS = ['#cc0000', '#aa0000', '#880000', '#660000', '#990000'];
const GRAVITY = 60;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  startMs: number;
}

interface LabGuiController {
  name(label: string): LabGuiController;
  onChange?(handler: () => void): LabGuiController;
  updateDisplay?(): void;
}

interface LabGuiLike {
  add(...args: unknown[]): LabGuiController;
  addFolder?(title: string): LabGuiLike;
  open?(): void;
  destroy?(): void;
}

type ControlsWithGui = HTMLElement & { __labGui?: LabGuiLike };

function createGoreLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: GoreLabSettings = { ...DEFAULT_SETTINGS };

  // Create canvas for particle rendering
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  canvas.style.width = '100%';
  canvas.style.maxWidth = '600px';
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = '3 / 2';
  canvas.style.borderRadius = '12px';
  canvas.style.border = '1px solid rgba(148, 163, 184, 0.2)';
  canvas.style.background = '#0a0a12';
  canvas.style.cursor = 'crosshair';
  canvas.style.display = 'block';
  canvas.style.marginBottom = '16px';

  const ctx = canvas.getContext('2d')!;

  const root = document.createElement('div');
  root.style.padding = '24px';
  root.style.color = '#f8fafc';
  root.style.fontFamily = 'Inter, system-ui, sans-serif';

  const title = document.createElement('h2');
  title.textContent = 'Gore VFX Lab';
  title.style.marginBottom = '8px';

  const description = document.createElement('p');
  description.textContent =
    'Click canvas for hit-gore, Shift+click for death-gore burst. Adjust intensity and parameters with controls.';
  description.style.color = '#cbd5e1';
  description.style.marginBottom = '16px';

  const particles: Particle[] = [];
  let rng = new SeededRandom(Date.now());
  let animId = 0;
  let lastFrameMs = performance.now();

  function spawnParticles(
    x: number,
    y: number,
    count: number,
    dirX: number,
    dirY: number,
    spread: number,
  ): void {
    const scaledCount = Math.round(count * settings.intensity);
    if (scaledCount <= 0) return;
    const now = performance.now();
    for (let i = 0; i < scaledCount; i++) {
      const angle = Math.atan2(dirY, dirX) + (rng.next() - 0.5) * spread;
      const speed = PARTICLE_SPEED * (0.5 + rng.next() * 0.8);
      const size = PARTICLE_SIZE_MIN + rng.next() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN);
      const color = BLOOD_COLORS[Math.floor(rng.next() * BLOOD_COLORS.length)]!;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size,
        color,
        startMs: now,
      });
    }
  }

  function handleClick(e: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    rng = new SeededRandom(Date.now());

    if (e.shiftKey) {
      // Death gore — large burst
      const overkillMult = 1 + Math.min(settings.overkillAmount / 20, 3);
      const count = Math.round(DEATH_BASE_PARTICLES * overkillMult);
      const angle = rng.next() * Math.PI * 2;
      spawnParticles(cx, cy, count, Math.cos(angle), Math.sin(angle), Math.PI * 0.8);
    } else {
      // Hit gore — small directional splatter
      if (!settings.hitGoreEnabled) return;
      if (rng.next() > settings.goreFactor) return;
      const count = Math.max(
        1,
        Math.min(
          Math.round(HIT_BASE_PARTICLES * settings.goreFactor * (settings.hitDamage / 10)),
          8,
        ),
      );
      const angle = rng.next() * Math.PI * 2;
      spawnParticles(cx, cy, count, Math.cos(angle), Math.sin(angle), Math.PI * 0.6);
    }
  }

  canvas.addEventListener('click', handleClick);

  function render(): void {
    const now = performance.now();
    const deltaMs = now - lastFrameMs;
    lastFrameMs = now;
    const dtSec = deltaMs / 1000;

    // Dark background with slight trail effect
    ctx.fillStyle = 'rgba(10, 10, 18, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Update and draw particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      const age = now - p.startMs;
      const progress = Math.min(1, age / PARTICLE_LIFETIME_MS);

      if (progress >= 1) {
        particles.splice(i, 1);
        continue;
      }

      // Physics (matches GoreVfx.ts)
      const decel = 1 - progress * 0.7;
      p.x += p.vx * dtSec * decel;
      p.y += p.vy * dtSec * decel;
      p.vy += GRAVITY * dtSec;

      // Draw
      const alpha = (1 - progress) * 0.9;
      const scale = 1 - progress * 0.5;
      const drawSize = p.size * scale;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - drawSize / 2, p.y - drawSize / 2, drawSize, drawSize);
    }

    ctx.globalAlpha = 1;

    // Draw crosshair hint when no particles
    if (particles.length === 0) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.font = '14px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        'Click for hit-gore • Shift+click for death-gore',
        canvas.width / 2,
        canvas.height / 2,
      );
    }

    animId = requestAnimationFrame(render);
  }

  root.append(title, description, canvas);
  canvasHost.append(root);

  // Start animation loop
  animId = requestAnimationFrame(render);

  // GUI controls
  const guiGroup = typeof gui.addFolder === 'function' ? gui.addFolder('Gore Lab') : gui;
  guiGroup.add(settings, 'hitGoreEnabled').name('Hit Gore');
  guiGroup.add(settings, 'intensity', 0, 3, 0.1).name('Intensity');
  guiGroup.add(settings, 'overkillAmount', 0, 100, 1).name('Overkill Amount');
  guiGroup.add(settings, 'hitDamage', 1, 50, 1).name('Hit Damage');
  guiGroup.add(settings, 'goreFactor', 0, 1, 0.05).name('Gore Factor');
  guiGroup.open?.();

  return () => {
    cancelAnimationFrame(animId);
    canvas.removeEventListener('click', handleClick);
    if (guiGroup !== gui) guiGroup.destroy?.();
    root.remove();
  };
}

registerLab('gore-lab', {
  category: 'Combat' as LabCategory,
  name: 'Gore Lab',
  description: 'Interactive blood splatter particle preview — click to trigger gore VFX.',
  create: createGoreLab,
});
