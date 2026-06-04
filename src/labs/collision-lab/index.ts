import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createCollisionLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const params = { sampleEntities: 16, sampleFrames: 120 };
  gui.add(params, 'sampleEntities', 2, 64, 1).name('Entities');
  gui.add(params, 'sampleFrames', 30, 600, 10).name('Frames');

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;line-height:1.6;';
  panel.textContent =
    'Collision Lab scaffold.\nUse this sandbox to tune broadphase and response behavior before integrating combat changes.';
  canvasHost.append(panel);

  const hint = document.createElement('p');
  hint.textContent =
    'Stub lab for collisionSystem. Expand this with visualization and overlap probes.';
  hint.style.cssText = 'padding:8px 16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('collision-lab', {
  name: 'Collision Lab',
  description: 'Scaffold for validating collisionSystem behavior and tuning.',
  create: createCollisionLab,
});
