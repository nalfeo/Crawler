import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createHelloWorldLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const LAB_ID = 'hello-world';

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #243b55 0%, #141e30 60%, #0f172a 100%)';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  const info = document.createElement('div');
  info.style.position = 'absolute';
  info.style.top = '16px';
  info.style.left = '16px';
  info.style.padding = '12px 14px';
  info.style.borderRadius = '12px';
  info.style.background = 'rgba(5, 10, 24, 0.72)';
  info.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  info.style.color = '#f8fafc';
  info.style.lineHeight = '1.5';
  info.style.whiteSpace = 'pre-line';
  info.style.pointerEvents = 'none';

  const note = document.createElement('p');
  note.textContent = 'Canvas2D lab with lil-gui controls. Adjust the rectangle live.';
  note.style.marginTop = '16px';
  note.style.color = '#c9d4ff';
  note.style.lineHeight = '1.6';

  controls.append(note);
  root.append(canvas, info);
  canvasHost.append(root);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create a 2D canvas context.');
  }
  const ctx = context;

  const settings: { color: string; speed: number; size: number } = {
    color: '#ff4d6d',
    speed: 220,
    size: 72,
    ...(loadLabState<{ color: string; speed: number; size: number }>(LAB_ID) ?? {}),
  };

  gui.addColor(settings, 'color').name('Color');
  gui.add(settings, 'speed', 50, 480, 1).name('Speed');
  gui.add(settings, 'size', 24, 180, 1).name('Size');
  gui.onChange(() => saveLabState(LAB_ID, settings));

  const rectangle = {
    x: 96,
    y: 96,
    vx: 1,
    vy: 1,
  };

  let animationFrame = 0;
  let lastTime = performance.now();
  let width = 0;
  let height = 0;

  function resizeCanvas(): void {
    const bounds = root.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(bounds.width));
    const nextHeight = Math.max(1, Math.round(bounds.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    width = nextWidth;
    height = nextHeight;

    canvas.width = Math.round(nextWidth * dpr);
    canvas.height = Math.round(nextHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    rectangle.x = Math.min(rectangle.x, Math.max(0, width - settings.size));
    rectangle.y = Math.min(rectangle.y, Math.max(0, height - settings.size));
  }

  function renderFrame(now: number): void {
    const deltaSeconds = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    const size = Math.min(settings.size, width, height);
    rectangle.x += rectangle.vx * settings.speed * deltaSeconds;
    rectangle.y += rectangle.vy * settings.speed * deltaSeconds;

    if (rectangle.x <= 0) {
      rectangle.x = 0;
      rectangle.vx = 1;
    } else if (rectangle.x + size >= width) {
      rectangle.x = Math.max(0, width - size);
      rectangle.vx = -1;
    }

    if (rectangle.y <= 0) {
      rectangle.y = 0;
      rectangle.vy = 1;
    } else if (rectangle.y + size >= height) {
      rectangle.y = Math.max(0, height - size);
      rectangle.vy = -1;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(7, 13, 26, 0.92)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(126, 224, 255, 0.14)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.shadowColor = settings.color;
    ctx.shadowBlur = 24;
    ctx.fillStyle = settings.color;
    ctx.fillRect(rectangle.x, rectangle.y, size, size);
    ctx.shadowBlur = 0;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rectangle.x, rectangle.y, size, size);

    info.textContent = [
      'Hello World Lab',
      `Color: ${settings.color}`,
      `Speed: ${settings.speed.toFixed(0)}`,
      `Size: ${settings.size.toFixed(0)}`,
    ].join('\n');

    animationFrame = window.requestAnimationFrame(renderFrame);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  animationFrame = window.requestAnimationFrame(renderFrame);

  return () => {
    window.cancelAnimationFrame(animationFrame);
    window.removeEventListener('resize', resizeCanvas);
    note.remove();
    root.remove();
  };
}

registerLab('hello-world', {
  category: 'Meta' as LabCategory,
  name: 'Hello World',
  description: 'Basic lab framework test',
  create: createHelloWorldLab,
});
