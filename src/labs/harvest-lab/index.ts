/**
 * Harvest Lab — interactive sandbox for the material harvesting system.
 *
 * Spawns a grid of harvestable nodes (one per HARVESTABLE_DEFS entry) and a
 * player entity. Drives the harvestSystem each tick so you can see progress
 * increment and items land in the inventory without needing a full game boot.
 *
 * Controls:
 *   - Move player onto a node to start harvesting.
 *   - Adjust harvest speed multiplier to skip waiting.
 *   - Reset button to respawn all nodes and clear inventory.
 */
import { setComponent } from 'bitecs';
import { registerLab, type LabCategory } from '../registry.js';
import { createGameWorld } from '../../core/world.js';
import { spawnPlayer, spawnHarvestableNode } from '../../core/helpers.js';
import { harvestSystem } from '../../core/systems/harvestSystem.js';
import { Position } from '../../core/components.js';
import { HARVESTABLE_DEFS } from '../../shared/harvestableDefs.js';
import { getItemCount } from '../../shared/inventory.js';
import { getItemById } from '../../shared/items.js';
import { GAME } from '../../shared/constants.js';

interface LabGuiController {
  name(label: string): LabGuiController;
  onChange(handler: () => void): LabGuiController;
  updateDisplay?(): void;
}

interface LabGuiLike {
  add(...args: unknown[]): LabGuiController;
  destroy?(): void;
}

type ControlsWithGui = HTMLElement & { __labGui?: LabGuiLike };

interface HarvestLabSettings {
  speedMultiplier: number;
  playerX: number;
  playerY: number;
}

const DEFAULT_SETTINGS: HarvestLabSettings = {
  speedMultiplier: 1,
  playerX: 0,
  playerY: 0,
};

// Node layout — each node placed 12 "feet" apart in a row.
const NODE_SPACING_FT = 12;

function createHarvestLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: HarvestLabSettings = { ...DEFAULT_SETTINGS };

  // ── DOM ──────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.style.cssText =
    'padding:24px;color:#f8fafc;font-family:Inter,system-ui,sans-serif;height:100%;box-sizing:border-box;overflow:auto;';

  const title = document.createElement('h2');
  title.textContent = 'Harvest System Lab';
  title.style.marginBottom = '8px';

  const description = document.createElement('p');
  description.textContent =
    'Move the player (X coordinate) onto a node to start harvesting. Progress resets when you move away.';
  description.style.cssText = 'color:#cbd5e1;margin-bottom:16px;';

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 200;
  canvas.style.cssText = 'display:block;background:#1a1a2e;border-radius:8px;margin-bottom:16px;';

  const output = document.createElement('pre');
  output.style.cssText =
    'background:rgba(15,23,42,0.9);border:1px solid rgba(148,163,184,0.2);border-radius:12px;padding:16px;font-size:13px;color:#e2e8f0;white-space:pre-wrap;';

  root.append(title, description, canvas, output);
  canvasHost.append(root);

  // ── ECS world ────────────────────────────────────────────────────────
  let world = createGameWorld({ seed: 1 });
  let playerEid = -1;
  const nodeEids: number[] = [];

  function resetWorld(): void {
    world = createGameWorld({ seed: 1 });
    nodeEids.length = 0;

    // Spawn nodes at regular intervals along the X axis at y=0.
    for (let i = 0; i < HARVESTABLE_DEFS.length; i++) {
      const x = i * NODE_SPACING_FT;
      const eid = spawnHarvestableNode(world, x, 0, i);
      nodeEids.push(eid);
    }

    // Spawn player at x=settings.playerX, y=0.
    playerEid = spawnPlayer(world, settings.playerX, 0);
    settings.playerX = 0;
  }

  resetWorld();

  // ── lil-gui controls ─────────────────────────────────────────────────
  gui
    .add(settings, 'speedMultiplier', 0.25, 20, 0.25)
    .name('Speed ×')
    .onChange(() => {
      /* applied per-tick */
    });

  gui
    .add(settings, 'playerX', 0, (HARVESTABLE_DEFS.length - 1) * NODE_SPACING_FT, 0.5)
    .name('Player X (ft)')
    .onChange(() => {
      if (playerEid >= 0) {
        setComponent(world.ecs, playerEid, Position, { x: settings.playerX, y: 0 });
      }
    });

  const resetButton = { reset: resetWorld };
  gui.add(resetButton, 'reset').name('Reset');

  // ── Canvas helpers ───────────────────────────────────────────────────
  const CANVAS_PAD_X = 40;
  const CANVAS_SCALE =
    (canvas.width - CANVAS_PAD_X * 2) /
    Math.max(1, (HARVESTABLE_DEFS.length - 1) * NODE_SPACING_FT);
  const NODE_R = 8;
  const RING_R = 14;

  function worldToCanvasX(x: number): number {
    return CANVAS_PAD_X + x * CANVAS_SCALE;
  }

  function renderCanvas(): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cy = canvas.height / 2;

    // Draw nodes.
    for (let i = 0; i < HARVESTABLE_DEFS.length; i++) {
      const def = HARVESTABLE_DEFS[i]!;
      const eid = nodeEids[i];
      const cx = worldToCanvasX(i * NODE_SPACING_FT);

      // Check if node still exists.
      const px = eid !== undefined ? (world.stores.position.x[eid] ?? -1) : -1;
      const isAlive = px >= 0 && eid !== undefined;

      if (!isAlive) {
        // Harvested: show faint ghost.
        ctx.strokeStyle = '#44444466';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, NODE_R, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      // Node body.
      const tint = def.tint;
      const red = (tint >> 16) & 0xff;
      const green = (tint >> 8) & 0xff;
      const blue = tint & 0xff;
      ctx.fillStyle = `rgb(${red},${green},${blue})`;
      ctx.beginPath();
      ctx.arc(cx, cy, NODE_R, 0, Math.PI * 2);
      ctx.fill();

      // Progress ring.
      const progressMs = world.stores.harvestable.progressMs[eid] ?? 0;
      const durationMs = world.stores.harvestable.durationMs[eid] ?? 1;
      if (progressMs > 0) {
        const progress = Math.min(1, progressMs / durationMs);
        // Background ring.
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, RING_R, 0, Math.PI * 2);
        ctx.stroke();
        // Fill arc.
        ctx.strokeStyle = '#44ff88';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, RING_R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress, false);
        ctx.stroke();
      }

      // Label.
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(def.label, cx, cy + RING_R + 14);
    }

    // Draw player.
    const px = world.stores.position.x[playerEid] ?? 0;
    const pcx = worldToCanvasX(px);
    ctx.fillStyle = '#00ff66';
    ctx.beginPath();
    ctx.moveTo(pcx, cy - 12);
    ctx.lineTo(pcx - 7, cy + 4);
    ctx.lineTo(pcx + 7, cy + 4);
    ctx.closePath();
    ctx.fill();
  }

  function renderStats(): void {
    const bag = world.inventories.get(playerEid);
    if (!bag) {
      output.textContent = '(no inventory)';
      return;
    }

    const lines: string[] = ['Inventory:'];
    for (const def of HARVESTABLE_DEFS) {
      const itemDef = getItemById(def.itemId);
      if (!itemDef) continue;
      const count = getItemCount(bag, itemDef.id);
      const bar = '█'.repeat(count);
      lines.push(`  ${def.label.padEnd(22)} ${String(count).padStart(2)}  ${bar}`);
    }

    const harvesting: string[] = [];
    for (const eid of nodeEids) {
      if (eid === undefined) continue;
      const progressMs = world.stores.harvestable.progressMs[eid] ?? 0;
      const durationMs = world.stores.harvestable.durationMs[eid] ?? 1;
      if (progressMs > 0) {
        const defIndex = world.stores.harvestable.defIndex[eid] ?? 0;
        const def = HARVESTABLE_DEFS[defIndex]!;
        const pct = Math.round((progressMs / durationMs) * 100);
        harvesting.push(`  ${def.label}: ${pct}%`);
      }
    }
    if (harvesting.length > 0) {
      lines.push('', 'Harvesting:');
      lines.push(...harvesting);
    }

    output.textContent = lines.join('\n');
  }

  // ── Simulation loop ──────────────────────────────────────────────────
  let rafId = 0;
  let lastTs = performance.now();

  function tick(ts: number): void {
    const rawDelta = ts - lastTs;
    lastTs = ts;

    // Clamp to avoid spiral-of-death on tab-switch.
    const delta = Math.min(rawDelta, 100);

    // Run harvestSystem for as many fixed ticks as delta allows, scaled by speedMultiplier.
    const scaledDelta = delta * settings.speedMultiplier;
    let acc = scaledDelta;
    while (acc >= GAME.DELTA_MS) {
      harvestSystem(world);
      acc -= GAME.DELTA_MS;
    }

    renderCanvas();
    renderStats();

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    root.remove();
  };
}

registerLab('harvest-lab', {
  category: 'Items & Equipment' as LabCategory,
  name: 'Harvest Lab',
  description:
    'Sandbox for the material harvesting system — proximity timer, progress ring, and inventory delivery.',
  create: createHarvestLab,
});
