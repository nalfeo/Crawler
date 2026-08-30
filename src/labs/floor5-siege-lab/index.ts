import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer } from '../../core/index.js';
import {
  getFloor5SiegeRunStats,
  initializeFloor5Scenario,
  siegeDirectorSystem,
} from '../../game/floor5Scenario.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createFloor5SiegeLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const state = { seed: 505, stepMs: 1_000 };
  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  let world = createGameWorld({ seed: state.seed });

  function setup(): void {
    world = createGameWorld({ seed: state.seed });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor5Scenario(world, player);
    render();
  }

  function step(): void {
    world.elapsedMs += state.stepMs;
    siegeDirectorSystem(world);
    render();
  }

  function render(): void {
    const siege = getFloor5SiegeRunStats(world);
    panel.textContent = [
      `seed=${state.seed} floor=${world.floorId || '(not initialized)'}`,
      `worldElapsedMs=${world.elapsedMs}`,
      `phase=${siege ? JSON.stringify(siege.phase) : '(none)'}`,
      `commandPostHealth=${siege?.commandPostHealth ?? 0}`,
      `engine=${siege?.engineState ?? '(none)'}`,
      `breach=${siege?.breachState ?? '(none)'}`,
      `hero=${siege?.heroState ?? '(none)'}`,
      `checkpointOwner=${siege?.checkpointOwner ?? '(none)'}`,
      `waveCycles=${siege?.laneTelemetry.waveCyclesCompleted ?? 0}`,
      `checkpointContests=${siege?.laneTelemetry.checkpointContests ?? 0}`,
      `legalDamage=${siege?.laneTelemetry.legalDamageEvents ?? 0}`,
      `illegalDamage=${siege?.laneTelemetry.illegalDamageEvents ?? 0}`,
      `pathStalls=${siege?.laneTelemetry.pathStalls ?? 0}`,
      '',
      'stream keys:',
      ...Object.entries(siege?.rngStreamKeys ?? {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      'structures:',
      ...Object.values(siege?.structures ?? {}).map(
        (structure) =>
          `  ${structure.id} team=${structure.team} hp=${structure.health}/${structure.maxHealth}`,
      ),
      '',
      'wave manifest:',
      ...(siege?.waveManifest ?? []).map(
        (entry) =>
          `  ${entry.id} team=${entry.team} releaseFrame=${entry.releaseFrame} count=${entry.count}`,
      ),
      '',
      'phase trace:',
      ...(siege?.trace ?? []).map(
        (entry) =>
          `  f=${entry.frame} world=${entry.worldElapsedMs} ${JSON.stringify(entry.phase)} ${entry.reason}`,
      ),
    ].join('\n');
  }

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => setup());
  gui.add(state, 'stepMs', 16, 10_000, 16).name('Step ms');
  gui.add({ step }, 'step').name('Advance director');
  gui.add({ setup }, 'setup').name('Reset');

  setup();

  return () => {
    gui.destroy();
    panel.remove();
  };
}

registerLab('floor5-siege-lab', {
  name: 'Floor 5 Siege',
  category: 'Meta',
  description: 'Inspect Floor 5 siege phase skeleton, stream keys, and empty transition trace.',
  create: createFloor5SiegeLab,
});
