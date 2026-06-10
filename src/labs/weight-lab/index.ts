import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type EntityKind = 'player' | 'enemy' | 'item' | 'projectile';

interface WeightLabEntity {
  id: number;
  label: string;
  kind: EntityKind;
  weight: number;
  x: number;
  y: number;
}

const KIND_COLOR: Record<EntityKind, string> = {
  player: '#38bdf8',
  enemy: '#f87171',
  item: '#a3e635',
  projectile: '#fb923c',
};

const DEFAULT_WEIGHTS: Record<EntityKind, number> = {
  player: 180,
  enemy: 120,
  item: 5,
  projectile: 1,
};

const BACKGROUND = '#0d0d14';
const RADIUS_BASE = 12;
const RADIUS_SCALE = 0.18;

function createWeightLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.cssText =
    'position:relative;width:100%;height:100%;overflow:hidden;background:' + BACKGROUND;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:crosshair;touch-action:none';

  const hud = document.createElement('div');
  hud.style.cssText =
    'position:absolute;top:16px;left:16px;padding:10px 12px;border-radius:12px;' +
    'background:rgba(15,23,42,0.82);border:1px solid rgba(255,255,255,0.1);' +
    'color:#f8fafc;font-family:monospace;font-size:13px;line-height:1.5;pointer-events:none;white-space:pre-line';

  const legend = document.createElement('div');
  legend.style.cssText =
    'position:absolute;bottom:16px;left:16px;padding:8px 12px;border-radius:10px;' +
    'background:rgba(15,23,42,0.82);border:1px solid rgba(255,255,255,0.1);' +
    'color:#f8fafc;font-family:monospace;font-size:12px;line-height:1.7';
  legend.innerHTML = Object.entries(KIND_COLOR)
    .map(
      ([kind, color]) =>
        `<span style="color:${color}">■</span> ${kind} (default ${DEFAULT_WEIGHTS[kind as EntityKind]} lbs)`,
    )
    .join('<br>');

  const hint = document.createElement('p');
  hint.textContent =
    'Click on the canvas to spawn entities. Circle radius scales with weight. Use controls to adjust weight before spawning.';
  hint.style.cssText = 'margin-top:16px;color:#cbd5e1;line-height:1.6';

  controls.append(hint);
  root.append(canvas, hud, legend);
  canvasHost.append(root);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D context for weight lab.');
  }

  const settings = {
    kind: 'enemy' as EntityKind,
    weight: DEFAULT_WEIGHTS['enemy'],
  };

  const entities: WeightLabEntity[] = [];
  let nextId = 1;
  let width = 1;
  let height = 1;
  let frameHandle = 0;

  const syncSize = () => {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(root.clientWidth));
    const h = Math.max(1, Math.floor(root.clientHeight));
    const pw = Math.max(1, Math.floor(w * dpr));
    const ph = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    }
    width = w;
    height = h;
  };

  const updateHud = () => {
    const total = entities.length;
    const avgWeight = total === 0 ? 0 : entities.reduce((sum, e) => sum + e.weight, 0) / total;
    hud.textContent = [
      `Entities: ${total}`,
      `Spawning: ${settings.kind} @ ${settings.weight} lbs`,
      `Avg weight: ${avgWeight.toFixed(1)} lbs`,
    ].join('\n');
  };

  const spawnAt = (x: number, y: number) => {
    entities.push({
      id: nextId++,
      label: `${settings.kind} #${nextId - 1}`,
      kind: settings.kind,
      weight: settings.weight,
      x,
      y,
    });
    updateHud();
  };

  const getPos = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent) => {
    const { x, y } = getPos(event);
    spawnAt(x, y);
  };

  const render = () => {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }

    for (const entity of entities) {
      const radius = Math.max(4, RADIUS_BASE + entity.weight * RADIUS_SCALE);
      const color = KIND_COLOR[entity.kind];

      ctx.beginPath();
      ctx.arc(entity.x, entity.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color + '44';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${entity.weight} lbs`, entity.x, entity.y);
    }
  };

  const tick = () => {
    syncSize();
    render();
    frameHandle = window.requestAnimationFrame(tick);
  };

  const kindFolder = gui.addFolder('Entity');
  kindFolder
    .add(settings, 'kind', ['player', 'enemy', 'item', 'projectile'] as EntityKind[])
    .name('kind')
    .onChange((kind: EntityKind) => {
      settings.weight = DEFAULT_WEIGHTS[kind];
      updateHud();
    });
  kindFolder
    .add(settings, 'weight', 0.1, 500, 0.1)
    .name('weight (lbs)')
    .onChange(() => updateHud());
  kindFolder.open();

  const actions = {
    clear: () => {
      entities.length = 0;
      nextId = 1;
      updateHud();
    },
  };
  gui.add(actions, 'clear').name('Clear All');

  canvas.addEventListener('pointerdown', onPointerDown);
  syncSize();
  updateHud();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    canvas.removeEventListener('pointerdown', onPointerDown);
    kindFolder.destroy();
    hint.remove();
    root.remove();
  };
}

registerLab('weight-lab', {
  category: 'Core' as LabCategory,
  name: 'Weight',
  description: 'Visualize entity weight values. Circle radius scales with weight.',
  create: createWeightLab,
});
