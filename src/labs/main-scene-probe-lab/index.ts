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
 * It deliberately boots via `createFloorGameConfig` + `createFloorMainSceneOptions`
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
import { query } from 'bitecs';
import Phaser from 'phaser';
import {
  createFloor1GameConfig,
  createFloorGameConfig,
} from '../../bootstrap/floor-game-config.js';
import { createFloorMainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import { Harvestable } from '../../core/components.js';
import type { GameWorld } from '../../core/index.js';
import { spawnDroppedItem } from '../../core/helpers.js';
import {
  acknowledgeBossChestReveal,
  createBossChestRecord,
  openBossChest,
} from '../../core/systems/bossChestRewards.js';
import { itemPickupSystem } from '../../core/systems/itemPickupSystem.js';
import { getEquipmentState } from '../../core/systems/equipmentSystem.js';
import { acceptQuest } from '../../core/systems/questSystem.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
} from '../../shared/quest-types.js';
import {
  createBloodPoolSurface,
  isBloodyFootprintSourceActive,
} from '../../shared/blood-surfaces.js';
import { PIXELS_PER_FOOT } from '../../shared/units.js';
import { generatedBriefIdForHarvestable } from '../../engine/phaser-bridge/sprite-kind.js';
import type { ScreenBounds } from '../../engine/ui-scale.js';
import { HARVESTABLE_DEFS } from '../../shared/harvestableDefs.js';
import type { GeneratedEquipmentInstanceKey } from '../../shared/generated-equipment-types.js';
import { getItemById, getItemIndex } from '../../shared/items.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import type { ModalPickerLayoutSnapshot } from '../../engine/ModalPickerUI.js';
import { registerLab, type LabCategory } from '../registry.js';
import { createAbilityState } from '../../game/systems/abilitySystem.js';
import { unlockAchievement } from '../../game/systems/achievementSystem.js';
import { BOSS_CHEST_REWARD_BASE_IDS } from '../../game/boss-chest-resolver.js';
import { resolveEquipmentRewardBundle } from '../../game/floor2-reward-bundle-resolver.js';

const LAB_ID = 'main-scene-probe-lab';
const SCENE_KEY = 'MainGameScene';

/** Fixed world seed so every boot is byte-for-byte deterministic. */
const PROBE_SEED = 4242;

/**
 * Generated-sprite brief ids the render layer maps the Floor-1 harvestable node
 * types to (e.g. `crimson-mushroom-v1`). A harvestable node's on-floor Image is
 * created with one of these as the texture-key prefix, so the probe counts live
 * display-list Images by matching this set — the deterministic real-scene signal
 * that a node rendered its generated sprite instead of the procedural circle.
 */
const HARVESTABLE_BRIEF_IDS: readonly string[] = HARVESTABLE_DEFS.map((def) =>
  generatedBriefIdForHarvestable(def.id),
).filter((briefId): briefId is string => typeof briefId === 'string');

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

function readFloorId(): 'floor1' | 'floor2' {
  return new URLSearchParams(window.location.search).get('floor') === 'floor2'
    ? 'floor2'
    : 'floor1';
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
  /**
   * Darkness/fog RenderTexture drawn over the terrain. Exposed to the probe
   * purely so art observations can inspect terrain as authored: the torch
   * radius is small enough that cave rock and wall lighting are unreadable in
   * a normal screenshot, which previously led to a wall restyle being judged
   * against the flagstone spawn room instead of the cave.
   */
  lightOverlayRt?: { visible: boolean };
  hudUi?: {
    isMapOverlayOpen(): boolean;
    getFamilyRelationshipsState(): {
      visible: boolean;
      bounds: ScreenBounds | null;
      panelVisible: boolean;
    };
  };
  inventoryUI?: {
    isOpen(): boolean;
    refresh(world: GameWorld): void;
    getVisibleItemIds?(): readonly string[];
    getCellScreenBounds(index: number): ScreenBounds | null;
    getCellIndexForEntry(entry: {
      readonly kind: 'generated-instance';
      readonly instanceKey: GeneratedEquipmentInstanceKey;
    }): number | null;
  };
  equipmentUI?: {
    isOpen(): boolean;
    getGeneratedBagCellScreenBounds(
      instanceKey: GeneratedEquipmentInstanceKey,
    ): ScreenBounds | null;
  };
  achievementsUI?: {
    isOpen(): boolean;
    refresh(world: GameWorld): void;
    claimReward(achievementId: string): void;
  };
  bossChestUI?: { isOpen(): boolean; refresh(world: GameWorld): void };
  quartermasterUI?: { isOpen(): boolean; refresh(world: GameWorld): void };
  /**
   * The shared reward-opening sequence overlay driven by `AchievementsUI` /
   * `BossChestUI`. Test/automation affordances only (`getPhase`/`getBucket`/
   * `getRevealProgress`) plus the same `skip`/`acknowledge` a player's
   * keyboard/pointer input drives — no probe-only bypass of the real state
   * machine.
   */
  rewardOpeningUI?: {
    isOpen(): boolean;
    tick(deltaMs: number): void;
    skip(): void;
    acknowledge(): void;
    getPhase(): string | null;
    getBucket(): string | null;
    getRevealProgress(): { readonly revealed: number; readonly total: number } | null;
  };
  /**
   * Test/automation observability only (see `MainGameScene.rewardAudioCueLog`):
   * the ordered array of every reward-opening audio cue actually synthesized
   * by the real `AudioCueEngine`. Mutable — cleared directly (`.length = 0`)
   * by the probe so each e2e scenario starts clean.
   */
  rewardAudioCueLog?: RewardAudioCueLogEntryProbe[];
  abilityLoadoutUI?: { isOpen(): boolean; close(): void };
  inventoryButton?: { visible: boolean };
  equipButton?: { visible: boolean };
  achievementsButton?: { visible: boolean };
  abilitiesButton?: { visible: boolean; emit(eventName: string): boolean };
  bossChestButton?: { visible: boolean; emit(eventName: string): boolean };
  quartermasterButton?: { visible: boolean; emit(eventName: string): boolean };
  modalPicker?: {
    isOpen(): boolean;
    close(): void;
    getLayoutSnapshot(): ModalPickerLayoutSnapshot | null;
  };
  openSpellSelectionModal?(): void;
  conversationNpcEid?: number | null;
  queuedInteraction?: boolean;
  queuedAbilitiesToggle?: boolean;
  requestInventoryToggle?(): void;
  requestEquipAction?(): void;
  requestAchievementsToggle?(): void;
  requestBossChestsToggle?(): void;
  requestQuartermasterToggle?(): void;
  getSettlementShopOfferSnapshot?(): ReadonlyArray<{
    readonly stockId?: string;
    readonly offerId: string;
    readonly quantity: number;
    readonly unitPrice: number;
    readonly displayName: string | null;
  }>;
  purchaseFirstSettlementShopOffer?(): {
    ok: boolean;
    reason?: string;
    goldSpent?: number;
    itemId?: string;
    instanceId?: GeneratedEquipmentInstanceKey;
  };
  resumePendingRewardPresentations?(): void;
  setSimulationPaused(paused: boolean): void;
  advanceSimulationFrames?(frames?: number): void;
  isSimulationPaused(): boolean;
  getTerrainRenderSummary(): {
    generatedCount: number;
    spriteCount: number;
    colorCount: number;
    packWallCount: number;
    packFloorCount: number;
    packCorridorCount: number;
    packSpecialFloorCount: number;
    packFloorSourceCounts: Record<string, number>;
    packFloorTransformCounts: Record<string, number>;
    packFloorComboCounts: Record<string, number>;
    packCorridorSourceCounts: Record<string, number>;
    packCorridorTransformCounts: Record<string, number>;
    packCorridorComboCounts: Record<string, number>;
    packWallAccentedCount: number;
    packWallAccentCounts: Record<string, number>;
    packGroundDecalCount: number;
    packLineworkTileCount: number;
    packLineworkPropCount: number;
    packLineworkBuriedCount: number;
    packLineworkBuriedSample: readonly { readonly tx: number; readonly ty: number }[];
    packLineworkRuns: readonly {
      layerId: string;
      tileCount: number;
      hubTileCount: number;
    }[];
    packLineworkHubs: readonly { tx: number; ty: number }[];
  };
  getDoorRenderSummary(): {
    closedPackCount: number;
    closedGeneratedCount: number;
    closedKenneyCount: number;
    closedColorCount: number;
    openPackCount: number;
    openGeneratedCount: number;
    openKenneyCount: number;
    openColorCount: number;
    renderableClosedCount: number;
    renderableOpenCount: number;
  };
}

