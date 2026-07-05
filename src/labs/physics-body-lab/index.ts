/**
 * Physics Body Lab — visualise the `Size` component (green) vs sprite dims
 * (red) for each canonical entity class in the physics-defs registry.
 *
 * Slug: `size-body`. Access at `?lab=size-body`.
 *
 * This lab is a *diagnostic surface*: it does NOT drive gameplay logic. The
 * real collision path is validated by the headless
 * `collision-pair-parity.test.ts` and by `check:size-coverage`. This lab only
 * confirms that today's Slice-1 body values sit inside the sprite half-extent
 * envelope (they should coincide, since Slice 1 keeps parity).
 */

import GUI from 'lil-gui';
import { registerLab } from '../registry.js';
import {
  PHYSICS_BODIES,
  SHAPE_CIRCLE,
  type PhysicsBodyDef,
  type PhysicsBodyId,
} from '../../core/physics-defs.js';

const PX_PER_FT = 24;
const CANVAS_SIZE = 480;
const CENTER = CANVAS_SIZE / 2;

interface BodyLabState {
  bodyId: PhysicsBodyId;
  showSprite: boolean;
  showBody: boolean;
  overrideRadius: number;
  overrideHalfWidth: number;
  overrideHalfHeight: number;
}

function draw(ctx: CanvasRenderingContext2D, def: PhysicsBodyDef, state: BodyLabState): void {
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 1;
  for (let i = -10; i <= 10; i += 1) {
    ctx.beginPath();
    ctx.moveTo(CENTER + i * PX_PER_FT, 0);
    ctx.lineTo(CENTER + i * PX_PER_FT, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, CENTER + i * PX_PER_FT);
    ctx.lineTo(CANVAS_SIZE, CENTER + i * PX_PER_FT);
    ctx.stroke();
  }

  const r = state.overrideRadius > 0 ? state.overrideRadius : def.radius;
  const hw = state.overrideHalfWidth > 0 ? state.overrideHalfWidth : def.halfWidth;
  const hh = state.overrideHalfHeight > 0 ? state.overrideHalfHeight : def.halfHeight;

  if (state.showSprite) {
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    const spriteHw = def.shape === SHAPE_CIRCLE ? r : hw;
    const spriteHh = def.shape === SHAPE_CIRCLE ? r : hh;
    ctx.strokeRect(
      CENTER - spriteHw * PX_PER_FT,
      CENTER - spriteHh * PX_PER_FT,
      spriteHw * 2 * PX_PER_FT,
      spriteHh * 2 * PX_PER_FT,
    );
    ctx.setLineDash([]);
  }

  if (state.showBody) {
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    if (def.shape === SHAPE_CIRCLE) {
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, r * PX_PER_FT, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(
        CENTER - hw * PX_PER_FT,
        CENTER - hh * PX_PER_FT,
        hw * 2 * PX_PER_FT,
        hh * 2 * PX_PER_FT,
      );
    }
  }

  ctx.fillStyle = '#f8fafc';
  ctx.font = '13px monospace';
  ctx.fillText(
    `${state.bodyId} — shape=${def.shape === SHAPE_CIRCLE ? 'circle' : 'box'} r=${r} hw=${hw} hh=${hh} weight=${def.weight}`,
    12,
    CANVAS_SIZE - 12,
  );
}

registerLab('size-body', {
  name: 'Physics Body (Size vs Sprite)',
  description:
    'Overlay of body outline (green) vs sprite outline (red) for each entity in physics-defs. Slice-1 parity keeps them coincident.',
  category: 'Movement & Physics',
  create(container: HTMLElement, controls: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    canvas.style.background = '#0f172a';
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bodyIds = Object.keys(PHYSICS_BODIES) as PhysicsBodyId[];
    const state: BodyLabState = {
      bodyId: 'player',
      showSprite: true,
      showBody: true,
      overrideRadius: 0,
      overrideHalfWidth: 0,
      overrideHalfHeight: 0,
    };

    const gui = new GUI({ container: controls, title: 'Physics Body' });
    gui.add(state, 'bodyId', bodyIds).name('Entity');
    gui.add(state, 'showBody').name('Show body (green)');
    gui.add(state, 'showSprite').name('Show sprite (red)');
    gui.add(state, 'overrideRadius', 0, 5, 0.05).name('Override radius');
    gui.add(state, 'overrideHalfWidth', 0, 5, 0.05).name('Override hw');
    gui.add(state, 'overrideHalfHeight', 0, 5, 0.05).name('Override hh');

    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      draw(ctx, PHYSICS_BODIES[state.bodyId], state);
      requestAnimationFrame(tick);
    };
    tick();

    return () => {
      stopped = true;
      gui.destroy();
      canvas.remove();
    };
  },
});
