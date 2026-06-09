import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type Vec2 = {
  x: number;
  y: number;
};

type Wall = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CollisionTarget = {
  x: number;
  y: number;
  radius: number;
};

type RoomPreset = {
  id: string;
  name: string;
  walls: Wall[];
  mobs: CollisionTarget[];
};

type ProjectileType = 'bullet' | 'arrow' | 'beam';

type ProjectileProfile = {
  speed: number;
  radius: number;
  maxDistance: number;
  color: string;
};

type ProjectileState = {
  type: Exclude<ProjectileType, 'beam'>;
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  speed: number;
  radius: number;
  maxDistance: number;
  distanceTraveled: number;
  color: string;
  active: boolean;
};

type BeamPulse = {
  from: Vec2;
  to: Vec2;
  ttlMs: number;
};

const WORLD_WIDTH = 960;
const WORLD_HEIGHT = 640;
const BORDER_THICKNESS = 20;
const PLAYER_RADIUS = 14;
const PLAYER = {
  x: WORLD_WIDTH / 2,
  y: WORLD_HEIGHT / 2,
};
const AIM_RANGE = 620;
const BEAM_PULSE_TTL_MS = 140;
const MAX_FRAME_DELTA_MS = 50;
const EPSILON_LENGTH_SQ = 0.0001 * 0.0001;
const EPSILON_DELTA_SQ = 0.0000001;
const EPSILON_AXIS_DELTA = 0.000001;
const BACKGROUND = '#0b1020';

const PROJECTILE_PROFILES: Readonly<Record<Exclude<ProjectileType, 'beam'>, ProjectileProfile>> = {
  bullet: {
    speed: 720,
    radius: 5,
    maxDistance: 620,
    color: '#22d3ee',
  },
  arrow: {
    speed: 520,
    radius: 7,
    maxDistance: 700,
    color: '#facc15',
  },
};

function createBoundaryWalls(): Wall[] {
  return [
    { x: 0, y: 0, width: WORLD_WIDTH, height: BORDER_THICKNESS },
    { x: 0, y: WORLD_HEIGHT - BORDER_THICKNESS, width: WORLD_WIDTH, height: BORDER_THICKNESS },
    { x: 0, y: BORDER_THICKNESS, width: BORDER_THICKNESS, height: WORLD_HEIGHT - BORDER_THICKNESS * 2 },
    {
      x: WORLD_WIDTH - BORDER_THICKNESS,
      y: BORDER_THICKNESS,
      width: BORDER_THICKNESS,
      height: WORLD_HEIGHT - BORDER_THICKNESS * 2,
    },
  ];
}

const ROOM_PRESETS: readonly RoomPreset[] = [
  {
    id: 'split-lanes',
    name: 'Split Lanes',
    walls: [
      ...createBoundaryWalls(),
      { x: 310, y: 120, width: 28, height: 400 },
      { x: 622, y: 120, width: 28, height: 400 },
      { x: 338, y: 236, width: 284, height: 20 },
      { x: 338, y: 384, width: 284, height: 20 },
    ],
    mobs: [
      { x: 190, y: 180, radius: 16 },
      { x: 190, y: 460, radius: 16 },
      { x: 770, y: 180, radius: 16 },
      { x: 770, y: 460, radius: 16 },
      { x: 480, y: 100, radius: 16 },
      { x: 480, y: 540, radius: 16 },
    ],
  },
  {
    id: 'offset-bunker',
    name: 'Offset Bunker',
    walls: [
      ...createBoundaryWalls(),
      { x: 220, y: 80, width: 30, height: 310 },
      { x: 220, y: 420, width: 30, height: 140 },
      { x: 710, y: 80, width: 30, height: 140 },
      { x: 710, y: 250, width: 30, height: 310 },
      { x: 380, y: 170, width: 210, height: 20 },
      { x: 380, y: 450, width: 210, height: 20 },
    ],
    mobs: [
      { x: 130, y: 320, radius: 18 },
      { x: 305, y: 320, radius: 14 },
      { x: 655, y: 320, radius: 14 },
      { x: 830, y: 320, radius: 18 },
      { x: 480, y: 88, radius: 14 },
      { x: 480, y: 552, radius: 14 },
    ],
  },
  {
    id: 'maze-pocket',
    name: 'Maze Pocket',
    walls: [
      ...createBoundaryWalls(),
      { x: 140, y: 140, width: 640, height: 24 },
      { x: 140, y: 476, width: 640, height: 24 },
      { x: 140, y: 164, width: 24, height: 312 },
      { x: 756, y: 164, width: 24, height: 312 },
      { x: 310, y: 220, width: 24, height: 200 },
      { x: 626, y: 220, width: 24, height: 200 },
      { x: 416, y: 286, width: 128, height: 16 },
      { x: 416, y: 338, width: 128, height: 16 },
    ],
    mobs: [
      { x: 220, y: 220, radius: 14 },
      { x: 220, y: 420, radius: 14 },
      { x: 740, y: 220, radius: 14 },
      { x: 740, y: 420, radius: 14 },
      { x: 480, y: 220, radius: 14 },
      { x: 480, y: 420, radius: 14 },
    ],
  },
];

