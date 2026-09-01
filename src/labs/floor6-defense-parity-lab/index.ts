import GUI from 'lil-gui';
import { createFloorMainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import { createGameWorld, spawnPlayer } from '../../core/index.js';
import {
  _getFloor6InitializationArtifact,
  floor6DefenseDirectorSystem,
  getFloor6DefenseRunStats,
} from '../../game/floor6Scenario.js';
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

function tickDirectorN(world: ReturnType<typeof createGameWorld>, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    floor6DefenseDirectorSystem(world);
  }
}

function createFloor6DefenseParityLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const state = { seed: 606, tickCount: 0 };
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

    // Build wave stats by ticking the director N times
    const worldForStats = initializeViaWindowedPath(state.seed);
    tickDirectorN(worldForStats, state.tickCount);
    const stats = getFloor6DefenseRunStats(worldForStats);

    panel.textContent = [
      `seed=${state.seed}  ticks=${state.tickCount}`,
      `windowed/shared parity=${windowedBytes === sharedBytes ? 'BYTE-EQUIVALENT' : 'MISMATCH'}`,
      `artifact bytes=${windowedBytes.length}`,
      ``,
      `── Phase ──`,
      `phase=${stats?.phase.kind ?? windowed?.phase.kind ?? '(none)'}`,
      `phase trace entries=${stats?.phaseTrace.length ?? windowed?.phaseTrace.length ?? 0}`,
      ``,
      `── Wave Director ──`,
      `manifest entries=${stats?.waveManifestLength ?? 0}`,
      `next release index=${stats?.nextReleaseIndex ?? 0}`,
      `spawn debt=${stats?.spawnDebt ?? 0}`,
      `total released=${stats?.totalReleased ?? 0}`,
      `live enemy count=${stats?.liveEnemyCount ?? 0}`,
      `stalled count=${stats?.stalledCount ?? 0}`,
      `relay HP=${stats?.relayHp ?? 'n/a'} / ${stats?.relayMaxHp ?? 'n/a'}`,
      ``,
      `── Geometry ──`,
      `routes=${geometry?.routes.map((route) => route.id).join(', ') ?? '(none)'}`,
      `sites=${geometry?.buildSites.map((site) => site.id).join(', ') ?? '(none)'}`,
      `footprints=${geometry?.supportedFootprints.map((footprint) => footprint.id).join(', ') ?? '(none)'}`,
      ``,
      `stream keys:`,
      ...Object.entries(windowed?.rngStreamKeys ?? {}).map(([key, value]) => `  ${key}: ${value}`),
    ].join('\n');
  }

  gui.add(state, 'seed').name('Seed').onFinishChange(render);
  gui.add(state, 'tickCount', 0, 2000, 1).name('Tick count').onFinishChange(render);
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
    'Compare Floor 6 windowed and shared/headless initialization artifacts byte-for-byte. Also shows wave director stats at a configurable tick count.',
  create: createFloor6DefenseParityLab,
});