/** A 2-D point in some coordinate space (feet for world, pixels for camera). */
export interface ProbePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Snapshot of the shared reward-opening sequence overlay, or the "closed"
 * shape when no reward is currently presenting. Mirrors
 * `RewardOpeningUI`'s test/automation getters 1:1 so the e2e suite can assert
 * phase ordering / intensity bucket / reveal progress without reaching into
 * Phaser internals itself.
 */
export interface RewardOpeningProbeState {
  readonly open: boolean;
  readonly phase: string | null;
  readonly bucket: string | null;
  readonly revealed: number;
  readonly total: number;
}

/**
 * One synthesized reward-opening audio cue as actually dispatched to the
 * real `AudioCueEngine` inside the booted `MainGameScene` — mirrors
 * `RewardAudioCueLogEntry`. Lets the e2e suite assert cue ordering, gain
 * monotonicity, and reduced-intensity scaling against the REAL wiring
 * without touching Phaser/WebAudio internals itself.
 */
export interface RewardAudioCueLogEntryProbe {
  readonly label: string;
  readonly frequencyHz: number;
  readonly durationMs: number;
  readonly gain: number;
}

/**
 * The generated (or fallback) texture actually bound to a spawned NPC's live
 * sprite, tied back to its {@link NpcInstance.defId}. Lets an e2e / observation
 * script prove — in the REAL booted MainGameScene — that each welcome-room NPC
 * renders its own distinct generated sprite rather than the shared villager.
 */
export interface NpcRenderInfo {
  /** NPC definition id (e.g. 'tutorial-goon'). */
  readonly defId: string;
  /** ECS entity id of the NPC. */
  readonly eid: number;
  /** NPC feet position in FEET (sim space). */
  readonly feet: ProbePoint;
  /** Texture key on the rendered sprite nearest the NPC's feet, or null. */
  readonly textureKey: string | null;
  /** Pixel distance from the NPC feet to the matched sprite (0 ≈ exact). */
  readonly distancePx: number;
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
  /** True while the dedicated abilities management surface is open. */
  readonly abilityLoadoutOpen: boolean;
  /** True when inventory is open. */
  readonly inventoryOpen: boolean;
  /** True when equipment is open. */
  readonly equipmentOpen: boolean;
  /** True when achievements is open. */
  readonly achievementsOpen: boolean;
  /** True when the boss chest panel is open. */
  readonly bossChestOpen: boolean;
  /** True when the Quartermaster shop panel is open. */
  readonly quartermasterOpen: boolean;
  /** True while a conversation is active. */
  readonly conversationOpen: boolean;
  /** Active NPC dialogue line index, or null when no conversation is open. */
  readonly conversationLineIndex: number | null;
  /** Current corner-button visibility (safe-room panel shortcuts). */
  readonly inventoryButtonVisible: boolean;
  readonly equipButtonVisible: boolean;
  readonly achievementsButtonVisible: boolean;
  readonly abilitiesButtonVisible: boolean;
  readonly bossChestButtonVisible: boolean;
  readonly quartermasterButtonVisible: boolean;
  /** Number of primary surfaces currently open (modal/inventory/equipment/achievements). */
  readonly primarySurfaceCount: number;
  /** True when safe-room-gated surfaces should be allowed. */
  readonly safeContext: boolean;
  /** Whether the simulation is currently paused. */
  readonly simulationPaused: boolean;
  /** Number of top-level Phaser display objects on the scene. */
  readonly displayObjectCount: number;
  /** Live player position in FEET (sim space), or null before spawn. */
  readonly playerFeet: ProbePoint | null;
  /** Live world-camera center in PIXELS (world space), or null. */
  readonly cameraCenter: ProbePoint | null;
  /** Floor 2 settlement room count, or zero before/non-Floor-2 initialization. */
  readonly settlementRoomCount: number;
  /** Live Floor 2 settlement shop archetype ids in snapshot order. */
  readonly settlementShopArchetypeIds: readonly string[];
}

export interface FamilyHudProbeState {
  readonly mapOverlayOpen: boolean;
  readonly visible: boolean;
  readonly bounds: ScreenBounds | null;
  /** Raw Phaser display-object visibility — false proves the panel is actually hidden, not just logically gated. */
  readonly panelVisible: boolean;
}

/**
 * Per-def render tally for a single harvestable node type. Lets the e2e assert
 * that *each* type with live nodes renders all of them as sprites — a
 * type-specific texture miss (e.g. one brief unresolved) that the aggregate
 * `spriteImages === nodeEntities` count could otherwise mask.
 */
export interface HarvestableDefRenderSummary {
  /** Harvestable def id (e.g. `crimson-mushroom`). */
  readonly defId: string;
  /** Generated briefId the render layer maps this def to, or null if unmapped. */
  readonly briefId: string | null;
  /** Live node entities of this def. */
  readonly nodeEntities: number;
  /** Display-list Images whose texture matches this def's brief. */
  readonly spriteImages: number;
}

/**
 * Live count of Floor-1 harvestable resource nodes and how many of them render a
 * generated sprite (vs. the procedural tinted-circle fallback). Used by the
 * harvestable-node-sprite e2e to observe the real render path.
 */
export interface HarvestableRenderSummary {
  /** Number of live harvestable node entities in the world. */
  readonly nodeEntities: number;
  /** Number of display-list Images whose texture matches a harvestable brief. */
  readonly spriteImages: number;
  /** Per-def breakdown (only defs with live nodes and/or matching sprites). */
  readonly byDef: readonly HarvestableDefRenderSummary[];
}

