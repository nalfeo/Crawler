import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createPlayerInputLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const params = { deadzone: 0.1, smoothing: 0, sampleFrames: 240 };
  gui.add(params, 'deadzone', 0, 0.5, 0.01).name('Deadzone');
  gui.add(params, 'smoothing', 0, 1, 0.01).name('Smoothing');
  gui.add(params, 'sampleFrames', 30, 600, 10).name('Frames');

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;line-height:1.6;';
  panel.textContent =
    'Player Input Lab scaffold.\nUse this sandbox to inspect normalized movement vectors and input responsiveness.';
  canvasHost.append(panel);

  const hint = document.createElement('p');
  hint.textContent =
    'Stub lab for playerInputSystem. Add live key/gamepad visualizations and input trace playback.';
  hint.style.cssText = 'padding:8px 16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('playerinput-lab', {
  category: 'Movement & Physics' as LabCategory,
  name: 'Player Input Lab',
  description: 'Scaffold for validating playerInputSystem mappings and tuning.',
  create: createPlayerInputLab,
});
