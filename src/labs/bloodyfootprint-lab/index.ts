import type GUI from 'lil-gui';
import { query } from 'bitecs';
import { Player, Position } from '../../core/components.js';
import { spawnPlayer } from '../../core/helpers.js';
import {
  createGameWorld,
  movementSystem,
  playerInputSystem,
  type GameWorld,
} from '../../core/index.js';
import { bloodyFootprintSystem } from '../../core/systems/bloodyFootprintSystem.js';
import { GAME } from '../../shared/constants.js';
import {
  BLOOD_POOL_FINAL_VERTICAL_SCALE,
  BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS,
  createBloodPoolSurface,
  evaluateBloodPoolLobeScale,
  getBloodPoolRenderColor,
  isBloodyFootprintSourceActive,
  mixBloodColors,
} from '../../shared/blood-surfaces.js';
import { createInputState, normalizeInputDirection, type InputState } from '../../shared/input.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'bloody-footprints-lab';
const LAB_SEED = 0xb100d;
const RED_BLOOD = 0xcc0000;
const BLUE_BLOOD = 0x3355cc;
const MAX_STEPS_PER_FRAME = 4;
const PLAYER_RADIUS_PX = 10;
const FOOT_OFFSET_PX = 4;

interface BloodyFootprintLabSettings {
  paused: boolean;
  speed: number;
}

function createBloodyFootprintsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = '#12090d';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.tabIndex = 0;
  root.append(canvas);
  canvasHost.append(root);

  const hint = document.createElement('p');
  hint.textContent =
    'Walk with WASD / arrow keys through the red and blue pools. The player keeps a ~5s bloody-source window, leaves persistent footsteps while moving, and touching the second pool while still bloody mixes the colors.';
  hint.style.marginTop = '16px';
  hint.style.color = '#f8c8d8';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for bloody-footprints lab.');
  }

  const settings: BloodyFootprintLabSettings = {
    paused: false,
    speed: 1,
  };

  let width = 1;
  let height = 1;
  let world = createGameWorld({ seed: LAB_SEED });
  let playerEid = -1;
  let accumulator = 0;
  let lastFrameMs = performance.now();
  let frameHandle = 0;
  const pressed = new Set<string>();
  const inputState: InputState = createInputState();

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

  const playerPos = (): { x: number; y: number } => {
    const players = query(world.ecs, [Player, Position]);
    const eid = players[0] ?? playerEid;
    return {
      x: world.stores.position.x[eid] ?? 0,
      y: world.stores.position.y[eid] ?? 0,
    };
  };

  const seedPools = () => {
    const centerX = pxToFt(width) / 2;
    const centerY = pxToFt(height) / 2;
    const redPoolX = centerX - 3;
    const bluePoolX = centerX + 5;
    world.bloodPools.push(
      createBloodPoolSurface({
        worldSeed: world.seed,
        poolId: world.bloodyFootprintState.nextPoolId++,
        x: redPoolX,
        y: centerY + 1,
        color: RED_BLOOD,
        createdAtMs: 0,
      }),
      createBloodPoolSurface({
        worldSeed: world.seed,
        poolId: world.bloodyFootprintState.nextPoolId++,
        x: bluePoolX,
        y: centerY + 1,
        color: BLUE_BLOOD,
        createdAtMs: 0,
      }),
    );
  };

  const resetWorld = () => {
    world = createGameWorld({ seed: LAB_SEED });
    accumulator = 0;
    const centerX = pxToFt(width) / 2;
    const centerY = pxToFt(height) / 2;
    playerEid = spawnPlayer(world, centerX - 7, centerY + 1);
    seedPools();
  };

  const readInput = () => {
    const up = pressed.has('KeyW') || pressed.has('ArrowUp');
    const down = pressed.has('KeyS') || pressed.has('ArrowDown');
    const left = pressed.has('KeyA') || pressed.has('ArrowLeft');
    const right = pressed.has('KeyD') || pressed.has('ArrowRight');
    const rawX = (right ? 1 : 0) - (left ? 1 : 0);
    const rawY = (down ? 1 : 0) - (up ? 1 : 0);
    const { moveX, moveY } = normalizeInputDirection(rawX, rawY);
    inputState.moveX = moveX;
    inputState.moveY = moveY;
  };

  const stepSimulation = (deltaMs: number) => {
    if (settings.paused) {
      return;
    }
    accumulator += deltaMs * settings.speed;
    let steps = 0;
    while (accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
      world.frameCount += 1;
      world.elapsedMs += GAME.DELTA_MS;
      readInput();
      playerInputSystem(world, inputState);
      movementSystem(world);
      bloodyFootprintSystem(world);
      accumulator -= GAME.DELTA_MS;
      steps += 1;
    }
  };

  const drawPool = (pool: GameWorld['bloodPools'][number]) => {
    const progress = Math.max(
      0,
      Math.min(
        1,
        (world.elapsedMs - pool.createdAtMs) / Math.max(1, pool.expiresAtMs - pool.createdAtMs),
      ),
    );
    const alpha = 0.55 * (1 - progress);
    context.save();
    context.translate(ftToPx(pool.x + pool.renderOffsetXFt), ftToPx(pool.y + pool.renderOffsetYFt));
    context.scale(1, 1 - (1 - BLOOD_POOL_FINAL_VERTICAL_SCALE) * progress);
    context.fillStyle = `#${getBloodPoolRenderColor(pool.color).toString(16).padStart(6, '0')}`;
    context.globalAlpha = alpha;
    for (const lobe of pool.lobes) {
      const scale = evaluateBloodPoolLobeScale(progress, lobe);
      context.beginPath();
      context.ellipse(
        ftToPx(lobe.offsetXFt),
        ftToPx(lobe.offsetYFt),
        ftToPx(lobe.radiusXFt) * scale,
        ftToPx(lobe.radiusYFt) * scale,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.restore();
  };

  const drawFootprint = (footprint: GameWorld['bloodyFootprints'][number]) => {
    const lifetimeMs = Math.max(1, footprint.expiresAtMs - footprint.createdAtMs);
    const progress = Math.max(
      0,
      Math.min(1, (world.elapsedMs - footprint.createdAtMs) / lifetimeMs),
    );
    context.save();
    context.translate(ftToPx(footprint.x), ftToPx(footprint.y) + FOOT_OFFSET_PX);
    context.rotate(footprint.angleRad);
    context.fillStyle = `#${footprint.color.toString(16).padStart(6, '0')}`;
    context.globalAlpha = 0.58 * (1 - progress);
    if (footprint.smearLengthFt > 0) {
      context.beginPath();
      context.ellipse(
        ftToPx(footprint.toeOffsetFt * 0.5),
        0,
        ftToPx(footprint.smearLengthFt) / 2,
        ftToPx(footprint.smearWidthFt) / 2,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.beginPath();
    context.ellipse(
      0,
      0,
      ftToPx(footprint.heelRadiusXFt),
      ftToPx(footprint.heelRadiusYFt),
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.beginPath();
    context.ellipse(
      ftToPx(footprint.toeOffsetFt),
      0,
      ftToPx(footprint.toeRadiusXFt),
      ftToPx(footprint.toeRadiusYFt),
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
  };

  const render = () => {
    syncCanvasSize();
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#12090d';
    context.fillRect(0, 0, width, height);

    for (const pool of world.bloodPools) {
      drawPool(pool);
    }
    for (const footprint of world.bloodyFootprints) {
      drawFootprint(footprint);
    }

    const { x, y } = playerPos();
    context.fillStyle = '#f6f3ea';
    context.beginPath();
    context.arc(ftToPx(x), ftToPx(y), PLAYER_RADIUS_PX, 0, Math.PI * 2);
    context.fill();

    const activeSource = isBloodyFootprintSourceActive(
      world.bloodyFootprintState.source,
      world.elapsedMs,
    )
      ? world.bloodyFootprintState.source
      : null;
    const mixedPreview = mixBloodColors(RED_BLOOD, BLUE_BLOOD);
    context.fillStyle = '#fce7f3';
    context.font = '14px monospace';
    context.fillText(
      `source=${activeSource ? `#${activeSource.color.toString(16).padStart(6, '0')}` : 'none'}  expires≈${activeSource ? Math.max(0, Math.round((activeSource.expiresAtMs - world.elapsedMs) / 100) / 10) : 0}s`,
      16,
      24,
    );
    context.fillText(`footprints=${world.bloodyFootprints.length}`, 16, 44);
    context.fillText(
      `expected mix red+blue=#${mixedPreview.toString(16).padStart(6, '0')}`,
      16,
      64,
    );
    context.fillText(`window=${BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS / 1000}s`, 16, 84);
  };

  const frame = (timestampMs: number) => {
    const deltaMs = Math.min(100, Math.max(0, timestampMs - lastFrameMs));
    lastFrameMs = timestampMs;
    stepSimulation(deltaMs);
    render();
    frameHandle = window.requestAnimationFrame(frame);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    pressed.add(event.code);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    pressed.delete(event.code);
  };

  gui.add(settings, 'paused').name('Paused');
  gui.add(settings, 'speed', 0.5, 2, 0.25).name('Speed');
  gui.add({ reset: () => resetWorld() }, 'reset').name('Reset');

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  syncCanvasSize();
  resetWorld();
  render();
  frameHandle = window.requestAnimationFrame(frame);
  canvas.focus();

  return () => {
    window.cancelAnimationFrame(frameHandle);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    gui.destroy();
  };
}

registerLab(LAB_ID, {
  name: 'Bloody Footprints',
  category: 'Combat' satisfies LabCategory,
  create: createBloodyFootprintsLab,
  description:
    'Drives the real bloodyFootprintSystem in a deterministic sandbox with authored blood pools so you can observe the 5s source window, footprint persistence, and cross-pool color mixing.',
});
