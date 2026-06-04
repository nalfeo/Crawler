import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type Vector = {
  x: number;
  y: number;
};

type KeyDescriptor = {
  code: string;
  label: string;
};

interface PlayerInputLabSettings {
  moveSpeed: number;
  showRawVector: boolean;
  showNormalized: boolean;
  trailLength: number;
}

const LAB_ID = 'playerinput-lab';
const BACKGROUND_COLOR = '#0d0d14';
const WASD_KEYS: KeyDescriptor[] = [
  { code: 'KeyW', label: 'W' },
  { code: 'KeyA', label: 'A' },
  { code: 'KeyS', label: 'S' },
  { code: 'KeyD', label: 'D' },
];
const ARROW_KEYS: KeyDescriptor[] = [
  { code: 'ArrowUp', label: '↑' },
  { code: 'ArrowLeft', label: '←' },
  { code: 'ArrowDown', label: '↓' },
  { code: 'ArrowRight', label: '→' },
];
const TRACKED_KEYS = new Set([...WASD_KEYS, ...ARROW_KEYS].map((key) => key.code));

function normalizeInput(moveX: number, moveY: number): Vector {
  const magnitude = Math.hypot(moveX, moveY);

  if (magnitude === 0) {
    return { x: 0, y: 0 };
  }

  if (magnitude <= 1) {
    return { x: moveX, y: moveY };
  }

  return {
    x: moveX / magnitude,
    y: moveY / magnitude,
  };
}

function wrapPosition(value: number, max: number): number {
  if (max <= 0) {
    return 0;
  }

  if (value < 0) {
    return value + max;
  }

  if (value >= max) {
    return value - max;
  }

  return value;
}

function createKeyGroup(title: string, keys: KeyDescriptor[], pressed: Set<string>): HTMLElement {
  const group = document.createElement('div');
  group.style.display = 'flex';
  group.style.flexDirection = 'column';
  group.style.gap = '8px';

  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.color = '#8f9bb3';
  heading.style.fontSize = '12px';
  heading.style.letterSpacing = '0.08em';
  heading.style.textTransform = 'uppercase';

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.flexWrap = 'wrap';
  row.style.gap = '8px';

  for (const key of keys) {
    const badge = document.createElement('div');
    badge.dataset.keyCode = key.code;
    badge.textContent = key.label;
    badge.style.minWidth = '44px';
    badge.style.padding = '8px 10px';
    badge.style.borderRadius = '8px';
    badge.style.border = '1px solid rgba(255, 255, 255, 0.14)';
    badge.style.background = pressed.has(key.code) ? '#7ee0ff' : 'rgba(255, 255, 255, 0.04)';
    badge.style.color = pressed.has(key.code) ? '#04131d' : '#f4f7fb';
    badge.style.boxShadow = pressed.has(key.code) ? '0 0 20px rgba(126, 224, 255, 0.28)' : 'none';
    badge.style.fontFamily = 'monospace';
    badge.style.fontSize = '16px';
    badge.style.fontWeight = '700';
    badge.style.textAlign = 'center';
    row.append(badge);
  }

  group.append(heading, row);
  return group;
}

function createPlayerInputLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.padding = '16px';
  root.style.boxSizing = 'border-box';
  root.style.background = BACKGROUND_COLOR;
  root.style.color = '#f4f7fb';
  root.style.fontFamily = 'monospace';
  root.style.gap = '12px';

  const canvasFrame = document.createElement('div');
  canvasFrame.style.position = 'relative';
  canvasFrame.style.flex = '1';
  canvasFrame.style.minHeight = '360px';
  canvasFrame.style.borderRadius = '16px';
  canvasFrame.style.overflow = 'hidden';
  canvasFrame.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  canvasFrame.style.background = BACKGROUND_COLOR;
  canvasFrame.style.boxShadow = 'inset 0 0 0 1px rgba(255, 255, 255, 0.03)';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  const readout = document.createElement('div');
  readout.style.padding = '12px 14px';
  readout.style.borderRadius = '12px';
  readout.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  readout.style.background = 'rgba(255, 255, 255, 0.03)';
  readout.style.lineHeight = '1.6';
  readout.style.whiteSpace = 'pre-line';

  const keyPanel = document.createElement('div');
  keyPanel.style.display = 'flex';
  keyPanel.style.flexWrap = 'wrap';
  keyPanel.style.gap = '16px';
  keyPanel.style.padding = '2px 0 0';

  const hint = document.createElement('p');
  hint.textContent =
    'Hold WASD or the arrow keys to inspect raw input, normalized direction, and player motion.';
  hint.style.marginTop = '16px';
  hint.style.color = '#7ee0ff';
  hint.style.lineHeight = '1.6';

  canvasFrame.append(canvas);
  root.append(canvasFrame, readout, keyPanel);
  canvasHost.append(root);
  controls.append(hint);

  const pressedKeys = new Set<string>();
  keyPanel.append(
    createKeyGroup('WASD', WASD_KEYS, pressedKeys),
    createKeyGroup('Arrows', ARROW_KEYS, pressedKeys),
  );

  const settings: PlayerInputLabSettings = {
    moveSpeed: 5,
    showRawVector: true,
    showNormalized: true,
    trailLength: 30,
    ...(loadLabState<PlayerInputLabSettings>(LAB_ID) ?? {}),
  };

  const entity = { x: 0, y: 0 };
  const trail: Vector[] = [];
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create a 2D canvas context.');
  }
  const ctx = context;

  let animationFrame = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;

  const controlsApi = {
    resetPosition: () => {
      entity.x = canvasWidth / 2;
      entity.y = canvasHeight / 2;
      trail.length = 0;
    },
  };

  gui.add(settings, 'moveSpeed', 1, 20, 1).name('moveSpeed');
  gui.add(settings, 'showRawVector').name('showRawVector');
  gui.add(settings, 'showNormalized').name('showNormalized');
  gui.add(settings, 'trailLength', 0, 100, 1).name('trailLength');
  gui.add(controlsApi, 'resetPosition').name('Reset Position');
  gui.onChange(() => saveLabState(LAB_ID, settings));

  function updateKeyIndicators(): void {
    const badges = keyPanel.querySelectorAll<HTMLElement>('[data-key-code]');
    for (const badge of badges) {
      const code = badge.dataset.keyCode;
      const active = code ? pressedKeys.has(code) : false;
      badge.style.background = active ? '#7ee0ff' : 'rgba(255, 255, 255, 0.04)';
      badge.style.color = active ? '#04131d' : '#f4f7fb';
      badge.style.borderColor = active ? 'rgba(126, 224, 255, 0.9)' : 'rgba(255, 255, 255, 0.14)';
      badge.style.boxShadow = active ? '0 0 20px rgba(126, 224, 255, 0.28)' : 'none';
    }
  }

  function computeRawInput(): Vector {
    const left = pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft');
    const right = pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight');
    const up = pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp');
    const down = pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown');

    return {
      x: (right ? 1 : 0) - (left ? 1 : 0),
      y: (down ? 1 : 0) - (up ? 1 : 0),
    };
  }

  function resizeCanvas(): void {
    const bounds = canvasFrame.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(bounds.width));
    const nextHeight = Math.max(1, Math.round(bounds.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    canvasWidth = nextWidth;
    canvasHeight = nextHeight;
    canvas.width = Math.round(nextWidth * dpr);
    canvas.height = Math.round(nextHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (entity.x === 0 && entity.y === 0) {
      entity.x = canvasWidth / 2;
      entity.y = canvasHeight / 2;
    } else {
      entity.x = Math.min(Math.max(entity.x, 0), canvasWidth);
      entity.y = Math.min(Math.max(entity.y, 0), canvasHeight);
    }
  }

  function drawArrow(fromX: number, fromY: number, toX: number, toY: number): void {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const angle = Math.atan2(dy, dx);
    const headLength = 14;

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - Math.cos(angle - Math.PI / 6) * headLength,
      toY - Math.sin(angle - Math.PI / 6) * headLength,
    );
    ctx.lineTo(
      toX - Math.cos(angle + Math.PI / 6) * headLength,
      toY - Math.sin(angle + Math.PI / 6) * headLength,
    );
    ctx.closePath();
    ctx.fill();
  }

  function renderFrame(): void {
    const raw = computeRawInput();
    const normalized = normalizeInput(raw.x, raw.y);
    const magnitude = Math.hypot(raw.x, raw.y);
    const angleDegrees =
      normalized.x === 0 && normalized.y === 0
        ? null
        : ((Math.atan2(normalized.y, normalized.x) * 180) / Math.PI + 360) % 360;

    entity.x = wrapPosition(entity.x + normalized.x * settings.moveSpeed, canvasWidth);
    entity.y = wrapPosition(entity.y + normalized.y * settings.moveSpeed, canvasHeight);

    trail.push({ x: entity.x, y: entity.y });
    const maxTrail = Math.max(0, Math.floor(settings.trailLength));
    if (maxTrail === 0) {
      trail.length = 0;
    } else if (trail.length > maxTrail) {
      trail.splice(0, trail.length - maxTrail);
    }

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    for (let index = 0; index < trail.length; index += 1) {
      const point = trail[index];
      if (!point) {
        continue;
      }

      const alpha = (index + 1) / Math.max(1, trail.length);
      ctx.beginPath();
      ctx.fillStyle = `rgba(126, 224, 255, ${alpha * 0.45})`;
      ctx.arc(point.x, point.y, 2 + alpha * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.fillStyle = '#7ee0ff';
    ctx.shadowColor = '#7ee0ff';
    ctx.shadowBlur = 18;
    ctx.arc(entity.x, entity.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    const centerX = canvasWidth / 2;
    const centerY = canvasHeight / 2;
    const radius = Math.min(canvasWidth, canvasHeight) * 0.24;

    ctx.beginPath();
    ctx.fillStyle = 'rgba(18, 21, 33, 0.95)';
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 3;
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.moveTo(centerX - radius, centerY);
    ctx.lineTo(centerX + radius, centerY);
    ctx.moveTo(centerX, centerY - radius);
    ctx.lineTo(centerX, centerY + radius);
    ctx.stroke();

    if (settings.showRawVector && magnitude > 0) {
      ctx.beginPath();
      ctx.fillStyle = '#ffd84d';
      ctx.shadowColor = '#ffd84d';
      ctx.shadowBlur = 16;
      ctx.arc(centerX + raw.x * radius, centerY + raw.y * radius, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (settings.showNormalized && (normalized.x !== 0 || normalized.y !== 0)) {
      ctx.strokeStyle = '#7ee0ff';
      ctx.fillStyle = '#7ee0ff';
      ctx.lineWidth = 4;
      drawArrow(centerX, centerY, centerX + normalized.x * radius, centerY + normalized.y * radius);
    }

    readout.textContent = [
      `raw: (${raw.x.toFixed(2)}, ${raw.y.toFixed(2)})`,
      `normalized: (${normalized.x.toFixed(3)}, ${normalized.y.toFixed(3)})`,
      `magnitude: ${magnitude.toFixed(3)}`,
      `angle: ${angleDegrees === null ? '—' : `${angleDegrees.toFixed(1)}°`}`,
    ].join('\n');

    animationFrame = window.requestAnimationFrame(renderFrame);
  }

  function handleTrackedKey(event: KeyboardEvent, active: boolean): void {
    if (!TRACKED_KEYS.has(event.code)) {
      return;
    }

    event.preventDefault();
    if (active) {
      pressedKeys.add(event.code);
    } else {
      pressedKeys.delete(event.code);
    }
    updateKeyIndicators();
  }

  const onKeyDown = (event: KeyboardEvent) => handleTrackedKey(event, true);
  const onKeyUp = (event: KeyboardEvent) => handleTrackedKey(event, false);
  const onWindowBlur = () => {
    pressedKeys.clear();
    updateKeyIndicators();
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);

  const resizeObserver = new ResizeObserver(() => {
    resizeCanvas();
  });
  resizeObserver.observe(canvasFrame);

  resizeCanvas();
  updateKeyIndicators();
  controlsApi.resetPosition();
  animationFrame = window.requestAnimationFrame(renderFrame);

  return () => {
    window.cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
    hint.remove();
    root.remove();
  };
}

registerLab('playerinput-lab', {
  category: 'Movement & Physics' as LabCategory,
  name: 'Player Input Lab',
  description: 'Live keyboard input debugger for raw and normalized movement vectors.',
  create: createPlayerInputLab,
});
