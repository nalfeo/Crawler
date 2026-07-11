/**
 * Quest Waypoint Lab — visualises getQuestWaypoints + the off-screen direction
 * arrow. A real Phaser scene centres the camera on a player; lil-gui drives the
 * tracked objective's target distance/angle so the edge arrow rotates and hides
 * when the target enters the viewport. The minimap is inactive (no floor map).
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME, CAMERA } from '../../shared/constants.js';
import { createHudUI } from '../../engine/HudUI.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/index.js';
import { acceptQuest } from '../../core/systems/questSystem.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
} from '../../shared/quest-types.js';
import { ftToPx } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const SCENE_KEY = 'QuestWaypointLabScene';
const PLAYER_FT = { x: 80, y: 45 };

interface Settings {
  distanceFt: number;
  angleDeg: number;
}

export interface QuestWaypointProbeApi {
  visibleQuestIds(): string[];
}

declare global {
  interface Window {
    __questWaypointProbe?: QuestWaypointProbeApi;
  }
}

function makeFloorScenario(): NonNullable<GameWorld['floorScenario']> {
  const pos = { x: PLAYER_FT.x, y: PLAYER_FT.y };
  return {
    protagonistName: 'Waypoint Lab',
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
    bossRoomDoorEids: new Map(),
    objective: {
      requiredRats: 6,
      requiredSlimes: 4,
      requiredGold: 50,
      requiredJunk: 2,
      deadlineMs: 600_000,
      staircaseSpawnCountdownMs: 30_000,
      safeRoomPos: { ...pos },
      staircasePos: { ...pos },
      welcomeOfficePos: { ...pos },
      slimeRatRoomPos: { ...pos },
      spellQuestGiverPos: { ...pos },
      shopRoomPos: { ...pos },
      questItemPos: { ...pos },
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
      bossBattles: new Map(),
    },
    failReason: null,
    runSummary: null,
  };
}

function createQuestWaypointLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }
  const settings: Settings = { distanceFt: 60, angleDeg: 270 };

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);

  let game: Phaser.Game | undefined;
  let world: GameWorld | undefined;
  let playerEid = -1;
  let hudUi: ReturnType<typeof createHudUI> | undefined;

  function targetFeet(angleOffsetDeg = 0): { x: number; y: number } {
    const rad = ((settings.angleDeg + angleOffsetDeg) * Math.PI) / 180;
    return {
      x: PLAYER_FT.x + Math.cos(rad) * settings.distanceFt,
      y: PLAYER_FT.y + Math.sin(rad) * settings.distanceFt,
    };
  }

  class Scene extends Phaser.Scene {
    private marker?: Phaser.GameObjects.Arc;
    constructor() {
      super({ key: SCENE_KEY });
    }
    create(): void {
      world = createGameWorld({ seed: 7 });
      world.floor = 1;
      playerEid = spawnPlayer(world, PLAYER_FT.x, PLAYER_FT.y);
      world.floorScenario = makeFloorScenario();
      acceptQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);
      acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
      acceptQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);

      this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x05070f).setOrigin(0, 0);
      this.add
        .text(ftToPx(PLAYER_FT.x), ftToPx(PLAYER_FT.y), 'PLAYER', {
          fontFamily: 'monospace',
          color: '#9ca3af',
        })
        .setOrigin(0.5);
      this.marker = this.add.circle(0, 0, 6, 0xfcd34d).setDepth(5);
      this.cameras.main.setZoom(CAMERA.BASE_ZOOM);
      hudUi = createHudUI(this);
      window.__questWaypointProbe = {
        visibleQuestIds: () =>
          this.children.list
            .filter(
              (child): child is Phaser.GameObjects.Triangle =>
                child instanceof Phaser.GameObjects.Triangle &&
                child.visible &&
                child.name.startsWith('quest-direction-arrow:'),
            )
            .map((arrow) => arrow.name.slice('quest-direction-arrow:'.length)),
      };
      this.events.once('shutdown', () => hudUi?.destroy());
    }
    update(): void {
      if (!world || !hudUi) return;
      const floorScenario = world.floorScenario;
      if (!floorScenario) {
        throw new Error('Quest waypoint lab requires a floor scenario.');
      }
      const t = targetFeet();
      const pos = floorScenario.objective.welcomeOfficePos as { x: number; y: number };
      pos.x = t.x;
      pos.y = t.y;
      const shop = targetFeet(12);
      floorScenario.objective.shopRoomPos.x = shop.x;
      floorScenario.objective.shopRoomPos.y = shop.y;
      const combat = targetFeet(-12);
      floorScenario.objective.slimeRatRoomPos.x = combat.x;
      floorScenario.objective.slimeRatRoomPos.y = combat.y;
      this.marker?.setPosition(ftToPx(t.x), ftToPx(t.y));
      this.cameras.main.centerOn(ftToPx(PLAYER_FT.x), ftToPx(PLAYER_FT.y));
      hudUi.sync(world, playerEid);
    }
  }

  const createGame = (): void => {
    game?.destroy(true);
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: root,
      width: GAME.WIDTH,
      height: GAME.HEIGHT,
      backgroundColor: '#05070f',
      scene: [Scene],
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });
  };

  gui.add(settings, 'distanceFt', 5, 120, 1).name('Target distance (ft)');
  gui.add(settings, 'angleDeg', 0, 360, 5).name('Target angle (°)');
  gui.add({ restart: () => createGame() }, 'restart').name('Restart');
  createGame();

  return () => {
    delete window.__questWaypointProbe;
    hudUi?.destroy();
    game?.destroy(true);
    root.remove();
  };
}

registerLab('questwaypoints-lab', {
  category: 'Meta' as LabCategory,
  name: 'Quest Waypoint Lab',
  description: 'Three active quests with distinct off-screen arrows + waypoint resolver demo.',
  create: createQuestWaypointLab,
});
