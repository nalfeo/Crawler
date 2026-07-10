import GUI from 'lil-gui';
import { DungeonGenerator } from '../../core/map/generators/DungeonGenerator.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import {
  buildPassageRenderPlan,
  measurePassageJaggedness,
} from '../../engine/terrain/passage-smoothing.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { TERRAIN_FALLBACK_COLORS, colorToCss } from '../../shared/terrain-colors.js';
import { BiomeType, TerrainType, type MapConfig } from '../../shared/map-types.js';
import { SeededRandom } from '../../shared/random.js';

const LAB_ID = 'hallway-smoothing-lab';
const PANEL_GAP = 32;
const PANEL_PADDING = 20;

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type ScenarioId = 'diagonal' | 'curved';

interface HallwaySmoothingLabState {
  scenario: ScenarioId;
  seed: number;
  cellSize: number;
}

function rgba(color: number, alpha: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function terrainCss(terrain: TerrainType): string {
  return colorToCss(TERRAIN_FALLBACK_COLORS[terrain] ?? 0x05060f);
}

function generateScenario(settings: HallwaySmoothingLabState): FloorMap {
  const curved = settings.scenario === 'curved';
  const gen = new DungeonGenerator({ roomVariety: true, caveRegions: curved });
  const config: MapConfig = {
    widthTiles: curved ? 56 : 48,
    heightTiles: curved ? 34 : 30,
    tileSizeFt: 4,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: settings.seed,
    roomWidthRange: curved ? [5, 12] : [5, 10],
    roomHeightRange: curved ? [5, 10] : [5, 9],
    maxRooms: curved ? 18 : 16,
    floorDensity: curved ? 0.42 : 0.36,
  };
  return gen.generate(config, new SeededRandom(config.seed));
}

function drawBaseTerrain(
  ctx: CanvasRenderingContext2D,
  floorMap: FloorMap,
  originX: number,
  originY: number,
  cellSize: number,
): void {
  for (let ty = 0; ty < floorMap.height; ty++) {
    for (let tx = 0; tx < floorMap.width; tx++) {
      const idx = ty * floorMap.width + tx;
      const terrain = (floorMap.terrain[idx] ?? TerrainType.VOID) as TerrainType;
      ctx.fillStyle = terrainCss(terrain);
      ctx.fillRect(originX + tx * cellSize, originY + ty * cellSize, cellSize, cellSize);
    }
  }
}

function drawPanelChrome(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
): void {
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(x - 12, y - 34, width + 24, height + 50);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 12, y - 34, width + 24, height + 50);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '16px monospace';
  ctx.fillText(title, x - 4, y - 12);
}

function createHallwaySmoothingLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: HallwaySmoothingLabState = {
    scenario: 'diagonal',
    seed: 42,
    cellSize: 12,
    ...(loadLabState<Partial<HallwaySmoothingLabState>>(LAB_ID) ?? {}),
  };

  const canvas = document.createElement('canvas');
  canvas.dataset.testid = 'hallway-smoothing-canvas';
  canvas.style.display = 'block';
  canvas.style.imageRendering = 'pixelated';
  canvasHost.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable.');

  const metricsEl = document.createElement('pre');
  metricsEl.dataset.testid = 'hallway-smoothing-metrics';
  metricsEl.style.cssText =
    'margin-top:12px;padding:12px;border-radius:8px;background:#0f172a;color:#cbd5e1;' +
    'font:12px/1.5 monospace;white-space:pre-wrap;';
  canvasHost.appendChild(metricsEl);

  const render = (): void => {
    saveLabState(LAB_ID, settings);
    const floorMap = generateScenario(settings);
    const plan = buildPassageRenderPlan(floorMap);
    const report = measurePassageJaggedness(floorMap);
    const panelWidth = floorMap.width * settings.cellSize;
    const panelHeight = floorMap.height * settings.cellSize;
    const baselineX = PANEL_PADDING;
    const smoothX = baselineX + panelWidth + PANEL_GAP;
    const panelY = PANEL_PADDING + 34;
    canvas.width = smoothX + panelWidth + PANEL_PADDING;
    canvas.height = panelY + panelHeight + PANEL_PADDING;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawPanelChrome(ctx, baselineX, panelY, panelWidth, panelHeight, 'Baseline tile silhouette');
    drawBaseTerrain(ctx, floorMap, baselineX, panelY, settings.cellSize);

    drawPanelChrome(ctx, smoothX, panelY, panelWidth, panelHeight, 'Smoothed contour overlay');
    drawBaseTerrain(ctx, floorMap, smoothX, panelY, settings.cellSize);

    for (const group of plan.groups) {
      ctx.fillStyle = rgba(group.color, group.alpha);
      for (const circle of group.circles) {
        ctx.beginPath();
        ctx.arc(
          smoothX + circle.xTiles * settings.cellSize,
          panelY + circle.yTiles * settings.cellSize,
          circle.radiusTiles * settings.cellSize,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }

    metricsEl.textContent =
      `scenario: ${settings.scenario}\n` +
      `seed: ${settings.seed}\n` +
      `included passage tiles: ${report.includedTiles}\n` +
      `baseline jaggedness: ${report.baselineRoughness}\n` +
      `smoothed jaggedness: ${report.smoothRoughness}\n` +
      `reduction: ${(report.reduction * 100).toFixed(1)}%`;
  };

  gui
    .add(settings, 'scenario', {
      'Diagonal shortcuts': 'diagonal',
      'Curved cave passages': 'curved',
    })
    .name('Scenario')
    .onChange(render);
  gui.add(settings, 'seed', 1, 9999, 1).name('Seed').onChange(render);
  gui.add(settings, 'cellSize', 8, 20, 1).name('Zoom').onChange(render);

  render();
  return () => {
    canvas.remove();
    metricsEl.remove();
  };
}

registerLab(LAB_ID, {
  name: 'Hallway Smoothing',
  description: 'Fixed side-by-side debug scene for jagged versus smoothed passages.',
  category: 'Meta',
  create: createHallwaySmoothingLab,
});
