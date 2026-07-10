import GUI from 'lil-gui';
import Phaser from 'phaser';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { buildTerrainLayer } from '../../engine/terrain-renderer.js';
import { measurePassageJaggedness } from '../../engine/terrain/passage-smoothing.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { BiomeType, TerrainType, TilePresets, type MapConfig } from '../../shared/map-types.js';

const LAB_ID = 'hallway-smoothing-lab';
const PANEL_PADDING = 20;
const PANEL_GAP = 28;
const LABEL_Y = 14;
const PANEL_Y = 48;
const TILE_SIZE_FT = 4;
const PIXELS_PER_FOOT = 8;
const TILE_SIZE_PX = TILE_SIZE_FT * PIXELS_PER_FOOT;

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type ScenarioId = 'diagonal' | 'curved';

interface HallwaySmoothingLabState {
  scenario: ScenarioId;
}

interface FixtureScenario {
  readonly name: string;
  readonly rows: readonly string[];
}

declare global {
  interface Window {
    __hallwaySmoothingDebug?: {
      ready: boolean;
      scenario: ScenarioId;
      baselineJaggedness: number;
      smoothJaggedness: number;
      reduction: number;
      includedTiles: number;
    };
  }
}

const FIXTURES: Readonly<Record<ScenarioId, FixtureScenario>> = {
  diagonal: {
    name: 'Diagonal shortcuts',
    rows: [
      '####################',
      '#....###############',
      '#....###############',
      '#....##cc###########',
      '#....###cc##########',
      '#....####cc####....#',
      '#....#####cc###....#',
      '####d######cc##....#',
      '####.#######cc#....#',
      '####...............#',
      '####################',
      '####################',
    ],
  },
  curved: {
    name: 'Curved cave passages',
    rows: [
      '####################',
      '####vvvv############',
      '###vvvvvv###########',
      '##vvvv#vvv##########',
      '##vvv###vvv#########',
      '##vv#####vvv########',
      '###vv#####vvv#######',
      '####vv#####vvv######',
      '#####vv#####vvvv####',
      '######vv######vvv###',
      '#######vvvvvvvvvv###',
      '####################',
    ],
  },
};

function buildFixtureFloorMap(scenarioId: ScenarioId): FloorMap {
  const fixture = FIXTURES[scenarioId];
  const heightTiles = fixture.rows.length;
  const widthTiles = fixture.rows[0]?.length ?? 0;
  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: TILE_SIZE_FT,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 8,
    floorDensity: 0.4,
  };

  for (let y = 0; y < heightTiles; y++) {
    const row = fixture.rows[y]!;
    for (let x = 0; x < widthTiles; x++) {
      const idx = y * widthTiles + x;
      switch (row[x]) {
        case '.':
          terrain[idx] = TerrainType.STONE_FLOOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
          break;
        case 'c':
          terrain[idx] = TerrainType.CORRIDOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
          break;
        case 'd':
          terrain[idx] = TerrainType.DOOR;
          tileMap.flags[idx] = TilePresets.DOOR_CLOSED;
          break;
        case 'v':
          terrain[idx] = TerrainType.CAVE_FLOOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
          break;
        default:
          terrain[idx] = scenarioId === 'curved' ? TerrainType.CAVE_WALL : TerrainType.STONE_WALL;
          tileMap.flags[idx] = TilePresets.WALL;
          break;
      }
    }
  }

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 1, y: 1 });
}

class HallwaySmoothingScene extends Phaser.Scene {
  constructor(
    private readonly scenarioId: ScenarioId,
    private readonly metrics: ReturnType<typeof measurePassageJaggedness>,
  ) {
    super('HallwaySmoothingScene');
  }

  create(): void {
    const floorMap = buildFixtureFloorMap(this.scenarioId);
    const panelWidth = floorMap.width * TILE_SIZE_PX;
    const baseline = buildTerrainLayer(this, floorMap, { smoothPassages: false });
    baseline.rt.setPosition(PANEL_PADDING, PANEL_Y);
    const smooth = buildTerrainLayer(this, floorMap, { smoothPassages: true });
    smooth.rt.setPosition(PANEL_PADDING + panelWidth + PANEL_GAP, PANEL_Y);

    this.cameras.main.setBackgroundColor('#0f172a');
    const style = {
      fontFamily: 'monospace',
      fontSize: '24px',
      color: '#e2e8f0',
    };
    this.add.text(PANEL_PADDING, LABEL_Y, 'Baseline tile silhouette', style);
    this.add.text(
      PANEL_PADDING + panelWidth + PANEL_GAP,
      LABEL_Y,
      'Smoothed contour overlay',
      style,
    );

    window.__hallwaySmoothingDebug = {
      ready: true,
      scenario: this.scenarioId,
      baselineJaggedness: this.metrics.baselineRoughness,
      smoothJaggedness: this.metrics.smoothRoughness,
      reduction: this.metrics.reduction,
      includedTiles: this.metrics.includedTiles,
    };
  }
}

function createHallwaySmoothingLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: HallwaySmoothingLabState = {
    scenario: 'diagonal',
    ...(loadLabState<Partial<HallwaySmoothingLabState>>(LAB_ID) ?? {}),
  };

  const metricsEl = document.createElement('pre');
  metricsEl.dataset.testid = 'hallway-smoothing-metrics';
  metricsEl.style.cssText =
    'margin-top:12px;padding:12px;border-radius:8px;background:#0f172a;color:#cbd5e1;' +
    'font:12px/1.5 monospace;white-space:pre-wrap;';
  canvasHost.appendChild(metricsEl);

  let game: Phaser.Game | null = null;

  const render = (): void => {
    saveLabState(LAB_ID, settings);
    const floorMap = buildFixtureFloorMap(settings.scenario);
    const metrics = measurePassageJaggedness(floorMap);
    const panelWidth = floorMap.width * TILE_SIZE_PX;
    const panelHeight = floorMap.height * TILE_SIZE_PX;
    window.__hallwaySmoothingDebug = {
      ready: false,
      scenario: settings.scenario,
      baselineJaggedness: metrics.baselineRoughness,
      smoothJaggedness: metrics.smoothRoughness,
      reduction: metrics.reduction,
      includedTiles: metrics.includedTiles,
    };
    metricsEl.textContent =
      `scenario: ${settings.scenario}\n` +
      `included passage tiles: ${metrics.includedTiles}\n` +
      `baseline jaggedness: ${metrics.baselineRoughness}\n` +
      `smoothed jaggedness: ${metrics.smoothRoughness}\n` +
      `reduction: ${(metrics.reduction * 100).toFixed(1)}%`;
    game?.destroy(true);
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: canvasHost,
      width: PANEL_PADDING * 2 + panelWidth * 2 + PANEL_GAP,
      height: PANEL_Y + panelHeight + PANEL_PADDING,
      scene: new HallwaySmoothingScene(settings.scenario, metrics),
      pixelArt: true,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });
  };

  gui
    .add(settings, 'scenario', {
      'Diagonal shortcuts': 'diagonal',
      'Curved cave passages': 'curved',
    })
    .name('Scenario')
    .onChange(render);

  render();

  return () => {
    game?.destroy(true);
    metricsEl.remove();
    delete window.__hallwaySmoothingDebug;
  };
}

registerLab(LAB_ID, {
  name: 'Hallway Smoothing',
  description: 'Fixed side-by-side debug scene for jagged versus smoothed passages.',
  category: 'Meta',
  create: createHallwaySmoothingLab,
});
