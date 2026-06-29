import { addComponent, query, set, setComponent } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { BroadcastScore, Enemy, Velocity } from '../../core/components.js';
import {
  collisionSystem,
  createGameWorld,
  damageSystem,
  healthSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  lifetimeSystem,
  areaDamageSystem,
  beamSystem,
  trapSystem,
  returningProjectileSystem,
  aoeOnImpactPreDamage,
  aoeOnImpactPostDamage,
  meleeSwingSystem,
  knockbackSystem,
  dropSystem,
  deathTimerSystem,
  spawnAnimSystem,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import {
  configureEnemySpawner,
  enemySpawnerSystem,
  setActiveWeapon,
  weaponSystem,
} from '../../game/index.js';
import { GAME, MeleeStyle, PLAYER_SPEED, WeaponType } from '../../shared/constants.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { WEAPON_DEFS, type WeaponDef } from '../../shared/weaponDefs.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const WEAPON_IDS = [...WEAPON_DEFS.keys()];
const LAB_ID = 'weapon-lab';

/** Serializable snapshot of all lab state that should survive HMR. */
interface WeaponsLabSnapshot {
  settings: WeaponsLabSettings;
  tunedWeaponOverrides: Record<string, Partial<TunableWeaponDef>>;
}

/** Mutable copy of a WeaponDef for live tuning. */
interface TunableWeaponDef {
  id: string;
  name: string;
  weaponType: number;
  baseDamage: number;
  cooldownMs: number;
  range: number;
  projectileSpeed: number;
  aoeRadius: number;
  durationMs: number;
  beamTickMs: number;
  beamLength: number;
  trapArmMs: number;
  trapTriggerRadius: number;
  trapExplosionRadius: number;
  returnSpeed: number;
  maxRange: number;
  swingArcDeg: number;
  meleeStyle: number;
  headRadius: number;
  shaftDamageMult: number;
  knockback: number;
  pierce: number;
  bounceCount: number;
  baseAccuracy: number;
  goreFactor: number;
}

function cloneWeaponDef(def: WeaponDef): TunableWeaponDef {
  return { ...def };
}

function weaponTypeLabel(type: number | undefined): string {
  switch (type) {
    case WeaponType.MELEE:
      return 'Melee';
    case WeaponType.RANGED:
      return 'Ranged';
    case WeaponType.MAGIC:
      return 'Magic';
    case WeaponType.THROWN:
      return 'Thrown';
    case WeaponType.BEAM:
      return 'Beam';
    case WeaponType.TRAP:
      return 'Trap';
    default:
      return 'Unknown';
  }
}

interface WeaponsLabSettings {
  playerSpeed: number;
  maxEnemies: number;
  spawnIntervalMs: number;
  enemyHp: number;
  enemySpeed: number;
  activeWeapon: string;
  invulnerable: boolean;
}

const MAX_STEPS_PER_FRAME = 8;
const LAB_SEED = 7331;

function createWeaponsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #1a2040 0%, #0c0e1a 45%, #050510 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '12px 14px';
  hud.style.borderRadius = '12px';
  hud.style.background = 'rgba(10, 12, 30, 0.82)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  hud.style.color = '#f8fafc';
  hud.style.lineHeight = '1.5';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Move with WASD / arrows. Switch weapons in the controls panel. All weapon types auto-fire. ' +
    'Tune Base Accuracy to see misses register in the HUD; killed enemies leave lingering corpses (with drops).';
  hint.style.marginTop = '16px';
  hint.style.color = '#a5b4fc';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud);
  canvasHost.append(root);

  const saved = loadLabState<WeaponsLabSnapshot>(LAB_ID);

  const settings: WeaponsLabSettings = {
    playerSpeed: PLAYER_SPEED,
    maxEnemies: 30,
    spawnIntervalMs: 750,
    enemyHp: 30,
    enemySpeed: 0.15625,
    activeWeapon: WEAPON_IDS[0] ?? 'sword',
    invulnerable: true,
    ...(saved?.settings ?? {}),
  };

  // Per-weapon tuning overrides that survive weapon switching
  const tunedOverrides: Record<string, Partial<TunableWeaponDef>> = saved?.tunedWeaponOverrides ??
  {};

  let resetWorldFromGui = () => undefined;

  class WeaponsLabScene extends Phaser.Scene {
    private accumulator = 0;

    private bridge?: ReturnType<typeof createPhaserBridge>;

    private inputCapture?: ReturnType<typeof createInputCapture>;

    private inputState!: InputState;

    private playerEid = -1;

    private world!: GameWorld;

    private hits = 0;

    private misses = 0;

    constructor() {
      super({ key: 'WeaponsLabScene' });
    }

    create(): void {
      resetWorldFromGui = () => {
        this.resetWorld();
      };

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
      this.accumulator = 0;

      this.cameras.main.setBackgroundColor('#0c0e1a');
      this.bridge = createPhaserBridge(this);
      this.resetWorld();

      const handleResize = () => {
        this.applySpawnerBounds();
      };

      this.scale.on('resize', handleResize);
      this.events.once('shutdown', () => {
        resetWorldFromGui = () => undefined;
        this.scale.off('resize', handleResize);
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

      if (this.world.state === 'playing') {
        this.inputCapture.poll(this.inputState);
        this.accumulator += delta;
        let steps = 0;

        while (
          this.accumulator >= GAME.DELTA_MS &&
          steps < MAX_STEPS_PER_FRAME &&
          this.world.state === 'playing'
        ) {
          this.world.frameCount += 1;
          this.world.elapsedMs += GAME.DELTA_MS;

          this.applySpawnerBounds();
          this.applyActiveWeapon();

          playerInputSystem(this.world, this.inputState);
          this.applyPlayerSpeedSetting();
          enemySpawnerSystem(this.world, {
            maxEnemies: settings.maxEnemies,
            spawnIntervalMs: settings.spawnIntervalMs,
            enemyHp: settings.enemyHp,
            enemySpeed: settings.enemySpeed,
          });
          movementSystem(this.world);
          returningProjectileSystem(this.world);
          weaponSystem(this.world);

          const collision = collisionSystem(this.world);

          aoeOnImpactPreDamage(this.world);
          damageSystem(this.world, collision);
          aoeOnImpactPostDamage(this.world);

          areaDamageSystem(this.world, collision);
          meleeSwingSystem(this.world);
          knockbackSystem(this.world);
          beamSystem(this.world);
          trapSystem(this.world, collision);

          dropSystem(this.world);
          deathTimerSystem(this.world);
          spawnAnimSystem(this.world);
          healthSystem(this.world);
          this.applyInvulnerability();
          lifetimeSystem(this.world);
          projectileCleanupSystem(this.world);

          this.accumulator -= GAME.DELTA_MS;
          steps += 1;
        }

        if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
          this.accumulator = GAME.DELTA_MS;
        }
      }

      const interpAlpha = Math.min(1, Math.max(0, this.accumulator / GAME.DELTA_MS));
      const renderElapsedMs = this.world.elapsedMs + this.accumulator;
      this.tallyCombatEvents();
      this.bridge.sync(this.world, renderElapsedMs, interpAlpha);
      this.updateHud();
    }

    /**
     * Count player weapon hits/misses from combatEvents for the current frame.
     * Must run once per frame BEFORE bridge.sync, which drains combatEvents
     * (via CombatVfx). Calling it per sim-step would double-count un-drained
     * events.
     */
    private tallyCombatEvents(): void {
      for (const event of this.world.combatEvents) {
        if (event.type === 'hit' && event.targetType === 'enemy') {
          this.hits += 1;
        } else if (event.type === 'miss') {
          this.misses += 1;
        }
      }
    }

    private applyActiveWeapon(): void {
      if (tunedWeapon !== undefined) {
        setActiveWeapon(this.world, tunedWeapon as WeaponDef);
      }
    }

    private applyPlayerSpeedSetting(): void {
      if (this.playerEid < 0) {
        return;
      }

      const scale = PLAYER_SPEED > 0 ? settings.playerSpeed / PLAYER_SPEED : 1;
      const velocityX = (this.world.stores.velocity.x[this.playerEid] ?? 0) * scale;
      const velocityY = (this.world.stores.velocity.y[this.playerEid] ?? 0) * scale;

      setComponent(this.world.ecs, this.playerEid, Velocity, {
        x: velocityX,
        y: velocityY,
      });
    }

    private applyInvulnerability(): void {
      if (!settings.invulnerable || this.playerEid < 0) return;
      const max = this.world.stores.health.max[this.playerEid] ?? 100;
      this.world.stores.health.current[this.playerEid] = max;
    }

    private applySpawnerBounds(): void {
      configureEnemySpawner(this.world, {
        width: pxToFt(this.getSimulationWidth()),
        height: pxToFt(this.getSimulationHeight()),
      });
    }

    private getSimulationHeight(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private getSimulationWidth(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }

    private resetWorld(): void {
      this.accumulator = 0;
      this.hits = 0;
      this.misses = 0;
      this.world = createGameWorld({ seed: LAB_SEED });
      this.playerEid = spawnPlayer(
        this.world,
        pxToFt(this.getSimulationWidth()) / 2,
        pxToFt(this.getSimulationHeight()) / 2,
      );
      addComponent(this.world.ecs, this.playerEid, set(BroadcastScore, { current: 0 }));

      this.applyActiveWeapon();
      this.applySpawnerBounds();
      this.bridge?.sync(this.world);
      this.updateHud();
    }

    private updateHud(): void {
      const playerHp =
        this.playerEid >= 0 ? (this.world.stores.health.current[this.playerEid] ?? 0) : 0;
      const score =
        this.playerEid >= 0 ? (this.world.stores.broadcastScore.current[this.playerEid] ?? 0) : 0;
      const enemyCount = query(this.world.ecs, [Enemy]).length;
      const activeDef = tunedWeapon ?? WEAPON_DEFS.get(settings.activeWeapon);
      const baseAccuracyPct = ((activeDef?.baseAccuracy ?? 0) * 100).toFixed(0);
      const attempts = this.hits + this.misses;
      const hitRatePct = attempts > 0 ? ((this.hits / attempts) * 100).toFixed(0) : '—';

      hud.textContent = [
        `Weapon: ${activeDef?.name ?? settings.activeWeapon}`,
        `Type: ${weaponTypeLabel(activeDef?.weaponType)}`,
        `Base Accuracy: ${baseAccuracyPct}%`,
        `Player HP: ${playerHp.toFixed(0)}`,
        `Score: ${score.toFixed(0)}`,
        `Enemies: ${enemyCount}`,
        `Hits: ${this.hits}  Misses: ${this.misses}  (${hitRatePct}% hit)`,
        `State: ${this.world.state}`,
      ].join('\n');
    }
  }

  let tunedWeapon: TunableWeaponDef | undefined;
  let weaponFolder: GUI | undefined;

  /** Save current lab state to sessionStorage for HMR survival. */
  function persistState(): void {
    if (tunedWeapon) {
      tunedOverrides[settings.activeWeapon] = { ...tunedWeapon };
    }
    saveLabState<WeaponsLabSnapshot>(LAB_ID, {
      settings,
      tunedWeaponOverrides: tunedOverrides,
    });
  }

  function buildWeaponFolder(): void {
    if (weaponFolder) {
      weaponFolder.destroy();
      weaponFolder = undefined;
    }

    const baseDef = WEAPON_DEFS.get(settings.activeWeapon);
    if (!baseDef || !gui) return;

    tunedWeapon = cloneWeaponDef(baseDef);

    // Restore any saved tuning overrides for this weapon
    const overrides = tunedOverrides[settings.activeWeapon];
    if (overrides) {
      Object.assign(tunedWeapon, overrides);
      // Keep identity fields from base def
      tunedWeapon.id = baseDef.id;
      tunedWeapon.name = baseDef.name;
      tunedWeapon.weaponType = baseDef.weaponType;
    }

    weaponFolder = gui.addFolder(`${baseDef.name} Stats`);
    weaponFolder.open();

    // Common to all weapons
    weaponFolder.add(tunedWeapon, 'baseDamage', 1, 100, 1).name('Damage');
    weaponFolder.add(tunedWeapon, 'cooldownMs', 50, 5000, 10).name('Cooldown (ms)');
    weaponFolder.add(tunedWeapon, 'baseAccuracy', 0, 1, 0.01).name('Base Accuracy');
    weaponFolder.add(tunedWeapon, 'goreFactor', 0, 1, 0.05).name('Gore Factor');

    const wt = baseDef.weaponType;

    // Melee / Unarmed: show only relevant controls per weapon
    if (wt === WeaponType.MELEE) {
      weaponFolder.add(tunedWeapon, 'aoeRadius', 1, 15, 0.125).name('Blade Length');
      weaponFolder
        .add(tunedWeapon, 'meleeStyle', { Slash: MeleeStyle.SLASH, Stab: MeleeStyle.STAB })
        .name('Style');
      // Swing arc only matters for slash weapons
      if (baseDef.meleeStyle !== MeleeStyle.STAB) {
        weaponFolder.add(tunedWeapon, 'swingArcDeg', 5, 360, 1).name('Swing Arc (°)');
      }
      weaponFolder.add(tunedWeapon, 'durationMs', 50, 1000, 10).name('Swing Speed (ms)');
      // Head/shaft only for weapons with a head
      if (baseDef.headRadius > 0) {
        weaponFolder.add(tunedWeapon, 'headRadius', 0, 4, 0.125).name('Head Radius');
        weaponFolder.add(tunedWeapon, 'shaftDamageMult', 0, 1, 0.05).name('Shaft Damage %');
      }
      weaponFolder.add(tunedWeapon, 'knockback', 0, 12.5, 0.125).name('Knockback (ft)');
    }

    // Ranged: projectile speed + pierce
    if (wt === WeaponType.RANGED) {
      weaponFolder.add(tunedWeapon, 'projectileSpeed', 0.125, 2.5, 0.0625).name('Projectile Speed');
      weaponFolder.add(tunedWeapon, 'pierce', 0, 20, 1).name('Pierce');
    }

    // Magic: projectile speed + AoE radius
    if (wt === WeaponType.MAGIC) {
      weaponFolder.add(tunedWeapon, 'projectileSpeed', 0.125, 2.5, 0.0625).name('Projectile Speed');
      weaponFolder.add(tunedWeapon, 'aoeRadius', 1, 18.75, 0.125).name('Explosion Radius');
    }

    // Thrown: projectile speed + return speed + max range
    if (wt === WeaponType.THROWN) {
      weaponFolder.add(tunedWeapon, 'projectileSpeed', 0.125, 2.5, 0.0625).name('Throw Speed');
      weaponFolder.add(tunedWeapon, 'pierce', 0, 20, 1).name('Pierce');
      weaponFolder.add(tunedWeapon, 'returnSpeed', 0.125, 1.875, 0.0625).name('Return Speed');
      weaponFolder.add(tunedWeapon, 'maxRange', 6.25, 62.5, 1.25).name('Max Range');
      weaponFolder.add(tunedWeapon, 'bounceCount', 0, 12, 1).name('Bounce Count');
    }

    // Beam: length + duration + tick interval
    if (wt === WeaponType.BEAM) {
      weaponFolder.add(tunedWeapon, 'beamLength', 6.25, 62.5, 1.25).name('Beam Length');
      weaponFolder.add(tunedWeapon, 'durationMs', 100, 2000, 50).name('Duration (ms)');
      weaponFolder.add(tunedWeapon, 'beamTickMs', 25, 500, 25).name('Tick Interval (ms)');
    }

    // Trap: arm time + trigger radius + explosion radius
    if (wt === WeaponType.TRAP) {
      weaponFolder.add(tunedWeapon, 'trapArmMs', 0, 3000, 50).name('Arm Delay (ms)');
      weaponFolder.add(tunedWeapon, 'trapTriggerRadius', 1, 12.5, 0.125).name('Trigger Radius');
      weaponFolder.add(tunedWeapon, 'trapExplosionRadius', 2, 25, 0.125).name('Explosion Radius');
    }

    // Reset to defaults button
    weaponFolder
      .add(
        {
          reset: () => {
            const fresh = WEAPON_DEFS.get(settings.activeWeapon);
            if (fresh && tunedWeapon) {
              Object.assign(tunedWeapon, cloneWeaponDef(fresh));
              weaponFolder?.controllersRecursive().forEach((c) => c.updateDisplay());
            }
          },
        },
        'reset',
      )
      .name('Reset to Defaults');
  }

  const controlsApi = {
    reset: () => {
      resetWorldFromGui();
    },
  };

  gui
    .add(settings, 'activeWeapon', WEAPON_IDS)
    .name('Weapon')
    .onChange((newWeaponId: string) => {
      // Save the previous weapon's tuning before switching
      if (tunedWeapon && tunedWeapon.id !== newWeaponId) {
        tunedOverrides[tunedWeapon.id] = { ...tunedWeapon };
      }
      buildWeaponFolder();
      persistState();
    });

  const arenaFolder = gui.addFolder('Arena');
  arenaFolder.add(settings, 'playerSpeed', 0.125, 1.875, 0.0125).name('Player Speed');
  arenaFolder.add(settings, 'invulnerable').name('Invulnerable');
  arenaFolder.add(settings, 'maxEnemies', 5, 200, 1).name('Max Enemies');
  arenaFolder.add(settings, 'spawnIntervalMs', 100, 5000, 1).name('Spawn Interval');
  arenaFolder.add(settings, 'enemyHp', 10, 500, 1).name('Enemy HP');
  arenaFolder.add(settings, 'enemySpeed', 0.0625, 0.625, 0.0125).name('Enemy Speed');
  arenaFolder.add(controlsApi, 'reset').name('Reset');

  // Build initial weapon folder
  buildWeaponFolder();

  // Persist state on any GUI control change
  gui.onChange(persistState);

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
    backgroundColor: '#0c0e1a',
    scene: [WeaponsLabScene],
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
    resizeObserver.disconnect();
    game.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab('weapon-lab', {
  category: 'Combat' as LabCategory,
  name: 'Weapon Lab',
  description:
    'Stress-test auto-attacks against deterministic enemy spawns. Switch weapons via the dropdown to try every melee, ranged, magic, thrown, beam, and trap implementation (with correct sprites when available).',
  create: createWeaponsLab,
});
