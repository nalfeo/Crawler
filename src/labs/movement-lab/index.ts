import { hasComponent, query, setComponent } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { Enemy, Player, Position, Velocity } from '../../core/components.js';
import {
  createGameWorld,
  movementSystem,
  playerInputSystem,
  spawnEnemy,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import {
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../../engine/generatedAssets/index.js';
import { buildGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { GAME, PLAYER_SPEED } from '../../shared/constants.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

type TrailPoint = {
  x: number;
  y: number;
};

interface MovementLabSettings {
  speed: number;
  acceleration: number;
  friction: number;
  showTrail: boolean;
  trailLength: number;
}

const MAX_STEPS_PER_FRAME = 4;
const MAX_TRAIL_POINTS = 100;
const GRID_SIZE_FT = 6;
const ENEMY_COUNT = 10;
const ENEMY_MARGIN_FT = 4;
const LAB_ID = 'movement-lab';
const PLAYER_WALK_TEXTURE_KEY = 'player-walk-placeholder-v1-var-0';

function buildMovementLabSpriteRegistry() {
  return buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      [PLAYER_WALK_TEXTURE_KEY]: {
        briefId: 'player-walk-placeholder-v1',
        spriteName: PLAYER_WALK_TEXTURE_KEY,
        assetPath: 'generated/rhea-vale-v1-var-0-walk.png',
        approvedAt: '2026-08-01T00:00:00.000Z',
        sourceRun: 'movement-lab',
        variantIndex: 0,
        anchor: null,
        sensorScore: 'n/a',
        judgeScore: null,
        animation: {
          frameWidth: 64,
          frameHeight: 64,
          frameCount: 3,
          frameRate: 6,
          loop: true,
        },
      },
    },
  });
}

class TrailBuffer {
  private readonly points: Array<TrailPoint | undefined>;

  private head = 0;

  private size = 0;

  constructor(private readonly capacity: number) {
    this.points = new Array<TrailPoint | undefined>(capacity);
  }

  push(x: number, y: number): void {
    this.points[this.head] = { x, y };
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  last(): TrailPoint | undefined {
    if (this.size === 0) {
      return undefined;
    }

    const index = (this.head - 1 + this.capacity) % this.capacity;
    return this.points[index];
  }

  getPoints(limit: number): TrailPoint[] {
    const count = Math.min(this.size, Math.max(0, Math.floor(limit)));
    const start = (this.head - count + this.capacity) % this.capacity;
    const ordered: TrailPoint[] = [];

    for (let index = 0; index < count; index += 1) {
      const point = this.points[(start + index) % this.capacity];
      if (point) {
        ordered.push(point);
      }
    }

    return ordered;
  }
}

function lerp(from: number, to: number, factor: number): number {
  return from + (to - from) * factor;
}

function createMovementLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #12213d 0%, #090f1c 68%, #05070f 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const info = document.createElement('div');
  info.style.position = 'absolute';
  info.style.left = '16px';
  info.style.bottom = '16px';
  info.style.padding = '10px 12px';
  info.style.borderRadius = '12px';
  info.style.background = 'rgba(5, 10, 24, 0.78)';
  info.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  info.style.color = '#f8fafc';
  info.style.lineHeight = '1.5';
  info.style.whiteSpace = 'pre-line';
  info.style.pointerEvents = 'none';
  info.id = 'movement-lab-debug';

