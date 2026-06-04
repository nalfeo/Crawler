import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createHealthLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.background = 'radial-gradient(circle at top, #214536 0%, #12291f 60%, #0b1711 100%)';

  const card = document.createElement('div');
  card.style.maxWidth = '640px';
  card.style.padding = '20px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(10, 24, 17, 0.85)';
  card.style.color = '#d1fae5';
  card.style.lineHeight = '1.6';
  card.textContent =
    'Health Lab placeholder. Use this lab for max/current HP behavior, death transitions, and regen experiments.';

  root.append(card);
  canvasHost.append(root);

  return () => {
    root.remove();
  };
}

registerLab('health-lab', {
  name: 'Health Lab',
  description: 'Sandbox for health system behavior.',
  create: createHealthLab,
});

