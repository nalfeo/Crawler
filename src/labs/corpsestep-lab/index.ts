/**
 * Corpse Step Lab — interactive sandbox for `corpseStepSystem`.
 *
 * Drives the REAL system (not a re-implementation): a real `GameWorld` runs
 * `playerInputSystem` → `movementSystem` → `corpseStepSystem` →
 * `deathTimerSystem` each fixed step, exactly like the shipped pipeline order.
 * Walk the player (WASD / arrow keys) over the scattered corpses; each fresh
 * step onto a body rolls the deterministic {@link CORPSE_STEP_TRIGGER_CHANCE}
 * and, on a hit, bursts it (emits a `corpseExplode` event + zeros its
 * `DeathTimer` so `deathTimerSystem` reaps it that frame — a REAL removal, not
 * just a flourish).
 *
 * The single GREEN body is a `Spawner` corpse (rats-nest / slime pit). It is
 * tagged `Enemy` + `DeathTimer` like every other corpse, so it matches the
 * corpse query — but `corpseStepSystem` skips it. Stomp it as much as you like:
 * the "Spawner steps" counter climbs while "Bursts" never does, and the green
 * body never disappears. That is the regression fix for the arena-lock-in bug
 * (bursting a spawner corpse early orphaned the arena and trapped the player).
 *
 * Rendered with a plain 2D canvas so the lab has no sprite/asset dependencies
 * and stays deterministic for a given seed.
 */
