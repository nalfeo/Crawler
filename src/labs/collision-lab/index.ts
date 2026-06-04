import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createCollisionLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.background = 'radial-gradient(circle at top, #1f2a44 0%, #111827 60%, #0b1020 100%)';

  const card = document.createElement('div');
  card.style.maxWidth = '640px';
  card.style.padding = '20px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(9, 14, 28, 0.85)';
  card.style.color = '#e2e8f0';
  card.style.lineHeight = '1.6';
  card.textContent =
    'Collision Lab placeholder. Use this lab for focused collision-pair debugging and visualization experiments.';

  root.append(card);
  canvasHost.append(root);

  return () => {
    root.remove();
  };
}

registerLab('collision-lab', {
  name: 'Collision Lab',
  description: 'Sandbox for collision system behavior.',
  create: createCollisionLab,
});

