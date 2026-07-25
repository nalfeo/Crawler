/**
 * Prop Lab — visual sandbox for the props/decoration placement system.
 *
 * Generates a BASIC_UNDERGROUND floor, runs placePropsForFloor, and renders:
 *   - Terrain tiles in muted colours
 *   - Cave sub-regions highlighted with a purple background tint
 *   - Props as coloured dots sized by `scale` (colour varies by category)
 *   - PropLight emission radii as semi-transparent circles
 *
 * Controls (lil-gui):
 *   - seed            — deterministic RNG seed
 *   - density         — multiplier applied to all def densities
 *   - showCaveOverlay — toggle cave-floor highlight
 *   - showLightRadii  — toggle PropLight radius circles
 *   - cellSize        — zoom level in canvas pixels per tile
 */

import GUI from 'lil-gui';
import { query } from 'bitecs';
import { BiomeType, TerrainType } from '../../shared/map-types.js';
import type { MapConfig } from '../../shared/map-types.js';
import { getGenerator } from '../../core/map/generators/registry.js';
import { SeededRandom } from '../../shared/random.js';
import { createGameWorld } from '../../core/world.js';
import { placePropsForFloor, type PropPlacerConfig } from '../../game/systems/propPlacer.js';
import { DECORATION_INDEX_TO_ID, getDecorationDef } from '../../shared/decorationDefs.js';
import type { BiomeTag } from '../../shared/biome-tags.js';
import { Prop, PropLight, Position } from '../../core/components.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'prop-lab';

// Smaller grid for fast iteration in the lab
const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 60;
const DEFAULT_SEED = 12345;

interface PropLabSettings {
  seed: number;
  widthTiles: number;
  heightTiles: number;
  cellSize: number;
  density: number;
  biomeTag: BiomeTag;
  showCaveOverlay: boolean;
  showLightRadii: boolean;
}

/** Muted terrain colours for the canvas preview. */
const TERRAIN_COLORS: Record<number, string> = {
  [TerrainType.VOID]: '#050608',
  [TerrainType.STONE_FLOOR]: '#1e2a38',
  [TerrainType.STONE_WALL]: '#0d1117',
  [TerrainType.DOOR]: '#8b5e34',
  [TerrainType.CORRIDOR]: '#152230',
  [TerrainType.WATER]: '#1d4ed8',
  [TerrainType.LAVA]: '#b91c1c',
  [TerrainType.GRASS]: '#166534',
  [TerrainType.DIRT]: '#6b3f24',
  [TerrainType.WOOD_FLOOR]: '#5b4430',
  [TerrainType.CAVE_FLOOR]: '#3c2e4a',
  [TerrainType.CAVE_WALL]: '#160e1f',
  [TerrainType.BOSS_STAIR_FLOOR]: '#3d0a18',
  [TerrainType.SAFE_ROOM_FLOOR]: '#0a2040',
};

/** Prop category → canvas fill colour */
const CATEGORY_COLORS: Record<string, string> = {
  rubbish: '#a07850',
  'light-source': '#ffb347',
  structural: '#94a3b8',
  organic: '#4ade80',
  tech: '#38bdf8',
};

/** PIXELS_PER_FOOT constant mirrored from src/shared/units.ts (8 px/ft). */
const PIXELS_PER_FOOT = 8;

