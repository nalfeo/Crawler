/**
 * Main Scene Probe Lab — an e2e characterization harness that boots the **real**
 * {@link MainGameScene} (the ~2331-LOC engine god-class) through the shipped
 * bootstrap path and exposes a typed `window.__mainSceneProbe` automation API.
 *
 * Why this lab exists
 * -------------------
 * MainGameScene is ~0% unit-tested: it is Phaser-coupled (cameras, display list,
 * HUD, modal picker, the entity→sprite bridge) so its observable behavior can
 * only be characterized by booting it in a browser. This lab is the
 * instrumentation seam used by `tests/e2e/main-game-scene-boot.test.ts` to pin
 * the CURRENT boot wiring and camera-follow invariant BEFORE a future session
 * decomposes the class, so that refactor can prove equivalence.
 *
 * It deliberately boots via `createFloor1GameConfig` + `createFloor1MainSceneOptions`
 * (the exact path the shipped game uses) with a FIXED `worldSeed`, so every boot
 * is deterministic. The probe reaches the scene's runtime fields through a
 * structural cast — MainGameScene's members are TS `private` (not `#private`),
 * so they are readable at runtime, mirroring `ai-runner-lab`.
 *
 * Determinism for the camera guard: with the simulation paused and no pending
 * advance-steps, MainGameScene.update() runs `updateCamera()` and early-returns
 * BEFORE the sim loop (see MainGameScene `simulationPaused && pendingSimulationSteps <= 0`
 * branch). That freezes the player while the camera keeps following, so writing
 * a known player feet-position and reading the world camera center is a stable,
 * wall-clock-free probe of the `centerOn(ftToPx(px), ftToPx(py))` invariant.
 */
