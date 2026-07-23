/**
 * HUD Lab — Phaser-based sandbox for HudHealthBar, HudFloorTimer, HudBossBar,
 * HudAbilityBar, and HudMinimap.
 *
 * Spins up a real Phaser.Game instance with a synthetic GameWorld so the actual
 * Phaser code paths (RenderTexture bake, Rectangle fill, tween lifecycle) run.
 * lil-gui sliders mutate the world state and call hudUi.sync() each scene update.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME, FLOOR } from '../../shared/constants.js';
import {
  FLOOR1_BOSS_REWARD_SPELL_IDS,
  createEmptyAbilityState,
  type AbilityState,
} from '../../shared/abilities.js';
import { createHudUI } from '../../engine/HudUI.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnEnemy, spawnPlayer } from '../../core/index.js';
import { setActiveWeaponDef } from '../../core/active-weapon.js';
import { pxToFt } from '../../shared/units.js';
import { WEAPON_DEFS } from '../../shared/weaponDefs.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface HudLabSettings {
  hpPercent: number;
  maxHp: number;
  timeRemainingS: number;
  floor: number;
  minimapExpanded: boolean;
  bossFightActive: boolean;
  bossHpPercent: number;
  spellsUnlocked: boolean;
}

export interface HudProbeApi {
  ready(): boolean;
  setBossFightActive(active: boolean): void;
  setLootSkillStressState(): void;
  getLootSkillLayout(): HudLootSkillLayout;
  getGameSize(): { width: number; height: number };
}

export interface HudProbeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

export interface HudLootSkillLayout {
  viewport: HudProbeBounds;
  regions: Record<string, HudProbeBounds>;
  adjacentRegions: HudProbeBounds[];
  otherHudGroups: HudProbeBounds[];
}

const LAB_ID = 'hud-lab';

const SCENE_KEY = 'HudLabScene';

/** Boss max HP used by the lab so the boss bar can be exercised. */
const LAB_BOSS_MAX_HP = 500;

/**
 * Equip a few active abilities so the bottom-center ability bar renders. The
 * lab mirrors the Floor 1 boss reward spells; HudAbilityBar stays hidden until
 * `featureUnlocks.spells` is set, so the lab unlocks that flag alongside this.
 */
function makeLabAbilityState(): AbilityState {
  const equipped = [...FLOOR1_BOSS_REWARD_SPELL_IDS];
  const base = createEmptyAbilityState();
  return {
    ...base,
    learnedSpellIds: [...equipped],
    equippedActiveAbilityIds: [...equipped],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
    cooldownFramesByAbilityId: new Map(),
    appliedPassiveAbilityIds: new Set(),
  };
}

function createHudLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: HudLabSettings = {
    hpPercent: 80,
    maxHp: 100,
    timeRemainingS: 180,
    floor: 1,
    minimapExpanded: false,
    bossFightActive: false,
    bossHpPercent: 100,
    spellsUnlocked: true,
  };

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);

  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';
  root.append(gameHost);

  const hint = document.createElement('p');
  hint.textContent =
    'HUD lab: exercises the real Phaser HUD components in an isolated scene. Use lil-gui to drive state changes.';
  hint.style.cssText = 'margin-top:16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  let game: Phaser.Game | undefined;
  let world: GameWorld | undefined;
  let playerEid = -1;
  let bossEid = -1;
  let hudUi: ReturnType<typeof createHudUI> | undefined;
  let elapsedTracker = 0;
  let sceneBuilt = false;
  const probeWindow = window as unknown as { __hudProbe?: HudProbeApi };

  class HudLabScene extends Phaser.Scene {
    constructor() {
      super({ key: SCENE_KEY });
    }

    create(): void {
      sceneBuilt = false;
      world = createGameWorld({ seed: 1 });
      world.floor = settings.floor;

      // Spawn a player entity so health reads are valid
      playerEid = spawnPlayer(world, pxToFt(GAME.WIDTH) / 2, pxToFt(GAME.HEIGHT) / 2);
      // Override default health to match lab settings
      world.stores.health.current[playerEid] = (settings.hpPercent / 100) * settings.maxHp;
      world.stores.health.max[playerEid] = settings.maxHp;

      // Unlock spells and equip active abilities so the bottom-center ability
      // bar renders (HudAbilityBar stays hidden until featureUnlocks.spells).
      world.featureUnlocks.spells = settings.spellsUnlocked;
      world.abilityStatesByEntity.set(playerEid, makeLabAbilityState());

      // Fake a floor1 objective for timer display
      const deadlineMs = settings.timeRemainingS * 1000;
      world.floorScenario = {
        protagonistName: 'HUD Lab Player',
        starterWeaponPool: [],
        starterChoices: [],
        selectedWeaponId: null,
        selectedChoiceIndex: null,
        baseStatBonuses: { maxHp: 0, moveSpeed: 0, pickupRange: 0 },
        enemyArchetypes: new Map(),
        guideNpcEid: null,
        spellQuestGiverNpcEid: null,
        shopkeeperNpcEid: null,
        questItemEid: null,
        bossRoomDoorEids: new Map([
          ['slime-rat', []],
          ['staircase', []],
        ]),
        objective: {
          requiredRats: 5,
          requiredSlimes: 3,
          requiredGold: 50,
          requiredJunk: 2,
          deadlineMs,
          staircaseSpawnCountdownMs: 30_000,
          safeRoomPos: { x: 300, y: 300 },
          staircasePos: { x: 600, y: 400 },
          welcomeOfficePos: { x: 100, y: 100 },
          slimeRatRoomPos: { x: 760, y: 440 },
          spellQuestGiverPos: { x: 700, y: 500 },
          shopRoomPos: { x: 500, y: 300 },
          questItemPos: { x: 700, y: 500 },
          markerRadiusFt: 4,
          questAccepted: false,
          questCompleted: false,
          ratsKilled: 0,
          slimesKilled: 0,
          goldCollected: 0,
          junkCollected: 0,
          safeRoomDiscovered: false,
          staircaseSpawnStartedMs: null,
          staircaseSpawnRemainingMs: null,
          staircaseSpawned: false,
          staircaseLocked: false,
          staircaseUnlocked: false,
          staircaseDiscovered: false,
          bossBattles: new Map([
            [
              'slime-rat',
              { started: false, bossEid: null, defeated: false, displayName: 'Slime Rat' },
            ],
            [
              'staircase',
              { started: false, bossEid: null, defeated: false, displayName: 'Rat Slime' },
            ],
          ]),
        },
        failReason: null,
        runSummary: null,
      };

      elapsedTracker = 0;

      // Spawn a boss entity and wire it into the first boss battle so the boss
      // bar can be toggled on/off and driven via lil-gui.
      bossEid = spawnEnemy(
        world,
        pxToFt(GAME.WIDTH) / 2,
        pxToFt(GAME.HEIGHT) / 2 - 11.25,
        LAB_BOSS_MAX_HP,
      );
      const slimeRatBattle = world.floorScenario.objective.bossBattles.get('slime-rat');
      if (slimeRatBattle) {
        slimeRatBattle.bossEid = bossEid;
      }

      // Dark background
      this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x05070f).setOrigin(0, 0);

      // Centre info text
      this.add
        .text(GAME.WIDTH / 2, GAME.HEIGHT / 2, 'HUD Lab\n(no floor map — minimap inactive)', {
          fontFamily: 'monospace',
          fontSize: '18px',
          color: '#4b5563',
          align: 'center',
        })
        .setOrigin(0.5, 0.5);

      hudUi = createHudUI(this);
      if (settings.minimapExpanded) {
        hudUi.sync(world!, playerEid);
      }
      const readBounds = (object: Phaser.GameObjects.GameObject): HudProbeBounds | null => {
        if (!('getBounds' in object) || typeof object.getBounds !== 'function') return null;
        const bounds = object.getBounds();
        const text = object instanceof Phaser.GameObjects.Text ? object.text : undefined;
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, text };
      };
      const findNamedObject = (
        objects: readonly Phaser.GameObjects.GameObject[],
        name: string,
      ): Phaser.GameObjects.GameObject | null => {
        for (const object of objects) {
          if (object.name === name) return object;
          if (object instanceof Phaser.GameObjects.Container) {
            const nested = findNamedObject(object.list, name);
            if (nested) return nested;
          }
        }
        return null;
      };
      const collectLeaves = (
        objects: readonly Phaser.GameObjects.GameObject[],
      ): Phaser.GameObjects.GameObject[] =>
        objects.flatMap((object) =>
          object instanceof Phaser.GameObjects.Container ? collectLeaves(object.list) : [object],
        );
      const contains = (outer: HudProbeBounds, inner: HudProbeBounds): boolean =>
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height;
      const getLootSkillLayout = (): HudLootSkillLayout => {
        const regionNames = [
          'hud-loot-panel-bounds',
          'hud-loot-gold-value-bounds',
          'hud-loot-gold-text',
          'hud-loot-junk-value-bounds',
          'hud-loot-junk-text',
          'hud-skill-panel-bounds',
          'hud-skill-title-strip',
          'hud-skill-title-text',
          'hud-skill-class-name-text',
          'hud-skill-class-level',
          'hud-skill-class-bar-bg',
          'hud-skill-type-name-text',
          'hud-skill-type-level',
          'hud-skill-type-bar-bg',
        ] as const;
        const regions: Record<string, HudProbeBounds> = {};
        for (const name of regionNames) {
          const object = findNamedObject(this.children.list, name);
          const bounds = object ? readBounds(object) : null;
          if (!bounds) throw new Error(`HUD probe region not found: ${name}`);
          regions[name] = bounds;
        }

        const lootPanel = regions['hud-loot-panel-bounds']!;
        const skillPanel = regions['hud-skill-panel-bounds']!;
        const target = findNamedObject(this.children.list, 'hud-loot-panel-bounds');
        const bottomLeft = target?.parentContainer;
        if (!bottomLeft) throw new Error('HUD bottom-left group not found');

        const adjacentRegions = collectLeaves(bottomLeft.list)
          .filter(
            (object) =>
              !object.name.startsWith('hud-loot-') && !object.name.startsWith('hud-skill-'),
          )
          .map(readBounds)
          .filter((bounds): bounds is HudProbeBounds => bounds !== null)
          .filter((bounds) => !contains(lootPanel, bounds) && !contains(skillPanel, bounds));
        const otherHudGroups = this.children.list
          .filter(
            (object): object is Phaser.GameObjects.Container =>
              object instanceof Phaser.GameObjects.Container &&
              object !== bottomLeft &&
              object.visible,
          )
          .map(readBounds)
          .filter(
            (bounds): bounds is HudProbeBounds =>
              bounds !== null && bounds.width > 0 && bounds.height > 0,
          );

        return {
          viewport: { x: 0, y: 0, width: this.scale.width, height: this.scale.height },
          regions,
          adjacentRegions,
          otherHudGroups,
        };
      };
      const probeApi: HudProbeApi = {
        ready: () => sceneBuilt,
        setBossFightActive: (active: boolean) => {
          settings.bossFightActive = active;
        },
        setLootSkillStressState: () => {
          if (!world?.floorScenario) throw new Error('HUD lab world not ready');
          const stressWeapon = WEAPON_DEFS.get('baseball-bat');
          if (!stressWeapon) throw new Error('HUD stress weapon not found');
          world.playerGold = 9_949_999;
          world.floorScenario.objective.junkCollected = 99_499_999;
          setActiveWeaponDef(world, stressWeapon);
          hudUi?.sync(world, playerEid);
        },
        getLootSkillLayout,
        getGameSize: () => ({ width: this.scale.width, height: this.scale.height }),
      };
      probeWindow.__hudProbe = probeApi;
      sceneBuilt = true;

      this.events.once('shutdown', () => {
        sceneBuilt = false;
        if (probeWindow.__hudProbe) {
          delete probeWindow.__hudProbe;
        }
        hudUi?.destroy();
        hudUi = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!world || !hudUi) return;

      // Advance elapsed time in the direction of time-remaining
      elapsedTracker += delta;
      const maxMs = settings.timeRemainingS * 1000;
      world.elapsedMs = elapsedTracker % Math.max(maxMs, 1);
      world.floor = settings.floor;

      if (world.floorScenario) {
        world.floorScenario.objective = {
          ...world.floorScenario.objective,
          deadlineMs: maxMs,
        };
      }

      const current = (settings.hpPercent / 100) * settings.maxHp;
      world.stores.health.current[playerEid] = current;
      world.stores.health.max[playerEid] = settings.maxHp;

      // Keep the spells unlock in sync so toggling the control live shows/hides
      // the ability bar; ensure the ability state survives scene restarts.
      world.featureUnlocks.spells = settings.spellsUnlocked;
      if (!world.abilityStatesByEntity.has(playerEid)) {
        world.abilityStatesByEntity.set(playerEid, makeLabAbilityState());
      }

      // Drive the boss encounter so the boss bar shows beneath the floor timer.
      const bossBattle = world.floorScenario?.objective.bossBattles.get('slime-rat');
      if (bossBattle && bossEid >= 0) {
        bossBattle.started = settings.bossFightActive;
        world.stores.health.max[bossEid] = LAB_BOSS_MAX_HP;
        world.stores.health.current[bossEid] = (settings.bossHpPercent / 100) * LAB_BOSS_MAX_HP;
      }

      hudUi.sync(world, playerEid);
    }
  }

  const createGame = (): void => {
    game?.destroy(true);
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: gameHost,
      width: GAME.WIDTH,
      height: GAME.HEIGHT,
      backgroundColor: '#05070f',
      scene: [HudLabScene],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
  };

  gui
    .add(settings, 'hpPercent', 0, 100, 1)
    .name('HP %')
    .onChange(() => {});
  gui
    .add(settings, 'maxHp', 10, 500, 10)
    .name('Max HP')
    .onChange(() => {});
  gui
    .add(settings, 'timeRemainingS', 0, FLOOR.MAX_DURATION_S, 5)
    .name('Time remaining (s)')
    .onChange(() => {});
  gui
    .add(settings, 'floor', 1, 10, 1)
    .name('Floor')
    .onChange(() => {});
  gui.add(settings, 'bossFightActive').name('Boss fight active');
  gui.add(settings, 'bossHpPercent', 0, 100, 1).name('Boss HP %');
  gui.add(settings, 'spellsUnlocked').name('Spells unlocked (ability bar)');
  gui.add({ restart: () => createGame() }, 'restart').name('Restart scene');

  createGame();

  return () => {
    hudUi?.destroy();
    game?.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta' as LabCategory,
  name: 'HUD Lab',
  description:
    'Interactive Phaser sandbox for health bar, floor timer, boss bar, ability bar, and minimap.',
  create: createHudLab,
});
