import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createHealthLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const params = { startHp: 100, regenPerSecond: 0, sampleSeconds: 30 };
  gui.add(params, 'startHp', 1, 500, 1).name('Start HP');
  gui.add(params, 'regenPerSecond', 0, 50, 1).name('Regen/s');
  gui.add(params, 'sampleSeconds', 1, 120, 1).name('Seconds');

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;line-height:1.6;';
  panel.textContent =
    'Health Lab scaffold.\nUse this sandbox to tune health changes, death handling, and recovery rules.';
  canvasHost.append(panel);

  const hint = document.createElement('p');
  hint.textContent =
    'Stub lab for healthSystem. Add timeline charts for HP over time and death transitions.';
  hint.style.cssText = 'padding:8px 16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('health-lab', {
  category: 'Combat' as LabCategory,
  name: 'Health Lab',
  description: 'Scaffold for validating healthSystem behavior.',
  create: createHealthLab,
});