function render(canvas: HTMLCanvasElement, settings: PropLabSettings): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cs = settings.cellSize;

  const config: MapConfig = {
    widthTiles: settings.widthTiles,
    heightTiles: settings.heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: settings.seed,
    roomWidthRange: [8, 16],
    roomHeightRange: [7, 14],
    maxRooms: 30,
    floorDensity: 0.36,
  };

  const rng = new SeededRandom(settings.seed);
  const floorMap = getGenerator(config.biome).generate(config, rng);

  // Create an ECS world so we can spawn props.
  const world = createGameWorld({ seed: settings.seed, floor: 1, entityCapacityMode: 'test' });

  const placerConfig: PropPlacerConfig = {
    biomeTag: settings.biomeTag,
    densityMultiplier: settings.density,
  };

  // Use a fresh rng for placement so seed changes re-roll independently.
  const placerRng = new SeededRandom(settings.seed + 1);
  placePropsForFloor(world, floorMap, placerConfig, placerRng);

  // Resize canvas.
  canvas.width = settings.widthTiles * cs;
  canvas.height = settings.heightTiles * cs;

  const { terrain, width: w, height: h } = floorMap;

  // --- Draw terrain ---
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const t = terrain[ty * w + tx] ?? TerrainType.VOID;
      ctx.fillStyle = TERRAIN_COLORS[t] ?? '#111';
      ctx.fillRect(tx * cs, ty * cs, cs, cs);
    }
  }

  // --- Cave overlay ---
  if (settings.showCaveOverlay) {
    ctx.fillStyle = 'rgba(120, 60, 200, 0.18)';
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        if (terrain[ty * w + tx] === TerrainType.CAVE_FLOOR) {
          ctx.fillRect(tx * cs, ty * cs, cs, cs);
        }
      }
    }
  }

  // --- Collect PropLight entity IDs for fast membership test ---
  const propLightSet = new Set<number>(query(world.ecs, [PropLight, Prop]));

  // --- Draw props ---
  const tileSizeFt = floorMap.config.tileSizeFt;
  // Convert ft → canvas: (ft / tileSizeFt) * cellSize
  const ftToCanvas = (ft: number): number => (ft / tileSizeFt) * cs;

  for (const propEid of query(world.ecs, [Prop, Position])) {
    const xFt = world.stores.position.x[propEid] ?? 0;
    const yFt = world.stores.position.y[propEid] ?? 0;
    const cx = ftToCanvas(xFt);
    const cy = ftToCanvas(yFt);

    const defIdIndex = world.stores.prop.defIdIndex[propEid] ?? 0;
    const defId = DECORATION_INDEX_TO_ID[defIdIndex];
    const decorationDef = defId !== undefined ? getDecorationDef(defId) : undefined;

    const r = Math.max(2, (decorationDef?.scale ?? 1.0) * cs * 0.35);
    const color = decorationDef ? (CATEGORY_COLORS[decorationDef.category] ?? '#888') : '#888';

    // PropLight emission radius overlay.
    if (settings.showLightRadii && propLightSet.has(propEid)) {
      const radiusPx = world.stores.propLight.radiusPx[propEid] ?? 0;
      // radiusPx is in render-pixels (PIXELS_PER_FOOT=8). Convert to canvas coords:
      // radiusFt = radiusPx / PIXELS_PER_FOOT; canvasRadius = (radiusFt / tileSizeFt) * cs
      const radiusCanvas = (radiusPx / PIXELS_PER_FOOT / tileSizeFt) * cs;
      ctx.beginPath();
      ctx.arc(cx, cy, radiusCanvas, 0, Math.PI * 2);
      const intensity = world.stores.propLight.intensity[propEid] ?? 0.7;
      ctx.fillStyle = `rgba(255, 180, 70, ${(intensity * 0.08).toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255, 180, 70, ${(intensity * 0.3).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Draw prop dot.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

registerLab(LAB_ID, {
  name: 'Prop Lab',
  description: 'Visualise prop placement across a BASIC_UNDERGROUND floor',
  category: 'Meta',
  create(canvasHost: HTMLElement, controlsEl: HTMLElement): (() => void) | void {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.imageRendering = 'pixelated';
    canvasHost.appendChild(canvas);

    const saved = loadLabState<PropLabSettings>(LAB_ID);
    const settings: PropLabSettings = {
      seed: saved?.seed ?? DEFAULT_SEED,
      widthTiles: saved?.widthTiles ?? DEFAULT_WIDTH,
      heightTiles: saved?.heightTiles ?? DEFAULT_HEIGHT,
      cellSize: saved?.cellSize ?? 8,
      density: saved?.density ?? 1.0,
      biomeTag: saved?.biomeTag ?? 'dungeon',
      showCaveOverlay: saved?.showCaveOverlay ?? true,
      showLightRadii: saved?.showLightRadii ?? true,
    };

    const gui = (controlsEl as ControlsWithGui).__labGui;
    if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

    let dirty = true;
    let rafId = 0;

    const redraw = (): void => {
      dirty = false;
      render(canvas, settings);
    };

    const schedule = (): void => {
      dirty = true;
    };

    gui.add(settings, 'seed', 1, 999999, 1).name('Seed').onChange(schedule);
    gui.add(settings, 'density', 0.1, 5.0, 0.05).name('Density mult').onChange(schedule);
    gui
      .add(settings, 'biomeTag', ['dungeon', 'organic', 'tech', 'void', 'cave'])
      .name('Biome tag')
      .onChange(schedule);
    gui.add(settings, 'cellSize', 4, 16, 1).name('Cell size (px)').onChange(schedule);
    gui.add(settings, 'showCaveOverlay').name('Cave overlay').onChange(schedule);
    gui.add(settings, 'showLightRadii').name('Light radii').onChange(schedule);
    gui
      .add(
        {
          randomize(): void {
            settings.seed = Math.floor(Math.random() * 999999) + 1;
            gui
              .controllersRecursive()
              .find((c) => c.property === 'seed')
              ?.setValue(settings.seed);
            schedule();
          },
        },
        'randomize',
      )
      .name('Randomize seed');

    function loop(): void {
      if (dirty) {
        redraw();
        saveLabState(LAB_ID, settings);
      }
      rafId = requestAnimationFrame(loop);
    }

    redraw();
    rafId = requestAnimationFrame(loop);

    return (): void => {
      cancelAnimationFrame(rafId);
      canvas.remove();
    };
  },
});
