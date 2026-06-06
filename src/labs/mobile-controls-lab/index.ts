import type GUI from 'lil-gui';
import { getGlobalControlsConfig, setGlobalControlsConfig } from '../../engine/controls-config.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type MoveMode = 'joystick' | 'follow';

interface MobileControlsLabSettings {
  moveMode: MoveMode;
  joystickRadius: number;
  deadZone: number;
  followSpeed: number;
  followArrivalDist: number;
  showDebugOverlay: boolean;
  actionButtonSize: number;
  actionButtonPadding: number;
  hapticFeedback: boolean;
}

type PersistedMobileControlsLabSettings = Omit<MobileControlsLabSettings, 'moveMode'>;

interface TouchInfo {
  zone: 'move' | 'action';
  startX: number;
  startY: number;
  x: number;
  y: number;
}

const LAB_ID = 'mobile-controls-lab';
const BACKGROUND_COLOR = '#0d0d14';
const ACTION_BTN_COLOR = 'rgba(220, 60, 60, 1)';
const ACTION_BTN_PRESSED_COLOR = 'rgba(255, 90, 90, 1)';

function createMobileControlsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const persistedSettings = loadLabState<PersistedMobileControlsLabSettings>(LAB_ID) ?? {};

  const settings: MobileControlsLabSettings = {
    joystickRadius: 60,
    deadZone: 0.15,
    followSpeed: 5,
    followArrivalDist: 8,
    showDebugOverlay: true,
    actionButtonSize: 72,
    actionButtonPadding: 32,
    hapticFeedback: true,
    ...persistedSettings,
    moveMode: getGlobalControlsConfig().mobileMoveMode,
  };

  // --- DOM setup ---
  const root = document.createElement('div');
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.background = BACKGROUND_COLOR;
  root.style.color = '#f4f7fb';
  root.style.fontFamily = 'monospace';
  root.style.position = 'relative';
  root.style.overflow = 'hidden';
  root.style.touchAction = 'none';
  root.style.userSelect = 'none';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';

  const readout = document.createElement('div');
  readout.style.position = 'absolute';
  readout.style.top = '12px';
  readout.style.left = '12px';
  readout.style.padding = '10px 14px';
  readout.style.borderRadius = '10px';
  readout.style.background = 'rgba(0, 0, 0, 0.7)';
  readout.style.fontSize = '12px';
  readout.style.lineHeight = '1.6';
  readout.style.whiteSpace = 'pre';
  readout.style.pointerEvents = 'none';
  readout.style.zIndex = '10';

  const hint = document.createElement('p');
  hint.innerHTML =
    '<b>Joystick mode:</b> drag anywhere outside the action button to move.<br>' +
    '<b>Follow mode:</b> touch anywhere and the entity moves toward your finger.<br>' +
    'The <b>action button</b> (bottom-right) fires. Click/drag on desktop to emulate touch.';
  hint.style.marginTop = '16px';
  hint.style.color = '#7ee0ff';
  hint.style.lineHeight = '1.6';

  root.append(canvas, readout);
  canvasHost.append(root);
  controls.append(hint);

  // --- State ---
  const activeTouches = new Map<number, TouchInfo>();
  const MOUSE_POINTER_ID = -100;
  let moveOutput = { x: 0, y: 0 };
  let actionActive = false;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let animationFrame = 0;

  const entity = { x: 0, y: 0 };

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create 2D canvas context.');
  const ctx = context;

  // --- lil-gui ---
  gui
    .add(settings, 'moveMode', ['joystick', 'follow'])
    .name('Move Mode')
    .onChange((value: MoveMode) => {
      setGlobalControlsConfig({ mobileMoveMode: value });
    });

  const joystickFolder = gui.addFolder('Joystick Settings');
  joystickFolder.add(settings, 'joystickRadius', 30, 120, 5).name('Radius');
  joystickFolder.add(settings, 'deadZone', 0, 0.5, 0.01).name('Dead Zone');

  const followFolder = gui.addFolder('Follow Settings');
  followFolder.add(settings, 'followSpeed', 1, 15, 0.5).name('Speed');
  followFolder.add(settings, 'followArrivalDist', 2, 30, 1).name('Arrival Dist');

  gui.add(settings, 'actionButtonSize', 50, 120, 2).name('Action Btn Size');
  gui.add(settings, 'actionButtonPadding', 16, 80, 4).name('Action Btn Pad');
  gui.add(settings, 'showDebugOverlay').name('Debug Overlay');
  gui.add(settings, 'hapticFeedback').name('Haptic Feedback');
  gui.onChange(() => {
    saveLabState(LAB_ID, {
      joystickRadius: settings.joystickRadius,
      deadZone: settings.deadZone,
      followSpeed: settings.followSpeed,
      followArrivalDist: settings.followArrivalDist,
      showDebugOverlay: settings.showDebugOverlay,
      actionButtonSize: settings.actionButtonSize,
      actionButtonPadding: settings.actionButtonPadding,
      hapticFeedback: settings.hapticFeedback,
    });
  });

  // --- Hit testing for the action button ---
  function getActionBtnCenter(): { x: number; y: number } {
    const btnR = settings.actionButtonSize / 2;
    return {
      x: canvasWidth - settings.actionButtonPadding - btnR,
      y: canvasHeight - settings.actionButtonPadding - btnR,
    };
  }

  function isInsideActionButton(clientX: number, clientY: number): boolean {
    const rect = root.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const btn = getActionBtnCenter();
    const btnR = settings.actionButtonSize / 2;
    return Math.hypot(localX - btn.x, localY - btn.y) <= btnR + 10; // small hit margin
  }

  function classifyZone(clientX: number, clientY: number): 'move' | 'action' {
    return isInsideActionButton(clientX, clientY) ? 'action' : 'move';
  }

  // --- Touch handling ---
  function onTouchStart(e: TouchEvent): void {
    for (const touch of e.changedTouches) {
      activeTouches.set(touch.identifier, {
        zone: classifyZone(touch.clientX, touch.clientY),
        startX: touch.clientX,
        startY: touch.clientY,
        x: touch.clientX,
        y: touch.clientY,
      });
    }

    if (settings.hapticFeedback && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }

  function onTouchMove(e: TouchEvent): void {
    for (const touch of e.changedTouches) {
      const info = activeTouches.get(touch.identifier);
      if (info) {
        info.x = touch.clientX;
        info.y = touch.clientY;
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  function onTouchEnd(e: TouchEvent): void {
    for (const touch of e.changedTouches) {
      activeTouches.delete(touch.identifier);
    }
  }

  // Mouse emulation for desktop testing
  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    if (e.button !== 0) return;
    activeTouches.set(MOUSE_POINTER_ID, {
      zone: classifyZone(e.clientX, e.clientY),
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
    });
    if ((e.target as Element)?.setPointerCapture) {
      (e.target as Element).setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const info = activeTouches.get(MOUSE_POINTER_ID);
    if (info) {
      info.x = e.clientX;
      info.y = e.clientY;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    if (e.button !== 0) return;
    activeTouches.delete(MOUSE_POINTER_ID);
    if ((e.target as Element)?.releasePointerCapture) {
      try {
        (e.target as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
  }

  // --- Input processing ---
  function processJoystickInput(): void {
    let rawX = 0;
    let rawY = 0;

    for (const touch of activeTouches.values()) {
      if (touch.zone === 'move') {
        const dx = touch.x - touch.startX;
        const dy = touch.y - touch.startY;
        rawX = Math.max(-1, Math.min(1, dx / settings.joystickRadius));
        rawY = Math.max(-1, Math.min(1, dy / settings.joystickRadius));
        break;
      }
    }

    const magnitude = Math.hypot(rawX, rawY);
    if (magnitude === 0 || magnitude < settings.deadZone) {
      moveOutput = { x: 0, y: 0 };
    } else {
      const remapped = (magnitude - settings.deadZone) / (1 - settings.deadZone);
      const clamped = Math.min(1, remapped);
      moveOutput = {
        x: (rawX / magnitude) * clamped,
        y: (rawY / magnitude) * clamped,
      };
    }
  }

  function processFollowInput(): void {
    let moveTouch: TouchInfo | undefined;
    for (const touch of activeTouches.values()) {
      if (touch.zone === 'move') {
        moveTouch = touch;
        break;
      }
    }

    if (!moveTouch) {
      moveOutput = { x: 0, y: 0 };
      return;
    }

    // Convert touch position to canvas-local coords
    const rect = root.getBoundingClientRect();
    const targetX = moveTouch.x - rect.left;
    const targetY = moveTouch.y - rect.top;

    const dx = targetX - entity.x;
    const dy = targetY - entity.y;
    const dist = Math.hypot(dx, dy);

    if (dist < settings.followArrivalDist) {
      moveOutput = { x: 0, y: 0 };
    } else {
      // Normalize direction, scale by distance for smoother approach
      const strength = Math.min(1, dist / 100);
      moveOutput = {
        x: (dx / dist) * strength,
        y: (dy / dist) * strength,
      };
    }
  }

  function processInput(): void {
    actionActive = false;
    for (const touch of activeTouches.values()) {
      if (touch.zone === 'action') {
        actionActive = true;
        break;
      }
    }

    if (settings.moveMode === 'joystick') {
      processJoystickInput();
    } else {
      processFollowInput();
    }
  }

  // --- Rendering ---
  function resizeCanvas(): void {
    const rect = root.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvasWidth = Math.max(1, Math.round(rect.width));
    canvasHeight = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (entity.x === 0 && entity.y === 0) {
      entity.x = canvasWidth / 2;
      entity.y = canvasHeight / 2;
    }
  }

  function drawJoystickOverlay(): void {
    let moveTouch: TouchInfo | undefined;
    for (const touch of activeTouches.values()) {
      if (touch.zone === 'move') {
        moveTouch = touch;
        break;
      }
    }

    if (!moveTouch) return;

    const rect = root.getBoundingClientRect();
    const baseX = moveTouch.startX - rect.left;
    const baseY = moveTouch.startY - rect.top;
    const thumbX = moveTouch.x - rect.left;
    const thumbY = moveTouch.y - rect.top;

    // Base circle
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(126, 224, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.arc(baseX, baseY, settings.joystickRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Dead zone ring
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 216, 77, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.arc(baseX, baseY, settings.joystickRadius * settings.deadZone, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Thumb (clamped to radius)
    const dx = thumbX - baseX;
    const dy = thumbY - baseY;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, settings.joystickRadius);
    const angle = Math.atan2(dy, dx);
    const clampedX = baseX + Math.cos(angle) * clampedDist;
    const clampedY = baseY + Math.sin(angle) * clampedDist;

    ctx.beginPath();
    ctx.fillStyle = 'rgba(126, 224, 255, 0.85)';
    ctx.shadowColor = '#7ee0ff';
    ctx.shadowBlur = 12;
    ctx.arc(clampedX, clampedY, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawFollowTarget(): void {
    let moveTouch: TouchInfo | undefined;
    for (const touch of activeTouches.values()) {
      if (touch.zone === 'move') {
        moveTouch = touch;
        break;
      }
    }

    if (!moveTouch) return;

    const rect = root.getBoundingClientRect();
    const targetX = moveTouch.x - rect.left;
    const targetY = moveTouch.y - rect.top;

    // Crosshair at finger position
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(126, 224, 255, 0.6)';
    ctx.lineWidth = 1.5;
    const size = 12;
    ctx.moveTo(targetX - size, targetY);
    ctx.lineTo(targetX + size, targetY);
    ctx.moveTo(targetX, targetY - size);
    ctx.lineTo(targetX, targetY + size);
    ctx.stroke();

    // Arrival radius
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 216, 77, 0.3)';
    ctx.setLineDash([3, 3]);
    ctx.arc(targetX, targetY, settings.followArrivalDist, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Line from entity to target
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(126, 224, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.moveTo(entity.x, entity.y);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawActionButton(): void {
    const btn = getActionBtnCenter();
    const btnR = settings.actionButtonSize / 2;

    // Opaque solid button
    ctx.beginPath();
    ctx.fillStyle = actionActive ? ACTION_BTN_PRESSED_COLOR : ACTION_BTN_COLOR;
    ctx.shadowColor = actionActive ? '#ff5a5a' : '#dc3c3c';
    ctx.shadowBlur = actionActive ? 20 : 8;
    ctx.arc(btn.x, btn.y, btnR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Border
    ctx.beginPath();
    ctx.strokeStyle = actionActive ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.arc(btn.x, btn.y, btnR, 0, Math.PI * 2);
    ctx.stroke();

    // Label
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(btnR * 0.45)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ATK', btn.x, btn.y);
  }

  function drawEntity(): void {
    const speed = settings.moveMode === 'follow' ? settings.followSpeed : 4;
    entity.x += moveOutput.x * speed;
    entity.y += moveOutput.y * speed;

    // Clamp to bounds
    entity.x = Math.max(0, Math.min(canvasWidth, entity.x));
    entity.y = Math.max(0, Math.min(canvasHeight, entity.y));

    // Draw entity
    ctx.beginPath();
    ctx.fillStyle = actionActive ? '#ff6464' : '#7ee0ff';
    ctx.shadowColor = actionActive ? '#ff6464' : '#7ee0ff';
    ctx.shadowBlur = 16;
    ctx.arc(entity.x, entity.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Direction indicator
    if (moveOutput.x !== 0 || moveOutput.y !== 0) {
      const arrowLen = 22;
      ctx.beginPath();
      ctx.strokeStyle = '#7ee0ff';
      ctx.lineWidth = 2;
      ctx.moveTo(entity.x, entity.y);
      ctx.lineTo(entity.x + moveOutput.x * arrowLen, entity.y + moveOutput.y * arrowLen);
      ctx.stroke();
    }
  }

  function drawModeLabel(): void {
    const label = settings.moveMode === 'joystick' ? '🕹️ JOYSTICK' : '👆 FOLLOW FINGER';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, canvasWidth / 2, 10);
  }

  function renderFrame(): void {
    processInput();

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    drawModeLabel();
    drawEntity();

    if (settings.moveMode === 'joystick') {
      drawJoystickOverlay();
    } else {
      drawFollowTarget();
    }

    drawActionButton();

    // Debug readout
    if (settings.showDebugOverlay) {
      const magnitude = Math.hypot(moveOutput.x, moveOutput.y);
      const angle =
        magnitude === 0
          ? '—'
          : `${(((Math.atan2(moveOutput.y, moveOutput.x) * 180) / Math.PI + 360) % 360).toFixed(1)}°`;

      readout.style.display = 'block';
      readout.textContent = [
        `mode: ${settings.moveMode}`,
        `move: (${moveOutput.x.toFixed(3)}, ${moveOutput.y.toFixed(3)})`,
        `magnitude: ${magnitude.toFixed(3)}`,
        `angle: ${angle}`,
        `action: ${actionActive ? '🔴 ACTIVE' : '⚪ idle'}`,
        `touches: ${activeTouches.size}`,
      ].join('\n');
    } else {
      readout.style.display = 'none';
    }

    animationFrame = window.requestAnimationFrame(renderFrame);
  }

  // --- Event binding ---
  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('touchend', onTouchEnd, { passive: true });
  root.addEventListener('touchcancel', onTouchEnd, { passive: true });
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);

  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(root);

  resizeCanvas();
  animationFrame = window.requestAnimationFrame(renderFrame);

  // --- Cleanup ---
  return () => {
    window.cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    root.removeEventListener('touchstart', onTouchStart);
    root.removeEventListener('touchmove', onTouchMove);
    root.removeEventListener('touchend', onTouchEnd);
    root.removeEventListener('touchcancel', onTouchEnd);
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', onPointerUp);
    hint.remove();
    root.remove();
  };
}

registerLab('mobile-controls-lab', {
  category: 'Movement & Physics' as LabCategory,
  name: 'Mobile Controls Lab',
  description:
    'Virtual joystick and follow-finger movement with opaque action button for mobile iteration.',
  create: createMobileControlsLab,
});
