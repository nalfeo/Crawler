/**
 * UX Snapshot Lab — one screen showing the polished pixel-UI HUD over a
 * representative Floor 1 room, plus in-world drops (XP crystals, coins, a
 * potion) so every UX surface can be eyeballed and iterated at once.
 *
 * Drives the REAL `HudUI` (health bar, XP bar, floor timer, quest tracker,
 * minimap) against a synthetic GameWorld, exactly like `hud-lab`, so the
 * actual Phaser render paths run. lil-gui sliders push the HUD through its
 * states (low HP, XP fill, amber/red timer, multiple active quests).
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME, FLOOR } from '../../shared/constants.js';
import { createHudUI } from '../../engine/HudUI.js';
import { createDialogueBox, type DialogueBox } from '../../engine/DialogueBox.js';
import { createModalPickerUI } from '../../engine/ModalPickerUI.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import { spawnPlayer, spawnEnemy, spawnNpc } from '../../core/index.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { TileMap } from '../../core/map/TileMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { BiomeType, RoomRole, TerrainType, TilePresets } from '../../shared/map-types.js';
import { acceptQuest } from '../../core/systems/questSystem.js';
import { FLOOR1_TUTORIAL_QUEST_ID, FLOOR1_BOSS_UNLOCK_QUEST_ID } from '../../shared/quest-types.js';
import { xpRequiredForLevel } from '../../shared/xpMath.js';
import { SeededRandom } from '../../shared/random.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface UxLabSettings {
  hpPercent: number;
  maxHp: number;
  xpPercent: number;
  playerLevel: number;
  timeRemainingS: number;
  activeQuests: number;
  showDialog: boolean;
}

const LAB_ID = 'ux-snapshot-lab';
const SCENE_KEY = 'UxSnapshotScene';

const TILE = 64;
const GW = Math.ceil(GAME.WIDTH / TILE); // 20
const GH = Math.ceil(GAME.HEIGHT / TILE); // 12
const DOOR_OPEN_COL = 9;
const DOOR_CLOSED_ROW = Math.floor(GH / 2);

/**
 * Builds a synthetic FloorMap mirroring the visible Floor-1 room so the docked
 * round radar shows real terrain (teal safe-room floor + wall ring + doors).
 * `tileSizePx` matches the lab's TILE so ECS entity pixel coords line up with
 * radar tile maths. Fully revealed (no FOV system runs in labs).
 */
function buildRadarFloorMap(): FloorMap {
  const cfg = {
    widthTiles: GW,
    heightTiles: GH,
    tileSizePx: TILE,
    biome: BiomeType.DUNGEON as BiomeType,
    seed: 7,
    roomWidthRange: [4, 18] as [number, number],
    roomHeightRange: [4, 10] as [number, number],
    maxRooms: 1,
    floorDensity: 1,
  };

  const tileMap = new TileMap(GW, GH);
  const terrain = new Uint8Array(GW * GH);
  for (let r = 0; r < GH; r += 1) {
    for (let c = 0; c < GW; c += 1) {
      const idx = r * GW + c;
      const isBorder = c === 0 || r === 0 || c === GW - 1 || r === GH - 1;
      if (isBorder) {
        tileMap.flags[idx] = TilePresets.WALL;
        terrain[idx] = TerrainType.STONE_WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
        terrain[idx] = TerrainType.SAFE_ROOM_FLOOR;
      }
    }
  }
  // Carve the two doorways shown in the scene.
  terrain[0 * GW + DOOR_OPEN_COL] = TerrainType.DOOR;
  tileMap.flags[0 * GW + DOOR_OPEN_COL] = TilePresets.FLOOR;
  terrain[DOOR_CLOSED_ROW * GW + (GW - 1)] = TerrainType.DOOR;

  const graph = new RoomGraph();
  graph.add({ x: 1, y: 1, width: GW - 2, height: GH - 2 }, [], [], RoomRole.SAFE);

  const map = new FloorMap(cfg, tileMap, graph, terrain, {
    x: Math.floor(GW / 2),
    y: Math.floor(GH / 2),
  });
  map.visible.fill(1);
  return map;
}

