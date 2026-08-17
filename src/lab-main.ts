import './labs/index.js';
import { renderLabIndex } from './labs/lab-index.js';
import { initLabShell } from './labs/lab-shell.js';
import { runLab } from './labs/lab-runner.js';
import { renderLaunchContextBanner } from './launch-context-banner.js';
import type { LabCategory } from './labs/registry.js';

const LAB_MODULE_PATHS: Readonly<Record<string, string>> = {
  'ai-runner': '/src/labs/ai-runner-lab/index.ts',
  'bt-viz': '/src/labs/bt-viz-lab/index.ts',
  'bt-exploration': '/src/labs/bt-exploration-lab/index.ts',
  'collision-lab': '/src/labs/collision-lab/index.ts',
  'damage-lab': '/src/labs/damage-lab/index.ts',
  'health-lab': '/src/labs/health-lab/index.ts',
  'movement-lab': '/src/labs/movement-lab/index.ts',
  'playerinput-lab': '/src/labs/playerinput-lab/index.ts',
  'projectilecleanup-lab': '/src/labs/projectilecleanup-lab/index.ts',
  'enemy-ai-lab': '/src/labs/enemy-ai-lab/index.ts',
  'inventory-lab': '/src/labs/inventory-lab/index.ts',
  'itempickup-lab': '/src/labs/itempickup-lab/index.ts',
  'harvest-lab': '/src/labs/harvest-lab/index.ts',
  'knockback-lab': '/src/labs/knockback-lab/index.ts',
  'lifetime-lab': '/src/labs/lifetime-lab/index.ts',
  'weapon-lab': '/src/labs/weapon-lab/index.ts',
  'equipment-lab': '/src/labs/equipment-lab/index.ts',
  'equipment-balance-lab': '/src/labs/equipment-balance-lab/index.ts',
  'anchor-lab': '/src/labs/anchor-lab/index.ts',
  'stat-lab': '/src/labs/stat-lab/index.ts',
  'stats-lab': '/src/labs/stats-lab/index.ts',
  'level-up-lab': '/src/labs/level-up-lab/index.ts',
  'boss-intro-lab': '/src/labs/boss-intro-lab/index.ts',
  'xp-curve-lab': '/src/labs/xp-curve-lab/index.ts',
  'skill-lab': '/src/labs/skill-lab/index.ts',
  'status-effect-lab': '/src/labs/statuseffect-lab/index.ts',
  'weapon-skill-lab': '/src/labs/weapon-skill-lab/index.ts',
  'tile-explorer': '/src/labs/tile-explorer-lab/index.ts',
  'mobile-controls-lab': '/src/labs/mobile-controls-lab/index.ts',
  'sprite-catalog': '/src/labs/sprite-catalog-lab/index.ts',
  'weight-lab': '/src/labs/weight-lab/index.ts',
  'size-body': '/src/labs/physics-body-lab/index.ts',
  'drop-lab': '/src/labs/drop-lab/index.ts',
  'visual-snapshot-lab': '/src/labs/visual-snapshot-lab/index.ts',
  'gore-lab': '/src/labs/gore-lab/index.ts',
  'juice-lab': '/src/labs/juice-lab/index.ts',
  'fov-lab': '/src/labs/fov-lab/index.ts',
  'door-lab': '/src/labs/door-lab/index.ts',
  'door-lock-lab': '/src/labs/door-lock-lab/index.ts',
  'barrier-lab': '/src/labs/barrier-lab/index.ts',
  'map-gen-lab': '/src/labs/map-gen-lab/index.ts',
  'pathfinding-lab': '/src/labs/pathfinding-lab/index.ts',
  'terrain-pack-lab': '/src/labs/terrain-pack-lab/index.ts',
  'npc-lab': '/src/labs/npc-lab/index.ts',
  'quest-lab': '/src/labs/quest-lab/index.ts',
  'quest-content-lab': '/src/labs/quest-content-lab/index.ts',
  'safe-room-lab': '/src/labs/safe-room-lab/index.ts',
  'sprite-gallery': '/src/labs/sprite-gallery-lab/index.ts',
  'deathtimer-lab': '/src/labs/deathtimer-lab/index.ts',
  'corpsestep-lab': '/src/labs/corpsestep-lab/index.ts',
  'hud-lab': '/src/labs/hud-lab/index.ts',
  'questwaypoints-lab': '/src/labs/questwaypoints-lab/index.ts',
  'ux-snapshot-lab': '/src/labs/ux-snapshot-lab/index.ts',
  'death-lab': '/src/labs/death-lab/index.ts',
  'abilities-lab': '/src/labs/abilities-lab/index.ts',
  'tile-blend-lab': '/src/labs/tile-blend-lab/index.ts',
  'sprite-tint-lab': '/src/labs/sprite-tint-lab/index.ts',
  'mob-motion-lab': '/src/labs/mob-motion-lab/index.ts',
  'ui-probe-lab': '/src/labs/ui-probe-lab/index.ts',
  'set-piece-lab': '/src/labs/set-piece-lab/index.ts',
  'spawner-lab': '/src/labs/spawner-lab/index.ts',
  'spawnanim-lab': '/src/labs/spawnanim-lab/index.ts',
  'render-scale-lab': '/src/labs/render-scale-lab/index.ts',
  'prop-lab': '/src/labs/prop-lab/index.ts',
  'achievements-ui-lab': '/src/labs/achievements-ui-lab/index.ts',
  'main-scene-probe-lab': '/src/labs/main-scene-probe-lab/index.ts',
  'family-territory-lab': '/src/labs/family-territory-lab/index.ts',
  'family-boss-den-lab': '/src/labs/family-boss-den-lab/index.ts',
  'floor2-settlement-lab': '/src/labs/floor2-settlement-lab/index.ts',
  'family-feud-lab': '/src/labs/family-feud-lab/index.ts',
  'hud-family-relationships-lab': '/src/labs/hud-family-relationships-lab/index.ts',
  'combat-arena-lab': '/src/labs/combat-arena-lab/index.ts',
  'bosschestrewards-lab': '/src/labs/bosschestrewards-lab/index.ts',
  'bosschestpickup-lab': '/src/labs/bosschestpickup-lab/index.ts',
  'settlement-maintenance-planner-lab': '/src/labs/settlement-maintenance-planner-lab/index.ts',
  'reward-opening-ux-lab': '/src/labs/reward-opening-ux-lab/index.ts',
};

