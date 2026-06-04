import type GUI from 'lil-gui';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createPlayerInputLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.background = 'radial-gradient(circle at top, #2f2750 0%, #1a1630 60%, #100f1f 100%)';

  const card = document.createElement('div');
  card.style.maxWidth = '640px';
  card.style.padding = '20px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(16, 13, 34, 0.85)';
  card.style.color = '#ddd6fe';
  card.style.lineHeight = '1.6';
  card.textContent =
    'Player Input Lab placeholder. Use this lab to tune input sampling, direction normalization, and control feel.';

  root.append(card);
  canvasHost.append(root);

  return () => {
    root.remove();
  };
}

registerLab('playerinput-lab', {
  name: 'Player Input Lab',
  description: 'Sandbox for player input system behavior.',
  create: createPlayerInputLab,
});

