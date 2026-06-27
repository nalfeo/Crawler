import GUI from 'lil-gui';
import {
  DwellTracker,
  findNearestFrontierTile,
  isDoorKnownLocked,
  nextStuckFrames,
  pickNearestPoi,
  updateLockedDoorMemory,
  type AILockedDoorMemory,
  type FrontierGrid,
  type PoiCandidate,
} from '../../game/ai/exploration.js';
import { registerLab } from '../registry.js';

/**
 * BT Exploration Lab.
 *
 * Visualises the four exploration directives (C1–C4) the Behavior-Tree AI uses
 * to sweep a floor, driven by the *exact* pure kernels extracted into
 * `src/game/ai/exploration.ts` (which the AI provider delegates to). It runs a
 * tiny fog-of-war simulation — no Phaser, no ECS — so the kernels are the only
 * moving parts:
 *
 *  - C1 frontier search   ({@link findNearestFrontierTile}) — the green target
 *    the auto-walker steers toward; recomputed every frame as fog clears.
 *  - C2 POI seeking        ({@link pickNearestPoi}) — the nearest still-relevant
 *    point of interest inside the scan radius (toggle relevance by clicking).
 *  - C3 locked-door memory ({@link updateLockedDoorMemory} /
 *    {@link isDoorKnownLocked}) — locked doors block the BFS and are remembered;
 *    unlock one and the frontier search re-opens the far side.
 *  - C4 stuck / wiggle     ({@link nextStuckFrames} / {@link DwellTracker}) —
 *    the live readout; flip "Wiggle in place" to watch the dwell watchdog fire.
 *
 * Fully deterministic: the layout is fixed and the wiggle motion is a sine of
 * the frame counter — no `Math.random`, no `Date.now`.
 */

const LAB_ID = 'bt-exploration';
const GW = 30;
const GH = 20;
const CELL = 22;
const FIXED_DELTA_MS = 16;

// Mirrors the production constants in bt-ai-provider.ts so the lab demonstrates
// the same gates the real AI uses.
const EXPLORE_FRONTIER_MIN_PX = 80;
const EXPLORE_FRONTIER_BFS_MAX_TILES = 8192;
const STUCK_PROGRESS_EPSILON_PX = 4;

type TileKind = 'floor' | 'wall';

interface LabDoor {
  readonly eid: number;
  readonly tileX: number;
  readonly tileY: number;
  locked: boolean;
}

interface LabPoi extends PoiCandidate {
  readonly label: string;
  relevant: boolean;
}

function tileCenterPx(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * CELL + CELL / 2, y: tileY * CELL + CELL / 2 };
}

/** Fixed two-chamber layout split by a wall with two doors. */
function buildTerrain(): { tiles: TileKind[]; doors: LabDoor[]; poi: LabPoi[] } {
  const tiles: TileKind[] = [];
  for (let y = 0; y < GH; y += 1) {
    for (let x = 0; x < GW; x += 1) {
      const isBorder = x === 0 || y === 0 || x === GW - 1 || y === GH - 1;
      const isDivider = x === 15 && y !== 5 && y !== 13; // wall with two gaps
      tiles.push(isBorder || isDivider ? 'wall' : 'floor');
    }
  }
  // A couple of interior pillars on the left chamber to make the frontier sweep
  // curve around obstacles.
  for (const [px, py] of [
    [6, 6],
    [6, 7],
    [9, 12],
  ] as const) {
    tiles[py * GW + px] = 'wall';
  }

  const doors: LabDoor[] = [
    { eid: 1001, tileX: 15, tileY: 5, locked: true },
    { eid: 1002, tileX: 15, tileY: 13, locked: false },
  ];

  const poi: LabPoi[] = [
    { label: 'Shopkeeper', x: tileCenterPx(4, 3).x, y: tileCenterPx(4, 3).y, relevant: true },
    {
      label: 'Tutorial Goon',
      x: tileCenterPx(11, 16).x,
      y: tileCenterPx(11, 16).y,
      relevant: true,
    },
    { label: 'Boss Door', x: tileCenterPx(26, 4).x, y: tileCenterPx(26, 4).y, relevant: true },
    { label: 'Handled NPC', x: tileCenterPx(8, 3).x, y: tileCenterPx(8, 3).y, relevant: false },
  ];

  return { tiles, doors, poi };
}

function createBtExplorationLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = GW * CELL;
  canvas.height = GH * CELL;
  canvas.style.cssText =
    'display:block;margin:0 auto;border:1px solid rgba(255,255,255,0.15);cursor:crosshair;';

  const info = document.createElement('pre');
  info.style.cssText =
    'margin:0;padding:12px;background:rgba(5,10,24,0.65);border-radius:8px;color:#d6e4ff;font-size:12px;line-height:1.5;';

  const root = document.createElement('div');
  root.style.cssText = 'display:grid;gap:12px;';
  root.append(canvas, info);
  canvasHost.append(root);

  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) throw new Error('Canvas context could not be created.');
  const ctx: CanvasRenderingContext2D = maybeCtx;

  const settings = {
    revealRadiusTiles: 3,
    speedPx: 2.6,
    scanRadiusPx: 260,
    dwellEscapePx: 64,
    dwellFrameLimit: 120,
    wiggleInPlace: false,
  };

  // --- Mutable sim state ---
  let terrain = buildTerrain();
  let tiles = terrain.tiles;
  let doors = terrain.doors;
  let poi = terrain.poi;
  const seen = new Uint8Array(GW * GH);
  const frontierVisited = new Uint8Array(GW * GH);
  const knownLockedDoors = new Map<number, AILockedDoorMemory>();
  let dwell = new DwellTracker(settings.dwellEscapePx, settings.dwellFrameLimit);
  let stuckFrames = 0;
  let player = tileCenterPx(3, 10);
  let lastPlayer = { ...player };
  let frame = 0;
  let lastDwellResult = 'armed';
  let firedCount = 0;
  let wiggleAnchor = { ...player };
  let frontierTarget: { x: number; y: number } | null = null;
  let poiTarget: LabPoi | null = null;

  function tileIsPassable(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= GW || ty >= GH) return false;
    if (tiles[ty * GW + tx] === 'wall') return false;
    const door = doors.find((d) => d.tileX === tx && d.tileY === ty);
    if (door && door.locked) return false;
    return true;
  }

  function reset(): void {
    terrain = buildTerrain();
    tiles = terrain.tiles;
    doors = terrain.doors;
    poi = terrain.poi;
    seen.fill(0);
    knownLockedDoors.clear();
    dwell = new DwellTracker(settings.dwellEscapePx, settings.dwellFrameLimit);
    stuckFrames = 0;
    player = tileCenterPx(3, 10);
    lastPlayer = { ...player };
    wiggleAnchor = { ...player };
    frame = 0;
    firedCount = 0;
    lastDwellResult = 'armed';
    rebuildDoorGui();
  }

  function revealAround(): void {
    const ptx = Math.floor(player.x / CELL);
    const pty = Math.floor(player.y / CELL);
    const r = settings.revealRadiusTiles;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const tx = ptx + dx;
        const ty = pty + dy;
        if (tx < 0 || ty < 0 || tx >= GW || ty >= GH) continue;
        if (Math.hypot(dx, dy) <= r) seen[ty * GW + tx] = 1;
      }
    }
  }

  function buildFrontierGrid(): FrontierGrid {
    return {
      width: GW,
      height: GH,
      index: (tx, ty) => (tx < 0 || ty < 0 || tx >= GW || ty >= GH ? -1 : ty * GW + tx),
      isSeen: (idx) => seen[idx] !== 0,
      isPassable: (tx, ty) => tileIsPassable(tx, ty),
      tileDistanceFt: (tx, ty) => {
        const c = tileCenterPx(tx, ty);
        return Math.hypot(c.x - player.x, c.y - player.y);
      },
    };
  }

  function currentFrontierTarget(): { x: number; y: number } | null {
    const grid = buildFrontierGrid();
    const startTx = Math.floor(player.x / CELL);
    const startTy = Math.floor(player.y / CELL);
    const tile = findNearestFrontierTile(
      grid,
      startTx,
      startTy,
      EXPLORE_FRONTIER_MIN_PX,
      EXPLORE_FRONTIER_BFS_MAX_TILES,
      frontierVisited,
    );
    return tile ? tileCenterPx(tile.tileX, tile.tileY) : null;
  }

  function moveToward(target: { x: number; y: number }): void {
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return;
    const step = Math.min(settings.speedPx, dist);
    const nx = player.x + (dx / dist) * step;
    const ny = player.y + (dy / dist) * step;
    // Block motion into an impassable tile (walls + locked doors) so the player
    // can genuinely get stuck against a locked door — exercising C3 + C4.
    if (tileIsPassable(Math.floor(nx / CELL), Math.floor(ny / CELL))) {
      player = { x: nx, y: ny };
    } else if (tileIsPassable(Math.floor(nx / CELL), Math.floor(player.y / CELL))) {
      player = { x: nx, y: player.y };
    } else if (tileIsPassable(Math.floor(player.x / CELL), Math.floor(ny / CELL))) {
      player = { x: player.x, y: ny };
    }
  }

  function step(): void {
    frame += 1;
    revealAround();

    // C3: reconcile locked-door memory against doors blocked this tick.
    const blocked: AILockedDoorMemory[] = doors
      .filter((d) => d.locked)
      .map((d) => ({
        eid: d.eid,
        tileX: d.tileX,
        tileY: d.tileY,
        unlockRequirement: { goalIds: ['floor1-cleared'], itemIds: [], timerMs: [] },
      }));
    updateLockedDoorMemory(knownLockedDoors, blocked);

    // C1: nearest fog frontier (the exploration target).
    frontierTarget = currentFrontierTarget();

    // C2: nearest still-relevant POI within the scan radius.
    poiTarget = pickNearestPoi(poi, player.x, player.y, settings.scanRadiusPx);

    // Drive the walker.
    if (settings.wiggleInPlace) {
      // Oscillate inside the escape circle so the dwell watchdog accumulates.
      const amp = Math.max(4, settings.dwellEscapePx / 4);
      player = {
        x: wiggleAnchor.x + Math.sin(frame * 0.4) * amp,
        y: wiggleAnchor.y + Math.cos(frame * 0.4) * amp,
      };
    } else if (frontierTarget) {
      moveToward(frontierTarget);
    }

    // C4: per-frame stuck counter + net-displacement dwell watchdog.
    const moved = Math.hypot(player.x - lastPlayer.x, player.y - lastPlayer.y);
    stuckFrames = nextStuckFrames(stuckFrames, moved, STUCK_PROGRESS_EPSILON_PX);
    lastPlayer = { ...player };

    const result = dwell.update(player.x, player.y);
    lastDwellResult = result;
    if (result === 'fired') {
      firedCount += 1;
      // The real AI drops the unreachable target here; in the lab we just
      // re-anchor the wiggle so the demo keeps cycling.
      wiggleAnchor = { ...player };
    }
  }

  function draw(): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < GH; y += 1) {
      for (let x = 0; x < GW; x += 1) {
        const idx = y * GW + x;
        const isSeen = seen[idx] !== 0;
        const passable = tiles[idx] !== 'wall';
        if (!passable) ctx.fillStyle = isSeen ? '#2d3748' : '#1a202c';
        else ctx.fillStyle = isSeen ? '#0f172a' : '#070b16';
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.strokeRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    // Doors (C3): red = remembered locked, orange = locked (pre-memory), green = open.
    for (const door of doors) {
      const known = isDoorKnownLocked(knownLockedDoors, door.eid);
      ctx.fillStyle = door.locked ? (known ? '#e53e3e' : '#dd6b20') : '#38a169';
      ctx.fillRect(door.tileX * CELL + 3, door.tileY * CELL + 3, CELL - 6, CELL - 6);
    }

    // Scan radius (C2).
    ctx.strokeStyle = 'rgba(120,180,255,0.18)';
    ctx.beginPath();
    ctx.arc(player.x, player.y, settings.scanRadiusPx, 0, Math.PI * 2);
    ctx.stroke();

    // POIs (C2).
    for (const p of poi) {
      ctx.fillStyle = p.relevant ? '#9f7aea' : '#4a5568';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#cbd5e0';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.label, p.x, p.y - 9);
    }
    if (poiTarget) {
      ctx.strokeStyle = '#9f7aea';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(player.x, player.y);
      ctx.lineTo(poiTarget.x, poiTarget.y);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Frontier target (C1).
    if (frontierTarget) {
      ctx.fillStyle = 'rgba(72,187,120,0.85)';
      ctx.fillRect(frontierTarget.x - CELL / 2, frontierTarget.y - CELL / 2, CELL, CELL);
      ctx.strokeStyle = '#48bb78';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(player.x, player.y);
      ctx.lineTo(frontierTarget.x, frontierTarget.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Player.
    ctx.fillStyle = '#f6e05e';
    ctx.beginPath();
    ctx.arc(player.x, player.y, 7, 0, Math.PI * 2);
    ctx.fill();

    const lockedList = [...knownLockedDoors.values()]
      .map((d) => `#${String(d.eid)}@(${String(d.tileX)},${String(d.tileY)})`)
      .join(', ');
    info.textContent = [
      `C1 frontier target : ${frontierTarget ? `(${frontierTarget.x.toFixed(0)}, ${frontierTarget.y.toFixed(0)})` : 'none — fully explored'}`,
      `C2 nearest POI     : ${poiTarget ? poiTarget.label : 'none in range'}`,
      `C3 locked-door mem : ${lockedList || '(none)'}`,
      `C4 stuckFrames     : ${String(stuckFrames)}`,
      `C4 dwell           : ${lastDwellResult} (parked ${String(dwell.framesParked)} / fired ${String(firedCount)}x)`,
      `frame              : ${String(frame)}`,
    ].join('\n');
  }

  let rafId = 0;
  let lastTs = 0;
  let accumulator = 0;
  function loop(ts: number): void {
    const delta = lastTs === 0 ? FIXED_DELTA_MS : Math.min(100, ts - lastTs);
    lastTs = ts;
    accumulator += delta;
    let steps = 0;
    while (accumulator >= FIXED_DELTA_MS && steps < 4) {
      step();
      accumulator -= FIXED_DELTA_MS;
      steps += 1;
    }
    draw();
    rafId = requestAnimationFrame(loop);
  }

  // Click a POI to toggle its relevance (handled vs. still-needed).
  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const cx = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const cy = ((event.clientY - rect.top) * canvas.height) / rect.height;
    for (const p of poi) {
      if (Math.hypot(p.x - cx, p.y - cy) <= 10) {
        p.relevant = !p.relevant;
        return;
      }
    }
  });

  // --- GUI ---
  gui.add(settings, 'revealRadiusTiles', 1, 6, 1).name('Reveal radius (tiles)');
  gui.add(settings, 'speedPx', 0.5, 6, 0.1).name('Walk speed (px)');
  gui.add(settings, 'scanRadiusPx', 60, 400, 10).name('POI scan radius (px)');
  gui
    .add(settings, 'dwellEscapePx', 16, 160, 8)
    .name('Dwell escape (px)')
    .onChange(() => {
      dwell = new DwellTracker(settings.dwellEscapePx, settings.dwellFrameLimit);
    });
  gui
    .add(settings, 'dwellFrameLimit', 30, 300, 10)
    .name('Dwell frame limit')
    .onChange(() => {
      dwell = new DwellTracker(settings.dwellEscapePx, settings.dwellFrameLimit);
    });
  gui.add(settings, 'wiggleInPlace').name('Wiggle in place (C4)');

  const doorFolder = gui.addFolder('Doors (C3)');
  function rebuildDoorGui(): void {
    for (const child of [...doorFolder.controllers]) {
      child.destroy();
    }
    for (const door of doors) {
      const api = {
        toggle: () => {
          door.locked = !door.locked;
        },
      };
      doorFolder.add(api, 'toggle').name(`Toggle door #${String(door.eid)}`);
    }
  }
  rebuildDoorGui();
  gui.add({ reset }, 'reset').name('Reset scenario');

  reset();
  rafId = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(rafId);
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Movement & Physics',
  name: 'BT Exploration Lab',
  description:
    'Visualise the Behavior-Tree AI exploration directives C1–C4 (frontier search, POI seeking, locked-door memory, stuck/wiggle dwell watchdog) driven by the pure kernels in src/game/ai/exploration.ts. Toggle door locks and "Wiggle in place" to watch the watchdog fire.',
  create: createBtExplorationLab,
});