/**
 * Tile-provenance counts from the last terrain bake in the REAL booted scene.
 * Terrain bakes into a single RenderTexture, so per-tile provenance is invisible
 * to display-list counting — this summary (read from the scene's stored counts)
 * is the observe seam proving approved generated tile textures actually stamp
 * (`generatedCount > 0`), rather than falling back to Kenney frames or color.
 */
export interface TerrainRenderSummary {
  /** Tiles stamped from a GENERATED single-texture (approved art wired). */
  readonly generatedCount: number;
  /** Tiles stamped from a Kenney spritesheet frame (placeholder fallback). */
  readonly spriteCount: number;
  /** Tiles drawn as a solid-color fill (no texture at all). */
  readonly colorCount: number;
  /**
   * WALL tiles stamped from a terrain-pack blob47 atlas frame. Non-zero only
   * when the floor manifest wires a `terrainPackId` (Floor 2 → `industrial-cave`);
   * the deterministic seam proving the pack renders in the REAL booted scene.
   */
  readonly packWallCount: number;
  /** FLOOR tiles stamped from a terrain-pack `floorPool` variant. */
  readonly packFloorCount: number;
  /** CORRIDOR tiles stamped from a terrain-pack `corridorPool` variant. */
  readonly packCorridorCount: number;
  /** Role-keyed special-room floor tiles stamped from a terrain pack. */
  readonly packSpecialFloorCount: number;
  /**
   * Live diversity instrumentation (2026-07-25 terrain-variance refinement
   * #4): per-source and per-transform stamp counts from the REAL bake, so an
   * e2e probe can assert "all 8 sources used" / histogram shape against the
   * actual booted scene rather than just a synthetic sample.
   */
  readonly packFloorSourceCounts: Record<string, number>;
  readonly packFloorTransformCounts: Record<string, number>;
  readonly packFloorComboCounts: Record<string, number>;
  readonly packCorridorSourceCounts: Record<string, number>;
  readonly packCorridorTransformCounts: Record<string, number>;
  readonly packCorridorComboCounts: Record<string, number>;
  /** Number of WALL tiles that additionally received an accent-atlas stamp. */
  readonly packWallAccentedCount: number;
  /** Per-accent-id stamp counts. */
  readonly packWallAccentCounts: Record<string, number>;
  /**
   * Cross-tile ground decals stamped between the ground and cover paint passes.
   * The only pack mechanism that can express a feature larger than one cell, so
   * this is the seam proving decals actually placed in the REAL booted scene.
   */
  readonly packGroundDecalCount: number;
  /**
   * Industrial-linework tiles stamped by the path pass (all layers summed).
   * Unlike decals, these are chosen by TOPOLOGY: each tile's frame is its 2-edge
   * Wang mask over the occupancy grid, so a non-zero count here proves that
   * routed multi-tile runs — not scattered stamps — reached the real bake.
   */
  readonly packLineworkTileCount: number;
  /** Props (switch stands, carts, valves) placed on eligible linework tiles. */
  readonly packLineworkPropCount: number;
  readonly packLineworkBuriedCount: number;
  readonly packLineworkBuriedSample: readonly { readonly tx: number; readonly ty: number }[];
  /**
   * One entry per maximal connected component of every linework layer. This is
   * what the placement gate is asserted against headlessly: "at least 6 runs of
   * at least 40 tiles, with at least 60% of total run length near a boss den or
   * the resource heart" is a pure function of this array.
   */
  readonly packLineworkRuns: readonly {
    readonly layerId: string;
    readonly tileCount: number;
    readonly hubTileCount: number;
  }[];
  /** Hub tiles (boss dens + resource heart) the concentration is measured against. */
  readonly packLineworkHubs: readonly { readonly tx: number; readonly ty: number }[];
}

/**
 * Door-render provenance counts from the last `updateDoorOverlay()` pass in the
 * REAL booted scene. Doors are drawn per-frame as overlay Images (not baked into
 * the terrain RenderTexture); this summary (read from the scene's stored counts)
 * is the observe seam proving CLOSED doors stamp the approved generated texture
 * (`closedPackCount === renderableClosedCount` on a pack-using floor) rather
 * than generated/Kenney/color fallbacks. Buckets are mutually exclusive.
 */
export interface DoorRenderSummary {
  /** Closed doors rendered from a terrain-pack doorSet texture. */
  readonly closedPackCount: number;
  /** Closed doors rendered from the approved GENERATED texture. */
  readonly closedGeneratedCount: number;
  /** Closed doors rendered from the Kenney closed frame (fallback). */
  readonly closedKenneyCount: number;
  /** Closed doors drawn as a solid-color fill (no art at all). */
  readonly closedColorCount: number;
  /** Open doors rendered from a terrain-pack doorSet texture. */
  readonly openPackCount: number;
  /** Open doors rendered from an approved GENERATED open-door texture. */
  readonly openGeneratedCount: number;
  /** Open doors rendered from the Kenney open frame (fallback). */
  readonly openKenneyCount: number;
  /** Open doors drawn as a solid-color fill (no art at all). */
  readonly openColorCount: number;
  /** Sum of the four CLOSED buckets — total closed doors actually rendered. */
  readonly renderableClosedCount: number;
  /** Sum of the four OPEN buckets — total open doors actually rendered. */
  readonly renderableOpenCount: number;
}