  // Raw keyboard tracker independent of Phaser
  const rawKeys = new Set<string>();
  const keyLog: string[] = [];
  const MAX_KEY_LOG = 20;
  const logKey = (type: string, key: string) => {
    keyLog.push(`${Date.now() % 100000} ${type} ${key}`);
    if (keyLog.length > MAX_KEY_LOG) keyLog.shift();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    rawKeys.add(e.code);
    logKey('DN', e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    rawKeys.delete(e.code);
    logKey('UP', e.code);
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  const hint = document.createElement('p');
  hint.textContent =
    'Move with WASD or arrow keys. Tune speed, acceleration, friction, trail length, and enemy clutter live.';
  hint.style.marginTop = '16px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, info);
  canvasHost.append(root);

  const settings: MovementLabSettings = {
    speed: PLAYER_SPEED,
    acceleration: 1,
    friction: 0,
    showTrail: true,
    trailLength: 20,
    ...(loadLabState<MovementLabSettings>(LAB_ID) ?? {}),
  };

  let spawnEnemiesFromGui = (_count: number) => undefined;
  let refreshTrailFromGui = () => undefined;
  let updateInfoFromGui = () => undefined;

  class MovementLabScene extends Phaser.Scene {
    private accumulator = 0;

    private bridge?: ReturnType<typeof createPhaserBridge>;

    private gridGraphics?: Phaser.GameObjects.Graphics;

    private inputCapture?: ReturnType<typeof createInputCapture>;

    private inputState!: InputState;

    private playerEid = -1;

    private trailGraphics?: Phaser.GameObjects.Graphics;

    private readonly trail = new TrailBuffer(MAX_TRAIL_POINTS);

    private world!: GameWorld;

    constructor() {
      super({ key: 'MovementLabScene' });
    }

    preload(): void {
      const generatedRegistry = buildMovementLabSpriteRegistry();
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, generatedRegistry);
      if (this.load) {
        preloadGeneratedSprites(this.load, generatedRegistry);
      }
    }

    create(): void {
      spawnEnemiesFromGui = (count: number) => {
        this.spawnEnemies(count);
      };
      refreshTrailFromGui = () => {
        this.refreshTrail();
      };
      updateInfoFromGui = () => {
        this.updateInfo();
      };

      this.accumulator = 0;
      this.world = createGameWorld({ seed: 1337 });
      this.inputState = createInputState();
      this.inputCapture = createInputCapture(this, {
        getFollowOrigin: () =>
          this.playerEid < 0
            ? undefined
            : {
                // Camera world-space is pixels; scale the player's feet position.
                x: ftToPx(this.world.stores.position.x[this.playerEid] ?? 0),
                y: ftToPx(this.world.stores.position.y[this.playerEid] ?? 0),
              },
      });

      this.cameras.main.setBackgroundColor('#050816');

      this.gridGraphics = this.add.graphics();
      this.trailGraphics = this.add.graphics();
      this.redrawGrid();

      this.playerEid = spawnPlayer(
        this.world,
        pxToFt(this.getViewportWidth()) / 2,
        pxToFt(this.getViewportHeight()) / 2,
      );
      this.recordTrail(true);

      this.bridge = createPhaserBridge(this);
      this.bridge.sync(this.world);
      this.drawTrail();
      this.updateInfo();

      const handleResize = () => {
        this.redrawGrid();
        this.drawTrail();
        this.updateInfo();
      };

      this.scale.on('resize', handleResize);
      this.events.once('shutdown', () => {
        spawnEnemiesFromGui = (_count: number) => undefined;
        refreshTrailFromGui = () => undefined;
        updateInfoFromGui = () => undefined;

        this.scale.off('resize', handleResize);
        this.inputCapture?.destroy();
        this.inputCapture = undefined;
        this.bridge?.destroy();
        this.bridge = undefined;
        this.gridGraphics?.destroy();
        this.gridGraphics = undefined;
        this.trailGraphics?.destroy();
        this.trailGraphics = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!this.bridge || !this.inputCapture || this.world.state !== 'playing') {
        return;
      }

      this.inputCapture.poll(this.inputState);
      this.accumulator += delta;
      let steps = 0;

      while (this.accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
        this.world.frameCount += 1;
        this.world.elapsedMs += GAME.DELTA_MS;

        this.applyPlayerMovementTuning();
        movementSystem(this.world);
        this.recordTrail();

        this.accumulator -= GAME.DELTA_MS;
        steps += 1;

        if (this.world.state !== 'playing') {
          break;
        }
      }

      if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
        this.accumulator = 0;
      }

      this.bridge.sync(this.world);
      this.drawTrail();
      this.updateInfo();
    }

    spawnEnemies(count: number): void {
      const spawnWidth = pxToFt(this.getViewportWidth());
      const spawnHeight = pxToFt(this.getViewportHeight());
      const usableWidth = Math.max(1, spawnWidth - ENEMY_MARGIN_FT * 2);
      const usableHeight = Math.max(1, spawnHeight - ENEMY_MARGIN_FT * 2);

      for (let index = 0; index < count; index += 1) {
        const x = ENEMY_MARGIN_FT + this.world.rng.next() * usableWidth;
        const y = ENEMY_MARGIN_FT + this.world.rng.next() * usableHeight;
        const hp = this.world.rng.nextInt(15, 40);
        spawnEnemy(this.world, x, y, hp);
      }

      this.bridge?.sync(this.world);
      this.updateInfo();
    }

    refreshTrail(): void {
      this.drawTrail();
      this.updateInfo();
    }

    updateInfo(): void {
      const playerX = this.playerEid >= 0 ? (this.world.stores.position.x[this.playerEid] ?? 0) : 0;
      const playerY = this.playerEid >= 0 ? (this.world.stores.position.y[this.playerEid] ?? 0) : 0;
      const velocityX =
        this.playerEid >= 0 ? (this.world.stores.velocity.x[this.playerEid] ?? 0) : 0;
      const velocityY =
        this.playerEid >= 0 ? (this.world.stores.velocity.y[this.playerEid] ?? 0) : 0;
      const enemyCount = query(this.world.ecs, [Enemy]).length;

      // The player's game object is a Sprite (not a plain Image) only when its
      // resolved texture carries an `animation` descriptor — see
      // `playPlayerWalkAnimation` in PhaserBridge.ts. Introspecting the scene's
      // display list (rather than adding a bridge-internal accessor) keeps this
      // lab a pure OBSERVER of the animation layer, exercising the exact same
      // public Phaser surface a real player render would.
      const playerSprite = this.children.list.find(
        (obj): obj is Phaser.GameObjects.Sprite =>
          'anims' in obj && (obj as Partial<Phaser.GameObjects.Sprite>).anims !== undefined,
      );
      const walkAnim = playerSprite
        ? {
            textureKey: playerSprite.texture.key,
            isPlaying: playerSprite.anims.isPlaying,
            frameIndex: playerSprite.anims.currentFrame?.index ?? null,
            flipX: playerSprite.flipX,
          }
        : null;

      // Read Phaser key states directly
      const kb = this.input.keyboard;
      const phaserW =
        kb?.checkDown(kb?.addKey('W', false, false) as Phaser.Input.Keyboard.Key) ?? false;
      const phaserA =
        kb?.checkDown(kb?.addKey('A', false, false) as Phaser.Input.Keyboard.Key) ?? false;
      const phaserS =
        kb?.checkDown(kb?.addKey('S', false, false) as Phaser.Input.Keyboard.Key) ?? false;
      const phaserD =
        kb?.checkDown(kb?.addKey('D', false, false) as Phaser.Input.Keyboard.Key) ?? false;

      const rawKeysStr = rawKeys.size > 0 ? Array.from(rawKeys).join('+') : 'none';
      const phaserKeysStr =
        [phaserW && 'W', phaserA && 'A', phaserS && 'S', phaserD && 'D']
          .filter(Boolean)
          .join('+') || 'none';

      // Expose debug object on window for JS evaluation
      (window as unknown as Record<string, unknown>).__movLabDebug = {
        worldState: this.world.state,
        rawKeys: Array.from(rawKeys),
        phaserKeys: { W: phaserW, A: phaserA, S: phaserS, D: phaserD },
        inputState: { ...this.inputState },
        velocity: { x: velocityX, y: velocityY },
        frameCount: this.world.frameCount,
        playerEid: this.playerEid,
        keyLog: [...keyLog],
        walkAnim,
      };

      info.textContent = [
        `State: ${this.world.state}  Frame: ${this.world.frameCount}  Enemies: ${enemyCount}`,
        `Player: (${playerX.toFixed(1)}, ${playerY.toFixed(1)})  Vel: (${velocityX.toFixed(2)}, ${velocityY.toFixed(2)})`,
        `Input: move(${this.inputState.moveX.toFixed(2)}, ${this.inputState.moveY.toFixed(2)})`,
        `RawKeys: ${rawKeysStr}  PhaserKeys: ${phaserKeysStr}`,
        `Speed: ${settings.speed.toFixed(1)}  Accel: ${settings.acceleration.toFixed(2)}  Fric: ${settings.friction.toFixed(2)}`,
        walkAnim
          ? `Walk anim: ${walkAnim.textureKey}  playing=${walkAnim.isPlaying}  frame=${walkAnim.frameIndex}  flipX=${walkAnim.flipX}`
          : 'Walk anim: (player has no animation descriptor — static Image)',
      ].join('\n');
    }

    private applyPlayerMovementTuning(): void {
      const players = Array.from(query(this.world.ecs, [Player, Velocity]));
      if (players.length === 0) {
        return;
      }

      const previousVelocities = players.map((eid) => ({
        eid,
        x: this.world.stores.velocity.x[eid] ?? 0,
        y: this.world.stores.velocity.y[eid] ?? 0,
      }));

      playerInputSystem(this.world, this.inputState);

      const speedScale = settings.speed / PLAYER_SPEED;
      const acceleration = Math.max(0, Math.min(1, settings.acceleration));
      const friction = Math.max(0, Math.min(1, settings.friction));
      const damping = 1 - friction;

      for (const previousVelocity of previousVelocities) {
        const targetX = (this.world.stores.velocity.x[previousVelocity.eid] ?? 0) * speedScale;
        const targetY = (this.world.stores.velocity.y[previousVelocity.eid] ?? 0) * speedScale;
        const nextX = acceleration < 1 ? lerp(previousVelocity.x, targetX, acceleration) : targetX;
        const nextY = acceleration < 1 ? lerp(previousVelocity.y, targetY, acceleration) : targetY;

        setComponent(this.world.ecs, previousVelocity.eid, Velocity, {
          x: nextX * damping,
          y: nextY * damping,
        });
      }
    }

    private recordTrail(force = false): void {
      if (this.playerEid < 0 || !hasComponent(this.world.ecs, this.playerEid, Position)) {
        return;
      }

      const x = this.world.stores.position.x[this.playerEid] ?? 0;
      const y = this.world.stores.position.y[this.playerEid] ?? 0;
      const lastPoint = this.trail.last();

      // 0.00625 ft ≈ 0.05 px: resample the trail on any sub-pixel movement.
      if (force || !lastPoint || Math.hypot(lastPoint.x - x, lastPoint.y - y) > 0.00625) {
        this.trail.push(x, y);
      }
    }

    private drawTrail(): void {
      const graphics = this.trailGraphics;
      if (!graphics) {
        return;
      }

      graphics.clear();
      if (!settings.showTrail) {
        return;
      }

      const points = this.trail.getPoints(settings.trailLength);
      if (points.length === 0) {
        return;
      }

      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (!previous || !current) {
          continue;
        }

        const alpha = index / points.length;
        graphics.lineStyle(2, 0x7ee0ff, alpha * 0.45);
        graphics.lineBetween(
          ftToPx(previous.x),
          ftToPx(previous.y),
          ftToPx(current.x),
          ftToPx(current.y),
        );
      }

      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        if (!point) {
          continue;
        }

        const alpha = (index + 1) / points.length;
        graphics.fillStyle(0x7ee0ff, alpha * 0.75);
        graphics.fillCircle(ftToPx(point.x), ftToPx(point.y), 2 + alpha * 2);
      }
    }

