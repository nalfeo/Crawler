import type GUI from 'lil-gui';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createAoeOnImpactLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const root = document.createElement('div');
  root.style.cssText = 'padding:16px;color:#e2e8f0;font-family:monospace;';
  root.innerHTML = '<h3>aoeOnImpact Lab</h3><p>Use weapons-lab for full interaction.</p>';
  canvasHost.append(root);

  const state = { enabled: true };
  gui.add(state, 'enabled').name('Enabled');

  return () => root.remove();
}

registerLab('aoeonimpact-lab', {
  category: 'Combat' as LabCategory,
  name: 'AoE On Impact',
  description: 'Placeholder lab entry for aoeOnImpactSystem.',
  create: createAoeOnImpactLab,
});