export interface BloodSurfaceProbeSummary {
  readonly poolCount: number;
  readonly footprintCount: number;
  readonly renderedPoolCount: number;
  readonly renderedFootprintCount: number;
  readonly activeSourceColor: number | null;
  readonly activeSourceRemainingMs: number;
  readonly footprintColors: number[];
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
  /** Force `isInSafeContext(world)` on/off via `playerInSafeRoom`. */
  setSafeContext(enabled: boolean): void;
  /** Unlock inventory/equipment/abilities and seed one achievement for testing. */
  unlockSafeRoomSurfaces(): void;
  /** Resolve the opening loadout modal (pick option 0) and freeze the sim. */
  resolveLoadout(): void;
  /** Activate the Floor 2 reputation HUD through the shipped broker callback. */
  activateFamilyRelationships(): void;
  /** Mounted family-HUD visibility and bounds plus fullscreen-map state. */
  getFamilyHudState(): FamilyHudProbeState;
  /** Trigger the shipped Floor-1 boss reward condition and open its real picker path. */
  openBossRewardPicker(): void;
  /** Measured layout for the currently open real modal picker. */
  getModalPickerLayout(): ModalPickerLayoutSnapshot | null;
  /** Pause / unpause the simulation. */
  setSimulationPaused(paused: boolean): void;
  /** Advance the paused simulation by N fixed steps using the real scene seam. */
  advanceSimulationFrames(frames: number): void;
  /** Overwrite the player's FEET position and zero its velocity. */
  setPlayerFeet(x: number, y: number): void;
  /**
   * Show/hide the darkness+fog overlay. Art-observation affordance only —
   * lets a screenshot show terrain as authored rather than as torch-lit.
   * Returns false when the overlay does not exist yet.
   */
  setLightingOverlayVisible(visible: boolean): boolean;
  /** Seed an authoritative blood pool directly into the live world. */
  seedBloodPool(x: number, y: number, color: number): number | null;
  /** World + display-list summary for blood pools / bloody footprints. */
  getBloodSurfaceSummary(): BloodSurfaceProbeSummary;
  /** Move the player onto the first NPC and mark it interactable for probe tests. */
  primeNpcInteractionTarget(): ProbePoint | null;
  /** Seed three off-screen quests through the real scene's live world. */
  primeQuestWaypointArrows(): void;
  /** Visible quest arrow ids on the real MainGameScene display list. */
  getVisibleQuestArrowIds(): string[];
  /** Queue the Achievements toggle through the real MainGameScene request path. */
  requestAchievementsToggle(): void;
  /** Queue Inventory ([I]) and Equipment ([G]) toggles through scene request paths. */
  requestInventoryToggle(): void;
  requestEquipToggle(): void;
  /** Queue Boss Chests ([C]) through the scene request path. */
  requestBossChestsToggle(): void;
  /** Queue Quartermaster ([Q]) through the scene request path. */
  requestQuartermasterToggle(): void;
  /** Queue abilities ([B]) toggle for the next update frame. */
  queueAbilitiesToggle(): void;
  /** Override the live world state machine value for targeted scene-flow probes. */
  setWorldState(state: GameWorld['state']): void;
  /** Emit a pointer tap on the Skills corner button. Returns false if unavailable/hidden. */
  tapAbilitiesButton(): boolean;
  /** Emit a pointer tap on the Chests corner button. Returns false if unavailable/hidden. */
  tapBossChestButton(): boolean;
  /** Emit a pointer tap on the Shop corner button. Returns false if unavailable/hidden. */
  tapQuartermasterButton(): boolean;
  /** Queue B + V in the same frame to exercise single-surface exclusivity. */
  queueAbilitiesAndAchievementsToggle(): void;
  /** Queue the shared interaction request used by touch and repeated E presses. */
  queueInteraction(): void;
  /** Live world-camera center in PIXELS, or null before the camera exists. */
  getCameraCenter(): ProbePoint | null;
  /** Floor map size in FEET (camera bounds === ftToPx of this), or null. */
  getMapSizeFeet(): ProbePoint | null;
  /** Live world-camera viewport size in PIXELS (worldView), or null. */
  getCameraViewSize(): ProbePoint | null;
  /**
   * Per-NPC render info: each spawned NPC's def id tied to the texture key on
   * its nearest live sprite. Used by the welcome-room NPC sprite-wiring
   * observation to prove three distinct generated textures in the real scene.
   */
  getNpcRenderInfo(): NpcRenderInfo[];
  /** Live harvestable node count + how many render a generated sprite. */
  getHarvestableRenderSummary(): HarvestableRenderSummary;
  /**
   * Tile-provenance counts from the last terrain bake. Used by the
   * terrain-generated-tiles e2e to prove — in the REAL booted scene — that
   * approved generated tile textures stamp (`generatedCount > 0`).
   */
  getTerrainRenderSummary(): TerrainRenderSummary;
  /**
   * Door-render provenance counts from the last `updateDoorOverlay()` pass. Used
   * by the generated-door-overlay e2e to prove — in the REAL booted scene — that
   * closed dungeon doors stamp the approved generated texture
   * (`renderableClosedCount > 0 && closedGeneratedCount === renderableClosedCount`).
   */
  getDoorRenderSummary(): DoorRenderSummary;
  /**
   * Unlock (if needed) and claim `achievementId`'s reward through the REAL
   * `AchievementsUI.claimReward` code path — the same exact-once claim +
   * `RewardOpeningUI.open()` call a player's "Open reward" click drives. A
   * no-op unlock if the achievement is already unlocked/claimed (idempotent).
   */
  claimAchievementReward(achievementId: string): readonly GeneratedEquipmentInstanceKey[];
  /** Seed one pending achievement reward plus one revealed boss chest reward. */
  seedPendingRewardResumeScenario(): void;
  /** Seed an available boss chest so touch/UI affordances can be observed. */
  seedAvailableBossChest(): void;
  /** Run the real MainGameScene shared reward-resume coordinator. */
  resumePendingRewardPresentations(): void;
  /** Snapshot of the shared reward-opening overlay, or the closed shape. */
  getRewardOpeningState(): RewardOpeningProbeState;
  /** Advance the open reward-opening sequence by `deltaMs`. No-op while closed. */
  tickRewardOpening(deltaMs: number): void;
  /** Jump the open reward-opening sequence straight to `summary`. */
  skipRewardOpening(): void;
  /** Confirm the summary (the real acknowledge/claim-once path). */
  acknowledgeRewardOpening(): void;
  /** Live `world.elapsedMs` — used to prove the sim is frozen while a reward presents. */
  getWorldElapsedMs(): number | null;
  /** Current player gold — for asserting purchase outcomes. */
  getPlayerGold(): number | null;
  /** Set player gold — for arranging purchase preconditions in tests. */
  setPlayerGold(amount: number): void;
  /** Get a snapshot of whichever settlement shop the shared panel is currently targeting. */
  getQuartermasterStockSnapshot(): ReadonlyArray<{
    readonly stockId?: string;
    readonly offerId: string;
    readonly quantity: number;
    readonly unitPrice: number;
    readonly displayName: string | null;
  }>;
  /** Get the raw seeded inventory snapshot for a non-Quartermaster settlement shop NPC. */
  getSettlementShopInventorySnapshot(npcEid: number): ReadonlyArray<{
    readonly itemId: string;
    readonly quantity: number;
    readonly unitPrice: number;
    readonly displayName: string | null;
  }>;
  /**
   * Purchase the first purchasable offer from whichever settlement shop the shared
   * panel is currently targeting. Used to exercise the full purchase path from
   * an e2e test.
   */
  purchaseFirstQuartermasterOffer(): {
    ok: boolean;
    reason?: string;
    goldSpent?: number;
    itemId?: string;
    instanceId?: GeneratedEquipmentInstanceKey;
  };
  /** Visible rendered inventory item ids from the live InventoryUI grid. */
  getInventoryVisibleItemIds(): readonly string[];
  /** Open + acknowledge the first available boss chest through core grant APIs. */
  openFirstAvailableBossChest(): { ok: boolean; reason?: string };
  /** Spawn a floor drop at the player and advance the real sim enough to pick it up. */
  spawnAndPickupFloorDrop(itemId: string): { ok: boolean; reason?: string };
  /** Bounds for an exact generated instance's rendered inventory cell. */
  getGeneratedInventoryCellBounds(instanceKey: GeneratedEquipmentInstanceKey): ScreenBounds | null;
  /** Bounds for an exact generated instance's rendered Gear-panel bag cell. */
  getGeneratedEquipmentBagCellBounds(
    instanceKey: GeneratedEquipmentInstanceKey,
  ): ScreenBounds | null;
  /** Exact generated instance keys currently equipped by the player. */
  getEquippedGeneratedInstanceKeys(): readonly GeneratedEquipmentInstanceKey[];
  /**
   * Ordered log of every reward-opening audio cue actually dispatched to the
   * REAL `AudioCueEngine` (as `SynthCueSpec`s), since the last
   * `clearRewardAudioCueLog()`. Used to prove — against the real scene wiring,
   * not the pure cue-decision functions in isolation — cue ordering,
   * intensity/gain monotonicity, reduced-motion scaling, and that
   * skip/close/duplicate-input never leaves overlapping cues.
   */
  getRewardAudioCueLog(): readonly RewardAudioCueLogEntryProbe[];
  /** Reset the reward-opening audio cue log so a scenario starts from empty. */
  clearRewardAudioCueLog(): void;
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

