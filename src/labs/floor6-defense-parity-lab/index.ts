import GUI from 'lil-gui';
import { setComponent } from 'bitecs';
import { createFloorMainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import { Position, createGameWorld, spawnPlayer } from '../../core/index.js';
import {
  _getFloor6InitializationArtifact,
  floor6DefenseDirectorSystem,
  floor6TowerSystem,
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

function exerciseTowerSystem(seed: number) {
  const world = initializeViaWindowedPath(seed);
  tickDirectorN(world, 181);
  const state = world.floorExtendedState?.floor6Defense;
  const commands = getScenarioDefinition('floor6').floor6Towers;
  if (!state || !commands) throw new Error('Floor 6 tower state missing');
  state.economy.balance = 999;
  state.economy.totalEarned = 999;
  const site = state.towers.sites[0]!;
  const tower = commands.getRoster(world)[0]!;
  const buildResult = commands.build(world, site.siteId, tower.id);
  const target = state.liveEnemies.find((record) => record.eid > 0 && !record.defeated);
  if (buildResult.ok && target) {
    setComponent(world.ecs, target.eid, Position, {
      x: (world.stores.position.x[site.towerEid] ?? 0) + 4,
      y: world.stores.position.y[site.towerEid] ?? 0,
    });
    floor6TowerSystem(world);
  }
  return { buildResult, stats: getFloor6DefenseRunStats(world) };
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
    const towerExercise = exerciseTowerSystem(state.seed);

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
      `── Tower System ──`,
      `build=${towerExercise.buildResult.reason}`,
      `targets hit=${towerExercise.stats?.towers.combatTrace.length ?? 0}`,
      `effects spawned=${towerExercise.stats?.towers.effectsSpawned ?? 0}`,
      `active effects=${towerExercise.stats?.towers.activeEffectCount ?? 0}`,
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
    'Compare Floor 6 initialization paths and exercise tower build, targeting, and effect behavior.',
  create: createFloor6DefenseParityLab,
});
