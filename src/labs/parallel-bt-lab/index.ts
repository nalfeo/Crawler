/**
 * Parallel Behavior Tree Lab
 *
 * Demonstrates the 2-track parallel behavior tree in action:
 *
 * - Track A (Movement Goal): the exclusive priority selector that picks one
 *   movement target per frame (Retreat > Interact > Progress > Engage > Collect
 *   > Hunt > Explore).
 * - Track B (Opportunistic): ticks every frame and writes pull/dodge vectors
 *   that are blended additively into Track A's direction.
 *
 * The controls panel shows:
 * - Current Track A state and reason
 * - Live Track B vector values (collect pull, dodge, farm pull)
 * - The raw Track A direction vs. the final blended direction (displayed as
 *   compass arrows so the deviation is immediately visible)
 * - The serialised tree structure with Track A and Track B highlighted
 */

import Phaser from 'phaser';
import { query } from 'bitecs';
import { createFloor1MainSceneOptions } from '../../bootstrap/floor1-main-scene-options.js';
import { BootScene, MainGameScene } from '../../engine/index.js';
import { BehaviorTreeAI } from '../../game/ai/bt-ai-provider.js';
import { Player, Position, Health, type GameWorld } from '../../core/index.js';
import type { SerializedBTNode } from '../../game/ai/behavior-tree.js';
import { createLogger } from '../../shared/logger.js';
import { registerLab } from '../registry.js';

const logger = createLogger('lab:parallel-bt');

const STATE_NAMES = ['EXPLORE', 'ENGAGE', 'RETREAT', 'COLLECT', 'INTERACT'];

// ── Vector arrow canvas ──────────────────────────────────────────────────────

/**
 * Draw a compass-style arrow on a 2D canvas.
 * `dx/dy` is the unit-ish direction vector; 0,0 draws nothing.
 */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  length: number,
  color: string,
  label: string,
): void {
  const mag = Math.hypot(dx, dy);
  if (mag < 0.01) return;
  const nx = dx / mag;
  const ny = dy / mag;

  const ex = cx + nx * length;
  const ey = cy + ny * length;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  // Arrowhead
  const hw = 6;
  const hl = 10;
  const bx = ex - nx * hl;
  const by = ey - ny * hl;
  const px = -ny;
  const py = nx;

  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(bx + px * hw, by + py * hw);
  ctx.lineTo(bx - px * hw, by - py * hw);
  ctx.fill();

  // Label
  ctx.font = '11px monospace';
  ctx.fillText(label, ex + 4, ey + 4);
}

/**
 * Draw the vector overlay canvas showing Track A direction, blend vectors, and
 * the final blended direction.
 */
function renderVectorCanvas(
  canvas: HTMLCanvasElement,
  trackAX: number,
  trackAY: number,
  pullX: number,
  pullY: number,
  dodgeX: number,
  dodgeY: number,
  collectWeight: number,
  dodgeWeight: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(cx, cy) - 20;

  ctx.clearRect(0, 0, W, H);

  // Background circle
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Cross-hair
  ctx.strokeStyle = '#222';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // Dodge vector (orange)
  drawArrow(ctx, cx, cy, dodgeX, dodgeY, r * dodgeWeight, '#ff9800', 'dodge');

  // Collect pull vector (cyan)
  drawArrow(ctx, cx, cy, pullX, pullY, r * collectWeight, '#26c6da', 'pull');

  // Track A direction (yellow)
  drawArrow(ctx, cx, cy, trackAX, trackAY, r, '#ffee58', 'A');

  // Blended final direction (bright green)
  const blendX = trackAX + dodgeX * dodgeWeight + pullX * collectWeight;
  const blendY = trackAY + dodgeY * dodgeWeight + pullY * collectWeight;
  const blendLen = Math.hypot(blendX, blendY);
  const finalX = blendLen > 1 ? blendX / blendLen : blendX;
  const finalY = blendLen > 1 ? blendY / blendLen : blendY;
  drawArrow(ctx, cx, cy, finalX, finalY, r, '#66bb6a', 'final');
}

// ── Tree renderer ─────────────────────────────────────────────────────────────

function getNodeColor(type: string): string {
  if (type.startsWith('Parallel')) return '#e040fb'; // Purple
  if (type === 'Cooldown') return '#ab47bc';
  if (type === 'Sequence') return '#4caf50';
  if (type === 'Selector') return '#ff9800';
  if (type === 'Condition') return '#2196f3';
  if (type === 'Action') return '#f44336';
  return '#888';
}

