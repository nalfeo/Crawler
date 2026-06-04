import type GUI from 'lil-gui';
import { SeededRandom } from '../../shared/random.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type KnockbackState = {
  dirX: number;
  dirY: number;
  speed: number;
  remaining: number;
};

type LabEntity = {
  id: number;
  x: number;
  y: number;
  knockback: KnockbackState | null;
};

type DragState = {
  entityId: number;
  pointerId: number;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
};

type PendingSpawn = {
  pointerId: number;
  x: number;
  y: number;
};

interface KnockbackLabSettings {
  speed: number;
  distance: number;
  entityCount: number;
}

const BACKGROUND = '#0d0d14';
const ENTITY_RADIUS = 16;
const CYAN = '#22d3ee';
const ORANGE = '#fb923c';
const LAB_PADDING = 96;
const MIN_DRAG_DISTANCE = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function drawArrow(
  context: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.hypot(dx, dy);

  if (length <= 0.001) {
    return;
  }

  const dirX = dx / length;
  const dirY = dy / length;
  const headSize = 10;
  const leftX = toX - dirX * headSize - dirY * headSize * 0.65;
  const leftY = toY - dirY * headSize + dirX * headSize * 0.65;
  const rightX = toX - dirX * headSize + dirY * headSize * 0.65;
  const rightY = toY - dirY * headSize - dirX * headSize * 0.65;

  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 3;
  context.lineCap = 'round';

  context.beginPath();
  context.moveTo(fromX, fromY);
  context.lineTo(toX, toY);
  context.stroke();

  context.beginPath();
  context.moveTo(toX, toY);
  context.lineTo(leftX, leftY);
  context.lineTo(rightX, rightY);
  context.closePath();
  context.fill();
}

function createKnockbackLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
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
  canvas.style.cursor = 'crosshair';
  canvas.style.touchAction = 'none';

  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '10px 12px';
  hud.style.borderRadius = '12px';
  hud.style.background = 'rgba(15, 23, 42, 0.78)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.1)';
  hud.style.color = '#f8fafc';
  hud.style.fontFamily = 'monospace';
  hud.style.fontSize = '13px';
  hud.style.lineHeight = '1.45';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Click empty space to spawn entities. Drag from an entity to apply knockback. Use Knock All to blast every entity in a random direction.';
  hint.style.marginTop = '16px';
  hint.style.color = '#cbd5f5';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(canvas, hud);
  canvasHost.append(root);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for knockback lab.');
  }

  const settings: KnockbackLabSettings = {
    speed: 8,
    distance: 100,
    entityCount: 6,
  };

  const random = new SeededRandom(0x4b1d2026);
  const entities: LabEntity[] = [];
  let nextEntityId = 1;
  let width = 1;
  let height = 1;
  let frameHandle = 0;
  let activeDrag: DragState | null = null;
  let pendingSpawn: PendingSpawn | null = null;

  const findEntityAt = (x: number, y: number): LabEntity | undefined => {
    for (let index = entities.length - 1; index >= 0; index -= 1) {
      const entity = entities[index];
      if (!entity) {
        continue;
      }

      if (Math.hypot(entity.x - x, entity.y - y) <= ENTITY_RADIUS) {
        return entity;
      }
    }

    return undefined;
  };

  const updateHud = () => {
    const activeCount = entities.filter((entity) => entity.knockback !== null).length;
    hud.textContent = [
      `Entities: ${entities.length}`,
      `Active knockbacks: ${activeCount}`,
      `Speed/frame: ${settings.speed}`,
      `Max distance: ${settings.distance}`,
    ].join('\n');
  };

  const syncCanvasSize = () => {
    const nextWidth = Math.max(1, Math.floor(root.clientWidth));
    const nextHeight = Math.max(1, Math.floor(root.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.floor(nextWidth * dpr));
    const pixelHeight = Math.max(1, Math.floor(nextHeight * dpr));

    if (canvas.width === pixelWidth && canvas.height === pixelHeight) {
      width = nextWidth;
      height = nextHeight;
      return;
    }

    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    width = nextWidth;
    height = nextHeight;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);
  };

  const spawnEntity = (x: number, y: number) => {
    entities.push({
      id: nextEntityId,
      x,
      y,
      knockback: null,
    });
    nextEntityId += 1;
    updateHud();
  };

  const applyKnockback = (entity: LabEntity, dirX: number, dirY: number, remaining: number) => {
    entity.knockback = {
      dirX,
      dirY,
      speed: settings.speed,
      remaining,
    };
    updateHud();
  };

  const respawnGrid = () => {
    entities.length = 0;
    nextEntityId = 1;
    activeDrag = null;
    pendingSpawn = null;

    const count = Math.max(2, Math.floor(settings.entityCount));
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / columns));
    const horizontalPadding = Math.min(LAB_PADDING, Math.max(40, width * 0.16));
    const verticalPadding = Math.min(LAB_PADDING, Math.max(40, height * 0.16));
    const minX = horizontalPadding;
    const maxX = Math.max(minX, width - horizontalPadding);
    const minY = verticalPadding;
    const maxY = Math.max(minY, height - verticalPadding);

    for (let index = 0; index < count; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = columns === 1 ? width / 2 : lerp(minX, maxX, column / (columns - 1));
      const y = rows === 1 ? height / 2 : lerp(minY, maxY, row / (rows - 1));
      spawnEntity(x, y);
    }
  };

  const knockAll = () => {
    for (const entity of entities) {
      const angle = random.next() * Math.PI * 2;
      applyKnockback(entity, Math.cos(angle), Math.sin(angle), settings.distance);
    }
    updateHud();
  };

  const getCanvasPosition = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp(event.clientX - rect.left, 0, rect.width),
      y: clamp(event.clientY - rect.top, 0, rect.height),
    };
  };

  const onPointerDown = (event: PointerEvent) => {
    const position = getCanvasPosition(event);
    const entity = findEntityAt(position.x, position.y);

    if (entity) {
      activeDrag = {
        entityId: entity.id,
        pointerId: event.pointerId,
        originX: entity.x,
        originY: entity.y,
        currentX: position.x,
        currentY: position.y,
      };
      pendingSpawn = null;
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    pendingSpawn = { pointerId: event.pointerId, x: position.x, y: position.y };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
      return;
    }

    const position = getCanvasPosition(event);
    activeDrag.currentX = position.x;
    activeDrag.currentY = position.y;
  };

  const clearInteraction = (pointerId: number) => {
    if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    activeDrag = null;
    pendingSpawn = null;
  };

  const onPointerUp = (event: PointerEvent) => {
    const position = getCanvasPosition(event);

    if (activeDrag && activeDrag.pointerId === event.pointerId) {
      const entity = entities.find((candidate) => candidate.id === activeDrag?.entityId);
      const dx = position.x - activeDrag.originX;
      const dy = position.y - activeDrag.originY;
      const magnitude = Math.hypot(dx, dy);

      if (entity && magnitude >= MIN_DRAG_DISTANCE) {
        const limitedDistance = Math.min(settings.distance, magnitude);
        applyKnockback(entity, dx / magnitude, dy / magnitude, limitedDistance);
      }

      clearInteraction(event.pointerId);
      return;
    }

    if (pendingSpawn && pendingSpawn.pointerId === event.pointerId) {
      spawnEntity(position.x, position.y);
      clearInteraction(event.pointerId);
    }
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (activeDrag?.pointerId === event.pointerId || pendingSpawn?.pointerId === event.pointerId) {
      clearInteraction(event.pointerId);
    }
  };

  const render = () => {
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    context.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    context.lineWidth = 1;
    for (let x = 0; x <= width; x += 48) {
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
    for (let y = 0; y <= height; y += 48) {
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
      context.stroke();
    }

    for (const entity of entities) {
      const isActive = entity.knockback !== null;
      const fill = isActive ? ORANGE : CYAN;

      context.beginPath();
      context.arc(entity.x, entity.y, ENTITY_RADIUS, 0, Math.PI * 2);
      context.fillStyle = fill;
      context.fill();
      context.lineWidth = 3;
      context.strokeStyle = isActive ? 'rgba(255, 237, 213, 0.95)' : 'rgba(207, 250, 254, 0.95)';
      context.stroke();

      if (entity.knockback) {
        const arrowLength = 28 + Math.min(entity.knockback.remaining, 42);
        drawArrow(
          context,
          entity.x,
          entity.y,
          entity.x + entity.knockback.dirX * arrowLength,
          entity.y + entity.knockback.dirY * arrowLength,
          '#fdba74',
        );
      }
    }

    if (activeDrag) {
      const dragDx = activeDrag.currentX - activeDrag.originX;
      const dragDy = activeDrag.currentY - activeDrag.originY;
      const dragLength = Math.hypot(dragDx, dragDy);

      context.save();
      context.setLineDash([10, 6]);
      context.strokeStyle = 'rgba(251, 146, 60, 0.9)';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(activeDrag.originX, activeDrag.originY);
      context.lineTo(activeDrag.currentX, activeDrag.currentY);
      context.stroke();
      context.restore();

      if (dragLength >= MIN_DRAG_DISTANCE) {
        drawArrow(
          context,
          activeDrag.originX,
          activeDrag.originY,
          activeDrag.currentX,
          activeDrag.currentY,
          ORANGE,
        );
      }
    }
  };

  const tick = () => {
    syncCanvasSize();

    for (const entity of entities) {
      if (!entity.knockback) {
        continue;
      }

      const remaining = entity.knockback.remaining;
      const speed = entity.knockback.speed;

      if (remaining <= 0 || speed <= 0) {
        entity.knockback = null;
        continue;
      }

      const step = Math.min(speed, remaining);
      entity.x += entity.knockback.dirX * step;
      entity.y += entity.knockback.dirY * step;
      entity.knockback.remaining = remaining - step;

      if (entity.knockback.remaining <= 0) {
        entity.knockback = null;
      }
    }

    render();
    updateHud();
    frameHandle = window.requestAnimationFrame(tick);
  };

  const actions = {
    knockAll,
    reset: respawnGrid,
  };

  const folder = gui.addFolder('Knockback');
  folder.add(settings, 'speed', 1, 20, 1).name('speed');
  folder.add(settings, 'distance', 10, 300, 1).name('distance');
  folder
    .add(settings, 'entityCount', 2, 20, 1)
    .name('entityCount')
    .onFinishChange(() => respawnGrid());
  folder.add(actions, 'knockAll').name('Knock All');
  folder.add(actions, 'reset').name('Reset');
  folder.open();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  syncCanvasSize();
  respawnGrid();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    folder.destroy();
    hint.remove();
    root.remove();
  };
}

registerLab('knockback-lab', {
  category: 'Combat' as LabCategory,
  name: 'Knockback',
  description: 'Interactive canvas visualization for knockback direction, speed, and distance.',
  create: createKnockbackLab,
});
