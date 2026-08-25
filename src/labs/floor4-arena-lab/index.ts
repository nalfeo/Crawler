import GUI from 'lil-gui';
import { query } from 'bitecs';
import { ArenaWaveEnemy, createGameWorld, Enemy, Health, spawnPlayer } from '../../core/index.js';
import { arenaDirectorSystem, initializeFloor4Scenario } from '../../game/floor4Scenario.js';
import { getFloorManifest } from '../../shared/floor-registry.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createFloor4ArenaLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const phase = getFloorManifest('floor4')!.floor4!.phase;
  const waves = getFloorManifest('floor4')!.floor4!.waves!;
  const state = {
    seed: 404,
    // Default to one wave interval so stepping walks the release cadence.
    stepMs: getFloorManifest('floor4')!.floor4!.waves!.waveIntervalMs,
  };

  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  let world = createGameWorld({ seed: state.seed });

  function setup(): void {
    world = createGameWorld({ seed: state.seed });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor4Scenario(world, player);
    render();
  }

  function step(): void {
    world.elapsedMs += state.stepMs;
    arenaDirectorSystem(world);
    render();
  }

  function render(): void {
    const arena = world.floorExtendedState?.floor4Arena;
    const lines = [
      `seed=${state.seed} floor=${world.floorId || '(not initialized)'}`,
      `worldElapsedMs=${world.elapsedMs}`,
      `phase=${arena ? JSON.stringify(arena.phase) : '(none)'}`,
      `arenaElapsedMs=${arena?.arenaElapsedMs ?? 0}`,
      `phaseElapsedMs=${arena?.phaseElapsedMs ?? 0}`,
      '',
      `waves released=${arena?.waveStats.wavesReleased ?? 0}/${arena?.waveManifests.length ?? 0}` +
        ` scheduled=${arena?.waveStats.enemiesScheduled ?? 0} spawned=${arena?.waveStats.enemiesSpawned ?? 0}`,
      `live=${world.floorId ? query(world.ecs, [Enemy, Health]).length : 0}` +
        ` waveEnemies=${world.floorId ? query(world.ecs, [ArenaWaveEnemy]).length : 0}` +
        ` cap=${waves.concurrencyCap}`,
      `debt=${arena?.spawnDebt.length ?? 0}/${waves.debtCap}` +
        ` deferred=${arena?.waveStats.spawnsDeferred ?? 0}` +
        ` discarded=${arena?.waveStats.spawnsDiscarded ?? 0}` +
        ` cleared=${arena?.waveStats.debtCleared ?? 0}`,
      `cut=${arena?.waveStats.enemiesCut ?? 0}` +
        ` telegraphs=${arena?.waveStats.gateTelegraphsFired ?? 0}` +
        ` lit=${(arena?.activeGateTelegraphs ?? []).map((t) => t.gateIndex).join(',') || '-'}`,
      `manifestFingerprints=${(arena?.waveManifestFingerprints ?? []).join(' ') || '-'}`,
      '',
      'wave manifest (current act):',
      ...(arena?.waveManifests ?? []).map(
        (wave) =>
          `  w${wave.waveIndex} release=${wave.releaseAtMs} telegraph=${wave.telegraphAtMs}` +
          ` budget=${wave.budget} spawns=${wave.spawns.map((s) => `${s.archetypeId}@g${s.gateIndex}`).join(' ')}`,
      ),
      '',
      'timeline:',
      ...(arena?.timeline ?? []).map(
        (entry) =>
          `  f=${entry.frame} world=${entry.worldElapsedMs} arena=${entry.arenaElapsedMs} ${JSON.stringify(entry.phase)} ${entry.reason}`,
      ),
    ];
    panel.textContent = lines.join('\n');
  }

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => setup());
  gui.add(state, 'stepMs', 16, phase.actDurationMs, 16).name('Step ms');
  gui.add({ step }, 'step').name('Advance director');
  gui.add({ reset: setup }, 'reset').name('Reset');

  setup();
  return () => {
    panel.remove();
  };
}

registerLab('floor4-arena-lab', {
  category: 'Progression' as LabCategory,
  name: 'Floor 4 Arena Lab',
  description:
    'Floor 4 — inspect the arena phase machine, wave manifests, concurrency cap, spawn debt and the cut.',
  create: createFloor4ArenaLab,
});