function renderTree(container: HTMLElement, tree: SerializedBTNode): void {
  container.innerHTML = '';

  function renderNode(node: SerializedBTNode, depth: number, parentEl: HTMLElement): void {
    const isTrackA = node.name === 'Track A: Movement Goal';
    const isTrackB = node.name === 'Track B: Opportunistic';
    const bg = isTrackA
      ? '#1a2a1a'
      : isTrackB
        ? '#1a1a2e'
        : depth % 2 === 0
          ? '#2a2a2a'
          : '#252525';

    const nodeDiv = document.createElement('div');
    nodeDiv.style.cssText = `
      margin-left: ${depth * 16}px;
      padding: 3px 8px;
      margin-top: 3px;
      border-left: 2px solid ${getNodeColor(node.type)};
      background: ${bg};
      font-family: monospace;
      font-size: 11px;
      color: #fff;
    `;

    const badge = isTrackA
      ? ' <span style="color:#66bb6a;font-size:10px;">[Track A]</span>'
      : isTrackB
        ? ' <span style="color:#ab47bc;font-size:10px;">[Track B]</span>'
        : '';

    nodeDiv.innerHTML = `<span style="color:${getNodeColor(node.type)};font-weight:bold;">[${node.type}]</span> <span style="color:#ddd;">${node.name}</span>${badge}`;
    parentEl.appendChild(nodeDiv);

    for (const child of node.children) {
      renderNode(child, depth + 1, parentEl);
    }
  }

  renderNode(tree, 0, container);
}

// ── Controls panel renderer ───────────────────────────────────────────────────

function buildControlsPanel(controls: HTMLElement): {
  stateEl: HTMLElement;
  vectorCanvas: HTMLCanvasElement;
  trackBEl: HTMLElement;
  treeEl: HTMLElement;
} {
  controls.style.cssText =
    'background:#1e1e1e;color:#fff;font-family:"Segoe UI",sans-serif;overflow-y:auto;';
  controls.innerHTML = '';

  const header = document.createElement('div');
  header.style.cssText = 'padding:10px;background:#222;border-bottom:1px solid #444;';
  header.innerHTML =
    '<h3 style="margin:0;color:#fff;">Parallel BT Lab</h3>' +
    '<div style="color:#aaa;font-size:11px;margin-top:4px;">Track A = movement goal · Track B = opportunistic overlay</div>';
  controls.appendChild(header);

  // Track A state
  const stateEl = document.createElement('div');
  stateEl.style.cssText = 'padding:10px;background:#2a2a2a;border-bottom:1px solid #333;';
  controls.appendChild(stateEl);

  // Vector arrow canvas
  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText =
    'padding:10px;background:#111;border-bottom:1px solid #333;display:flex;flex-direction:column;align-items:center;';
  const canvasLabel = document.createElement('div');
  canvasLabel.style.cssText = 'color:#aaa;font-size:11px;margin-bottom:6px;';
  canvasLabel.textContent =
    'Direction vectors  ■ yellow=A  ■ green=blended  ■ cyan=pull  ■ orange=dodge';
  const vectorCanvas = document.createElement('canvas');
  vectorCanvas.width = 160;
  vectorCanvas.height = 160;
  vectorCanvas.style.cssText = 'border:1px solid #333;border-radius:4px;';
  canvasWrap.appendChild(canvasLabel);
  canvasWrap.appendChild(vectorCanvas);
  controls.appendChild(canvasWrap);

  // Track B live values
  const trackBEl = document.createElement('div');
  trackBEl.style.cssText =
    'padding:10px;background:#1a1a2e;border-bottom:1px solid #333;font-size:12px;';
  controls.appendChild(trackBEl);

  // Legend
  const legendEl = document.createElement('div');
  legendEl.style.cssText =
    'padding:8px 10px;background:#222;border-bottom:1px solid #333;font-size:11px;color:#aaa;';
  legendEl.innerHTML =
    '<span style="color:#e040fb;">■</span> Parallel(OBSERVE) &nbsp;' +
    '<span style="color:#4caf50;">■</span> Sequence &nbsp;' +
    '<span style="color:#ff9800;">■</span> Selector &nbsp;' +
    '<span style="color:#2196f3;">■</span> Condition &nbsp;' +
    '<span style="color:#f44336;">■</span> Action';
  controls.appendChild(legendEl);

  // Tree structure
  const treeSection = document.createElement('div');
  treeSection.style.cssText = 'padding:8px;background:#181818;';
  const treeLabel = document.createElement('div');
  treeLabel.style.cssText = 'color:#777;font-size:11px;padding:4px 4px 8px;';
  treeLabel.textContent = 'Tree structure';
  treeSection.appendChild(treeLabel);
  const treeEl = document.createElement('div');
  treeSection.appendChild(treeEl);
  controls.appendChild(treeSection);

  return { stateEl, vectorCanvas, trackBEl, treeEl };
}

// ── Lab registration ──────────────────────────────────────────────────────────