import Phaser from 'phaser';
import { createFloor1GameConfig } from '../../bootstrap/floor-game-config.js';
import { createFloor1MainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import type { GameWorld } from '../../core/index.js';
import { registerLab, type LabCategory } from '../registry.js';

const LAB_ID = 'main-scene-probe-lab';
const SCENE_KEY = 'MainGameScene';

/** Fixed world seed so every boot is byte-for-byte deterministic. */
const PROBE_SEED = 4242;

/**
 * Parse an optional `?ambient=<0..1>` query param used only by the
 * lighting-defaults e2e to force a DISTINGUISHING per-floor ambient (one that
 * differs from DEFAULT_LIGHTING_CONFIG.ambient), proving `options.lightingConfig`
 * actually flows into the live scene. Returns null when the param is absent or is
 * not a finite number in [0, 1] — in which case the floor's authored default is
 * kept and boot stays byte-for-byte deterministic for every other e2e.
 */
function readAmbientOverride(): number | null {
  const raw = new URLSearchParams(window.location.search).get('ambient');
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * The slice of MainGameScene's runtime shape this probe reads. The fields are
 * declared `private` in the class but are plain instance properties at runtime,
 * so a structural cast exposes them without modifying the engine layer.
 */
interface MainSceneInternals {
  world?: GameWorld;
  playerEid?: number;
  bridge?: unknown;
  hudUi?: unknown;
  modalPicker?: { isOpen(): boolean; close(): void };
  setSimulationPaused(paused: boolean): void;
  isSimulationPaused(): boolean;
}

/** A 2-D point in some coordinate space (feet for world, pixels for camera). */
export interface ProbePoint {
  readonly x: number;
  readonly y: number;
}

/** Boot-time facts + live readings exposed for characterization assertions. */
export interface MainSceneState {
  /** ECS world state machine value (e.g. 'loadout' | 'playing'). */
  readonly worldState: string | null;
  /** Player entity id, or -1 before the world spawns it. */
  readonly playerEid: number;
  /** True once the scene wired up its HUD UI. */
  readonly hudPresent: boolean;
  /** True once the scene wired up the entity→sprite bridge. */
  readonly bridgePresent: boolean;
  /** True while the loadout / modal picker overlay is open. */
  readonly modalOpen: boolean;
  /** Whether the simulation is currently paused. */
  readonly simulationPaused: boolean;
  /** Number of top-level Phaser display objects on the scene. */
  readonly displayObjectCount: number;
  /** Live player position in FEET (sim space), or null before spawn. */
  readonly playerFeet: ProbePoint | null;
  /** Live world-camera center in PIXELS (world space), or null. */
  readonly cameraCenter: ProbePoint | null;
}

/**
 * Automation surface attached to `window.__mainSceneProbe`. The e2e suite polls
 * {@link MainSceneProbeApi.ready} then drives loadout/camera through these.
 */
export interface MainSceneProbeApi {
  /** True once the real scene has booted a world and spawned the player. */
  ready(): boolean;
  /** Snapshot of boot facts + live camera/player readings. */
  getState(): MainSceneState;
  /** Resolve the opening loadout modal (pick option 0) and freeze the sim. */
  resolveLoadout(): void;
  /** Pause / unpause the simulation. */
  setSimulationPaused(paused: boolean): void;
  /** Overwrite the player's FEET position and zero its velocity. */
  setPlayerFeet(x: number, y: number): void;
  /** Live world-camera center in PIXELS, or null before the camera exists. */
  getCameraCenter(): ProbePoint | null;
  /** Floor map size in FEET (camera bounds === ftToPx of this), or null. */
  getMapSizeFeet(): ProbePoint | null;
  /** Live world-camera viewport size in PIXELS (worldView), or null. */
  getCameraViewSize(): ProbePoint | null;
}

function createMainSceneProbeLab(canvas: HTMLElement, controls: HTMLElement): () => void {
  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = '#111111';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';
  root.append(gameHost);
  canvas.append(root);

  const hint = document.createElement('p');
  hint.textContent =
    'Characterization harness booting the real MainGameScene. e2e drives window.__mainSceneProbe to pin boot wiring + the camera-follow invariant.';
  hint.style.marginTop = '12px';
  hint.style.color = '#7ee0ff';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  // The bootstrap ships Floor 1's authored per-floor ambient via `lightingConfig`;
  // an optional `?ambient=` override lets the lighting-defaults e2e exercise a
  // distinguishing value end-to-end (see readAmbientOverride). Absent → default.
  const baseOptions = createFloor1MainSceneOptions();
  const ambientOverride = readAmbientOverride();
  const sceneOptions = {
    ...baseOptions,
    worldSeed: PROBE_SEED,
    ...(ambientOverride !== null
      ? { lightingConfig: { ...baseOptions.lightingConfig, ambient: ambientOverride } }
      : {}),
  };
  const config = createFloor1GameConfig(gameHost, sceneOptions);
  const game = new Phaser.Game(config);

  const getScene = (): MainSceneInternals | null =>
    (game.scene.getScene(SCENE_KEY) as unknown as MainSceneInternals | null) ?? null;
  const getPhaserScene = (): Phaser.Scene | null =>
    (game.scene.getScene(SCENE_KEY) as Phaser.Scene | null) ?? null;

  const playerEidOf = (scene: MainSceneInternals | null): number => {
    const eid = scene?.playerEid;
    return typeof eid === 'number' ? eid : -1;
  };

  const cameraCenter = (): ProbePoint | null => {
    const scene = getPhaserScene();
    const cam = scene?.cameras?.main;
    if (!cam) {
      return null;
    }
    const view = cam.worldView;
    return { x: view.centerX, y: view.centerY };
  };

  const cameraViewSize = (): ProbePoint | null => {
    const scene = getPhaserScene();
    const cam = scene?.cameras?.main;
    if (!cam) {
      return null;
    }
    const view = cam.worldView;
    return { x: view.width, y: view.height };
  };

  const mapSizeFeet = (): ProbePoint | null => {
    const floorMap = getScene()?.world?.floorMap;
    if (!floorMap) {
      return null;
    }
    return { x: floorMap.widthFt, y: floorMap.heightFt };
  };

  const probeWindow = window as unknown as { __mainSceneProbe?: MainSceneProbeApi };

  const api: MainSceneProbeApi = {
    ready: () => {
      const scene = getScene();
      return scene?.world != null && playerEidOf(scene) >= 0;
    },

    getState: (): MainSceneState => {
      const scene = getScene();
      const phaserScene = getPhaserScene();
      const world = scene?.world;
      const eid = playerEidOf(scene);
      const position = world?.stores.position;
      const playerFeet =
        position && eid >= 0 ? { x: position.x[eid] ?? 0, y: position.y[eid] ?? 0 } : null;
      return {
        worldState: world?.state ?? null,
        playerEid: eid,
        hudPresent: scene?.hudUi != null,
        bridgePresent: scene?.bridge != null,
        modalOpen: scene?.modalPicker?.isOpen() ?? false,
        simulationPaused: scene?.isSimulationPaused() ?? false,
        displayObjectCount: phaserScene?.children.list.length ?? 0,
        playerFeet,
        cameraCenter: cameraCenter(),
      };
    },

    resolveLoadout: () => {
      const scene = getScene();
      const world = scene?.world;
      if (!scene || !world) {
        return;
      }
      if (world.state === 'loadout') {
        sceneOptions.selectLoadoutOption?.(world, 0);
        scene.modalPicker?.close();
      }
      // Freeze the sim so the player stays put while the camera keeps following
      // — the deterministic seam the camera guard relies on.
      scene.setSimulationPaused(true);
    },

    setSimulationPaused: (paused: boolean) => {
      getScene()?.setSimulationPaused(paused);
    },

    setPlayerFeet: (x: number, y: number) => {
      const scene = getScene();
      const world = scene?.world;
      const eid = playerEidOf(scene);
      if (!world || eid < 0) {
        return;
      }
      world.stores.position.x[eid] = x;
      world.stores.position.y[eid] = y;
      world.stores.velocity.x[eid] = 0;
      world.stores.velocity.y[eid] = 0;
    },

    getCameraCenter: () => cameraCenter(),

    getMapSizeFeet: () => mapSizeFeet(),

    getCameraViewSize: () => cameraViewSize(),
  };
  probeWindow.__mainSceneProbe = api;

  return () => {
    if (probeWindow.__mainSceneProbe === api) {
      delete probeWindow.__mainSceneProbe;
    }
    game.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta' as LabCategory,
  name: 'Main Scene Probe Lab',
  description:
    'Characterization harness that boots the real MainGameScene via the shipped floor bootstrap (fixed seed) and exposes window.__mainSceneProbe for boot-wiring + camera-follow e2e guards.',
  create: createMainSceneProbeLab,
});
