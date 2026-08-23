/**
 * Abilities Lab
 *
 * Boots the real {@link MainGameScene} onto a proper Arena floor map generated
 * by {@link ArenaGenerator} (biome ARENA). Every ability in the shared catalog
 * can be equipped/granted via toggles and exercised against configurable
 * enemy scenarios that trip each authored trigger (cluster / low-HP / skill
 * usage / boss). A debug hotbar overlay lets you click any equipped ability
 * slot to force-fire it, bypassing cooldown.
 *
 * Replaces the previous naked-Phaser sandbox: the same shipped simulation
 * pipeline (runSimulationStep) and world are used, so what you see in the
 * lab matches what runs in-game.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { query } from 'bitecs';
import { createFloorGameConfig } from '../../bootstrap/floor-game-config.js';
import { ArenaGenerator } from '../../core/map/generators/ArenaGenerator.js';
import { Enemy, type GameWorld } from '../../core/index.js';
import { spawnEnemy } from '../../core/helpers.js';
import { familyRelationshipSystem, statSystem, statusEffectSystem } from '../../core/index.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import type { MainGameSceneOptions } from '../../engine/scenes/MainGameScene.js';
import type { AbilityLoadoutConfig, AbilityLoadoutEntry } from '../../engine/AbilityLoadoutUI.js';
import type { ScreenBounds } from '../../engine/ui-scale.js';
import {
  abilitySystem,
  configureEnemySpawner,
  enemyAISystem,
  enemySpawnerSystem,
  equipActiveAbility,
  forceActivateAbility,
  getAllAbilityDefinitions,
  grantPassiveAbility,
  memorizeSpell,
  queueAbilityTrigger,
  setActiveWeapon,
  skillSystem,
  spawnerSystem,
  unequipActiveAbility,
  weaponSystem,
  weaponPrerequisiteMet,
  type AbilityDefinition,
} from '../../game/index.js';
import { getAbilityPresentation } from '../../shared/ability-presentation.js';
import { ACTIVE_ABILITY_SLOT_LIMIT, type AbilityState } from '../../shared/abilities.js';
import { BiomeType } from '../../shared/map-types.js';
import type { MapConfig } from '../../shared/map-types.js';
import { WEAPON_DEFS } from '../../shared/weaponDefs.js';
import { getActiveWeaponDef } from '../../core/active-weapon.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'abilities-lab';
const LAB_SEED = 8842;
const ARENA_TILE_SIZE_FT = 4;
const ARENA_WIDTH_TILES = 60;
const ARENA_HEIGHT_TILES = 40;

const ABILITIES = getAllAbilityDefinitions();
const WEAPON_IDS = [...WEAPON_DEFS.keys()];

// ---------------------------------------------------------------------------
// Scenarios — presets that trip each authored ability trigger.
// ---------------------------------------------------------------------------

type ScenarioId = 'solo' | 'target-dummy' | 'cluster' | 'low-hp' | 'boss' | 'skill-trigger';

interface ScenarioDefinition {
  readonly id: ScenarioId;
  readonly label: string;
  readonly description: string;
  /** Recurring spawner (max enemies). 0 → recurring spawner disabled. */
  readonly maxEnemies: number;
  readonly spawnIntervalMs: number;
  readonly enemyHp: number;
  /** How many enemies to hand-place at scene start, and how tight the cluster is. */
  readonly staticEnemyCount: number;
  readonly clusterRadiusFt: number;
  /** If true, drop the player to 40% HP so low-HP triggers fire immediately. */
  readonly startAtLowHp: boolean;
  /** If true, queue a synthetic skill_usage event on world reset. */
  readonly queueSkillTrigger: boolean;
}

