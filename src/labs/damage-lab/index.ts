import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createDamageLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.background = 'radial-gradient(circle at top, #3f1d2e 0%, #1e0f1d 60%, #120813 100%)';

  const card = document.createElement('div');
  card.style.maxWidth = '640px';
  card.style.padding = '20px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(24, 8, 20, 0.85)';
  card.style.color = '#f1d5db';
  card.style.lineHeight = '1.6';
  card.textContent =
    'Damage Lab placeholder. Use this lab for tuning damage application, invulnerability windows, and hit validation.';

  root.append(card);
  canvasHost.append(root);

  return () => {
    root.remove();
  };
}

registerLab('damage-lab', {
  name: 'Damage Lab',
  description: 'Sandbox for damage system behavior.',
  create: createDamageLab,
});

