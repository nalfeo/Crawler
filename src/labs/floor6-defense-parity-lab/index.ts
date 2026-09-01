import GUI from 'lil-gui';
import { createFloorMainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import { createGameWorld, spawnPlayer } from '../../core/index.js';
import { _getFloor6InitializationArtifact } from '../../game/floor6Scenario.js';
import { getScenarioDefinition } from '../../game/scenarioDefinitions.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function initializeViaWindowedPath(seed: number) {
  const world = createGameWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld!(world, player);
  return world;
}

function initializeViaSharedScenario(seed: number) {
  const world = createGameWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  getScenarioDefinition('floor6').configureWorld(world, player);
  return world;
}

function createFloor6DefenseParityLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const state = { seed: 606 };
  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  function render(): void {
    const windowed = _getFloor6InitializationArtifact(initializeViaWindowedPath(state.seed));
    const shared = _getFloor6InitializationArtifact(initializeViaSharedScenario(state.seed));
    const windowedBytes = JSON.stringify(windowed);
    const sharedBytes = JSON.stringify(shared);
    const geometry = windowed?.geometry;
    panel.textContent = [
      `seed=${state.seed}`,
      `windowed/shared parity=${windowedBytes === sharedBytes ? 'BYTE-EQUIVALENT' : 'MISMATCH'}`,
      `artifact bytes=${windowedBytes.length}`,
      `phase=${windowed?.phase.kind ?? '(none)'}`,
      `phase trace entries=${windowed?.phaseTrace.length ?? 0}`,
      `routes=${geometry?.routes.map((route) => route.id).join(', ') ?? '(none)'}`,
      `sites=${geometry?.buildSites.map((site) => site.id).join(', ') ?? '(none)'}`,
      `footprints=${geometry?.supportedFootprints.map((footprint) => footprint.id).join(', ') ?? '(none)'}`,
      '',
      'stream keys:',
      ...Object.entries(windowed?.rngStreamKeys ?? {}).map(([key, value]) => `  ${key}: ${value}`),
    ].join('\n');
  }

  gui.add(state, 'seed').name('Seed').onFinishChange(render);
  gui.add({ render }, 'render').name('Rebuild parity artifacts');
  render();

  return () => {
    gui.destroy();
    panel.remove();
  };
}

registerLab('floor6-defense-parity-lab', {
  name: 'Floor 6 Defense Parity',
  category: 'Meta',
  description:
    'Compare Floor 6 windowed and shared/headless initialization artifacts byte-for-byte.',
  create: createFloor6DefenseParityLab,
});
