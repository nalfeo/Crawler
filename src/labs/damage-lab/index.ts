import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createDamageLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const params = { incomingDamage: 25, armor: 5, sampleFrames: 120 };
  gui.add(params, 'incomingDamage', 1, 200, 1).name('Damage');
  gui.add(params, 'armor', 0, 50, 1).name('Armor');
  gui.add(params, 'sampleFrames', 30, 600, 10).name('Frames');

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;line-height:1.6;';
  panel.textContent =
    'Damage Lab scaffold.\nUse this sandbox to verify hit application, scaling, and stat interactions.';
  canvasHost.append(panel);

  const hint = document.createElement('p');
  hint.textContent =
    'Stub lab for damageSystem. Add repeatable hit simulation and damage breakdown tables.';
  hint.style.cssText = 'padding:8px 16px;color:#c9d4ff;line-height:1.6;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('damage-lab', {
  name: 'Damage Lab',
  description: 'Scaffold for validating damageSystem formulas and outcomes.',
  create: createDamageLab,
});
