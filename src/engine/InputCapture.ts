import type Phaser from 'phaser';
import { normalizeInputDirection, type InputState } from '../shared/input.js';

/**
 * Raw DOM keyboard tracker that listens on `window`.
 * Phaser's built-in keyboard plugin is tied to canvas focus — when lil-gui
 * buttons steal focus, keyup events are missed and keys stick.  This
 * implementation is completely focus-independent.
 *
 * Touch listeners bind to the Phaser canvas (when available) so only
 * touches that start on the game surface are captured — lab UI panels
 * and other overlays remain scrollable.
 *
 * Mouse pointer events are mapped through the same virtual-joystick logic
 * so developers can test the mobile touch experience on desktop without a
 * touch screen (left-half = move joystick, right-half = action).
 */
export function createInputCapture(scene: Phaser.Scene): {
  /** Read current hardware state into the InputState */
  poll(state: InputState): void;
  destroy(): void;
} {
  const keysDown = new Set<string>();
  const activeTouches = new Map<
    number,
    { zone: 'move' | 'action'; startX: number; startY: number; x: number; y: number }
  >();
  const JOYSTICK_RADIUS_PX = 60;
  const touchStartOptions: AddEventListenerOptions = { passive: true };
  const touchMoveOptions: AddEventListenerOptions = { passive: false };
  const touchEndOptions: AddEventListenerOptions = { passive: true };

  // Synthetic pointer ID for mouse-based touch emulation (avoids collision with real touch ids)
  const MOUSE_POINTER_ID_BASE = -100;

  // Touch target: prefer canvas so lab UI stays interactive
  const touchTarget: EventTarget = scene.game?.canvas ?? window;

  const onKeyDown = (e: KeyboardEvent) => {
    keysDown.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keysDown.delete(e.code);
  };
  // Clear all keys and touches when the window loses focus (alt-tab, etc.)
  const onBlur = () => {
    keysDown.clear();
    activeTouches.clear();
  };

  const classifyTouchZone = (clientX: number): 'move' | 'action' => {
    const canvas = scene.game?.canvas;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      return clientX < rect.left + rect.width / 2 ? 'move' : 'action';
    }
    return clientX < window.innerWidth / 2 ? 'move' : 'action';
  };

  const onTouchStart = (e: TouchEvent) => {
    for (const touch of e.changedTouches) {
      activeTouches.set(touch.identifier, {
        zone: classifyTouchZone(touch.clientX),
        startX: touch.clientX,
        startY: touch.clientY,
        x: touch.clientX,
        y: touch.clientY,
      });
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    for (const touch of e.changedTouches) {
      const state = activeTouches.get(touch.identifier);
      if (!state) {
        continue;
      }

      state.x = touch.clientX;
      state.y = touch.clientY;
    }
    if (e.cancelable) e.preventDefault();
  };
  const onTouchEnd = (e: TouchEvent) => {
    for (const touch of e.changedTouches) {
      activeTouches.delete(touch.identifier);
    }
  };

  // --- Mouse pointer emulation (enables testing mobile UX on desktop) ---
  // Only left-click (button 0) is emulated as a synthetic touch.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // real touches handled above
    if (e.button !== 0) return; // only left-click emulates touch
    activeTouches.set(MOUSE_POINTER_ID_BASE, {
      zone: classifyTouchZone(e.clientX),
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
    });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const state = activeTouches.get(MOUSE_POINTER_ID_BASE);
    if (state) {
      state.x = e.clientX;
      state.y = e.clientY;
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (e.button !== 0) return; // only left-click emulates touch
    activeTouches.delete(MOUSE_POINTER_ID_BASE);
  };
  const toWorldPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = scene.game?.canvas;
    if (!canvas) {
      return { x: clientX, y: clientY };
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { x: clientX, y: clientY };
    }

    const scaleX = scene.scale.width / rect.width;
    const scaleY = scene.scale.height / rect.height;
    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;
    const worldPoint = scene.cameras.main.getWorldPoint(canvasX, canvasY);
    return { x: worldPoint.x, y: worldPoint.y };
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  touchTarget.addEventListener('touchstart', onTouchStart as EventListener, touchStartOptions);
  touchTarget.addEventListener('touchmove', onTouchMove as EventListener, touchMoveOptions);
  touchTarget.addEventListener('touchend', onTouchEnd as EventListener, touchEndOptions);
  touchTarget.addEventListener('touchcancel', onTouchEnd as EventListener, touchEndOptions);
  touchTarget.addEventListener('pointerdown', onPointerDown as EventListener);
  touchTarget.addEventListener('pointermove', onPointerMove as EventListener);
  touchTarget.addEventListener('pointerup', onPointerUp as EventListener);
  touchTarget.addEventListener('pointercancel', onPointerUp as EventListener);

  return {
    poll(state: InputState): void {
      const keyboardMoveX =
        Number(keysDown.has('ArrowRight') || keysDown.has('KeyD')) -
        Number(keysDown.has('ArrowLeft') || keysDown.has('KeyA'));
      const keyboardMoveY =
        Number(keysDown.has('ArrowDown') || keysDown.has('KeyS')) -
        Number(keysDown.has('ArrowUp') || keysDown.has('KeyW'));
      let touchMoveX = 0;
      let touchMoveY = 0;
      let touchAction = false;
      let actionTouchPosition: { x: number; y: number } | undefined;
      let hasMoveTouch = false;
      const hasKeyboardInput = keyboardMoveX !== 0 || keyboardMoveY !== 0;

      for (const touch of activeTouches.values()) {
        if (touch.zone === 'move' && !hasMoveTouch) {
          // First movement touch wins to keep movement stable with accidental multi-touch.
          const deltaX = touch.x - touch.startX;
          const deltaY = touch.y - touch.startY;
          touchMoveX = Math.max(-1, Math.min(1, deltaX / JOYSTICK_RADIUS_PX));
          touchMoveY = Math.max(-1, Math.min(1, deltaY / JOYSTICK_RADIUS_PX));
          hasMoveTouch = true;
        } else if (touch.zone === 'action') {
          touchAction = true;
          actionTouchPosition = { x: touch.x, y: touch.y };
        }
      }

      const normalized = normalizeInputDirection(
        hasKeyboardInput ? keyboardMoveX : touchMoveX,
        hasKeyboardInput ? keyboardMoveY : touchMoveY,
      );

      state.moveX = normalized.moveX;
      state.moveY = normalized.moveY;
      state.action = keysDown.has('Space') || touchAction;

      if (actionTouchPosition) {
        const worldPoint = toWorldPoint(actionTouchPosition.x, actionTouchPosition.y);
        state.pointerX = worldPoint.x;
        state.pointerY = worldPoint.y;
      } else {
        const pointer = scene.input.activePointer;
        pointer.updateWorldPoint(scene.cameras.main);
        state.pointerX = pointer.worldX;
        state.pointerY = pointer.worldY;
      }
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      touchTarget.removeEventListener(
        'touchstart',
        onTouchStart as EventListener,
        touchStartOptions,
      );
      touchTarget.removeEventListener('touchmove', onTouchMove as EventListener, touchMoveOptions);
      touchTarget.removeEventListener('touchend', onTouchEnd as EventListener, touchEndOptions);
      touchTarget.removeEventListener('touchcancel', onTouchEnd as EventListener, touchEndOptions);
      touchTarget.removeEventListener('pointerdown', onPointerDown as EventListener);
      touchTarget.removeEventListener('pointermove', onPointerMove as EventListener);
      touchTarget.removeEventListener('pointerup', onPointerUp as EventListener);
      touchTarget.removeEventListener('pointercancel', onPointerUp as EventListener);
      keysDown.clear();
      activeTouches.clear();
    },
  };
}
