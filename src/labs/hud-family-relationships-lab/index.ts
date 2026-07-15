/**
 * HUD Family-Relationships Lab — Phaser sandbox for `HudFamilyRelationships`.
 *
 * Spins up a synthetic Floor-2 world (present families, seeded roster, boss
 * flags in `world.goalFlags`) and exposes a slider per family for its
 * relation value plus a boss-defeated toggle. Also renders a small preview
 * legend showing the minimap tint palette.
 *
 * Rule #10 note: the lab is *not* sufficient validation — the widget is also
 * wired into `HudUI` and mounts in `MainGameScene` on Floor 2.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import { createHudUI } from '../../engine/HudUI.js';
import {
  asFamilyId,
  createGameWorld,
  initializeFactionRelations,
  spawnPlayer,
  type FamilyId,
  type GameWorld,
} from '../../core/index.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { loadFamilies, type FamilyDef } from '../../shared/data/families.js';
import { bossDefeatedGoalFlag } from '../../engine/family-relationships-state.js';
import {
  SETTLEMENT_TINT,
  RESOURCE_HEART_TINT,
  BOSS_DEN_OUTLINE,
} from '../../engine/minimap-family-tint.js';
import { BiomeType, RoomRole, TerrainType, TilePresets } from '../../shared/map-types.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'hud-family-relationships-lab';
const SCENE_KEY = 'HudFamilyRelationshipsLabScene';

const PRESENT_COUNT = 4;
const LAB_MAP_WIDTH = 24;
const LAB_MAP_HEIGHT = 16;
const LAB_TILE_SIZE_FT = 4;
const LAB_PLAYER_TILE = { x: 12, y: 8 };

export interface FamilyRelProbeApi {
  ready(): boolean;
  setRelation(familyIndex: number, value: number): void;
  setBossDefeated(familyIndex: number, defeated: boolean): void;
}

interface FamilySettings {
  relation: number;
  bossDefeated: boolean;
}

function hexHash(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

function buildFloor2LabMap(families: readonly FamilyDef[]): FloorMap {
  const tileMap = new TileMap(LAB_MAP_WIDTH, LAB_MAP_HEIGHT);
  const terrain = new Uint8Array(LAB_MAP_WIDTH * LAB_MAP_HEIGHT);
  tileMap.fill(TilePresets.FLOOR);
  terrain.fill(TerrainType.CAVE_FLOOR);

  for (let y = 0; y < LAB_MAP_HEIGHT; y += 1) {
    for (let x = 0; x < LAB_MAP_WIDTH; x += 1) {
      if (x === 0 || y === 0 || x === LAB_MAP_WIDTH - 1 || y === LAB_MAP_HEIGHT - 1) {
        tileMap.setFlags(x, y, TilePresets.WALL);
        terrain[y * LAB_MAP_WIDTH + x] = TerrainType.CAVE_WALL;
      }
    }
  }

  const roomGraph = new RoomGraph();
  roomGraph.add(
    { x: 0, y: 0, width: 12, height: 8 },
    [],
    [],
    RoomRole.TERRITORY,
    'West Territory',
    0,
  );
  roomGraph.add(
    { x: 12, y: 0, width: 12, height: 8 },
    [],
    [],
    RoomRole.TERRITORY,
    'North Territory',
    1,
  );
  roomGraph.add(
    { x: 0, y: 8, width: 12, height: 8 },
    [],
    [],
    RoomRole.TERRITORY,
    'South Territory',
    2,
  );
  roomGraph.add(
    { x: 12, y: 8, width: 12, height: 8 },
    [],
    [],
    RoomRole.TERRITORY,
    'East Territory',
    3,
  );

  const floorMap = new FloorMap(
    {
      widthTiles: LAB_MAP_WIDTH,
      heightTiles: LAB_MAP_HEIGHT,
      tileSizeFt: LAB_TILE_SIZE_FT,
      biome: BiomeType.CAVE_SYSTEM,
      seed: 424242,
      roomWidthRange: [6, 12],
      roomHeightRange: [4, 8],
      maxRooms: 4,
      floorDensity: 0.5,
      caveSystem: { presentCount: Math.min(PRESENT_COUNT, families.length) },
    },
    tileMap,
    roomGraph,
    terrain,
    {
      x: LAB_PLAYER_TILE.x,
      y: LAB_PLAYER_TILE.y,
    },
    undefined,
    [
      { familyIndex: 0, centerX: 10, centerY: 8, radius: 6 },
      { familyIndex: 1, centerX: 14, centerY: 8, radius: 6 },
      { familyIndex: 2, centerX: 6, centerY: 12, radius: 4 },
      { familyIndex: 3, centerX: 18, centerY: 12, radius: 4 },
    ],
  );
  floorMap.revealAll();
  return floorMap;
}

function createHudFamilyRelationshipsLab(
  canvasHost: HTMLElement,
  controls: HTMLElement,
): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const families = loadFamilies();
  const present: FamilyDef[] = families.slice(0, PRESENT_COUNT);
  const settingsById = new Map<string, FamilySettings>(
    present.map((f, i) => [f.id, { relation: 50 + i * 10, bossDefeated: false }]),
  );
  const floorMap = buildFloor2LabMap(present);
  const playerSpawn = floorMap.tileToWorld(LAB_PLAYER_TILE.x, LAB_PLAYER_TILE.y);

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);
  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';
  root.append(gameHost);

  const legend = document.createElement('div');
  legend.style.cssText =
    'margin-top:16px;color:#c9d4ff;line-height:1.6;font-family:monospace;font-size:12px;';
  legend.innerHTML = `
    <p>Family-relationships widget + minimap tint palette. Slice 7 (ADR 0040 · D8).</p>
    <p>Minimap palette:
      <span style="background:${hexHash(SETTLEMENT_TINT)};padding:2px 6px;">Settlement</span>
      <span style="background:${hexHash(RESOURCE_HEART_TINT)};padding:2px 6px;">Resource Heart</span>
      <span style="background:${hexHash(BOSS_DEN_OUTLINE)};color:#fff;padding:2px 6px;">Boss Den (fallback)</span>
    </p>`;
  controls.append(legend);

  let world: GameWorld | undefined;
  let hudUi: ReturnType<typeof createHudUI> | undefined;
  let sceneReady = false;
  let hudSynced = false;
  let playerEid = -1;
  interface FamilyRelProbeApiLocal extends FamilyRelProbeApi {
    _sentinel?: never;
  }
  const probeWindow = window as unknown as { __familyRelProbe?: FamilyRelProbeApiLocal };

  class FamilyRelLabScene extends Phaser.Scene {
    constructor() {
      super({ key: SCENE_KEY });
    }

    create(): void {
      const w = createGameWorld({ seed: 424242 });
      w.state = 'playing';
      const presentIds: FamilyId[] = present.map((f) => asFamilyId(f.id));
      initializeFactionRelations(w, presentIds);
      w.floorExtendedState = {
        familyState: {
          presentFamilies: presentIds.slice(),
          contestedResource: 'contested' as never,
          betrayerFlag: false,
        },
      };
      w.floorMap = floorMap;
      playerEid = spawnPlayer(w, playerSpawn.x, playerSpawn.y);
      world = w;

      this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x05070f).setOrigin(0, 0);
      this.add
        .text(
          GAME.WIDTH / 2,
          GAME.HEIGHT / 2,
          'HudFamilyRelationships Lab\nAdjust relations + boss flags →',
          {
            fontFamily: 'monospace',
            fontSize: '16px',
            color: '#4b5563',
            align: 'center',
          },
        )
        .setOrigin(0.5, 0.5);

      hudUi = createHudUI(this);
      sceneReady = true;

      probeWindow.__familyRelProbe = {
        ready: () => sceneReady && hudSynced,
        setRelation: (i, value) => {
          const fam = present[i];
          if (fam) settingsById.get(fam.id)!.relation = value;
        },
        setBossDefeated: (i, defeated) => {
          const fam = present[i];
          if (fam) settingsById.get(fam.id)!.bossDefeated = defeated;
        },
      };

      this.events.once('shutdown', () => {
        sceneReady = false;
        if (probeWindow.__familyRelProbe) delete probeWindow.__familyRelProbe;
        hudUi?.destroy();
        hudUi = undefined;
      });
    }

    update(): void {
      if (!world || !hudUi) return;
      for (const [id, s] of settingsById.entries()) {
        const fid = asFamilyId(id);
        world.factionRelations.set(fid, s.relation);
        world.goalFlags.set(bossDefeatedGoalFlag(fid), s.bossDefeated);
      }
      hudUi.sync(world, playerEid);
      hudSynced = true;
    }
  }

  for (const fam of present) {
    const folder = gui.addFolder(fam.name);
    const state = settingsById.get(fam.id)!;
    folder.add(state, 'relation', 0, 100, 1).name('Relation');
    folder.add(state, 'bossDefeated').name('Boss defeated');
    folder.open();
  }

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: GAME.WIDTH,
    height: GAME.HEIGHT,
    backgroundColor: '#05070f',
    scene: [FamilyRelLabScene],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  };
  const game = new Phaser.Game(config);

  return () => {
    hudUi?.destroy();
    game.destroy(true);
    legend.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta' as LabCategory,
  name: 'HUD Family Relationships',
  description:
    'Sandbox for the Floor-2 family-relationships HUD widget: sliders per family + boss-defeated toggles.',
  create: createHudFamilyRelationshipsLab,
});