    private redrawGrid(): void {
      const graphics = this.gridGraphics;
      if (!graphics) {
        return;
      }

      const width = this.getViewportWidth();
      const height = this.getViewportHeight();
      graphics.clear();
      graphics.fillStyle(0x070d1a, 0.4);
      graphics.fillRect(0, 0, width, height);
      graphics.lineStyle(1, 0x24324a, 0.45);

      const gridSizePx = ftToPx(GRID_SIZE_FT);

      for (let x = 0; x <= width; x += gridSizePx) {
        graphics.lineBetween(x, 0, x, height);
      }

      for (let y = 0; y <= height; y += gridSizePx) {
        graphics.lineBetween(0, y, width, y);
      }
    }

    private getViewportHeight(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private getViewportWidth(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }
  }

  const controlsApi = {
    spawnEnemies: () => {
      spawnEnemiesFromGui(ENEMY_COUNT);
    },
  };

  gui
    .add(settings, 'speed', 0.125, 1.875, 0.0125)
    .name('Speed')
    .onChange(() => updateInfoFromGui());
  gui
    .add(settings, 'acceleration', 0, 1, 0.01)
    .name('Acceleration')
    .onChange(() => updateInfoFromGui());
  gui
    .add(settings, 'friction', 0, 1, 0.01)
    .name('Friction')
    .onChange(() => updateInfoFromGui());
  gui
    .add(settings, 'showTrail')
    .name('Show Trail')
    .onChange(() => refreshTrailFromGui());
  gui
    .add(settings, 'trailLength', 5, 100, 1)
    .name('Trail Length')
    .onChange(() => refreshTrailFromGui());
  gui.add(controlsApi, 'spawnEnemies').name('Spawn Enemies');
  gui.onChange(() => saveLabState(LAB_ID, settings));

  const getSize = () => ({
    width: Math.max(1, Math.round(gameHost.clientWidth || GAME.WIDTH)),
    height: Math.max(1, Math.round(gameHost.clientHeight || GAME.HEIGHT)),
  });

  const initialSize = getSize();
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: initialSize.width,
    height: initialSize.height,
    backgroundColor: '#050816',
    scene: [MovementLabScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  const game = new Phaser.Game(config);
  const resizeObserver = new ResizeObserver(() => {
    const nextSize = getSize();
    game.scale.resize(nextSize.width, nextSize.height);
  });
  resizeObserver.observe(gameHost);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    delete (window as unknown as Record<string, unknown>).__movLabDebug;
    resizeObserver.disconnect();
    game.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab('movement-lab', {
  category: 'Movement & Physics' as LabCategory,
  name: 'Movement Lab',
  description:
    'Tune WASD movement with live speed, acceleration, friction, trail, and enemy spawn controls. Also surfaces the player walk-animation state (texture, frame index, flip) driven by PhaserBridge.',
  create: createMovementLab,
});
