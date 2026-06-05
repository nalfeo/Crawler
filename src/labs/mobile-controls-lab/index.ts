import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface MobileControlsLabSettings {
  joystickRadius: number;
  deadZone: number;
  showDebugOverlay: boolean;
  actionButtonSize: number;
  opacity: number;
  hapticFeedback: boolean;
}

interface TouchInfo {
  zone: 'move' | 'action';
  startX: number;
  startY: number;
  x: number;
  y: number;
}

const LAB_ID = 'mobile-controls-lab';
const BACKGROUND_COLOR = '#0d0d14';

function createMobileControlsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: MobileControlsLabSettings = {
    joystickRadius: 60,
    deadZone: 0.15,
    showDebugOverlay: true,
    actionButtonSize: 70,
    opacity: 0.6,
    hapticFeedback: true,
    ...(loadLabState<MobileControlsLabSettings>(LAB_ID) ?? {}),
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
    'Touch the <b>left half</b> to move (virtual joystick) and the <b>right half</b> to fire. ' +
    'On desktop, click and drag to emulate touch. Tune deadzone and radius with the controls.';
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

  // Player entity position
  const entity = { x: 0, y: 0 };

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create 2D canvas context.');
  const ctx = context;

  // --- lil-gui ---
  gui.add(settings, 'joystickRadius', 30, 120, 5).name('Joystick Radius');
  gui.add(settings, 'deadZone', 0, 0.5, 0.01).name('Dead Zone');
  gui.add(settings, 'actionButtonSize', 40, 120, 5).name('Action Btn Size');
  gui.add(settings, 'opacity', 0.1, 1, 0.05).name('Control Opacity');
  gui.add(settings, 'showDebugOverlay').name('Debug Overlay');
  gui.add(settings, 'hapticFeedback').name('Haptic Feedback');
  gui.onChange(() => saveLabState(LAB_ID, settings));

  // --- Touch handling ---
  function classifyZone(clientX: number): 'move' | 'action' {
    const rect = root.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2 ? 'move' : 'action';
  }

  function onTouchStart(e: TouchEvent): void {
    for (const touch of e.changedTouches) {
      activeTouches.set(touch.identifier, {
        zone: classifyZone(touch.clientX),
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
      zone: classifyZone(e.clientX),
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
  function processInput(): void {
    let rawX = 0;
    let rawY = 0;
    actionActive = false;

    for (const touch of activeTouches.values()) {
      if (touch.zone === 'move') {
        const dx = touch.x - touch.startX;
        const dy = touch.y - touch.startY;
        rawX = Math.max(-1, Math.min(1, dx / settings.joystickRadius));
        rawY = Math.max(-1, Math.min(1, dy / settings.joystickRadius));
      } else {
        actionActive = true;
      }
    }

    // Apply dead zone
    const magnitude = Math.hypot(rawX, rawY);
    if (magnitude < settings.deadZone) {
      moveOutput = { x: 0, y: 0 };
    } else {
      // Remap from [deadZone, 1] to [0, 1]
      const remapped = (magnitude - settings.deadZone) / (1 - settings.deadZone);
      const clamped = Math.min(1, remapped);
      moveOutput = {
        x: (rawX / magnitude) * clamped,
        y: (rawY / magnitude) * clamped,
      };
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

  function drawJoystick(): void {
    // Find the active move touch
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

    const alpha = settings.opacity;

    // Base circle
    ctx.beginPath();
    ctx.strokeStyle = `rgba(126, 224, 255, ${alpha * 0.5})`;
    ctx.lineWidth = 2;
    ctx.arc(baseX, baseY, settings.joystickRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Dead zone ring
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 216, 77, ${alpha * 0.4})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.arc(baseX, baseY, settings.joystickRadius * settings.deadZone, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Thumb
    const dx = thumbX - baseX;
    const dy = thumbY - baseY;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, settings.joystickRadius);
    const angle = Math.atan2(dy, dx);
    const clampedX = baseX + Math.cos(angle) * clampedDist;
    const clampedY = baseY + Math.sin(angle) * clampedDist;

    ctx.beginPath();
    ctx.fillStyle = `rgba(126, 224, 255, ${alpha * 0.8})`;
    ctx.shadowColor = '#7ee0ff';
    ctx.shadowBlur = 12;
    ctx.arc(clampedX, clampedY, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawActionButton(): void {
    // Find active action touch
    let actionTouch: TouchInfo | undefined;
    for (const touch of activeTouches.values()) {
      if (touch.zone === 'action') {
        actionTouch = touch;
        break;
      }
    }

    // Draw static action zone indicator (bottom-right)
    const btnX = canvasWidth - 80;
    const btnY = canvasHeight - 80;
    const btnR = settings.actionButtonSize / 2;
    const alpha = settings.opacity;

    ctx.beginPath();
    ctx.strokeStyle = actionTouch
      ? `rgba(255, 100, 100, ${alpha})`
      : `rgba(255, 100, 100, ${alpha * 0.4})`;
    ctx.fillStyle = actionTouch
      ? `rgba(255, 100, 100, ${alpha * 0.3})`
      : `rgba(255, 100, 100, ${alpha * 0.1})`;
    ctx.lineWidth = 2;
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Label
    ctx.fillStyle = `rgba(255, 100, 100, ${alpha})`;
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ACT', btnX, btnY);
  }

  function drawDivider(): void {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.moveTo(canvasWidth / 2, 0);
    ctx.lineTo(canvasWidth / 2, canvasHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    // Zone labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('MOVE', canvasWidth / 4, 10);
    ctx.fillText('ACTION', (canvasWidth * 3) / 4, 10);
  }

  function drawEntity(): void {
    // Move entity based on processed input
    const speed = 4;
    entity.x += moveOutput.x * speed;
    entity.y += moveOutput.y * speed;

    // Wrap around edges
    if (entity.x < 0) entity.x += canvasWidth;
    if (entity.x >= canvasWidth) entity.x -= canvasWidth;
    if (entity.y < 0) entity.y += canvasHeight;
    if (entity.y >= canvasHeight) entity.y -= canvasHeight;

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
      const arrowLen = 20;
      ctx.beginPath();
      ctx.strokeStyle = '#7ee0ff';
      ctx.lineWidth = 2;
      ctx.moveTo(entity.x, entity.y);
      ctx.lineTo(entity.x + moveOutput.x * arrowLen, entity.y + moveOutput.y * arrowLen);
      ctx.stroke();
    }
  }

  function renderFrame(): void {
    processInput();

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    drawDivider();
    drawEntity();
    drawJoystick();
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
        `move: (${moveOutput.x.toFixed(3)}, ${moveOutput.y.toFixed(3)})`,
        `magnitude: ${magnitude.toFixed(3)}`,
        `angle: ${angle}`,
        `action: ${actionActive ? '🔴 ACTIVE' : '⚪ idle'}`,
        `touches: ${activeTouches.size}`,
        `deadZone: ${settings.deadZone}`,
        `radius: ${settings.joystickRadius}px`,
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
    'Virtual joystick and action button sandbox for iterating on mobile touch controls.',
  create: createMobileControlsLab,
});