registerLab('parallel-bt', {
  name: 'Parallel BT Mixed Behaviors',
  description:
    'Demonstrates 2-track parallel behavior tree: Track A (movement goal) + Track B (opportunistic collect/dodge/farm)',
  category: 'Meta',

  create: (canvas: HTMLElement, controls: HTMLElement) => {
    logger.info('Starting Parallel BT Lab');

    const ai = new BehaviorTreeAI({ seed: 54321, debug: false });

    // Custom AI input provider
    const aiInputProvider = {
      poll(state: {
        moveX: number;
        moveY: number;
        action: boolean;
        pointerX: number;
        pointerY: number;
      }): void {
        const scene = game.scene.getScene('MainGameScene') as MainGameScene | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (scene && (scene as any).world) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const world = (scene as any).world as GameWorld;
          ai.poll(state, world);
        } else {
          state.moveX = 0;
          state.moveY = 0;
          state.action = false;
          state.pointerX = 0;
          state.pointerY = 0;
        }
      },
      destroy(): void {},
    };

    const sceneOptions = {
      ...createFloor1MainSceneOptions(),
      inputCaptureOverride: aiInputProvider,
    };

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.WEBGL,
      parent: canvas,
      width: 1280,
      height: 720,
      backgroundColor: '#1a1a2e',
      pixelArt: true,
      scene: [BootScene, new MainGameScene(sceneOptions)],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      physics: {
        default: 'arcade',
        arcade: { gravity: { x: 0, y: 0 }, debug: false },
      },
    };

    const game = new Phaser.Game(config);

    const { stateEl, vectorCanvas, trackBEl, treeEl } = buildControlsPanel(controls);

    // Render tree structure once (static structure)
    renderTree(treeEl, ai.getTree().serialize());

    // Track the last Track A raw move direction across frames (approximated from
    // decision target minus player pos — we don't have access to the raw vector
    // computed by moveToward(), so we reconstruct it from decision data).
    let lastMoveX = 0;
    let lastMoveY = 0;

    const updateInterval = setInterval(() => {
      const decision = ai.getDecision();
      const opp = ai.getOpportunisticDebug();
      const stateName = STATE_NAMES[decision.state] ?? 'UNKNOWN';

      // Update Track A state panel
      stateEl.innerHTML = `
        <div style="font-weight:bold;margin-bottom:4px;">
          Track A: <span style="color:#4fc3f7;">${stateName}</span>
        </div>
        <div style="color:#aaa;font-size:11px;">${decision.reason}</div>
        ${decision.targetX !== null ? `<div style="color:#666;font-size:10px;margin-top:2px;">target=(${Math.round(decision.targetX)},${Math.round(decision.targetY ?? 0)})</div>` : ''}
      `;

      // Approximate Track A direction from decision target (best-effort)
      const scene = game.scene.getScene('MainGameScene') as MainGameScene | null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (scene && (scene as any).world) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const world = (scene as any).world as GameWorld;
        const playerEntities = query(world.ecs, [Player, Position, Health]);
        const playerEid = playerEntities[0];
        if (playerEid !== undefined && decision.targetX !== null && decision.targetY !== null) {
          const px = world.stores.position.x[playerEid] ?? 0;
          const py = world.stores.position.y[playerEid] ?? 0;
          const dx = decision.targetX - px;
          const dy = decision.targetY - py;
          const len = Math.hypot(dx, dy);
          if (len > 0) {
            lastMoveX = dx / len;
            lastMoveY = dy / len;
          }
        }
      }

      // Track B values panel
      const pullActive = Math.hypot(opp.pullX, opp.pullY) > 0.01;
      const farmActive = Math.hypot(opp.farmX, opp.farmY) > 0.01;
      const dodgeActive = Math.hypot(opp.dodgeX, opp.dodgeY) > 0.01;
      trackBEl.innerHTML = `
        <div style="font-weight:bold;margin-bottom:6px;color:#ab47bc;">Track B: Opportunistic</div>
        <div style="margin-bottom:3px;">
          <span style="color:${pullActive ? '#26c6da' : '#555'};">● Collect (loot) detour</span>
          <span style="color:#888;margin-left:6px;font-size:10px;">(${opp.pullX.toFixed(2)}, ${opp.pullY.toFixed(2)})</span>
          ${pullActive ? '<span style="color:#26c6da;margin-left:6px;font-size:10px;">ACTIVE</span>' : ''}
        </div>
        <div style="margin-bottom:3px;">
          <span style="color:${farmActive ? '#9ccc65' : '#555'};">● Farm (enemy) pull</span>
          <span style="color:#888;margin-left:6px;font-size:10px;">(${opp.farmX.toFixed(2)}, ${opp.farmY.toFixed(2)})</span>
          ${farmActive ? '<span style="color:#9ccc65;margin-left:6px;font-size:10px;">ACTIVE</span>' : '<span style="color:#555;margin-left:6px;font-size:10px;">dormant</span>'}
        </div>
        <div>
          <span style="color:${dodgeActive ? '#ff9800' : '#555'};">● Dodge</span>
          <span style="color:#888;margin-left:6px;font-size:10px;">(${opp.dodgeX.toFixed(2)}, ${opp.dodgeY.toFixed(2)})</span>
          ${dodgeActive ? '<span style="color:#ff9800;margin-left:6px;font-size:10px;">ACTIVE</span>' : ''}
        </div>
      `;

      // Redraw vector canvas
      renderVectorCanvas(
        vectorCanvas,
        lastMoveX,
        lastMoveY,
        opp.pullX,
        opp.pullY,
        opp.dodgeX,
        opp.dodgeY,
        0.25,
        0.4,
      );
    }, 100); // ~10 Hz refresh

    return () => {
      clearInterval(updateInterval);
      game.destroy(true);
      logger.info('Parallel BT Lab stopped');
    };
  },
});
