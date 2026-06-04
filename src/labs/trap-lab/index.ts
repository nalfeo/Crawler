import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createTrapLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const root = document.createElement('div');
  root.style.cssText = 'padding:16px;color:#e2e8f0;font-family:monospace;';
  root.innerHTML = '<h3>trap Lab</h3><p>Use weapons-lab for full interaction.</p>';
  canvasHost.append(root);

  const state = { enabled: true };
  gui.add(state, 'enabled').name('Enabled');

  return () => root.remove();
}

registerLab('trap-lab', {
  name: 'Trap',
  description: 'Placeholder lab entry for trapSystem.',
  create: createTrapLab,
});