  const floorId = readFloorId();
  // The bootstrap ships each floor's authored ambient via `lightingConfig`;
  // an optional `?ambient=` override lets the lighting-defaults e2e exercise a
  // distinguishing value end-to-end (see readAmbientOverride). Absent → default.
  const baseOptions = createFloorMainSceneOptions(floorId);
  const ambientOverride = readAmbientOverride();
  const sceneOptions = {
    ...baseOptions,
    worldSeed: PROBE_SEED,
    ...(ambientOverride !== null
      ? { lightingConfig: { ...baseOptions.lightingConfig, ambient: ambientOverride } }
      : {}),
  };
  const config =
    floorId === 'floor1'
      ? createFloor1GameConfig(gameHost, sceneOptions)
      : createFloorGameConfig(gameHost, sceneOptions, floorId);
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
      const modalOpen = scene?.modalPicker?.isOpen() ?? false;
      const abilityLoadoutOpen = scene?.abilityLoadoutUI?.isOpen() ?? false;
      const inventoryOpen = scene?.inventoryUI?.isOpen() ?? false;
      const equipmentOpen = scene?.equipmentUI?.isOpen() ?? false;
      const achievementsOpen = scene?.achievementsUI?.isOpen() ?? false;
      const bossChestOpen = scene?.bossChestUI?.isOpen() ?? false;
      const quartermasterOpen = scene?.quartermasterUI?.isOpen() ?? false;
      const conversationNpcEid = scene?.conversationNpcEid ?? null;
      const conversationLineIndex =
        conversationNpcEid !== null
          ? (world?.npcs.get(conversationNpcEid)?.dialogueIndex ?? 0)
          : null;
      return {
        worldState: world?.state ?? null,
        playerEid: eid,
        hudPresent: scene?.hudUi != null,
        bridgePresent: scene?.bridge != null,
        modalOpen,
        abilityLoadoutOpen,
        inventoryOpen,
        equipmentOpen,
        achievementsOpen,
        bossChestOpen,
        quartermasterOpen,
        conversationOpen: conversationNpcEid !== null,
        conversationLineIndex,
        inventoryButtonVisible: scene?.inventoryButton?.visible ?? false,
        equipButtonVisible: scene?.equipButton?.visible ?? false,
        achievementsButtonVisible: scene?.achievementsButton?.visible ?? false,
        abilitiesButtonVisible: scene?.abilitiesButton?.visible ?? false,
        bossChestButtonVisible: scene?.bossChestButton?.visible ?? false,
        quartermasterButtonVisible: scene?.quartermasterButton?.visible ?? false,
        primarySurfaceCount: [
          modalOpen,
          abilityLoadoutOpen,
          inventoryOpen,
          equipmentOpen,
          achievementsOpen,
          bossChestOpen,
          quartermasterOpen,
        ].filter(Boolean).length,
        safeContext: (world?.playerInSafeRoom ?? false) || world?.state === 'safe_room',
        simulationPaused: scene?.isSimulationPaused() ?? false,
        displayObjectCount: phaserScene?.children.list.length ?? 0,
        playerFeet,
        cameraCenter: cameraCenter(),
        settlementRoomCount: world?.floorExtendedState?.settlement?.settlementRoomIds.length ?? 0,
        settlementShopArchetypeIds: [
          ...(world?.floorExtendedState?.settlement?.quartermasterShop
            ? [world.floorExtendedState.settlement.quartermasterShop.archetypeId]
            : []),
          ...(world?.floorExtendedState?.settlement?.shops.map((shop) => shop.archetypeId) ?? []),
        ],
      };
    },

    setSafeContext: (enabled: boolean) => {
      const world = getScene()?.world;
      if (world) {
        world.playerInSafeRoom = enabled;
      }
    },

    openBossRewardPicker: () => {
      const scene = getScene();
      const world = scene?.world;
      if (!scene || !world) {
        throw new Error('MainGameScene is not ready');
      }
      if (world.state === 'loadout') {
        scene.modalPicker?.close();
        sceneOptions.selectLoadoutOption?.(world, 0);
      }
      world.state = 'playing';
      world.goalFlags.set('floor1-boss-battle-complete', true);
      world.featureUnlocks.spells = false;
      scene.modalPicker?.close();
      scene.openSpellSelectionModal?.();
      if (!scene.modalPicker?.isOpen()) {
        throw new Error('real boss reward picker did not open');
      }
    },

    getModalPickerLayout: () => getScene()?.modalPicker?.getLayoutSnapshot() ?? null,

    setWorldState: (state) => {
      const world = getScene()?.world;
      if (world) {
        world.state = state;
      }
    },
    unlockSafeRoomSurfaces: () => {
      const scene = getScene();
      const world = scene?.world;
      const eid = playerEidOf(scene);
      if (!world) {
        return;
      }
      world.playerInSafeRoom = true;
      world.featureUnlocks.inventory = true;
      world.featureUnlocks.equipment = true;
      world.featureUnlocks.spells = true;
      world.achievements.unlockedIds.add('first-bonk');
      if (eid >= 0) {
        const state = world.abilityStatesByEntity.get(eid) ?? createAbilityState();
        if (state.learnedSpellIds.length === 0 && state.equippedActiveAbilityIds.length === 0) {
          state.learnedSpellIds = ['fireball'];
        }
        world.abilityStatesByEntity.set(eid, state);
      }
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

    activateFamilyRelationships: () => {
      const scene = getScene();
      const world = scene?.world;
      if (scene && world) {
        sceneOptions.broker?.met(world);
        scene.setSimulationPaused(false);
      }
    },

    getFamilyHudState: (): FamilyHudProbeState => {
      const hud = getScene()?.hudUi;
      const family = hud?.getFamilyRelationshipsState();
      return {
        mapOverlayOpen: hud?.isMapOverlayOpen() ?? false,
        visible: family?.visible ?? false,
        bounds: family?.bounds ?? null,
        panelVisible: family?.panelVisible ?? false,
      };
    },

    setSimulationPaused: (paused: boolean) => {
      getScene()?.setSimulationPaused(paused);
    },

    advanceSimulationFrames: (frames: number) => {
      getScene()?.advanceSimulationFrames?.(frames);
    },

    setLightingOverlayVisible: (visible: boolean): boolean => {
      const rt = getScene()?.lightOverlayRt;
      if (!rt) return false;
      rt.visible = visible;
      return true;
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

    seedBloodPool: (x: number, y: number, color: number): number | null => {
      const world = getScene()?.world;
      if (!world) {
        return null;
      }
      const pool = createBloodPoolSurface({
        worldSeed: world.seed,
        poolId: world.bloodyFootprintState.nextPoolId++,
        x,
        y,
        color,
        createdAtMs: world.elapsedMs,
      });
      world.bloodPools.push(pool);
      return pool.id;
    },

    getBloodSurfaceSummary: (): BloodSurfaceProbeSummary => {
      const world = getScene()?.world;
      const phaserScene = getPhaserScene();
      const elapsedMs = world?.elapsedMs ?? 0;
      const source = world?.bloodyFootprintState.source ?? null;
      const activeSource =
        world && isBloodyFootprintSourceActive(source, elapsedMs) ? source : null;
      const children = phaserScene?.children.list ?? [];
      const renderedPoolCount = children.filter(
        (child) =>
          typeof (child as { name?: unknown }).name === 'string' &&
          (child as { name: string }).name.startsWith('blood-pool:'),
      ).length;
      const renderedFootprintCount = children.filter(
        (child) =>
          typeof (child as { name?: unknown }).name === 'string' &&
          (child as { name: string }).name.startsWith('bloody-footprint:'),
      ).length;
      return {
        poolCount: world?.bloodPools.length ?? 0,
        footprintCount: world?.bloodyFootprints.length ?? 0,
        renderedPoolCount,
        renderedFootprintCount,
        activeSourceColor: activeSource?.color ?? null,
        activeSourceRemainingMs: activeSource
          ? Math.max(0, activeSource.expiresAtMs - elapsedMs)
          : 0,
        footprintColors: world?.bloodyFootprints.map((footprint) => footprint.color) ?? [],
      };
    },

    primeNpcInteractionTarget: (): ProbePoint | null => {
      const scene = getScene();
      const world = scene?.world;
      const eid = playerEidOf(scene);
      if (!world || eid < 0) {
        return null;
      }
      const firstNpc = world.npcs.entries().next().value;
      if (!firstNpc) {
        return null;
      }
      const [npcEid, instance] = firstNpc;
      const x = world.stores.position.x[npcEid] ?? 0;
      const y = world.stores.position.y[npcEid] ?? 0;
      instance.nearbyPlayer = true;
      world.stores.position.x[eid] = x;
      world.stores.position.y[eid] = y;
      world.stores.velocity.x[eid] = 0;
      world.stores.velocity.y[eid] = 0;
      return { x, y };
    },

    primeQuestWaypointArrows: () => {
      const scene = getScene();
      const world = scene?.world;
      const eid = playerEidOf(scene);
      const objective = world?.floorScenario?.objective;
      if (!scene || !world || !objective || eid < 0) {
        return;
      }
      if (world.state === 'loadout') {
        sceneOptions.selectLoadoutOption?.(world, 0);
        scene.modalPicker?.close();
      }
      scene.setSimulationPaused(true);
      acceptQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);
      acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
      acceptQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);
      const px = world.stores.position.x[eid] ?? 0;
      const py = world.stores.position.y[eid] ?? 0;
      objective.welcomeOfficePos.x = px + 100;
      objective.welcomeOfficePos.y = py;
      objective.shopRoomPos.x = px + 100;
      objective.shopRoomPos.y = py + 1;
      objective.slimeRatRoomPos.x = px + 100;
      objective.slimeRatRoomPos.y = py - 1;
    },

    getVisibleQuestArrowIds: (): string[] => {
      const phaserScene = getPhaserScene();
      if (!phaserScene) {
        return [];
      }
      return phaserScene.children.list
        .filter(
          (child): child is Phaser.GameObjects.Triangle =>
            child instanceof Phaser.GameObjects.Triangle &&
            child.visible &&
            child.name.startsWith('quest-direction-arrow:'),
        )
        .map((arrow) => arrow.name.slice('quest-direction-arrow:'.length));
    },

    requestAchievementsToggle: () => {
      getScene()?.requestAchievementsToggle?.();
    },

    requestBossChestsToggle: () => {
      getScene()?.requestBossChestsToggle?.();
    },

    requestQuartermasterToggle: () => {
      getScene()?.requestQuartermasterToggle?.();
    },

    requestInventoryToggle: () => {
      getScene()?.requestInventoryToggle?.();
    },

    requestEquipToggle: () => {
      getScene()?.requestEquipAction?.();
    },

    queueAbilitiesToggle: () => {
      const scene = getScene();
      if (scene) {
        scene.queuedAbilitiesToggle = true;
      }
    },

    tapAbilitiesButton: () => {
      const button = getScene()?.abilitiesButton;
      if (!button?.visible) {
        return false;
      }
      button.emit('pointerdown');
      return true;
    },

    tapBossChestButton: () => {
      const button = getScene()?.bossChestButton;
      if (!button?.visible) {
        return false;
      }
      button.emit('pointerdown');
      return true;
    },

    tapQuartermasterButton: () => {
      const button = getScene()?.quartermasterButton;
      if (!button?.visible) {
        return false;
      }
      button.emit('pointerdown');
      return true;
    },

    queueAbilitiesAndAchievementsToggle: () => {
      const scene = getScene();
      if (!scene) {
        return;
      }
      scene.requestAchievementsToggle?.();
      scene.queuedAbilitiesToggle = true;
    },

    queueInteraction: () => {
      const scene = getScene();
      if (scene) {
        scene.queuedInteraction = true;
      }
    },

    getCameraCenter: () => cameraCenter(),

    getMapSizeFeet: () => mapSizeFeet(),

    getCameraViewSize: () => cameraViewSize(),

    getNpcRenderInfo: (): NpcRenderInfo[] => {
      const scene = getScene();
      const phaserScene = getPhaserScene();
      const world = scene?.world;
      if (!world || !phaserScene) {
        return [];
      }
      const images = phaserScene.children.list.filter(
        (obj): obj is Phaser.GameObjects.Image => obj instanceof Phaser.GameObjects.Image,
      );
      const infos: NpcRenderInfo[] = [];
      for (const [eid, instance] of world.npcs.entries()) {
        const feetX = world.stores.position.x[eid] ?? 0;
        const feetY = world.stores.position.y[eid] ?? 0;
        const px = feetX * PIXELS_PER_FOOT;
        const py = feetY * PIXELS_PER_FOOT;
        let bestKey: string | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const img of images) {
          const dist = Math.hypot(img.x - px, img.y - py);
          if (dist < bestDist) {
            bestDist = dist;
            bestKey = img.texture.key;
          }
        }
        infos.push({
          defId: instance.defId,
          eid,
          feet: { x: feetX, y: feetY },
          textureKey: bestKey,
          distancePx: Number.isFinite(bestDist) ? Math.round(bestDist) : -1,
        });
      }
      return infos;
    },

    getHarvestableRenderSummary: (): HarvestableRenderSummary => {
      const world = getScene()?.world;
      const phaserScene = getPhaserScene();
      if (!world || !phaserScene) {
        return { nodeEntities: 0, spriteImages: 0, byDef: [] };
      }
      const nodes = query(world.ecs, [Harvestable]);
      const nodeEntities = nodes.length;

      // Node entities tallied per def id (via the stored defIndex → HARVESTABLE_DEFS).
      const nodeCountByDef = new Map<string, number>();
      for (const eid of nodes) {
        const defIndex = world.stores.harvestable.defIndex[eid] ?? -1;
        const def = HARVESTABLE_DEFS[defIndex];
        if (def) {
          nodeCountByDef.set(def.id, (nodeCountByDef.get(def.id) ?? 0) + 1);
        }
      }

      // Display-list Images tallied per matching brief id (and in aggregate).
      // Brief ids are distinct and none is a prefix of another, so the first
      // startsWith match is unambiguous.
      const spriteCountByBrief = new Map<string, number>();
      let spriteImages = 0;
      for (const obj of phaserScene.children.list) {
        const key = (obj as { texture?: { key?: string } }).texture?.key;
        if (typeof key !== 'string') {
          continue;
        }
        const briefId = HARVESTABLE_BRIEF_IDS.find((b) => key.startsWith(b));
        if (briefId !== undefined) {
          spriteImages += 1;
          spriteCountByBrief.set(briefId, (spriteCountByBrief.get(briefId) ?? 0) + 1);
        }
      }

      const byDef: HarvestableDefRenderSummary[] = HARVESTABLE_DEFS.map((def) => {
        const briefId = generatedBriefIdForHarvestable(def.id);
        return {
          defId: def.id,
          briefId: briefId ?? null,
          nodeEntities: nodeCountByDef.get(def.id) ?? 0,
          spriteImages: briefId !== undefined ? (spriteCountByBrief.get(briefId) ?? 0) : 0,
        };
      }).filter((d) => d.nodeEntities > 0 || d.spriteImages > 0);

      return { nodeEntities, spriteImages, byDef };
    },

    getTerrainRenderSummary: (): TerrainRenderSummary => {
      const summary = getScene()?.getTerrainRenderSummary();
      return {
        generatedCount: summary?.generatedCount ?? 0,
        spriteCount: summary?.spriteCount ?? 0,
        colorCount: summary?.colorCount ?? 0,
        packWallCount: summary?.packWallCount ?? 0,
        packFloorCount: summary?.packFloorCount ?? 0,
        packCorridorCount: summary?.packCorridorCount ?? 0,
        packSpecialFloorCount: summary?.packSpecialFloorCount ?? 0,
        packFloorSourceCounts: summary?.packFloorSourceCounts ?? {},
        packFloorTransformCounts: summary?.packFloorTransformCounts ?? {},
        packFloorComboCounts: summary?.packFloorComboCounts ?? {},
        packCorridorSourceCounts: summary?.packCorridorSourceCounts ?? {},
        packCorridorTransformCounts: summary?.packCorridorTransformCounts ?? {},
        packCorridorComboCounts: summary?.packCorridorComboCounts ?? {},
        packWallAccentedCount: summary?.packWallAccentedCount ?? 0,
        packWallAccentCounts: summary?.packWallAccentCounts ?? {},
        packGroundDecalCount: summary?.packGroundDecalCount ?? 0,
        packLineworkTileCount: summary?.packLineworkTileCount ?? 0,
        packLineworkPropCount: summary?.packLineworkPropCount ?? 0,
        packLineworkBuriedCount: summary?.packLineworkBuriedCount ?? 0,
        packLineworkBuriedSample: summary?.packLineworkBuriedSample ?? [],
        packLineworkRuns: (summary?.packLineworkRuns ?? []).map((run) => ({
          layerId: run.layerId,
          tileCount: run.tileCount,
          hubTileCount: run.hubTileCount,
        })),
        packLineworkHubs: (summary?.packLineworkHubs ?? []).map((hub) => ({
          tx: hub.tx,
          ty: hub.ty,
        })),
      };
    },

    getDoorRenderSummary: (): DoorRenderSummary => {
      const summary = getScene()?.getDoorRenderSummary();
      return {
        closedPackCount: summary?.closedPackCount ?? 0,
        closedGeneratedCount: summary?.closedGeneratedCount ?? 0,
        closedKenneyCount: summary?.closedKenneyCount ?? 0,
        closedColorCount: summary?.closedColorCount ?? 0,
        openPackCount: summary?.openPackCount ?? 0,
        openGeneratedCount: summary?.openGeneratedCount ?? 0,
        openKenneyCount: summary?.openKenneyCount ?? 0,
        openColorCount: summary?.openColorCount ?? 0,
        renderableClosedCount: summary?.renderableClosedCount ?? 0,
        renderableOpenCount: summary?.renderableOpenCount ?? 0,
      };
    },

    claimAchievementReward: (achievementId: string) => {
      const scene = getScene();
      const world = scene?.world;
      const achievementsUI = scene?.achievementsUI;
      if (!world || !achievementsUI) {
        return [];
      }
      const playerEid = playerEidOf(scene);
      const before = new Set(
        world.inventories.get(playerEid)?.generatedEquipment?.map((entry) => entry.instanceKey) ??
          [],
      );
      // Use the REAL unlock path (`unlockAchievement`) rather than mutating
      // `unlockedIds` directly — for `lootBox`/`equipment` rewards, unlocking
      // is what resolves the immutable reward bundle into
      // `world.lootBoxRewardBundles`/generated-equipment registry BEFORE the
      // unlock is recorded. Without that resolution step `claimReward` below
      // fails closed (`grantFailed`, no bundle) and the reward-opening overlay
      // never appears. Idempotent: a no-op if already unlocked.
      unlockAchievement(world, achievementId);
      // `refresh` unconditionally captures `world` as the panel's `lastWorld`
      // even while the panel is closed — the same assignment the real toggle
      // path performs — so claimReward can resolve/grant without requiring
      // the achievements panel to be visibly open first.
      achievementsUI.refresh(world);
      achievementsUI.claimReward(achievementId);
      scene.inventoryUI?.refresh(world);
      return (
        world.inventories
          .get(playerEid)
          ?.generatedEquipment?.map((entry) => entry.instanceKey)
          .filter((instanceKey) => !before.has(instanceKey)) ?? []
      );
    },

    seedPendingRewardResumeScenario: () => {
      const scene = getScene();
      const world = scene?.world;
      if (!world) {
        return;
      }
      world.achievements.pendingPresentations.set('first-bonk', {
        kind: 'lootBox',
        tier: 'trash',
        gold: 25,
        materials: ['floor1-common-scrap', 'floor1-common-scrap'],
      });
      world.bossChests.set('boss-chest:ratfolk', {
        chestId: 'boss-chest:ratfolk',
        familyId: 'ratfolk',
        state: 'revealed',
        createdAtMs: 0,
        revealedGrant: {
          kind: 'equipment',
          tier: 'tier1',
          instanceKeys: ['gei:v1:probe-boss-chest:0'],
        },
      });
      scene.achievementsUI?.refresh(world);
      scene.bossChestUI?.refresh(world);
    },

    seedAvailableBossChest: () => {
      const scene = getScene();
      const world = scene?.world;
      if (!world) {
        return;
      }
      const chestId = 'boss-chest:ratfolk';
      world.bossChests.delete(chestId);
      world.generatedEquipmentRewardBundles.delete(chestId);
      resolveEquipmentRewardBundle(world, chestId, BOSS_CHEST_REWARD_BASE_IDS, 'tier4');
      const created = createBossChestRecord(world, chestId, 'ratfolk');
      if (!created.ok) {
        throw new Error(`probe boss chest setup failed: missing bundle for ${chestId}`);
      }
      scene.bossChestUI?.refresh(world);
    },

    resumePendingRewardPresentations: () => {
      getScene()?.resumePendingRewardPresentations?.();
    },

    getRewardOpeningState: (): RewardOpeningProbeState => {
      const ui = getScene()?.rewardOpeningUI;
      const open = ui?.isOpen() ?? false;
      if (!ui || !open) {
        return { open: false, phase: null, bucket: null, revealed: 0, total: 0 };
      }
      const progress = ui.getRevealProgress();
      return {
        open: true,
        phase: ui.getPhase(),
        bucket: ui.getBucket(),
        revealed: progress?.revealed ?? 0,
        total: progress?.total ?? 0,
      };
    },

    tickRewardOpening: (deltaMs: number) => {
      getScene()?.rewardOpeningUI?.tick(deltaMs);
    },

    skipRewardOpening: () => {
      getScene()?.rewardOpeningUI?.skip();
    },

    acknowledgeRewardOpening: () => {
      getScene()?.rewardOpeningUI?.acknowledge();
    },

    getWorldElapsedMs: (): number | null => {
      const world = getScene()?.world;
      return world ? world.elapsedMs : null;
    },

    getPlayerGold: (): number | null => {
      const world = getScene()?.world;
      return world ? world.playerGold : null;
    },

    setPlayerGold: (amount: number): void => {
      const world = getScene()?.world;
      if (world) {
        world.playerGold = amount;
      }
    },

    getQuartermasterStockSnapshot: () => {
      const scene = getScene();
      return scene?.getSettlementShopOfferSnapshot?.() ?? [];
    },

    getSettlementShopInventorySnapshot: (npcEid: number) => {
      const world = getScene()?.world;
      const settlement = world?.floorExtendedState?.settlement;
      const shop = settlement?.shops.find((entry) => entry.npcEid === npcEid);
      return (
        shop?.inventory.map((entry) => ({
          itemId: entry.itemId,
          quantity: entry.stock,
          unitPrice: entry.unitPrice,
          displayName: displayNameForSettlementShopItem(entry.itemId),
        })) ?? []
      );
    },

    purchaseFirstQuartermasterOffer: () => {
      const scene = getScene();
      return scene?.purchaseFirstSettlementShopOffer?.() ?? { ok: false, reason: 'no-scene' };
    },
    getGeneratedInventoryCellBounds: (instanceKey: GeneratedEquipmentInstanceKey) => {
      const inventory = getScene()?.inventoryUI;
      if (!inventory?.isOpen()) return null;
      const index = inventory.getCellIndexForEntry({ kind: 'generated-instance', instanceKey });
      return index === null ? null : inventory.getCellScreenBounds(index);
    },
    getGeneratedEquipmentBagCellBounds: (instanceKey: GeneratedEquipmentInstanceKey) => {
      const equipment = getScene()?.equipmentUI;
      return equipment?.isOpen() ? equipment.getGeneratedBagCellScreenBounds(instanceKey) : null;
    },
    getEquippedGeneratedInstanceKeys: () => {
      const scene = getScene();
      const world = scene?.world;
      const playerEid = playerEidOf(scene);
      if (!world || playerEid < 0) return [];
      return Object.values(getEquipmentState(world, playerEid)?.equipped ?? {}).filter(
        (instanceId): instanceId is GeneratedEquipmentInstanceKey => typeof instanceId === 'string',
      );
    },

    getInventoryVisibleItemIds: (): readonly string[] => {
      return getScene()?.inventoryUI?.getVisibleItemIds?.() ?? [];
    },

    openFirstAvailableBossChest: () => {
      const scene = getScene();
      const world = scene?.world;
      if (!world) return { ok: false, reason: 'no-world' };
      const playerEid = playerEidOf(scene);
      if (playerEid < 0) return { ok: false, reason: 'no-player' };
      const chest = [...world.bossChests.values()]
        .filter((candidate) => candidate.state === 'available')
        .sort((left, right) => left.chestId.localeCompare(right.chestId))[0];
      if (!chest) return { ok: false, reason: 'no-available-chest' };
      const opened = openBossChest(world, chest.chestId, playerEid);
      if (!opened.ok) return { ok: false, reason: opened.reason };
      const acknowledged = acknowledgeBossChestReveal(world, chest.chestId);
      if (!acknowledged.ok) return { ok: false, reason: acknowledged.reason };
      scene.bossChestUI?.refresh(world);
      scene.inventoryUI?.refresh(world);
      return { ok: true };
    },

    spawnAndPickupFloorDrop: (itemId: string) => {
      const scene = getScene();
      const world = scene?.world;
      if (!scene || !world) return { ok: false, reason: 'no-world' };
      const playerEid = playerEidOf(scene);
      if (playerEid < 0) return { ok: false, reason: 'no-player' };
      const itemIndex = getItemIndex(itemId);
      if (itemIndex < 0) return { ok: false, reason: 'unknown-item' };
      const x = world.stores.position.x[playerEid] ?? 0;
      const y = world.stores.position.y[playerEid] ?? 0;
      const dropEid = spawnDroppedItem(world, x, y, itemIndex);
      itemPickupSystem(world, {
        pairs: [{ a: playerEid, b: dropEid }],
        grid: {
          clear() {},
          insert() {},
          queryPairs: () => [],
          queryRadius: () => [],
        },
      });
      scene.inventoryUI?.refresh(world);
      return { ok: true };
    },

    getRewardAudioCueLog: (): readonly RewardAudioCueLogEntryProbe[] => {
      return getScene()?.rewardAudioCueLog ?? [];
    },

    clearRewardAudioCueLog: (): void => {
      const scene = getScene();
      if (scene?.rewardAudioCueLog) {
        scene.rewardAudioCueLog.length = 0;
      }
    },
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
function displayNameForSettlementShopItem(itemId: string): string | null {
  return getItemById(itemId)?.name ?? getWeaponDef(itemId)?.name ?? null;
}