function humanizeLabId(labId: string): string {
  const tokens = labId
    .replace(/-lab$/, '')
    .replace(/-/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return tokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ');
}

const CATEGORY_HINTS: Readonly<Record<string, LabCategory>> = {
  combat: 'Combat',
  collision: 'Movement & Physics',
  damage: 'Combat',
  health: 'Entities',
  movement: 'Movement & Physics',
  playerinput: 'Movement & Physics',
  projectilecleanup: 'Combat',
  enemy: 'Entities',
  inventory: 'Items & Equipment',
  itempickup: 'Items & Equipment',
  knockback: 'Movement & Physics',
  lifetime: 'Entities',
  weapon: 'Combat',
  abilities: 'Combat',
  equipment: 'Items & Equipment',
  anchor: 'Meta',
  stat: 'Progression',
  stats: 'Progression',
  xp: 'Progression',
  skill: 'Progression',
  tile: 'Meta',
  mobile: 'Meta',
  sprite: 'Meta',
  weight: 'Entities',
  drop: 'Items & Equipment',
  visual: 'Meta',
  gore: 'Combat',
  bosschestrewards: 'Progression',
  fov: 'Movement & Physics',
  door: 'Entities',
  map: 'Meta',
  pathfinding: 'Movement & Physics',
  floor1: 'Meta',
  npc: 'Entities',
  quest: 'Progression',
  safe: 'Entities',
  deathtimer: 'Entities',
  hud: 'Meta',
  ux: 'Meta',
  death: 'Entities',
  spawner: 'Entities',
  spawnanim: 'Entities',
  prop: 'Meta',
};

function inferCategory(labId: string): LabCategory | undefined {
  const token = labId.split('-')[0];
  return token ? CATEGORY_HINTS[token] : undefined;
}

const LAB_INDEX_ENTRIES = Object.keys(LAB_MODULE_PATHS).map((id) => ({
  id,
  name: humanizeLabId(id),
  description: `${humanizeLabId(id)} sandbox.`,
  category: inferCategory(id),
}));

type GlobLoaderMap = Record<string, () => Promise<unknown>>;
// @ts-expect-error Vite provides import.meta.glob at runtime.
const loaders = import.meta.glob('/src/labs/**/index.ts') as GlobLoaderMap;

function renderFatal(message: string): void {
  const canvas = document.getElementById('lab-canvas');
  const controls = document.getElementById('lab-controls');
  if (!canvas || !controls) return;

  canvas.replaceChildren();
  controls.replaceChildren();

  const panel = document.createElement('div');
  panel.style.padding = '24px';
  panel.style.maxWidth = '720px';
  panel.style.margin = '24px auto';
  panel.style.border = '1px solid rgba(255,255,255,0.15)';
  panel.style.borderRadius = '12px';
  panel.style.background = 'rgba(15, 23, 42, 0.9)';
  panel.style.color = '#e2e8f0';

  const title = document.createElement('h2');
  title.textContent = 'Lab failed to load';
  title.style.marginBottom = '10px';

  const body = document.createElement('pre');
  body.textContent = message;
  body.style.whiteSpace = 'pre-wrap';
  body.style.wordBreak = 'break-word';
  body.style.lineHeight = '1.4';
  body.style.fontSize = '13px';

  panel.append(title, body);
  canvas.append(panel);
}

async function loadLabModule(labId: string): Promise<void> {
  const modulePath = LAB_MODULE_PATHS[labId];
  if (!modulePath) {
    return;
  }
  const loader = loaders[modulePath];
  if (!loader) {
    throw new Error(`No loader found for lab module: ${modulePath}`);
  }
  await loader();
}

async function main(): Promise<void> {
  const labId = new URLSearchParams(window.location.search).get('lab');
  initLabShell({ hasActiveLab: Boolean(labId) });
  renderLaunchContextBanner();

  if (labId) {
    await loadLabModule(labId);
    runLab(labId);
    return;
  }

  renderLabIndex({ entries: LAB_INDEX_ENTRIES });
}

void main().catch((error: unknown) => {
  renderFatal(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
