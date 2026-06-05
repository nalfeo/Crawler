import Phaser from 'phaser';
import {
  createGameWorld,
  dropSystem,
  healthSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { GAME } from '../../shared/constants.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { createInputCapture } from '../InputCapture.js';
import { createPhaserBridge } from '../PhaserBridge.js';

/** Maximum simulation steps per frame to prevent spiral of death. */
const MAX_STEPS_PER_FRAME = 4;

export class MainGameScene extends Phaser.Scene {
  static readonly KEY = 'MainGameScene';

  private bridge?: ReturnType<typeof createPhaserBridge>;

  private inputState!: InputState;

  private inputCapture?: ReturnType<typeof createInputCapture>;

  private playerEid = -1;

  private world!: GameWorld;

  /** Accumulated real time not yet consumed by fixed-step simulation (ms). */
  private accumulator = 0;

  /**
   * Optional game-layer systems injected at construction time.
   * The engine layer cannot import from the game layer, so callers
   * (e.g. src/main.ts) inject these via the constructor.
   */
  constructor(private readonly extraSystems: ReadonlyArray<(world: GameWorld) => void> = []) {
    super({ key: MainGameScene.KEY });
  }

  create(): void {
    this.world = createGameWorld();
    this.inputState = createInputState();
    this.inputCapture = createInputCapture(this, {
      getFollowOrigin: () =>
        this.playerEid < 0
          ? undefined
          : {
              x: this.world.stores.position.x[this.playerEid] ?? 0,
              y: this.world.stores.position.y[this.playerEid] ?? 0,
            },
    });
    this.accumulator = 0;

    this.playerEid = spawnPlayer(this.world, GAME.WIDTH / 2, GAME.HEIGHT / 2);

    this.bridge = createPhaserBridge(this);
    this.bridge.sync(this.world);

    this.events.once('shutdown', () => {
      this.inputCapture?.destroy();
      this.inputCapture = undefined;
      this.bridge?.destroy();
      this.bridge = undefined;
    });
  }

  update(_time: number, delta: number): void {
    if (!this.bridge || !this.inputCapture) {
      return;
    }

    if (this.world.state !== 'playing') {
      return;
    }

    // Poll input once per frame (hardware state, not simulation)
    this.inputCapture.poll(this.inputState);

    // Fixed-timestep accumulator: run simulation at GAME.DELTA_MS intervals
    this.accumulator += delta;
    let steps = 0;

    while (this.accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
      this.world.frameCount += 1;
      this.world.elapsedMs += GAME.DELTA_MS;

      playerInputSystem(this.world, this.inputState);
      movementSystem(this.world);
      dropSystem(this.world);
      healthSystem(this.world);
      projectileCleanupSystem(this.world);
      for (const sys of this.extraSystems) {
        sys(this.world);
      }

      this.accumulator -= GAME.DELTA_MS;
      steps += 1;

      if (this.world.state !== 'playing') {
        break;
      }
    }

    // Cap accumulator to prevent spiral of death after long pauses
    if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
      this.accumulator = 0;
    }

    this.bridge.sync(this.world);
  }
}