/** Draw a faceted cyan crystal texture (scaled-up cousin of the in-world gem). */
function ensureCrystalTexture(scene: Phaser.Scene, key: string, s: number): void {
  if (scene.textures.exists(key)) {
    return;
  }
  const g = scene.add.graphics();
  const m = (n: number): number => n * s;
  g.fillStyle(0x0b3038, 1);
  g.fillTriangle(m(7), m(0), m(0), m(7), m(7), m(14));
  g.fillTriangle(m(7), m(0), m(14), m(7), m(7), m(14));
  g.fillStyle(0x1f9fb8, 1);
  g.fillTriangle(m(7), m(2), m(2), m(7), m(7), m(12));
  g.fillTriangle(m(7), m(2), m(12), m(7), m(7), m(12));
  g.fillStyle(0x4fd6e8, 1);
  g.fillTriangle(m(7), m(2), m(2), m(7), m(7), m(7));
  g.fillStyle(0x9af0ff, 1);
  g.fillRect(m(5), m(3), m(2), m(2));
  g.generateTexture(key, 14 * s, 14 * s);
  g.destroy();
}

/** Small round coin texture with a highlight. */
function ensureCoinTexture(scene: Phaser.Scene, key: string): void {
  if (scene.textures.exists(key)) {
    return;
  }
  const g = scene.add.graphics();
  g.fillStyle(0x7a5a12, 1);
  g.fillCircle(16, 16, 15);
  g.fillStyle(0xf2c23a, 1);
  g.fillCircle(16, 16, 12);
  g.fillStyle(0xfff0a8, 1);
  g.fillCircle(12, 12, 4);
  g.fillStyle(0xb8861d, 1);
  g.fillRect(13, 9, 6, 14);
  g.generateTexture(key, 32, 32);
  g.destroy();
}

/** Small potion bottle texture. */
function ensurePotionTexture(scene: Phaser.Scene, key: string): void {
  if (scene.textures.exists(key)) {
    return;
  }
  const g = scene.add.graphics();
  g.fillStyle(0x2a1a3a, 1);
  g.fillRoundedRect(7, 12, 18, 18, 6);
  g.fillStyle(0xe23b6e, 1);
  g.fillRoundedRect(9, 16, 14, 12, 4);
  g.fillStyle(0xff9ac0, 1);
  g.fillRect(11, 18, 3, 8);
  g.fillStyle(0x6b4a2a, 1);
  g.fillRect(12, 6, 8, 7);
  g.fillStyle(0x9a6f3f, 1);
  g.fillRect(11, 4, 10, 3);
  g.generateTexture(key, 32, 32);
  g.destroy();
}

function createUxLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: UxLabSettings = {
    hpPercent: 45,
    maxHp: 100,
    xpPercent: 60,
    playerLevel: 3,
    timeRemainingS: 50,
    activeQuests: 2,
    showDialog: true,
  };

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);

  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';
  root.append(gameHost);

  const hint = document.createElement('p');
  hint.textContent =
    'UX Snapshot: the real pixel-UI HUD (health, XP, floor timer, gold/junk loot counter, quest tracker, minimap) plus the NPC dialogue box and choice modal, over a Floor 1 room with in-world drops. Drag the sliders to push every element through its states; toggle the dialogue and open the choice modal from the controls.';
  hint.style.cssText = 'margin-top:16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  let game: Phaser.Game | undefined;
  let world: GameWorld | undefined;
  let playerEid = -1;
  let hudUi: ReturnType<typeof createHudUI> | undefined;
  let dialogueBox: DialogueBox | undefined;
  let modalPicker: ReturnType<typeof createModalPickerUI> | undefined;

  const openSampleModal = (): void => {
    modalPicker?.open(
      {
        title: 'Choose Your Starter',
        subtitle: 'The Producer is watching. Pick a weapon to begin Floor 1.',
        options: [
          {
            id: 'cleaver',
            label: 'Rusty Cleaver',
            description: 'Heavy melee swing. High damage, short reach.',
          },
          {
            id: 'sparkwand',
            label: 'Spark Wand',
            description: 'Ranged bolts that chain to a nearby foe.',
          },
          {
            id: 'caltrops',
            label: 'Caltrops',
            description: 'Drop a trail of spikes. Locked until Floor 2.',
            disabled: true,
          },
        ],
        allowCancel: true,
      },
      { onConfirm: () => modalPicker?.close() },
    );
  };

  function syncQuests(w: GameWorld): void {
    w.questLog.clear();
    if (settings.activeQuests >= 1) {
      acceptQuest(w, FLOOR1_TUTORIAL_QUEST_ID);
    }
    if (settings.activeQuests >= 2) {
      acceptQuest(w, FLOOR1_BOSS_UNLOCK_QUEST_ID);
    }
  }

  class UxSnapshotScene extends Phaser.Scene {
    constructor() {
      super({ key: SCENE_KEY });
    }

    preload(): void {
      for (let i = 0; i < 2; i++) {
        this.load.image(`ux_floor_${i}`, `assets/generated/temp_floor_${i}.png`);
      }
      this.load.image('ux_wall', 'assets/generated/temp_wall.png');
      this.load.image('ux_door_open', 'assets/generated/temp_door_open.png');
      this.load.image('ux_door_closed', 'assets/generated/temp_door_closed.png');
      this.load.image('ux_hero', 'assets/generated/temp_hero.png');
      this.load.image('ux_npc', 'assets/generated/temp_npc.png');
      this.load.image('ux_slime', 'assets/generated/temp_slime.png');
      this.load.image('ux_rat', 'assets/generated/temp_rat.png');
    }

    private tile(col: number, row: number, key: string, depth: number): void {
      const img = this.add.image(col * TILE, row * TILE, key);
      img.setOrigin(0, 0);
      img.setDepth(depth);
    }

    private entity(col: number, row: number, key: string): void {
      const img = this.add.image(col * TILE + TILE / 2, row * TILE + TILE / 2, key);
      img.setOrigin(0.5, 0.9);
      img.setDepth(100 + img.y);
    }

    /** Bobbing in-world drop with a soft ground shadow. */
    private drop(x: number, y: number, key: string): void {
      const shadow = this.add.ellipse(x, y + 18, 26, 9, 0x000000, 0.32);
      shadow.setDepth(100 + y - 1);
      const img = this.add.image(x, y, key);
      img.setDepth(100 + y);
      this.tweens.add({
        targets: img,
        y: y - 7,
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    create(): void {
      const rng = new SeededRandom(0x5eed);
      this.cameras.main.setBackgroundColor('#0e0b14');

      const isWall = (c: number, r: number): boolean =>
        c === 0 || r === 0 || c === GW - 1 || r === GH - 1;
      const floorKey = (): string => `ux_floor_${rng.nextInt(0, 3) === 0 ? 1 : 0}`;

      // Floor everywhere (including a passage tile beyond the open door).
      this.tile(DOOR_OPEN_COL, -1, floorKey(), 0);
      for (let r = 0; r < GH; r++) {
        for (let c = 0; c < GW; c++) {
          this.tile(c, r, floorKey(), 0);
        }
      }

      // Wall ring with a single open doorway at the top.
      for (let r = 0; r < GH; r++) {
        for (let c = 0; c < GW; c++) {
          if (!isWall(c, r)) {
            continue;
          }
          if (r === 0 && c === DOOR_OPEN_COL) {
            continue;
          }
          this.tile(c, r, 'ux_wall', 1);
        }
      }
      this.tile(DOOR_OPEN_COL, 0, 'ux_door_open', 2);
      this.tile(GW - 1, Math.floor(GH / 2), 'ux_door_closed', 2);

      // Inner drop-shadow so the wall ring reads as taller than the floor.
      const inX = TILE;
      const inY = TILE;
      const inW = (GW - 2) * TILE;
      const inH = (GH - 2) * TILE;
      const shadow = (x: number, y: number, w: number, h: number, a: number): void => {
        const s = this.add.rectangle(x, y, w, h, 0x000000, a);
        s.setOrigin(0, 0);
        s.setDepth(3);
        s.setBlendMode(Phaser.BlendModes.MULTIPLY);
      };
      for (let layer = 0; layer < 3; layer++) {
        const t = (3 - layer) * 5;
        const a = 0.18 - layer * 0.05;
        shadow(inX, inY + layer * 5, inW, t, a);
        shadow(inX, inY + inH - (layer + 1) * 5, inW, t, a);
        shadow(inX + layer * 5, inY, t, inH, a);
        shadow(inX + inW - (layer + 1) * 5, inY, t, inH, a);
      }

      // Representative actors.
      this.entity(4, 3, 'ux_npc');
      this.entity(10, 5, 'ux_hero');
      this.entity(5, 8, 'ux_slime');
      this.entity(14, 7, 'ux_rat');

      // In-world drops: XP crystals, coins, a potion.
      ensureCrystalTexture(this, 'ux_crystal', 3);
      ensureCoinTexture(this, 'ux_coin');
      ensurePotionTexture(this, 'ux_potion');
      this.drop(8 * TILE, 5 * TILE, 'ux_crystal');
      this.drop(9 * TILE + 20, 6 * TILE, 'ux_crystal');
      this.drop(12 * TILE, 4 * TILE, 'ux_coin');
      this.drop(11 * TILE + 30, 8 * TILE, 'ux_coin');
      this.drop(7 * TILE, 9 * TILE, 'ux_potion');

      // -------- Synthetic world driving the real HUD --------
      world = createGameWorld({ seed: 7 });
      world.floor = 1;
      // Revealed safe-room floorMap so the docked round radar shows real
      // terrain + room; tileSizePx == TILE keeps ECS coords aligned.
      world.floorMap = buildRadarFloorMap();
      world.state = 'playing';
      playerEid = spawnPlayer(world, GAME.WIDTH / 2, GAME.HEIGHT / 2);

      // ECS mobs + NPC co-located with the visible actors so radar blips match
      // the on-screen sprites (red = enemy, green = NPC, white = player).
      spawnNpc(world, 4 * TILE + TILE / 2, 3 * TILE + TILE / 2, 'shopkeeper');
      spawnEnemy(world, 5 * TILE + TILE / 2, 8 * TILE + TILE / 2, 30);
      spawnEnemy(world, 14 * TILE + TILE / 2, 7 * TILE + TILE / 2, 12);

      // XP unlocked so the experience bar is visible.
      world.goalFlags.set('floor1-xp-unlocked', true);

      world.floor1 = {
        protagonistName: 'UX Lab Player',
        starterWeaponPool: [],
        starterChoices: [],
        selectedWeaponId: null,
        selectedChoiceIndex: null,
        baseStatBonuses: { maxHp: 0, moveSpeed: 0, pickupRange: 0 },
        enemyArchetypes: new Map(),
        guideNpcEid: null,
        shopkeeperNpcEid: null,
        questItemEid: null,
        bossDoorEids: [],
        objective: {
          requiredRats: 5,
          requiredSlimes: 3,
          requiredGold: 50,
          requiredJunk: 2,
          deadlineMs: settings.timeRemainingS * 1000,
          staircaseSpawnCountdownMs: 30_000,
          safeRoomPos: { x: 300, y: 300 },
          staircasePos: { x: 600, y: 400 },
          welcomeOfficePos: { x: 100, y: 100 },
          shopRoomPos: { x: 500, y: 300 },
          questItemPos: { x: 700, y: 500 },
          markerRadiusPx: 32,
          questAccepted: true,
          questCompleted: false,
          ratsKilled: 2,
          slimesKilled: 1,
          goldCollected: 20,
          junkCollected: 1,
          safeRoomDiscovered: false,
          staircaseSpawnStartedMs: null,
          staircaseSpawnRemainingMs: null,
          staircaseSpawned: false,
          staircaseLocked: false,
          staircaseUnlocked: false,
          staircaseDiscovered: false,
          bossBattleStarted: false,
          staircaseBossEid: null,
          staircaseBossDefeated: false,
        },
        failReason: null,
        runSummary: null,
      };

      syncQuests(world);

      // Carry some loot so the gold/junk HUD counter reads non-zero.
      world.playerGold = 137;

      hudUi = createHudUI(this);

      modalPicker = createModalPickerUI(this);
      dialogueBox = createDialogueBox(this, {
        onClose: () => {
          settings.showDialog = false;
          dialogueBox?.hide();
        },
      });
      dialogueBox.showLine(
        'The Guide',
        '"Welcome to Floor 1, contestant. Clear the rats, grab the loot, and try not to die on camera."',
      );
      dialogueBox.setCloseVisible(true);
      dialogueBox.setVisible(settings.showDialog);

      this.events.once('shutdown', () => {
        hudUi?.destroy();
        hudUi = undefined;
        dialogueBox?.destroy();
        dialogueBox = undefined;
        modalPicker?.destroy();
        modalPicker = undefined;
      });
    }

    update(): void {
      if (!world || !hudUi) {
        return;
      }

      // Health.
      world.stores.health.max[playerEid] = settings.maxHp;
      world.stores.health.current[playerEid] = (settings.hpPercent / 100) * settings.maxHp;

      // XP — set total xp so the bar fills to xpPercent of the current level.
      const lvl = Math.max(0, Math.floor(settings.playerLevel));
      world.playerLevel.level = lvl;
      const base = xpRequiredForLevel(lvl);
      const span = Math.max(1, xpRequiredForLevel(lvl + 1) - base);
      world.playerLevel.xp = base + Math.round((settings.xpPercent / 100) * span);

      // Floor timer — hold elapsed at 0 so the slider directly sets remaining.
      world.elapsedMs = 0;
      if (world.floor1) {
        world.floor1.objective.deadlineMs = settings.timeRemainingS * 1000;
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
      backgroundColor: '#0e0b14',
      pixelArt: true,
      scene: [UxSnapshotScene],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
  };

  gui.add(settings, 'hpPercent', 0, 100, 1).name('HP %');
  gui.add(settings, 'maxHp', 10, 500, 10).name('Max HP');
  gui.add(settings, 'xpPercent', 0, 100, 1).name('XP %');
  gui.add(settings, 'playerLevel', 0, 20, 1).name('Level');
  gui.add(settings, 'timeRemainingS', 0, FLOOR.MAX_DURATION_S, 5).name('Time left (s)');
  gui
    .add(settings, 'activeQuests', 0, 2, 1)
    .name('Active quests')
    .onChange(() => {
      if (world) {
        syncQuests(world);
      }
    });
  gui
    .add(settings, 'showDialog')
    .name('Show dialogue')
    .onChange((v: boolean) => {
      dialogueBox?.setVisible(v);
    });
  gui.add({ openModal: () => openSampleModal() }, 'openModal').name('Open choice modal');
  gui.add({ restart: () => createGame() }, 'restart').name('Restart scene');

  createGame();

  return () => {
    hudUi?.destroy();
    dialogueBox?.destroy();
    modalPicker?.destroy();
    game?.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta' as LabCategory,
  name: 'UX Snapshot',
  description:
    'All HUD/UX surfaces at once — health bar, XP bar, floor timer, gold/junk loot counter, quest tracker, minimap, NPC dialogue box, and choice modal — over a Floor 1 room with in-world drops.',
  create: createUxLab,
});