import { addComponent, hasComponent, query, removeEntity, set } from 'bitecs';
import type GUI from 'lil-gui';
import { DeathTimer, Enemy, Position, Spawner } from '../../core/components.js';
import { clearEntityStores, createEntity } from '../../core/helpers.js';
import {
  createGameWorld,
  movementSystem,
  playerInputSystem,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import {
  CORPSE_STEP_RANGE_FT,
  CORPSE_STEP_TRIGGER_CHANCE,
  corpseStepSystem,
} from '../../core/systems/corpseStepSystem.js';
import { deathTimerSystem } from '../../core/systems/deathTimerSystem.js';
import { GAME } from '../../shared/constants.js';
import { createInputState, normalizeInputDirection, type InputState } from '../../shared/input.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const BACKGROUND = '#0d0710';
const LAB_SEED = 0xc0_5_57ee9;
const MAX_STEPS_PER_FRAME = 4;
/**
 * Large re-arm value (ms) we stamp onto every surviving corpse each step so
 * `deathTimerSystem`'s natural countdown never expires them during the demo.
 * Only a step-burst (which zeros the timer) removes a body — that keeps the
 * sandbox populated for as long as you want to experiment.
 */
const CORPSE_ARM_MS = 1_000_000;
const PLAYER_RADIUS_PX = 10;
const CORPSE_RADIUS_PX = 9;
const BURST_LIFETIME_MS = 320;

interface Burst {
  x: number;
  y: number;
  ageMs: number;
}

interface CorpseStepLabSettings {
  corpseCount: number;
  playerSpeed: number;
  paused: boolean;
}

function createCorpseStepLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
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
  canvas.tabIndex = 0;
  root.append(canvas);
  canvasHost.append(root);

  const hint = document.createElement('p');
  hint.textContent =
    'Move with WASD / arrow keys and step across the red corpses — each fresh step has a 10% chance to burst one (real removal, not a flourish). The GREEN body is a Spawner corpse: corpseStepSystem skips it, so it never bursts no matter how much you stomp it.';
  hint.style.marginTop = '16px';
  hint.style.color = '#f5b8d0';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for corpse step lab.');
  }

  const settings: CorpseStepLabSettings = {
    corpseCount: 12,
    playerSpeed: 1,
    paused: false,
  };

  let world: GameWorld = createGameWorld({ seed: LAB_SEED });
  let playerEid = -1;
  let spawnerEid = -1;
  let width = 1;
  let height = 1;
  let frameHandle = 0;
  let lastFrameTimeMs = performance.now();
  let accumulator = 0;
  let burstTotal = 0;
  let spawnerStepTotal = 0;
  let spawnerOverlapping = false;
  const bursts: Burst[] = [];

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

  const spawnCorpse = (x: number, y: number, isSpawner: boolean): number => {
    const eid = createEntity(world);
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Position, { x, y }));
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: CORPSE_ARM_MS }));
    if (isSpawner) addComponent(world.ecs, eid, set(Spawner, {}));
    return eid;
  };

  const clearCorpses = () => {
    for (const eid of Array.from(query(world.ecs, [Enemy, DeathTimer]))) {
      if (eid === undefined) continue;
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
    }
  };

  const resetWorld = () => {
    world = createGameWorld({ seed: LAB_SEED });
    accumulator = 0;
    burstTotal = 0;
    spawnerStepTotal = 0;
    spawnerOverlapping = false;
    bursts.length = 0;

    const centerX = pxToFt(width) / 2;
    const centerY = pxToFt(height) / 2;
    playerEid = spawnPlayer(world, centerX, centerY);

    // Scatter regular corpses across the field so the player can wander into them.
    for (let i = 0; i < settings.corpseCount; i++) {
      const marginFt = 2;
      const x = marginFt + world.rng.next() * Math.max(1, pxToFt(width) - marginFt * 2);
      const y = marginFt + world.rng.next() * Math.max(1, pxToFt(height) - marginFt * 2);
      spawnCorpse(x, y, false);
    }

    // One spawner corpse pinned near the centre so it's easy to stomp and
    // observe that it never bursts.
    spawnerEid = spawnCorpse(centerX + 2, centerY, true);
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

  /** Keep every surviving corpse's linger timer topped up so only a burst removes it. */
  const rearmCorpses = () => {
    const { deathTimer } = world.stores;
    for (const eid of query(world.ecs, [Enemy, DeathTimer])) {
      if (eid === undefined) continue;
      if ((deathTimer.remainingMs[eid] ?? 0) > 0) {
        deathTimer.remainingMs[eid] = CORPSE_ARM_MS;
      }
    }
  };

  const trackSpawnerSteps = () => {
    if (spawnerEid < 0 || !hasComponent(world.ecs, spawnerEid, Spawner)) {
      spawnerOverlapping = false;
      return;
    }
    const { position } = world.stores;
    const px = position.x[playerEid] ?? 0;
    const py = position.y[playerEid] ?? 0;
    const sx = position.x[spawnerEid] ?? 0;
    const sy = position.y[spawnerEid] ?? 0;
    const within =
      (px - sx) * (px - sx) + (py - sy) * (py - sy) <= CORPSE_STEP_RANGE_FT * CORPSE_STEP_RANGE_FT;
    if (within && !spawnerOverlapping) spawnerStepTotal += 1; // count the enter-transition
    spawnerOverlapping = within;
  };

  const collectBursts = () => {
    for (const evt of world.combatEvents) {
      if (evt.type !== 'corpseExplode') continue;
      burstTotal += 1;
      bursts.push({ x: evt.x, y: evt.y, ageMs: 0 });
    }
    world.combatEvents.length = 0;
  };

  const stepSimulation = (deltaMs: number) => {
    if (settings.paused) return;
    accumulator += deltaMs;
    let steps = 0;
    while (accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
      world.frameCount += 1;
      world.elapsedMs += GAME.DELTA_MS;

      readInput();
      rearmCorpses();

      playerInputSystem(world, inputState);
      // Scale the player's freshly-set velocity to the tunable lab speed.
      if (playerEid >= 0) {
        world.stores.velocity.x[playerEid] =
          (world.stores.velocity.x[playerEid] ?? 0) * settings.playerSpeed;
        world.stores.velocity.y[playerEid] =
          (world.stores.velocity.y[playerEid] ?? 0) * settings.playerSpeed;
      }
      movementSystem(world);
      corpseStepSystem(world);
      trackSpawnerSteps();
      deathTimerSystem(world);
      collectBursts();

      accumulator -= GAME.DELTA_MS;
      steps += 1;
    }
    if (accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
      accumulator = GAME.DELTA_MS;
    }
  };

  const drawBody = (eid: number) => {
    const { position } = world.stores;
    const x = ftToPx(position.x[eid] ?? 0);
    const y = ftToPx(position.y[eid] ?? 0);
    const isSpawner = hasComponent(world.ecs, eid, Spawner);

    if (isSpawner) {
      context.fillStyle = '#39d98a';
      context.strokeStyle = '#7bffc0';
      context.lineWidth = 2;
      context.beginPath();
      context.rect(
        x - CORPSE_RADIUS_PX,
        y - CORPSE_RADIUS_PX,
        CORPSE_RADIUS_PX * 2,
        CORPSE_RADIUS_PX * 2,
      );
      context.fill();
      context.stroke();
      context.fillStyle = '#04150c';
      context.font = '9px monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('NEST', x, y);
      return;
    }

    context.fillStyle = '#c0303a';
    context.beginPath();
    context.arc(x, y, CORPSE_RADIUS_PX, 0, Math.PI * 2);
    context.fill();
  };

  const render = () => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    // Bursts (expanding fading rings).
    for (const burst of bursts) {
      const bx = ftToPx(burst.x);
      const by = ftToPx(burst.y);
      const t = Math.min(1, burst.ageMs / BURST_LIFETIME_MS);
      const radius = 6 + t * 26;
      context.globalAlpha = 1 - t;
      context.strokeStyle = '#ffb703';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(bx, by, radius, 0, Math.PI * 2);
      context.stroke();
      context.globalAlpha = 1;
    }

    // Corpses.
    for (const eid of query(world.ecs, [Enemy, DeathTimer, Position])) {
      if (eid === undefined) continue;
      drawBody(eid);
    }

    // Player + its step radius.
    if (playerEid >= 0) {
      const px = ftToPx(world.stores.position.x[playerEid] ?? 0);
      const py = ftToPx(world.stores.position.y[playerEid] ?? 0);
      context.strokeStyle = 'rgba(126, 224, 255, 0.35)';
      context.lineWidth = 1;
      context.beginPath();
      context.arc(px, py, ftToPx(CORPSE_STEP_RANGE_FT) + PLAYER_RADIUS_PX, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = '#7ee0ff';
      context.beginPath();
      context.arc(px, py, PLAYER_RADIUS_PX, 0, Math.PI * 2);
      context.fill();
    }

    // HUD.
    const corpseCount = query(world.ecs, [Enemy, DeathTimer]).length;
    context.fillStyle = '#f8fafc';
    context.font = '14px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    const lines = [
      `Corpses: ${corpseCount}   Bursts: ${burstTotal}`,
      `Spawner steps: ${spawnerStepTotal}   Spawner bursts: 0 (excluded)`,
      `Trigger chance: ${(CORPSE_STEP_TRIGGER_CHANCE * 100).toFixed(0)}%   Range: ${CORPSE_STEP_RANGE_FT} ft`,
      settings.paused ? 'PAUSED' : 'WASD / arrows to move',
    ];
    let ty = 16;
    for (const line of lines) {
      context.fillText(line, 16, ty);
      ty += 18;
    }
  };

  const tick = (now: number) => {
    syncCanvasSize();
    const deltaMs = Math.min(now - lastFrameTimeMs, 50);
    lastFrameTimeMs = now;

    stepSimulation(deltaMs);

    for (let i = bursts.length - 1; i >= 0; i--) {
      const burst = bursts[i]!;
      burst.ageMs += deltaMs;
      if (burst.ageMs > BURST_LIFETIME_MS) bursts.splice(i, 1);
    }

    render();
    frameHandle = window.requestAnimationFrame(tick);
  };

  const MOVEMENT_CODES = [
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
  ];
  const onKeyDown = (event: KeyboardEvent) => {
    pressed.add(event.code);
    if (MOVEMENT_CODES.includes(event.code)) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    pressed.delete(event.code);
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  const actions = {
    respawn: () => {
      syncCanvasSize();
      resetWorld();
    },
    clearCorpses: () => {
      clearCorpses();
      spawnerEid = -1;
    },
  };

  gui.add(settings, 'corpseCount', 1, 40, 1).name('Corpse count');
  gui.add(settings, 'playerSpeed', 0.25, 2.5, 0.05).name('Player speed');
  gui.add(settings, 'paused').name('Paused');
  gui.add(actions, 'respawn').name('Respawn Corpses');
  gui.add(actions, 'clearCorpses').name('Clear Corpses');

  const handleResize = () => syncCanvasSize();
  window.addEventListener('resize', handleResize);

  syncCanvasSize();
  resetWorld();
  canvas.focus();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    hint.remove();
    root.remove();
  };
}

registerLab('corpsestep-lab', {
  category: 'Combat' as LabCategory,
  name: 'Corpse Step',
  description:
    'Walk over corpses to trigger the 10% step-burst. Demonstrates that Spawner (nest) corpses are excluded and never burst — the arena-lock-in regression fix.',
  create: createCorpseStepLab,
});