const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: 'solo',
    label: 'Solo — no enemies (force-fire only)',
    description:
      'Empty arena. Use the debug hotbar to force-fire abilities; nothing else fires them.',
    maxEnemies: 0,
    spawnIntervalMs: 1000,
    enemyHp: 30,
    staticEnemyCount: 0,
    clusterRadiusFt: 0,
    startAtLowHp: false,
    queueSkillTrigger: false,
  },
  {
    id: 'target-dummy',
    label: 'Target Dummy — single stationary enemy',
    description: 'One high-HP stationary enemy to soak damage and tune single-target output.',
    maxEnemies: 0,
    spawnIntervalMs: 1000,
    enemyHp: 500,
    staticEnemyCount: 1,
    clusterRadiusFt: 0,
    startAtLowHp: false,
    queueSkillTrigger: false,
  },
  {
    id: 'cluster',
    label: 'Cluster — trips enemy_cluster triggers',
    description: 'Ten stationary enemies packed within 8ft of the player to fire cluster spells.',
    maxEnemies: 0,
    spawnIntervalMs: 1000,
    enemyHp: 30,
    staticEnemyCount: 10,
    clusterRadiusFt: 8,
    startAtLowHp: false,
    queueSkillTrigger: false,
  },
  {
    id: 'low-hp',
    label: 'Low HP — trips low_health triggers',
    description:
      'Player starts at 40% HP surrounded by 6 enemies to trip low_health and low_health_crowded.',
    maxEnemies: 0,
    spawnIntervalMs: 1000,
    enemyHp: 30,
    staticEnemyCount: 6,
    clusterRadiusFt: 10,
    startAtLowHp: true,
    queueSkillTrigger: false,
  },
  {
    id: 'boss',
    label: 'Boss — continuous horde',
    description:
      'Recurring spawner floods the arena with enemies (max 30) so every autofire trigger keeps firing.',
    maxEnemies: 30,
    spawnIntervalMs: 750,
    enemyHp: 30,
    staticEnemyCount: 0,
    clusterRadiusFt: 0,
    startAtLowHp: false,
    queueSkillTrigger: false,
  },
  {
    id: 'skill-trigger',
    label: 'Skill Trigger — trips skill_usage triggers',
    description:
      'Queues a hits-landed=10 skill_usage event every reset so hit/damage-count abilities fire.',
    maxEnemies: 0,
    spawnIntervalMs: 1000,
    enemyHp: 30,
    staticEnemyCount: 3,
    clusterRadiusFt: 6,
    startAtLowHp: false,
    queueSkillTrigger: true,
  },
] as const;

