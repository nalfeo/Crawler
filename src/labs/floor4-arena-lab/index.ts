import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer } from '../../core/index.js';
import { arenaDirectorSystem, initializeFloor4Scenario } from '../../game/floor4Scenario.js';
import { getFloorManifest } from '../../shared/floor-registry.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createFloor4ArenaLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const phase = getFloorManifest('floor4')!.floor4!.phase;
  const state = {
    seed: 404,
    stepMs: phase.waveWindowMs,
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
  description: 'Floor 4 — inspect the empty-arena phase machine, arena clock, and timeline.',
  create: createFloor4ArenaLab,
});
