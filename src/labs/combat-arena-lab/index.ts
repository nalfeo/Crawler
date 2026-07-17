/**
 * Combat Arena Lab
 *
 * A full-engine combat sandbox for AI debugging and encounter playtesting.
 * Supports multiple room geometry presets, enemy encounter presets (filterable
 * by floor), and a custom mob-placement mode.
 *
 * All game logic runs via `runCoreSimulationStep` — the same shared deterministic
 * pipeline used by the visual and headless floor simulations. Pure arena data
 * (room presets, enemy presets, spawn helpers) lives in `arena-data.ts` and is
 * safe to import in Node/headless tests.
 */
import { addComponent, query, removeComponent, removeEntity } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import {
  clearEntityStores,
  Enemy,
  Invincible,
  createGameWorld,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { runCoreSimulationStep } from '../../core/simulation-core-step.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import { createHudAnnouncementBanner } from '../../engine/HudAnnouncementBanner.js';
import { buildTerrainLayer } from '../../engine/terrain-renderer.js';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../../engine/generatedAssets/index.js';
import { SHEETS } from '../../engine/sprites/index.js';
import { enemyAISystem, weaponSystem } from '../../game/index.js';
import { mobAbilitySystem, statusEffectSystem } from '../../core/index.js';
import { equipStarterOrFallback } from '../../game/scenarios/starterWeaponEquip.js';
import { GAME } from '../../shared/constants.js';
import { emptyGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { floor2EnemyPack, type EnemyArchetypeDef } from '../../shared/enemy-packs.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { createLogger } from '../../shared/logger.js';
import { SeededRandom } from '../../shared/random.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import {
  ALL_ARCHETYPES,
  ARENA_ENEMY_PRESETS,
  ARENA_ROOM_PRESETS,
  findWalkablePosition,
  getEnemyPreset,
  getRoomPreset,
  spawnFromArchetype,
  spawnPresetAroundCenter,
} from './arena-data.js';

// Re-export pure data so consumers can use a single import.
export {
  ALL_ARCHETYPES,
  ARENA_ENEMY_PRESETS,
  ARENA_ROOM_PRESETS,
  spawnFromArchetype,
} from './arena-data.js';

const LAB_ID = 'combat-arena-lab';
const MAX_STEPS_PER_FRAME = 32;
const PLAYER_HP_HERO = 200;
const PLAYER_HP_OBSERVER = 5_000;
const STARTER_WEAPON_ID = 'sword';
const logger = createLogger('labs:combat-arena');

const CRITICAL_SHEET_KEYS = new Set([
  'kenney-tiny-dungeon',
  'kenney-tiny-town',
  'kenney-roguelike-rpg-pack',
  'custom-pixel-sprites',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

type PlayerMode = 'hero' | 'observer' | 'immortal';
type SimSpeed = 1 | 4 | 16;
type FloorFilter = 'all' | 'floor1' | 'floor2';

interface CombatArenaLabSettings {
  roomPresetId: string;
  floorFilter: FloorFilter;
  enemyPresetId: string;
  playerMode: PlayerMode;
  simSpeed: SimSpeed;
  customMobId: string;
  customModeActive: boolean;
  arenaSeed: number;
}

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

// ─── Phaser Scene ────────────────────────────────────────────────────────────

class CombatArenaScene extends Phaser.Scene {
  private accumulator = 0;
  private bridge?: ReturnType<typeof createPhaserBridge>;
  private announcementBanner?: ReturnType<typeof createHudAnnouncementBanner>;
  private inputCapture?: ReturnType<typeof createInputCapture>;
  private inputState!: InputState;
  private playerEid = -1;
  /** GameWorld is intentionally public so the GUI step-frame helper can drive one tick. */
  world!: GameWorld;
  private rng!: SeededRandom;
  /** Mutable settings ref shared with the GUI. */
  settings!: CombatArenaLabSettings;
  /** Called by GUI when a mob should be spawned at a world position (in feet). */
  onSpawnAtPosition: ((x: number, y: number) => void) | null = null;
  /** Called each simulation step to update the info overlay. */
  onInfoUpdate: ((text: string) => void) | null = null;
  /** Called after the arena seed is (re)generated so the GUI display refreshes. */
  onSeedChanged: (() => void) | null = null;

  constructor() {
    super({ key: 'CombatArenaScene' });
  }

  preload(): void {
    if (!this.load) return;
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      logger.warn('Sprite asset load error — falling back to procedural texture', {
        key: file.key,
        url: file.url,
      });
    });
    for (const sheet of SHEETS) {
      if (!CRITICAL_SHEET_KEYS.has(sheet.key)) continue;
      this.load.spritesheet(sheet.key, sheet.path, {
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
        margin: sheet.margin,
        spacing: sheet.spacing,
      });
    }
    this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0a0810');
    this.accumulator = 0;
    // Use crypto.getRandomValues for the initial seed — avoids Date.now() (prohibited
    // by project rules) and gives better entropy than low-resolution wall-clock time.
    // The seed is exposed in the GUI so runs are reproducible when needed.
    if (!this.settings.arenaSeed) {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      this.settings.arenaSeed = buf[0]! >>> 0;
      // Notify the GUI so the read-only seed display refreshes.
      this.onSeedChanged?.();
    }
    this.rng = new SeededRandom(this.settings.arenaSeed);
    this.world = createGameWorld({ seed: this.rng.nextInt(1, 99999) });
    this.inputState = createInputState();

    const preset = getRoomPreset(this.settings.roomPresetId);
    this.world.floorMap = preset.buildMap();
    this.world.hideFloorTimer = true;

    // Bake terrain tiles into a flat RenderTexture so walls, pillars, corridors,
    // and cave tiles are visible. The RT sits beneath all ECS entities at depth -20,
    // matching the convention used by MainGameScene and the set-piece lab.
    const { rt } = buildTerrainLayer(this, this.world.floorMap);
    rt.setDepth(-20);
    this.cameras.main.setBounds(
      0,
      0,
      ftToPx(this.world.floorMap.widthFt),
      ftToPx(this.world.floorMap.heightFt),
    );

    // Place player
    const spawnWorld = this.world.floorMap.tileToWorld(
      preset.playerSpawnTile.x,
      preset.playerSpawnTile.y,
    );
    this.playerEid = spawnPlayer(this.world, spawnWorld.x, spawnWorld.y);
    this.applyPlayerMode();

    // Equip starter weapon so the player can fight
    const weaponDef = getWeaponDef(STARTER_WEAPON_ID);
    if (weaponDef) {
      equipStarterOrFallback(this.world, STARTER_WEAPON_ID, weaponDef);
    }

    // Spawn initial enemy preset
    this.spawnCurrentPreset();

    // Set up input capture with camera following the player
    this.inputCapture = createInputCapture(this, {
      getFollowOrigin: () =>
        this.playerEid < 0
          ? undefined
          : {
              x: ftToPx(this.world.stores.position.x[this.playerEid] ?? 0),
              y: ftToPx(this.world.stores.position.y[this.playerEid] ?? 0),
            },
    });

    // Click-to-place in custom mode
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.settings.customModeActive) return;
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.onSpawnAtPosition?.(pxToFt(wp.x), pxToFt(wp.y));
    });

    this.bridge = createPhaserBridge(this);
    this.announcementBanner = createHudAnnouncementBanner(this);
    this.bridge.sync(this.world);
    this.announcementBanner.sync(this.world);
    this.emitInfo();

    void this.warmGeneratedSprites();

    this.events.once('shutdown', () => {
      this.inputCapture?.destroy();
      this.inputCapture = undefined;
      this.announcementBanner?.destroy();
      this.announcementBanner = undefined;
      this.bridge?.destroy();
      this.bridge = undefined;
    });

    // Signal E2E test harness that create() has fully run and terrain is baked.
    (window as unknown as Record<string, unknown>).__arenaReady = true;
  }

  update(_time: number, delta: number): void {
    if (!this.bridge || !this.inputCapture || !this.announcementBanner) return;

    this.inputCapture.poll(this.inputState);

    // Do not accumulate simulation time while paused — otherwise the backlog
    // drains all at once on resume or step-frame regardless of speed setting.
    if (this.world.state === 'paused') {
      return;
    }

    const speedMultiplier = this.settings.simSpeed as number;
    this.accumulator += delta * speedMultiplier;
    let steps = 0;

    while (this.accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
      this.world.frameCount += 1;
      this.world.elapsedMs += GAME.DELTA_MS;

      // Use the shared canonical pipeline (same ordering as visual + headless
      // floor simulations). weaponSystem runs before enemyAISystem to match
      // the main game's preSystems contract. statusEffectSystem runs after
      // enemyAISystem and before mobAbilitySystem — identical to the floor
      // scene's canonical order — so Tarnished (and other) debuffs tick/expire
      // correctly and a cast applied this frame lasts its full authored
      // duration. mobAbilitySystem is the canonical typed ability runtime
      // (default-off in production; the Queen Mab preset enables it) — the lab
      // does NOT re-dispatch a lab-only copy.
      runCoreSimulationStep(this.world, this.inputState, {
        preSystems: [weaponSystem, enemyAISystem, statusEffectSystem, mobAbilitySystem],
      });

      this.accumulator -= GAME.DELTA_MS;
      steps += 1;
    }

    // Prevent unbounded accumulator growth at high speeds
    if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
      this.accumulator = 0;
    }

    this.bridge.sync(this.world);
    this.announcementBanner.sync(this.world);
    this.emitInfo();
  }

  // ── Public API (called by GUI closures) ─────────────────────────────────

  spawnCurrentPreset(): void {
    const map = this.world.floorMap;
    if (!map) return;
    const preset = getEnemyPreset(this.settings.enemyPresetId);
    const cx = map.widthFt / 2;
    const cy = map.heightFt * 0.35; // spawn enemies in the far half of the arena
    spawnPresetAroundCenter(this.world, map, preset, cx, cy, this.rng, 14);
    this.bridge?.sync(this.world);
    this.emitInfo();
  }

  spawnCustomMob(x: number, y: number): void {
    const mobId = this.settings.customMobId;
    const def = ALL_ARCHETYPES.find((a) => a.id === mobId);
    if (def) {
      const map = this.world.floorMap;
      const pos = map ? findWalkablePosition(map, x, y, this.rng) : { x, y };
      spawnFromArchetype(this.world, pos.x, pos.y, def);
      this.bridge?.sync(this.world);
      this.emitInfo();
    }
  }

  spawnCustomMobAtCenter(): void {
    const map = this.world.floorMap;
    if (!map) return;
    const cx = map.widthFt / 2 + (this.rng.next() - 0.5) * 8;
    const cy = map.heightFt / 2 + (this.rng.next() - 0.5) * 8;
    this.spawnCustomMob(cx, cy);
  }

  clearEnemies(): void {
    for (const eid of Array.from(query(this.world.ecs, [Enemy]))) {
      clearEntityStores(this.world, eid);
      removeEntity(this.world.ecs, eid);
    }
    this.bridge?.sync(this.world);
    this.emitInfo();
  }

  respawn(): void {
    this.scene.restart();
  }

  applyPlayerMode(): void {
    if (this.playerEid < 0) return;
    const isImmortal = this.settings.playerMode === 'immortal';
    const hp = this.settings.playerMode === 'hero' ? PLAYER_HP_HERO : PLAYER_HP_OBSERVER;
    this.world.stores.health.current[this.playerEid] = hp;
    this.world.stores.health.max[this.playerEid] = hp;
    // Immortal mode: attach the Invincible component so healthSystem never
    // processes damage and can't set world.state='game_over'. Remove it when
    // switching away from immortal.
    if (isImmortal) {
      addComponent(this.world.ecs, this.playerEid, Invincible);
    } else {
      removeComponent(this.world.ecs, this.playerEid, Invincible);
    }
  }

  togglePause(): void {
    this.world.state = this.world.state === 'paused' ? 'playing' : 'paused';
    this.emitInfo();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private emitInfo(): void {
    if (!this.onInfoUpdate) return;
    const enemies = query(this.world.ecs, [Enemy]);
    const aliveEnemies = enemies.filter(
      (eid) => (this.world.stores.health.current[eid] ?? 0) > 0,
    ).length;
    const playerHp =
      this.playerEid >= 0 ? Math.max(0, this.world.stores.health.current[this.playerEid] ?? 0) : 0;
    const playerMaxHp =
      this.playerEid >= 0 ? (this.world.stores.health.max[this.playerEid] ?? 0) : 0;
    const speed = this.settings.simSpeed;
    const paused = this.world.state === 'paused';
    const modeIcon =
      this.settings.playerMode === 'immortal'
        ? '♾'
        : this.settings.playerMode === 'observer'
          ? '👁'
          : '⚔';
    this.onInfoUpdate(
      [
        `${modeIcon} Player HP: ${playerHp.toFixed(0)} / ${playerMaxHp.toFixed(0)}`,
        `Enemies alive: ${aliveEnemies}`,
        `Frame: ${this.world.frameCount}  Speed: ${paused ? 'PAUSED' : `${speed}x`}`,
        this.settings.customModeActive ? '🖱 Click arena to place enemy' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  private async warmGeneratedSprites(): Promise<void> {
    try {
      const registry = await fetchGeneratedSpriteRegistry();
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);
      if (registry.size === 0 || !this.load) return;
      const queued = preloadGeneratedSprites(this.load, registry);
      if (queued.length > 0) this.load.start();
    } catch (error) {
      logger.warn('Generated sprite load failed — continuing with built-in sprites', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ─── Lab create function ─────────────────────────────────────────────────────

function createCombatArenaLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialise lil-gui.');
  }

  // ── DOM layout ──────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.style.cssText =
    'position:relative;width:100%;height:100%;overflow:hidden;background:radial-gradient(circle at top,#18101a 0%,#0d0a12 60%,#05060b 100%);';

  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';

  const infoEl = document.createElement('div');
  infoEl.style.cssText =
    'position:absolute;left:12px;bottom:12px;padding:10px 12px;border-radius:12px;' +
    'background:rgba(10,8,18,0.86);border:1px solid rgba(255,255,255,0.12);' +
    'color:#f8fafc;line-height:1.55;white-space:pre-line;pointer-events:none;font-size:12px;';

  root.append(gameHost, infoEl);
  canvasHost.append(root);

  // ── Mutable settings ────────────────────────────────────────────────────
  const settings: CombatArenaLabSettings = {
    roomPresetId: 'boss-arena',
    floorFilter: 'all',
    enemyPresetId: 'f1-mixed',
    playerMode: 'hero',
    simSpeed: 1,
    customMobId: ALL_ARCHETYPES[0]?.id ?? 'rat',
    customModeActive: false,
    arenaSeed: 0, // 0 means "generate a fresh seed on first create()"
    ...(loadLabState<CombatArenaLabSettings>(LAB_ID) ?? {}),
  };

  // ── Scene — declared early so GUI closures can reference it ─────────────
  const arenaScene = new CombatArenaScene();
  arenaScene.settings = settings;
  arenaScene.onInfoUpdate = (text) => {
    infoEl.textContent = text;
  };
  arenaScene.onSpawnAtPosition = (x, y) => {
    arenaScene.spawnCustomMob(x, y);
  };

  // ── GUI ─────────────────────────────────────────────────────────────────
  const arenaFolder = gui.addFolder('Arena');
  arenaFolder.open();

  const roomOptions = Object.fromEntries(ARENA_ROOM_PRESETS.map((p) => [p.name, p.id]));
  arenaFolder
    .add(settings, 'roomPresetId', roomOptions)
    .name('Room Layout')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      arenaScene.respawn();
    });

  const playerModes: Record<string, PlayerMode> = {
    'Hero (200 HP)': 'hero',
    'Observer (5000 HP)': 'observer',
    'Immortal (∞)': 'immortal',
  };
  arenaFolder
    .add(settings, 'playerMode', playerModes)
    .name('Player Mode')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      arenaScene.applyPlayerMode();
    });

  const simFolder = gui.addFolder('Simulation');
  simFolder.open();

  const speedOptions: Record<string, SimSpeed> = { '1x': 1, '4x': 4, '16x': 16 };
  simFolder
    .add(settings, 'simSpeed', speedOptions)
    .name('Speed')
    .onChange(() => saveLabState(LAB_ID, settings));

  const simApi = {
    togglePause: () => arenaScene.togglePause(),
    stepFrame: () => {
      if (!arenaScene.world) return;
      const prev = arenaScene.world.state;
      arenaScene.world.state = 'playing';
      // Inject a single-step accumulator tick
      arenaScene.update(0, GAME.DELTA_MS / (settings.simSpeed as number));
      arenaScene.world.state = prev;
    },
    newSeed: () => {
      // Generate a new seed and reset the arena so the run is fully reproducible
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      settings.arenaSeed = buf[0]! >>> 0;
      saveLabState(LAB_ID, settings);
      // Refresh the display before respawn so the seed is visible immediately.
      seedCtrl.updateDisplay();
      arenaScene.respawn();
    },
  };
  simFolder.add(simApi, 'togglePause').name('Pause / Resume');
  simFolder.add(simApi, 'stepFrame').name('Step Frame');
  // Seed display: read-only text — shows the active seed for reproducibility.
  // Store the controller so we can call updateDisplay() when the seed mutates.
  const seedCtrl = simFolder.add(settings, 'arenaSeed').name('Seed (read-only)').disable();
  // Refresh the display whenever create() generates a new seed (initial boot or
  // after a room/layout change that triggers scene.restart()).
  arenaScene.onSeedChanged = () => {
    seedCtrl.updateDisplay();
  };
  simFolder.add(simApi, 'newSeed').name('New Seed + Reset');
  simFolder.close();

  // ── Enemy Preset controls ────────────────────────────────────────────────
  const enemyFolder = gui.addFolder('Enemies');
  enemyFolder.open();

  const floorFilters: Record<string, FloorFilter> = {
    'All Floors': 'all',
    'Floor 1 only': 'floor1',
    'Floor 2 only': 'floor2',
  };

  // Build a filtered map of presets for the dropdown
  const buildPresetOptions = (filter: FloorFilter): Record<string, string> =>
    Object.fromEntries(
      ARENA_ENEMY_PRESETS.filter(
        (p) => filter === 'all' || p.floor === filter || p.floor === 'all',
      ).map((p) => [p.name, p.id]),
    );

  let presetController: ReturnType<typeof enemyFolder.add> | null = null;

  const refreshPresetDropdown = (): void => {
    if (presetController) {
      presetController.destroy();
    }
    const opts = buildPresetOptions(settings.floorFilter);
    // If the currently selected preset is not in the filtered list, pick the first
    if (!Object.values(opts).includes(settings.enemyPresetId)) {
      settings.enemyPresetId = Object.values(opts)[0] ?? 'f1-mixed';
    }
    presetController = enemyFolder
      .add(settings, 'enemyPresetId', opts)
      .name('Enemy Preset')
      .onChange(() => saveLabState(LAB_ID, settings));
  };

  enemyFolder
    .add(settings, 'floorFilter', floorFilters)
    .name('Floor Filter')
    .onChange(() => {
      refreshPresetDropdown();
      saveLabState(LAB_ID, settings);
    });

  refreshPresetDropdown();

  const enemyApi = {
    spawnPreset: () => {
      arenaScene.spawnCurrentPreset();
    },
    clearEnemies: () => {
      arenaScene.clearEnemies();
    },
    resetArena: () => {
      saveLabState(LAB_ID, settings);
      arenaScene.respawn();
    },
  };
  enemyFolder.add(enemyApi, 'spawnPreset').name('Spawn Preset');
  enemyFolder.add(enemyApi, 'clearEnemies').name('Clear Enemies');
  enemyFolder.add(enemyApi, 'resetArena').name('↻ Reset Arena');
  enemyFolder.close();

  // ── Custom Placement ─────────────────────────────────────────────────────
  const customFolder = gui.addFolder('Custom Placement');
  customFolder.close();

  const mobOptions = Object.fromEntries(
    ALL_ARCHETYPES.map((a) => {
      const floor = floor2EnemyPack.archetypes.some((f: EnemyArchetypeDef) => f.id === a.id)
        ? 'F2'
        : 'F1';
      const bossTag = a.isBoss ? '★' : '';
      return [`[${floor}${bossTag}] ${a.name}`, a.id];
    }),
  );

  customFolder
    .add(settings, 'customMobId', mobOptions)
    .name('Mob Type')
    .onChange(() => saveLabState(LAB_ID, settings));

  customFolder
    .add(settings, 'customModeActive')
    .name('Click-to-Place Mode')
    .onChange(() => saveLabState(LAB_ID, settings));

  const customApi = {
    spawnAtCenter: () => arenaScene.spawnCustomMobAtCenter(),
  };
  customFolder.add(customApi, 'spawnAtCenter').name('Spawn at Center');

  // ── Description hint ────────────────────────────────────────────────────
  const hint = document.createElement('p');
  hint.textContent =
    'WASD / arrow keys to move. Left-click to attack (sword). Select room and enemy presets, ' +
    'then click "Spawn Preset". Enable Custom Mode to click in the arena to place individual mobs.';
  hint.style.cssText = 'margin-top:14px;color:#c4bfdf;line-height:1.6;font-size:13px;';
  controls.append(hint);

  // ── Phaser game setup ────────────────────────────────────────────────────
  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent: gameHost,
    width: 1280,
    height: 720,
    backgroundColor: '#0a0810',
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: 'arcade',
      arcade: { gravity: { x: 0, y: 0 }, debug: false },
    },
    scene: [arenaScene],
  });

  return () => {
    game.destroy(true);
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerLab(LAB_ID, {
  category: 'Combat' as LabCategory,
  name: 'Combat Arena',
  description:
    'Full-engine combat sandbox. Room presets, enemy encounter presets (floor-filtered), ' +
    'custom mob placement, and simulation speed controls for debugging AI and boss encounters.',
  create: createCombatArenaLab,
});