function getScenario(id: ScenarioId): ScenarioDefinition {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface AbilitiesLabSettings {
  scenario: ScenarioId;
  activeWeapon: string;
  invulnerable: boolean;
}

interface AbilitiesLabSnapshot {
  settings: AbilitiesLabSettings;
  equipped: Record<string, boolean>;
}

function loadSnapshot(): AbilitiesLabSnapshot {
  const saved = loadLabState<AbilitiesLabSnapshot>(LAB_ID);
  const settings: AbilitiesLabSettings = {
    scenario: 'cluster',
    activeWeapon: 'pistol',
    invulnerable: true,
    ...(saved?.settings ?? {}),
  };
  const equipped: Record<string, boolean> = {};
  let defaultActiveCount = 0;
  for (const def of ABILITIES) {
    const savedValue = saved?.equipped?.[def.id];
    if (savedValue !== undefined) {
      equipped[def.id] = savedValue;
    } else if (def.kind === 'passive') {
      equipped[def.id] = true;
    } else {
      // Default non-passive abilities to enabled only up to the active slot limit
      // so the lab never crashes with "Active ability slot cap reached" on first load.
      equipped[def.id] = defaultActiveCount < ACTIVE_ABILITY_SLOT_LIMIT;
      if (equipped[def.id]) defaultActiveCount += 1;
    }
  }
  return { settings, equipped };
}

function abilityKindLabel(def: AbilityDefinition): string {
  if (def.kind === 'spell') return 'Spell';
  if (def.kind === 'passive') return 'Passive';
  return 'Active';
}

// ---------------------------------------------------------------------------
// Arena floor map
// ---------------------------------------------------------------------------

function buildArenaFloorMap(world: GameWorld) {
  const cfg: MapConfig = {
    widthTiles: ARENA_WIDTH_TILES,
    heightTiles: ARENA_HEIGHT_TILES,
    tileSizeFt: ARENA_TILE_SIZE_FT,
    biome: BiomeType.ARENA,
    seed: world.rng.nextInt(1, 2_000_000),
    roomWidthRange: [ARENA_WIDTH_TILES - 4, ARENA_WIDTH_TILES - 4] as [number, number],
    roomHeightRange: [ARENA_HEIGHT_TILES - 4, ARENA_HEIGHT_TILES - 4] as [number, number],
    maxRooms: 1,
    floorDensity: 1,
  };
  return new ArenaGenerator({ obstacleCount: 12, maxObstacleSize: 3 }).generate(cfg, world.rng);
}

// ---------------------------------------------------------------------------
// Ability equipping — syncs the equipped-toggle record onto the player.
// ---------------------------------------------------------------------------

function syncEquippedAbilities(
  world: GameWorld,
  playerEid: number,
  equipped: Record<string, boolean>,
): void {
  if (playerEid < 0) return;
  for (const def of ABILITIES) {
    if (!equipped[def.id]) {
      if (def.kind !== 'passive') unequipActiveAbility(world, playerEid, def.id);
      continue;
    }
    if (def.kind === 'passive') {
      grantPassiveAbility(world, playerEid, def.id);
    } else if (def.kind === 'spell') {
      try {
        memorizeSpell(world, playerEid, def.id);
      } catch (err) {
        if (!(err instanceof Error && err.message.startsWith('Active ability slot cap'))) throw err;
        // Silently skip when the active slot limit is already full.
      }
    } else {
      try {
        equipActiveAbility(world, playerEid, def.id);
      } catch (err) {
        if (!(err instanceof Error && err.message.startsWith('Active ability slot cap'))) throw err;
        // Silently skip when the active slot limit is already full.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lab entry
// ---------------------------------------------------------------------------

interface LabRuntime {
  world?: GameWorld;
  playerEid?: number;
}

interface AbilityLoadoutProbe {
  open(config: AbilityLoadoutConfig): void;
  close(): void;
  isOpen(): boolean;
  getPanelScreenBounds(): ScreenBounds;
  getListViewportScreenBounds(): ScreenBounds;
  getVisibleRowScreenBounds(): ScreenBounds[];
  getVisibleAbilityIds(): string[];
  getFooterScreenBounds(): ScreenBounds;
  getSelectedAbilityId(): string | null;
}

interface AbilitiesSceneProbe {
  world?: GameWorld;
  playerEid?: number;
  queuedAbilitiesToggle?: boolean;
  openAbilitiesConfigModal?(): void;
  abilityLoadoutUI?: AbilityLoadoutProbe;
  hudUi?: {
    getAbilityBarBounds(): ScreenBounds;
    getAbilitySlotBounds(index: number): ScreenBounds | null;
  };
}

export interface AbilitiesProbeSnapshot {
  readonly open: boolean;
  readonly frameCount: number;
  readonly panel: ScreenBounds | null;
  readonly listViewport: ScreenBounds | null;
  readonly visibleRows: readonly ScreenBounds[];
  readonly visibleAbilityIds: readonly string[];
  readonly footer: ScreenBounds | null;
  readonly hotbar: ScreenBounds | null;
  readonly slots: readonly ScreenBounds[];
  readonly selectedAbilityId: string | null;
  readonly equippedAbilityIds: readonly string[];
}

export interface AbilitiesProbeApi {
  ready(): boolean;
  openLoadout(): void;
  closeLoadout(): void;
  getSnapshot(): AbilitiesProbeSnapshot;
}

function createAbilitiesLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const { settings, equipped } = loadSnapshot();
  const reviewMode = new URLSearchParams(window.location.search).get('review') === '1';
  const reviewStyleRestorers: Array<() => void> = [];
  const applyReviewStyle = (element: HTMLElement | null, styles: Partial<CSSStyleDeclaration>) => {
    if (!element) return;
    const previous = new Map<string, string>();
    for (const [property, value] of Object.entries(styles)) {
      previous.set(property, element.style.getPropertyValue(property));
      element.style.setProperty(property, String(value));
    }
    reviewStyleRestorers.push(() => {
      for (const [property, value] of previous) element.style.setProperty(property, value);
    });
  };
  if (reviewMode) {
    applyReviewStyle(document.querySelector<HTMLElement>('#app-header'), { display: 'none' });
    applyReviewStyle(document.querySelector<HTMLElement>('#controls-toggle'), { display: 'none' });
    applyReviewStyle(controls, { display: 'none' });
    applyReviewStyle(canvasHost.parentElement, { width: '100vw', height: '100vh' });
    applyReviewStyle(canvasHost, { width: '100vw', height: '100vh' });
  }

  // Mutable runtime updated by the scene's configureWorld hook. Shared with the
  // debug hotbar overlay so click handlers can address the live world.
  const runtime: LabRuntime = {};

  // ---- Layout ----
  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = '#050510';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  // ---- Debug hotbar overlay (HTML — clickable slots that force-fire) ----
  const hotbarWrap = document.createElement('div');
  hotbarWrap.style.position = 'absolute';
  hotbarWrap.style.left = '50%';
  hotbarWrap.style.bottom = '16px';
  hotbarWrap.style.transform = 'translateX(-50%)';
  hotbarWrap.style.display = 'flex';
  hotbarWrap.style.flexDirection = 'column';
  hotbarWrap.style.alignItems = 'center';
  hotbarWrap.style.gap = '6px';
  hotbarWrap.style.pointerEvents = 'auto';
  hotbarWrap.style.zIndex = '20';
  hotbarWrap.style.display = reviewMode ? 'none' : 'flex';

  const hotbarLabel = document.createElement('div');
  hotbarLabel.textContent = 'DEBUG HOTBAR — click a slot to force-fire';
  hotbarLabel.style.color = '#cbd5e1';
  hotbarLabel.style.fontFamily = 'Arial, sans-serif';
  hotbarLabel.style.fontSize = '11px';
  hotbarLabel.style.letterSpacing = '0.08em';
  hotbarLabel.style.textShadow = '0 1px 2px rgba(0,0,0,0.8)';

  const hotbarRow = document.createElement('div');
  hotbarRow.style.display = 'flex';
  hotbarRow.style.gap = '4px';

  hotbarWrap.append(hotbarLabel, hotbarRow);

  // HUD (top-left status)
  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '10px 12px';
  hud.style.borderRadius = '10px';
  hud.style.background = 'rgba(10, 12, 30, 0.78)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  hud.style.color = '#f8fafc';
  hud.style.lineHeight = '1.5';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';
  hud.style.fontSize = '12px';
  hud.style.fontFamily = 'Arial, sans-serif';
  hud.style.zIndex = '20';
  hud.style.display = reviewMode ? 'none' : 'block';

  const hint = document.createElement('p');
  hint.textContent =
    'The lab boots the real MainGameScene on a walled Arena map (BiomeType.ARENA). ' +
    'Pick a scenario to spawn the enemy setup you want to test against; toggle abilities to ' +
    'equip/grant them; click a slot in the debug hotbar (below the game view) to force-fire it ' +
    'without waiting for its authored trigger.';
  hint.style.marginTop = '16px';
  hint.style.color = '#a5b4fc';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud, hotbarWrap);
  canvasHost.append(root);

  // ---- Debug hotbar rendering ----
  function renderHotbar(): void {
    hotbarRow.replaceChildren();
    const activeIds = ABILITIES.filter((d) => equipped[d.id] && d.kind !== 'passive');
    if (activeIds.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(no active/spell abilities equipped)';
      empty.style.color = '#64748b';
      empty.style.fontSize = '11px';
      empty.style.fontStyle = 'italic';
      empty.style.padding = '6px 10px';
      hotbarRow.append(empty);
      return;
    }
    for (const def of activeIds) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = def.name;
      btn.title = `${def.description}\n\nClick to force-fire (bypasses cooldown).`;
      btn.style.padding = '10px 12px';
      btn.style.minWidth = '80px';
      btn.style.background = def.kind === 'spell' ? '#1e3a8a' : '#166534';
      btn.style.color = '#f8fafc';
      btn.style.border = '2px solid ' + (def.kind === 'spell' ? '#93c5fd' : '#86efac');
      btn.style.borderRadius = '6px';
      btn.style.fontFamily = 'Arial, sans-serif';
      btn.style.fontSize = '12px';
      btn.style.fontWeight = 'bold';
      btn.style.cursor = 'pointer';
      btn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
      btn.addEventListener('mouseenter', () => {
        btn.style.filter = 'brightness(1.2)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.filter = '';
      });
      btn.addEventListener('click', () => {
        const world = runtime.world;
        const eid = runtime.playerEid ?? -1;
        if (!world || eid < 0) return;
        const fired = forceActivateAbility(world, eid, def.id);
        btn.style.outline = fired ? '2px solid #fbbf24' : '2px solid #ef4444';
        window.setTimeout(() => {
          btn.style.outline = '';
        }, 200);
      });
      hotbarRow.append(btn);
    }
  }
  renderHotbar();

  // ---- Scenario execution (custom configureWorld) ----

  function configureWorld(world: GameWorld, playerEid: number): void {
    // 1. Build the arena floor map (walls + obstacles), reposition player.
    world.floorMap = buildArenaFloorMap(world);
    const spawnFt = world.floorMap.tileToWorld(
      world.floorMap.playerSpawn.x,
      world.floorMap.playerSpawn.y,
    );
    world.stores.position.x[playerEid] = spawnFt.x;
    world.stores.position.y[playerEid] = spawnFt.y;

    // 2. Base stats + feature unlocks (so HUD ability bar renders + inventory
    //    is available for parity with the shipped game).
    initializeBaseStats(world, playerEid);
    world.featureUnlocks.spells = true;
    world.featureUnlocks.inventory = true;
    world.featureUnlocks.equipment = true;
    world.featureUnlocks.equipmentPanel = true;

    // 3. Weapon.
    const weapon = WEAPON_DEFS.get(settings.activeWeapon);
    if (weapon !== undefined) {
      setActiveWeapon(world, weapon);
    }

    // 4. Equip abilities per the toggle map.
    syncEquippedAbilities(world, playerEid, equipped);

    // 5. Scenario-specific spawns + player-state tweaks.
    const scenario = getScenario(settings.scenario);
    configureEnemySpawner(world, {
      width: world.floorMap.widthFt,
      height: world.floorMap.heightFt,
    });
    if (scenario.staticEnemyCount > 0) {
      const clusterCenterFt = { x: spawnFt.x + 10, y: spawnFt.y };
      for (let i = 0; i < scenario.staticEnemyCount; i += 1) {
        const angle = (i / scenario.staticEnemyCount) * Math.PI * 2;
        const radius = scenario.clusterRadiusFt > 0 ? scenario.clusterRadiusFt * 0.5 : 0;
        spawnEnemy(
          world,
          clusterCenterFt.x + Math.cos(angle) * radius,
          clusterCenterFt.y + Math.sin(angle) * radius,
          scenario.enemyHp,
        );
      }
    }
    if (scenario.startAtLowHp) {
      const max = world.stores.health.max[playerEid] ?? 100;
      world.stores.health.current[playerEid] = Math.max(1, Math.round(max * 0.4));
    }
    if (scenario.queueSkillTrigger) {
      queueAbilityTrigger(world, {
        holderEid: playerEid,
        kind: 'skill_usage',
        metric: 'hits_landed',
        amount: 10,
      });
    }

    // 6. Publish the live world to the closure so debug hotbar + HUD can read it.
    runtime.world = world;
    runtime.playerEid = playerEid;
  }

  // Per-frame preSystem that (a) reruns the recurring enemy spawner with the
  // active scenario's config and (b) enforces the Invulnerable debug toggle.
  // Kept as a preSystem so it slots into the shipped runSimulationStep
  // pipeline in the exact same order every frame.
  function labPreSystem(world: GameWorld): void {
    const eid = runtime.playerEid ?? -1;
    if (eid < 0) return;

    if (settings.invulnerable) {
      const max = world.stores.health.max[eid] ?? 100;
      world.stores.health.current[eid] = max;
    }

    const scenario = getScenario(settings.scenario);
    if (scenario.maxEnemies > 0) {
      enemySpawnerSystem(world, {
        maxEnemies: scenario.maxEnemies,
        spawnIntervalMs: scenario.spawnIntervalMs,
        enemyHp: scenario.enemyHp,
        enemySpeed: 0.15625,
      });
    }
  }

  // ---- MainGameSceneOptions (mirrors the shipped floor bootstrap, minus the
  //      floor1-specific director/objective/quest/family systems, which would
  //      require a full floor manifest to work). ----
  const sceneOptions: MainGameSceneOptions = {
    worldSeed: LAB_SEED,
    configureWorld,
    preSystems: [
      statSystem,
      familyRelationshipSystem,
      weaponSystem,
      enemyAISystem,
      statusEffectSystem,
      spawnerSystem,
      labPreSystem,
    ],
    postSystems: [skillSystem, abilitySystem],
  };

  // ---- Boot Phaser ----
  const config = createFloorGameConfig(gameHost, sceneOptions);
  let game = new Phaser.Game(config);

  const getScene = (): AbilitiesSceneProbe | null => {
    const scene = game.scene.getScene('MainGameScene');
    return scene ? (scene as unknown as AbilitiesSceneProbe) : null;
  };
  let probeLoadoutPreviousState: GameWorld['state'] | null = null;
  const openLoadoutFromProbe = (scene: AbilitiesSceneProbe): void => {
    const world = scene.world;
    const playerEid = scene.playerEid ?? -1;
    const loadout = scene.abilityLoadoutUI;
    if (!world || playerEid < 0 || !loadout || loadout.isOpen()) {
      return;
    }

    const existingState = world.abilityStatesByEntity.get(playerEid);
    if (!existingState) {
      const fresh: AbilityState = {
        learnedSpellIds: [],
        equippedActiveAbilityIds: [],
        passiveAbilityIds: [],
        cooldownByAbilityId: new Map(),
        cooldownFramesByAbilityId: new Map(),
        appliedPassiveAbilityIds: new Set(),
      };
      world.abilityStatesByEntity.set(playerEid, fresh);
    }
    const state = world.abilityStatesByEntity.get(playerEid)!;
    const availableIds = [
      ...new Set([...state.equippedActiveAbilityIds, ...state.learnedSpellIds]),
    ];
    if (availableIds.length === 0) {
      return;
    }

    probeLoadoutPreviousState = world.state;
    world.state = 'safe_room';

    const buildEntries = (): AbilityLoadoutEntry[] =>
      availableIds.map((abilityId) => {
        const presentation = getAbilityPresentation(abilityId);
        const cooldownSeconds = presentation?.cooldownFrames ? presentation.cooldownFrames / 60 : 0;
        return {
          id: abilityId,
          name: presentation?.name ?? abilityId,
          shortLabel: presentation?.shortLabel ?? abilityId.slice(0, 5).toUpperCase(),
          description: presentation?.description ?? 'Configured auto ability.',
          category: presentation?.category ?? 'utility',
          details: `${presentation?.kind === 'spell' ? 'SPELL' : 'AUTO'}  •  ${cooldownSeconds}s CD`,
          equipped: state.equippedActiveAbilityIds.includes(abilityId),
        };
      });

    loadout.open({
      entries: buildEntries(),
      slotLimit: ACTIVE_ABILITY_SLOT_LIMIT,
      onToggle: (abilityId) => {
        const presentation = getAbilityPresentation(abilityId);
        const name = presentation?.name ?? abilityId;
        const equippedIndex = state.equippedActiveAbilityIds.indexOf(abilityId);
        if (equippedIndex >= 0) {
          state.equippedActiveAbilityIds.splice(equippedIndex, 1);
          return {
            entries: buildEntries(),
            feedback: `${name} removed from the auto bar.`,
            tone: 'success',
          };
        }
        if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
          return {
            entries: buildEntries(),
            feedback: `All ${ACTIVE_ABILITY_SLOT_LIMIT} slots are full. Remove an ability first.`,
            tone: 'warning',
          };
        }
        state.equippedActiveAbilityIds.push(abilityId);
        return {
          entries: buildEntries(),
          feedback: `${name} equipped to the auto bar.`,
          tone: 'success',
        };
      },
      onClose: () => {
        if (probeLoadoutPreviousState !== null) {
          world.state = probeLoadoutPreviousState;
          probeLoadoutPreviousState = null;
        }
      },
    });
  };
  const probeWindow = window as unknown as { __abilitiesProbe?: AbilitiesProbeApi };
  const probe: AbilitiesProbeApi = {
    ready: () => {
      const scene = getScene();
      return (
        scene?.world != null &&
        (scene.playerEid ?? -1) >= 0 &&
        scene.hudUi != null &&
        scene.abilityLoadoutUI != null
      );
    },
    openLoadout: () => {
      const scene = getScene();
      if (scene) {
        openLoadoutFromProbe(scene);
      }
    },
    closeLoadout: () => {
      const world = getScene()?.world;
      getScene()?.abilityLoadoutUI?.close();
      if (world && probeLoadoutPreviousState !== null) {
        world.state = probeLoadoutPreviousState;
        probeLoadoutPreviousState = null;
      }
    },
    getSnapshot: () => {
      const scene = getScene();
      const loadout = scene?.abilityLoadoutUI;
      const world = scene?.world;
      const playerEid = scene?.playerEid ?? -1;
      const open = loadout?.isOpen() ?? false;
      const slots: ScreenBounds[] = [];
      for (let index = 0; index < 10; index += 1) {
        const bounds = scene?.hudUi?.getAbilitySlotBounds(index);
        if (bounds) slots.push(bounds);
      }
      return {
        open,
        frameCount: world?.frameCount ?? -1,
        panel: open ? (loadout?.getPanelScreenBounds() ?? null) : null,
        listViewport: open ? (loadout?.getListViewportScreenBounds() ?? null) : null,
        visibleRows: open ? (loadout?.getVisibleRowScreenBounds() ?? []) : [],
        visibleAbilityIds: open ? (loadout?.getVisibleAbilityIds() ?? []) : [],
        footer: open ? (loadout?.getFooterScreenBounds() ?? null) : null,
        hotbar: scene?.hudUi?.getAbilityBarBounds() ?? null,
        slots,
        selectedAbilityId: open ? (loadout?.getSelectedAbilityId() ?? null) : null,
        equippedAbilityIds:
          world && playerEid >= 0
            ? [...(world.abilityStatesByEntity.get(playerEid)?.equippedActiveAbilityIds ?? [])]
            : [],
      };
    },
  };
  probeWindow.__abilitiesProbe = probe;
  const genericProbeWindow = window as unknown as {
    __uiProbe?: { ready(): boolean };
  };
  const readyAlias = { ready: probe.ready };
  if (reviewMode) genericProbeWindow.__uiProbe = readyAlias;

  function restartScene(): void {
    // Rebuild the entire Phaser game so every closure (configureWorld,
    // preSystems) captures the current toggle state and the arena regen
    // reseeds cleanly. Matches how weapon-lab handles Reset.
    runtime.world = undefined;
    runtime.playerEid = undefined;
    game.destroy(true);
    game = new Phaser.Game(createFloorGameConfig(gameHost, sceneOptions));
  }

  // ---- HUD ticker (reads live world) ----
  const hudInterval = window.setInterval(() => {
    const world = runtime.world;
    const eid = runtime.playerEid ?? -1;
    if (!world || eid < 0) {
      hud.textContent = 'Booting…';
      return;
    }
    const state = world.abilityStatesByEntity.get(eid);
    const enemyCount = query(world.ecs, [Enemy]).length;
    const equippedCount = state?.equippedActiveAbilityIds.length ?? 0;
    const passiveIds = state?.passiveAbilityIds ?? [];
    const hp = world.stores.health.current[eid] ?? 0;
    const hpMax = world.stores.health.max[eid] ?? 0;
    const currentWeapon = getActiveWeaponDef(world);

    const passiveLines = passiveIds.map((pid) => {
      const def = ABILITIES.find((a) => a.id === pid);
      if (!def || def.kind !== 'passive') return '';
      const prereq = def.weaponPrerequisite;
      const active = state?.appliedPassiveAbilityIds.has(pid) ?? false;
      if (prereq !== undefined) {
        const met = weaponPrerequisiteMet(world, eid, pid);
        return `  ${met ? '✓' : '✗'} ${def.name} [needs: ${prereq}]${active ? ' (applied)' : ''}`;
      }
      return `  ✓ ${def.name}${active ? ' (applied)' : ''}`;
    });

    hud.textContent = [
      `Weapon: ${currentWeapon?.id ?? '(none)'}`,
      `Scenario: ${getScenario(settings.scenario).label}`,
      `HP: ${hp.toFixed(0)} / ${hpMax.toFixed(0)}`,
      `Enemies: ${enemyCount}`,
      `Equipped: ${equippedCount} active/spell   ${passiveIds.length} passive`,
      passiveIds.length > 0 ? `Passives:\n${passiveLines.filter(Boolean).join('\n')}` : '',
      `State: ${world.state}`,
    ]
      .filter(Boolean)
      .join('\n');
  }, 100);

  // ---- GUI ----
  function persistState(): void {
    saveLabState<AbilitiesLabSnapshot>(LAB_ID, { settings, equipped });
  }

  // lil-gui (like dat.GUI) treats object keys as display labels and their
  // values as the stored setting, so this shows human-readable scenario
  // names in the dropdown while `settings.scenario` still holds the raw
  // scenario id.
  const scenarioLabels: Record<string, string> = {};
  for (const s of SCENARIOS) scenarioLabels[s.label] = s.id;

  gui
    .add(settings, 'scenario', scenarioLabels)
    .name('Scenario')
    .onChange(() => {
      persistState();
      restartScene();
    });

  gui
    .add(settings, 'activeWeapon', WEAPON_IDS)
    .name('Auto-Weapon')
    .onChange(() => {
      const world = runtime.world;
      const weapon = WEAPON_DEFS.get(settings.activeWeapon);
      if (world && weapon) setActiveWeapon(world, weapon);
      persistState();
    });

  const abilityFolder = gui.addFolder('Abilities');
  abilityFolder.open();
  for (const def of ABILITIES) {
    abilityFolder
      .add(equipped, def.id)
      .name(`${def.name} (${abilityKindLabel(def)})`)
      .onChange(() => {
        const world = runtime.world;
        const eid = runtime.playerEid ?? -1;
        if (world && eid >= 0) syncEquippedAbilities(world, eid, equipped);
        renderHotbar();
        persistState();
      });
  }

  const helpers = {
    'Take 60% HP': () => {
      const world = runtime.world;
      const eid = runtime.playerEid ?? -1;
      if (!world || eid < 0) return;
      const max = world.stores.health.max[eid] ?? 100;
      world.stores.health.current[eid] = Math.max(1, Math.round(max * 0.4));
    },
    'Queue hits→10 (skill_usage)': () => {
      const world = runtime.world;
      const eid = runtime.playerEid ?? -1;
      if (!world || eid < 0) return;
      queueAbilityTrigger(world, {
        holderEid: eid,
        kind: 'skill_usage',
        metric: 'hits_landed',
        amount: 10,
      });
    },
    'Full Heal': () => {
      const world = runtime.world;
      const eid = runtime.playerEid ?? -1;
      if (!world || eid < 0) return;
      const max = world.stores.health.max[eid] ?? 100;
      world.stores.health.current[eid] = max;
    },
    'Reset Arena': () => restartScene(),
  };
  const helperFolder = gui.addFolder('Helpers');
  helperFolder.add(helpers, 'Take 60% HP');
  helperFolder.add(helpers, 'Queue hits→10 (skill_usage)');
  helperFolder.add(helpers, 'Full Heal');
  helperFolder.add(helpers, 'Reset Arena');

  const arenaFolder = gui.addFolder('Debug Toggles');
  arenaFolder.add(settings, 'invulnerable').name('Invulnerable');

  gui.onChange(persistState);

  return () => {
    window.clearInterval(hudInterval);
    if (probeWindow.__abilitiesProbe === probe) delete probeWindow.__abilitiesProbe;
    if (genericProbeWindow.__uiProbe === readyAlias) delete genericProbeWindow.__uiProbe;
    game.destroy(true);
    for (const restore of reviewStyleRestorers.reverse()) restore();
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Combat' as LabCategory,
  name: 'Abilities Lab',
  description:
    'Boot MainGameScene onto an Arena floor. Pick a scenario (solo, target dummy, cluster, ' +
    'low-HP, boss horde, skill-trigger), equip any spells/actives/passives, and click the ' +
    'debug hotbar overlay to force-fire abilities bypassing cooldown.',
  create: createAbilitiesLab,
});
