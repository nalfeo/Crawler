import './labs/index.js';
import { renderLabIndex } from './labs/lab-index.js';
import { runLab } from './labs/lab-runner.js';

const LAB_MODULE_PATHS: Readonly<Record<string, string>> = {
  'combat-lab': '/src/labs/combat-lab/index.ts',
  'collision-lab': '/src/labs/collision-lab/index.ts',
  'damage-lab': '/src/labs/damage-lab/index.ts',
  'health-lab': '/src/labs/health-lab/index.ts',
  'hello-world': '/src/labs/hello-world/index.ts',
  'movement-lab': '/src/labs/movement-lab/index.ts',
  'playerinput-lab': '/src/labs/playerinput-lab/index.ts',
  'projectilecleanup-lab': '/src/labs/projectilecleanup-lab/index.ts',
  'enemy-ai-lab': '/src/labs/enemy-ai-lab/index.ts',
  'inventory-lab': '/src/labs/inventory-lab/index.ts',
  'itempickup-lab': '/src/labs/itempickup-lab/index.ts',
  'knockback-lab': '/src/labs/knockback-lab/index.ts',
  'lifetime-lab': '/src/labs/lifetime-lab/index.ts',
  'weapons-lab': '/src/labs/weapons-lab/index.ts',
  'equipment-lab': '/src/labs/equipment-lab/index.ts',
  'anchor-lab': '/src/labs/anchor-lab/index.ts',
  'stat-lab': '/src/labs/stat-lab/index.ts',
  'stats-lab': '/src/labs/stats-lab/index.ts',
  'xp-curve-lab': '/src/labs/xp-curve-lab/index.ts',
  'skill-lab': '/src/labs/skill-lab/index.ts',
  'tile-explorer': '/src/labs/tile-explorer-lab/index.ts',
  'mobile-controls-lab': '/src/labs/mobile-controls-lab/index.ts',
  'sprite-catalog': '/src/labs/sprite-catalog-lab/index.ts',
};

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

async function loadAllLabs(): Promise<void> {
  const modulePaths = Object.values(LAB_MODULE_PATHS);
  for (const modulePath of modulePaths) {
    const loader = loaders[modulePath];
    if (loader) {
      await loader();
    }
  }
}

async function main(): Promise<void> {
  const labId = new URLSearchParams(window.location.search).get('lab');

  if (labId) {
    await loadLabModule(labId);
    runLab(labId);
    return;
  }

  await loadAllLabs();
  renderLabIndex();
}

void main().catch((error: unknown) => {
  renderFatal(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