function getDefaultRoom(): RoomPreset {
  const room = ROOM_PRESETS[0];
  if (!room) {
    throw new Error('Projectile collision lab requires at least one room preset.');
  }
  return room;
}

const DEFAULT_ROOM = getDefaultRoom();

interface CollisionLabSettings {
  roomId: string;
  projectileType: ProjectileType;
  highlightAimTarget: boolean;
}

function normalizeVector(from: Vec2, to: Vec2): Vec2 | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON_LENGTH_SQ) {
    return null;
  }

  const inverseLength = 1 / Math.sqrt(lengthSquared);
  return {
    x: dx * inverseLength,
    y: dy * inverseLength,
  };
}

function raycastCircle(origin: Vec2, delta: Vec2, center: Vec2, radius: number): number | null {
  const a = delta.x * delta.x + delta.y * delta.y;
  if (a <= EPSILON_DELTA_SQ) {
    return null;
  }

  const relX = origin.x - center.x;
  const relY = origin.y - center.y;
  const b = 2 * (relX * delta.x + relY * delta.y);
  const c = relX * relX + relY * relY - radius * radius;
  const discriminant = b * b - 4 * a * c;

  if (discriminant < 0) {
    return null;
  }

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const t0 = (-b - sqrtDiscriminant) / (2 * a);
  const t1 = (-b + sqrtDiscriminant) / (2 * a);

  if (t0 >= 0 && t0 <= 1) {
    return t0;
  }
  if (t1 >= 0 && t1 <= 1) {
    return t1;
  }
  return null;
}

function raycastRect(origin: Vec2, delta: Vec2, wall: Wall, radius: number): number | null {
  const minX = wall.x - radius;
  const maxX = wall.x + wall.width + radius;
  const minY = wall.y - radius;
  const maxY = wall.y + wall.height + radius;

  let tMin = 0;
  let tMax = 1;

  const axes: Array<{ origin: number; delta: number; min: number; max: number }> = [
    { origin: origin.x, delta: delta.x, min: minX, max: maxX },
    { origin: origin.y, delta: delta.y, min: minY, max: maxY },
  ];

  for (const axis of axes) {
    if (Math.abs(axis.delta) < EPSILON_AXIS_DELTA) {
      if (axis.origin < axis.min || axis.origin > axis.max) {
        return null;
      }
      continue;
    }

    const inv = 1 / axis.delta;
    let t1 = (axis.min - axis.origin) * inv;
    let t2 = (axis.max - axis.origin) * inv;
    if (t1 > t2) {
      const temp = t1;
      t1 = t2;
      t2 = temp;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);

    if (tMin > tMax) {
      return null;
    }
  }

  if (tMin >= 0 && tMin <= 1) {
    return tMin;
  }
  return null;
}

function findRoom(roomId: string): RoomPreset {
  return ROOM_PRESETS.find((room) => room.id === roomId) ?? DEFAULT_ROOM;
}

function createCollisionLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.padding = '20px';
  root.style.boxSizing = 'border-box';
  root.style.background = BACKGROUND;

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.maxWidth = '960px';
  canvas.style.aspectRatio = `${WORLD_WIDTH} / ${WORLD_HEIGHT}`;
  canvas.style.background = BACKGROUND;
  canvas.style.cursor = 'crosshair';
  root.append(canvas);
  canvasHost.append(root);

  const hint = document.createElement('p');
  hint.textContent =
    'Player stays centered. Press and hold to aim the sight beam, then release to fire. Mobs are frozen test targets.';
  hint.style.cssText = 'margin-top:16px;color:#9fe7ff;line-height:1.6;font-family:monospace;';
  controls.append(hint);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire 2D context for collision lab.');
  }

  const settings: CollisionLabSettings = {
    roomId: DEFAULT_ROOM.id,
    projectileType: 'bullet',
    highlightAimTarget: true,
  };

  let currentRoom = findRoom(settings.roomId);
  const projectiles: ProjectileState[] = [];
  const beamPulses: BeamPulse[] = [];

  let pointerIsDown = false;
  let pointerWorld: Vec2 = { x: PLAYER.x + 1, y: PLAYER.y };

  let frameHandle = 0;
  let lastFrameTimeMs = performance.now();

  const syncCanvasSize = () => {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.floor(WORLD_WIDTH * dpr);
    const pixelHeight = Math.floor(WORLD_HEIGHT * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };

  const screenToWorld = (clientX: number, clientY: number): Vec2 | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return {
      x: ((clientX - rect.left) / rect.width) * WORLD_WIDTH,
      y: ((clientY - rect.top) / rect.height) * WORLD_HEIGHT,
    };
  };

  const clearShots = () => {
    projectiles.length = 0;
    beamPulses.length = 0;
  };

  const castRay = (
    origin: Vec2,
    direction: Vec2,
    maxDistance: number,
    radius: number,
  ): { hitPoint: Vec2; hitWall: boolean; hitMob: boolean } => {
    const delta = {
      x: direction.x * maxDistance,
      y: direction.y * maxDistance,
    };

    let earliest = 1;
    let hitWall = false;
    let hitMob = false;

    for (const wall of currentRoom.walls) {
      const t = raycastRect(origin, delta, wall, radius);
      if (t !== null && t < earliest) {
        earliest = t;
        hitWall = true;
        hitMob = false;
      }
    }

    for (const mob of currentRoom.mobs) {
      const t = raycastCircle(origin, delta, mob, mob.radius + radius);
      if (t !== null && t < earliest) {
        earliest = t;
        hitWall = false;
        hitMob = true;
      }
    }

    return {
      hitPoint: {
        x: origin.x + delta.x * earliest,
        y: origin.y + delta.y * earliest,
      },
      hitWall,
      hitMob,
    };
  };

  const fireProjectile = (direction: Vec2, type: Exclude<ProjectileType, 'beam'>) => {
    const profile = PROJECTILE_PROFILES[type];
    projectiles.push({
      type,
      x: PLAYER.x,
      y: PLAYER.y,
      dirX: direction.x,
      dirY: direction.y,
      speed: profile.speed,
      radius: profile.radius,
      maxDistance: profile.maxDistance,
      distanceTraveled: 0,
      color: profile.color,
      active: true,
    });
  };

  const fireBeam = (direction: Vec2) => {
    const result = castRay(PLAYER, direction, AIM_RANGE, 2);
    beamPulses.push({
      from: { ...PLAYER },
      to: result.hitPoint,
      ttlMs: BEAM_PULSE_TTL_MS,
    });
  };

  const fireCurrentShot = () => {
    const direction = normalizeVector(PLAYER, pointerWorld);
    if (!direction) {
      return;
    }

    if (settings.projectileType === 'beam') {
      fireBeam(direction);
      return;
    }

    fireProjectile(direction, settings.projectileType);
  };

  const updateProjectiles = (deltaMs: number) => {
    for (const projectile of projectiles) {
      if (!projectile.active) {
        continue;
      }

      const stepDistance = projectile.speed * (deltaMs / 1000);
      const remaining = projectile.maxDistance - projectile.distanceTraveled;
      if (remaining <= 0) {
        projectile.active = false;
        continue;
      }

      const travelDistance = Math.min(stepDistance, remaining);
      const delta = {
        x: projectile.dirX * travelDistance,
        y: projectile.dirY * travelDistance,
      };

      let earliest = 1;

      for (const wall of currentRoom.walls) {
        const t = raycastRect(projectile, delta, wall, projectile.radius);
        if (t !== null && t < earliest) {
          earliest = t;
        }
      }

      for (const mob of currentRoom.mobs) {
        const t = raycastCircle(projectile, delta, mob, mob.radius + projectile.radius);
        if (t !== null && t < earliest) {
          earliest = t;
        }
      }

      projectile.x += delta.x * earliest;
      projectile.y += delta.y * earliest;
      projectile.distanceTraveled += travelDistance * earliest;

      if (earliest < 1 || projectile.distanceTraveled >= projectile.maxDistance) {
        projectile.active = false;
      }
    }

    for (let index = projectiles.length - 1; index >= 0; index -= 1) {
      if (!projectiles[index]?.active) {
        projectiles.splice(index, 1);
      }
    }
  };

  const updateBeamPulses = (deltaMs: number) => {
    for (const pulse of beamPulses) {
      pulse.ttlMs -= deltaMs;
    }
    for (let index = beamPulses.length - 1; index >= 0; index -= 1) {
      if ((beamPulses[index]?.ttlMs ?? 0) <= 0) {
        beamPulses.splice(index, 1);
      }
    }
  };

  const drawWalls = () => {
    context.fillStyle = '#334155';
    for (const wall of currentRoom.walls) {
      context.fillRect(wall.x, wall.y, wall.width, wall.height);
    }
  };

  const drawMobs = () => {
    for (const mob of currentRoom.mobs) {
      context.fillStyle = '#ef4444';
      context.beginPath();
      context.arc(mob.x, mob.y, mob.radius, 0, Math.PI * 2);
      context.fill();

      context.strokeStyle = '#fecaca';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(mob.x, mob.y, mob.radius, 0, Math.PI * 2);
      context.stroke();
    }
  };

  const drawPlayer = () => {
    context.fillStyle = '#2dd4bf';
    context.beginPath();
    context.arc(PLAYER.x, PLAYER.y, PLAYER_RADIUS, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = '#99f6e4';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(PLAYER.x, PLAYER.y, PLAYER_RADIUS + 4, 0, Math.PI * 2);
    context.stroke();
  };

  const drawProjectiles = () => {
    for (const projectile of projectiles) {
      context.fillStyle = projectile.color;
      context.beginPath();
      context.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
      context.fill();

      if (projectile.type === 'arrow') {
        context.strokeStyle = '#fef08a';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(projectile.x, projectile.y);
        context.lineTo(
          projectile.x - projectile.dirX * 12,
          projectile.y - projectile.dirY * 12,
        );
        context.stroke();
      }
    }
  };

  const drawBeamPulses = () => {
    for (const pulse of beamPulses) {
      const alpha = Math.max(0, Math.min(1, pulse.ttlMs / BEAM_PULSE_TTL_MS));
      context.strokeStyle = `rgba(196, 181, 253, ${alpha})`;
      context.lineWidth = 6;
      context.beginPath();
      context.moveTo(pulse.from.x, pulse.from.y);
      context.lineTo(pulse.to.x, pulse.to.y);
      context.stroke();
    }
  };

  const drawAimSight = () => {
    if (!pointerIsDown) {
      return;
    }

    const direction = normalizeVector(PLAYER, pointerWorld);
    if (!direction) {
      return;
    }

    const aimRadius =
      settings.projectileType === 'beam' ? 2 : PROJECTILE_PROFILES[settings.projectileType].radius;
    const result = castRay(PLAYER, direction, AIM_RANGE, aimRadius);

    context.strokeStyle = settings.highlightAimTarget
      ? result.hitWall
        ? '#f97316'
        : result.hitMob
          ? '#fb7185'
          : '#22d3ee'
      : '#22d3ee';
    context.lineWidth = 2;
    context.setLineDash([8, 5]);
    context.beginPath();
    context.moveTo(PLAYER.x, PLAYER.y);
    context.lineTo(result.hitPoint.x, result.hitPoint.y);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = '#e2e8f0';
    context.beginPath();
    context.arc(pointerWorld.x, pointerWorld.y, 4, 0, Math.PI * 2);
    context.fill();
  };

  const drawHud = () => {
    context.fillStyle = '#e2e8f0';
    context.font = '16px monospace';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText(`Room: ${currentRoom.name}`, 24, 24);
    context.fillText(`Shot: ${settings.projectileType}`, 24, 44);
    context.fillText(`Mobs: ${currentRoom.mobs.length} (frozen)`, 24, 64);
    context.fillText(`Active projectiles: ${projectiles.length}`, 24, 84);
  };

  const render = () => {
    context.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    drawWalls();
    drawMobs();
    drawBeamPulses();
    drawProjectiles();
    drawPlayer();
    drawAimSight();
    drawHud();
  };

  const tick = (now: number) => {
    syncCanvasSize();
    const deltaMs = Math.min(now - lastFrameTimeMs, MAX_FRAME_DELTA_MS);
    lastFrameTimeMs = now;

    updateProjectiles(deltaMs);
    updateBeamPulses(deltaMs);
    render();
    frameHandle = window.requestAnimationFrame(tick);
  };

  const handlePointerDown = (event: PointerEvent) => {
    const world = screenToWorld(event.clientX, event.clientY);
    if (!world) {
      return;
    }

    pointerWorld = world;
    pointerIsDown = true;
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent) => {
    const world = screenToWorld(event.clientX, event.clientY);
    if (!world) {
      return;
    }
    pointerWorld = world;
  };

  const handlePointerRelease = (event: PointerEvent) => {
    if (!pointerIsDown) {
      return;
    }

    const world = screenToWorld(event.clientX, event.clientY);
    if (world) {
      pointerWorld = world;
    }
    pointerIsDown = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    fireCurrentShot();
  };

  const roomOptions = Object.fromEntries(ROOM_PRESETS.map((room) => [room.name, room.id]));
  const shotOptions: Record<string, ProjectileType> = {
    Bullet: 'bullet',
    Arrow: 'arrow',
    Beam: 'beam',
  };

  gui
    .add(settings, 'roomId', roomOptions)
    .name('Room Preset')
    .onChange((roomId: string) => {
      currentRoom = findRoom(roomId);
      clearShots();
      render();
    });

  gui
    .add(settings, 'projectileType', shotOptions)
    .name('Shot Type')
    .onChange(() => {
      clearShots();
      render();
    });

  gui.add(settings, 'highlightAimTarget').name('Color-Code Aim Target');
  gui
    .add(
      {
        clearShots,
      },
      'clearShots',
    )
    .name('Clear Shots');

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerRelease);
  canvas.addEventListener('pointercancel', handlePointerRelease);
  window.addEventListener('resize', syncCanvasSize);

  syncCanvasSize();
  render();
  frameHandle = window.requestAnimationFrame(tick);

  return () => {
    window.cancelAnimationFrame(frameHandle);
    window.removeEventListener('resize', syncCanvasSize);
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerup', handlePointerRelease);
    canvas.removeEventListener('pointercancel', handlePointerRelease);
    hint.remove();
    root.remove();
  };
}

registerLab('collision-lab', {
  category: 'Movement & Physics' as LabCategory,
  name: 'Projectile Collision Lab',
  description:
    'Hold to aim from a fixed player center, release to fire, and verify bullets/arrows/beams stop on walls in room presets.',
  create: createCollisionLab,
});
